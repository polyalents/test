require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcrypt');
const { spawn } = require('child_process');

const app = express();

// Переменные окружения (без fallback - пусть падает если нет)
const PORT = process.env.BACKEND_PORT;
const JWT_SECRET = process.env.JWT_SECRET;
const HLS_DIR = process.env.HLS_DIR;
const RECORDINGS_DIR = process.env.RECORDINGS_DIR;
const RTSP_BASE_IP = process.env.RTSP_BASE_IP;
const RTSP_PORT = process.env.RTSP_PORT;
const RTSP_USER = process.env.RTSP_USER;
const RTSP_PASS = process.env.RTSP_PASS;
const API_ACCESS_KEY = process.env.API_ACCESS_KEY;

// Проверяем обязательные переменные
const requiredEnvVars = ['BACKEND_PORT', 'JWT_SECRET', 'HLS_DIR', 'RECORDINGS_DIR', 'RTSP_BASE_IP', 'RTSP_PORT', 'RTSP_USER', 'RTSP_PASS', 'API_ACCESS_KEY'];
requiredEnvVars.forEach(varName => {
    if (!process.env[varName]) {
        console.error(`❌ Missing required environment variable: ${varName}`);
        process.exit(1);
    }
});

// Создаем необходимые директории
[HLS_DIR, RECORDINGS_DIR].forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        console.log(`Created directory: ${dir}`);
    }
});

// Храним активные процессы записи
const activeRecordings = new Map();

// Middleware
app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    next();
});

// Логирование (исключаем .ts сегменты чтобы не засорять лог)
app.use((req, res, next) => {
    if (!req.url.includes('.ts') && !req.url.includes('favicon')) {
        console.log(`${new Date().toISOString()} ${req.method} ${req.url} - ${req.ip}`);
    }
    next();
});

// ===============================
// MIDDLEWARE ФУНКЦИИ
// ===============================

// Проверка JWT токена
const verifyToken = (req, res, next) => {
    const token = req.headers.authorization?.replace('Bearer ', '') || req.query.token;
    
    if (!token) {
        return res.status(401).json({ error: 'Token required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid token', details: error.message });
    }
};

// Проверка API ключа
const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!apiKey || apiKey !== API_ACCESS_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    next();
};

// Проверка доступа к камере
const checkCameraAccess = async (req, res, next) => {
    const cameraId = parseInt(req.params.cameraId);
    
    if (req.user.role === 'ADMIN') {
        return next();
    }
    
    try {
        // Проверяем есть ли доступ к камере через permissions
            where: {
                userId: req.user.userId,
                cameraId: cameraId,
                canView: true
            }
        });
        
        if (!permission) {
            return res.status(403).json({ 
                error: 'Access denied to this camera',
                camera: cameraId
            });
        }
        
        next();
    } catch (error) {
        console.error('Error checking camera access:', error);
        res.status(500).json({ error: 'Access check failed' });
    }
};

// Проверка токена для сегментов
const verifySegmentToken = (req, res, next) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Segment access denied: token required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const cameraId = parseInt(req.params.cameraId);
        
        // Админы имеют доступ ко всем камерам
        if (decoded.role === 'ADMIN') {
            req.user = decoded;
            return next();
        }
        
        // Проверяем доступ к конкретной камере (будет проверено в checkCameraAccess)
        req.user = decoded;
        return next();
        
    } catch (error) {
        return res.status(401).json({ error: 'Segment access denied: invalid token' });
    }
};

// ===============================
// АУТЕНТИФИКАЦИЯ
// ===============================

// Получение токена
app.post('/auth/token', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    try {
        // Ищем пользователя в БД
            where: { username: username }
        });
        
        if (!user || !user.isActive) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Проверяем пароль
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Получаем камеры доступные пользователю
            where: { 
                userId: user.id,
                canView: true
            },
            include: { camera: true }
        });
        
        const userCameras = permissions.map(p => p.camera.channelId);
        
        const token = jwt.sign(
            { 
                userId: user.id,
                username: user.username, 
                role: user.role,
                cameras: userCameras
            }, 
            JWT_SECRET, 
            { expiresIn: '24h' }
        );
        
        res.json({ 
            token, 
            user: { 
                id: user.id,
                username: user.username, 
                role: user.role, 
                cameras: userCameras 
            } 
        });
    } catch (error) {
        console.error('Auth error:', error);
        res.status(500).json({ error: 'Authentication failed' });
    }
});

// Валидация токена
app.get('/auth/validate', verifyToken, (req, res) => {
    res.json({
        valid: true,
        user: {
            id: req.user.userId,
            username: req.user.username,
            role: req.user.role,
            cameras: req.user.cameras
        }
    });
});

// ===============================
// УПРАВЛЕНИЕ КАМЕРАМИ
// ===============================

// Список доступных камер
app.get('/api/cameras', verifyToken, async (req, res) => {
    try {
        let cameras;
        
        if (req.user.role === 'ADMIN') {
            // Админ видит все камеры
                where: { isActive: true },
                orderBy: { channelId: 'asc' }
            });
        } else {
            // Обычные пользователи видят только разрешенные камеры
                where: { 
                    userId: req.user.userId,
                    canView: true
                },
                include: { 
                    camera: {
                        where: { isActive: true }
                    }
                }
            });
            
            cameras = permissions
                .filter(p => p.camera)
                .map(p => p.camera)
                .sort((a, b) => a.channelId - b.channelId);
        }
        
        // Добавляем статус HLS для каждой камеры
        const camerasWithStatus = cameras.map(camera => {
            const cameraStatus = getCameraHLSStatus(camera.channelId);
            return {
                id: camera.id,
                channelId: camera.channelId,
                name: camera.name,
                rtspUrl: camera.rtspUrl,
                isActive: camera.isActive,
                status: cameraStatus.status,
                hlsUrl: cameraStatus.hlsUrl,
                qualities: cameraStatus.qualities
            };
        });
        
        res.json({ 
            success: true,
            cameras: camerasWithStatus,
            total: camerasWithStatus.length 
        });
    } catch (error) {
        console.error('Error fetching cameras:', error);
        res.status(500).json({ error: 'Failed to fetch cameras' });
    }
});

// Функция проверки статуса HLS камеры
function getCameraHLSStatus(channelId) {
    try {
        // Проверяем adaptive HLS
        const adaptiveDir = path.join(HLS_DIR, `camera_${channelId}`);
        const masterPlaylist = path.join(adaptiveDir, 'master.m3u8');
        
        if (fs.existsSync(masterPlaylist)) {
            const qualities = ['360p', '480p', '720p', '1080p'].filter(quality => {
                const qualityPlaylist = path.join(adaptiveDir, quality, 'playlist.m3u8');
                return fs.existsSync(qualityPlaylist);
            });
            
            return {
                status: 'active',
                hlsUrl: `/stream/${channelId}/master.m3u8`,
                qualities: qualities
            };
        }
        
        // Проверяем legacy HLS
        const legacyPlaylist = path.join(HLS_DIR, `camera_${channelId}.m3u8`);
        if (fs.existsSync(legacyPlaylist)) {
            return {
                status: 'active',
                hlsUrl: `/stream/${channelId}/playlist.m3u8`,
                qualities: ['legacy']
            };
        }
        
        return {
            status: 'inactive',
            hlsUrl: null,
            qualities: []
        };
    } catch (error) {
        return {
            status: 'error',
            hlsUrl: null,
            qualities: []
        };
    }
}

// Информация о конкретной камере
app.get('/api/camera/:cameraId', verifyToken, checkCameraAccess, async (req, res) => {
    const { cameraId } = req.params;
    
    try {
            where: { channelId: parseInt(cameraId) }
        });
        
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }
        
        const cameraStatus = getCameraHLSStatus(camera.channelId);
        
        res.json({
            id: camera.id,
            channelId: camera.channelId,
            name: camera.name,
            rtspUrl: camera.rtspUrl,
            isActive: camera.isActive,
            status: cameraStatus.status,
            hlsUrl: cameraStatus.hlsUrl,
            qualities: cameraStatus.qualities,
            createdAt: camera.createdAt
        });
    } catch (error) {
        console.error(`Error getting camera ${cameraId}:`, error);
        res.status(500).json({ error: 'Failed to get camera info' });
    }
});

// Обновление информации о камере
app.put('/api/cameras/:cameraId', verifyApiKey, async (req, res) => {
    const { cameraId } = req.params;
    const { name, isActive } = req.body;
    
    try {
            where: { channelId: parseInt(cameraId) },
            data: {
                ...(name && { name }),
                ...(typeof isActive === 'boolean' && { isActive })
            }
        });
        
        res.json({ 
            success: true,
            camera: {
                id: updatedCamera.id,
                channelId: updatedCamera.channelId,
                name: updatedCamera.name,
                isActive: updatedCamera.isActive
            }
        });
    } catch (error) {
        console.error('Error updating camera:', error);
        res.status(500).json({ error: 'Failed to update camera' });
    }
});

// ===============================
// HLS СТРИМИНГ
// ===============================

// HLS плейлист (адаптивный и legacy)
app.get('/stream/:cameraId/playlist.m3u8', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const quality = req.query.quality;
    
    let playlistPath;
    
    // СНАЧАЛА проверяем legacy формат
    const legacyPath = path.join(HLS_DIR, `camera_${cameraId}.m3u8`);
    
    if (fs.existsSync(legacyPath)) {
        playlistPath = legacyPath;
    } else if (quality && ['360p', '480p', '720p', '1080p'].includes(quality)) {
        // Адаптивное качество
        playlistPath = path.join(HLS_DIR, `camera_${cameraId}`, quality, 'playlist.m3u8');
    } else {
        // Адаптивный master плейлист
        const adaptivePath = path.join(HLS_DIR, `camera_${cameraId}`, 'master.m3u8');
        if (fs.existsSync(adaptivePath)) {
            playlistPath = adaptivePath;
        }
    }
    
    if (!playlistPath || !fs.existsSync(playlistPath)) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(playlistPath);
});

// Master плейлист для адаптивного HLS
app.get('/stream/:cameraId/master.m3u8', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const masterPath = path.join(HLS_DIR, `camera_${cameraId}`, 'master.m3u8');
    
    if (!fs.existsSync(masterPath)) {
        return res.status(404).json({ error: 'Adaptive stream not found' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(masterPath);
});

// Адаптивные HLS сегменты (camera_X/720p/segment_001.ts)
app.get('/stream/:cameraId/:quality/:segment', verifySegmentToken, checkCameraAccess, (req, res) => {
    const { cameraId, quality, segment } = req.params;
    
    if (!['360p', '480p', '720p', '1080p'].includes(quality)) {
        return res.status(400).json({ error: 'Invalid quality' });
    }
    
    if (!segment.endsWith('.ts')) {
        return res.status(400).json({ error: 'Invalid segment' });
    }
    
    const segmentPath = path.join(HLS_DIR, `camera_${cameraId}`, quality, segment);
    
    if (!fs.existsSync(segmentPath)) {
        return res.status(404).json({ error: 'Segment not found' });
    }
    
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(segmentPath);
});

// Legacy HLS сегменты (camera_X_XXXX.ts)
app.get('/stream/:cameraId/:segment', verifySegmentToken, checkCameraAccess, (req, res) => {
    const { cameraId, segment } = req.params;
    
    if (!segment.endsWith('.ts')) {
        return res.status(400).json({ error: 'Invalid segment' });
    }
    
    // Проверяем что сегмент принадлежит этой камере
    if (!segment.startsWith(`camera_${cameraId}_`)) {
        return res.status(400).json({ error: 'Segment does not belong to this camera' });
    }
    
    const filePath = path.join(HLS_DIR, segment);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Segment not found' });
    }
    
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(filePath);
});

// ===============================
// ЗАПИСЬ ВИДЕО
// ===============================

// Начать запись
app.post('/api/camera/:cameraId/start-recording', verifyToken, checkCameraAccess, async (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    if (activeRecordings.has(recordingKey)) {
        return res.status(400).json({ error: 'Recording already in progress' });
    }
    
    try {
        // Получаем камеру из БД
            where: { channelId: parseInt(cameraId) }
        });
        
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }
        
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `camera_${cameraId}_${timestamp}.mp4`;
        const outputPath = path.join(RECORDINGS_DIR, filename);
        
        const rtspUrl = camera.rtspUrl;
        
        const ffmpegArgs = [
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c:v', 'libx264',
            '-c:a', 'aac',
            '-preset', 'fast',
            '-f', 'mp4',
            outputPath
        ];
        
        const recordingProcess = spawn('ffmpeg', ffmpegArgs);
        const startTime = new Date();
        
        activeRecordings.set(recordingKey, {
            process: recordingProcess,
            filename: filename,
            cameraId: cameraId,
            startTime: startTime,
            outputPath: outputPath
        });
        
        recordingProcess.on('error', (error) => {
            console.error(`Recording error for camera ${cameraId}:`, error);
            activeRecordings.delete(recordingKey);
        });
        
        recordingProcess.on('exit', (code) => {
            console.log(`Recording ended for camera ${cameraId} with code ${code}`);
            activeRecordings.delete(recordingKey);
        });
        
        res.json({ 
            success: true, 
            message: 'Recording started',
            filename: filename,
            startTime: startTime
        });
    } catch (error) {
        console.error('Error starting recording:', error);
        res.status(500).json({ error: 'Failed to start recording' });
    }
});

// Остановить запись
app.post('/api/camera/:cameraId/stop-recording', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    const recording = activeRecordings.get(recordingKey);
    if (!recording) {
        return res.status(404).json({ error: 'No active recording found' });
    }
    
    try {
        recording.process.stdin.write('q');
        
        const duration = Date.now() - recording.startTime.getTime();
        
        res.json({ 
            success: true, 
            message: 'Recording stopped',
            filename: recording.filename,
            duration: Math.round(duration / 1000) // в секундах
        });
    } catch (error) {
        console.error('Error stopping recording:', error);
        res.status(500).json({ error: 'Failed to stop recording' });
    }
});

// Статус записи
app.get('/api/camera/:cameraId/recording-status', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    const recording = activeRecordings.get(recordingKey);
    
    if (!recording) {
        return res.json({
            isRecording: false,
            filename: null,
            startTime: null,
            duration: 0
        });
    }
    
    const duration = Date.now() - recording.startTime.getTime();
    
    res.json({
        isRecording: true,
        filename: recording.filename,
        startTime: recording.startTime,
        duration: Math.round(duration / 1000) // в секундах
    });
});

// ===============================
// СИСТЕМНАЯ ИНФОРМАЦИЯ
// ===============================

// Статус системы
app.get('/status', async (req, res) => {
    try {
        // Проверяем БД
            (SELECT COUNT(*) FROM cameras) as cameras,
            (SELECT COUNT(*) FROM users) as users,
            (SELECT COUNT(*) FROM user_camera_permissions) as permissions`;
        
        // Проверяем HLS файлы
        const hlsStats = {
            hls_accessible: fs.existsSync(HLS_DIR),
            recordings_accessible: fs.existsSync(RECORDINGS_DIR)
        };
        
        if (hlsStats.hls_accessible) {
            const files = fs.readdirSync(HLS_DIR);
            hlsStats.legacy_cameras = files.filter(f => f.endsWith('.m3u8')).length;
            hlsStats.adaptive_cameras = files.filter(f => f.startsWith('camera_') && !f.includes('.')).length;
            hlsStats.total_segments = files.filter(f => f.endsWith('.ts')).length;
        }
        
        if (hlsStats.recordings_accessible) {
            const recordings = fs.readdirSync(RECORDINGS_DIR);
            hlsStats.total_recordings = recordings.filter(f => f.endsWith('.mp4')).length;
        }
        
        res.json({ 
            status: 'ok', 
            service: 'askr-camera-system',
            version: '3.0.0-database',
            timestamp: new Date().toISOString(),
            hls_directory: HLS_DIR,
            recordings_directory: RECORDINGS_DIR,
            active_recordings: activeRecordings.size,
            jwt_secret_configured: !!JWT_SECRET,
            database: {
                connected: true,
                cameras: Number(dbStats[0].cameras),
                users: Number(dbStats[0].users),
                permissions: Number(dbStats[0].permissions)
            },
            ...hlsStats
        });
    } catch (error) {
        console.error('Status error:', error);
        res.status(500).json({
            status: 'error',
            service: 'askr-camera-system', 
            timestamp: new Date().toISOString(),
            error: error.message,
            database: {
                connected: false,
                error: error.message
            }
        });
    }
});

// ===============================
// ОБРАБОТКА ОШИБОК И ЗАВЕРШЕНИЕ
// ===============================

// 404 для всех остальных маршрутов
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Not found',
        path: req.originalUrl,
        method: req.method
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Завершение работы системы...');
    
    // Останавливаем все записи
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.stdin.write('q');
    }
    
    // Закрываем подключение к БД
    
    setTimeout(() => process.exit(0), 5000);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Получен SIGTERM, завершаем все записи...');
    
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.stdin.write('q');
    }
    
    setTimeout(() => process.exit(0), 5000);
});

// Запуск сервера
app.listen(PORT, async () => {
    try {
        // Проверяем подключение к БД
        
        console.log(`🚀 ASKR Camera System v3.0 (Database) running on port ${PORT}`);
        console.log(`📁 HLS files: ${HLS_DIR}`);
        console.log(`🎬 Recordings: ${RECORDINGS_DIR}`);
        console.log(`🗄️ Database: Connected via Prisma`);
        console.log(`🔑 JWT Secret: ${JWT_SECRET ? 'Configured' : 'Missing'}`);
        console.log(`📊 Status: http://localhost:${PORT}/status`);
        console.log(`🔗 API endpoints:`);
        console.log(`   POST /auth/token - Login`);
        console.log(`   GET /api/cameras - Camera list`);
        console.log(`   GET /stream/:id/playlist.m3u8 - HLS playlist`);
        console.log(`   POST /api/camera/:id/start-recording - Start recording`);
    } catch (error) {
        console.error('❌ Failed to connect to database:', error);
        process.exit(1);
    }
});

module.exports = app;
