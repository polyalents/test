require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const bcrypt = require('bcryptjs');

const app = express();
const prisma = new PrismaClient();

// Конфигурация из переменных окружения с fallback значениями
const PORT = process.env.BACKEND_PORT || 8080;
const JWT_SECRET = process.env.JWT_SECRET || 'askr-secret-key-2025';
const HLS_DIR = process.env.HLS_DIR || '/opt/rtsp-hls/output';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/opt/rtsp-hls/recordings';
const RTSP_BASE_IP = process.env.RTSP_BASE_IP || '192.168.4.200';
const RTSP_PORT = process.env.RTSP_PORT || '62342';
const RTSP_USER = process.env.RTSP_USER || 'admin';
const RTSP_PASS = process.env.RTSP_PASS || 'admin123';

// API ключ для интеграции между сервисами
const VALID_API_KEYS = [
    process.env.API_ACCESS_KEY || 'askr-api-key-2025'
];

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
    
    if (!apiKey || !VALID_API_KEYS.includes(apiKey)) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    next();
};

// Проверка доступа к камере
const checkCameraAccess = async (req, res, next) => {
    const cameraId = parseInt(req.params.cameraId);
    
    try {
        if (req.user.role === 'ADMIN') {
            return next();
        }
        
        // Проверяем права доступа через Prisma
        const permission = await prisma.userCameraPermission.findFirst({
            where: {
                userId: req.user.userId,
                camera: {
                    channelId: cameraId
                },
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
        res.status(500).json({ error: 'Failed to check camera access' });
    }
};

// Проверка токена для сегментов
const verifySegmentToken = (req, res, next) => {
    const token = req.query.token;
    
    if (!token) {
        return res.status(401).json({ error: 'Token required for stream access' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        
        // Дополнительно проверяем тип токена
        if (decoded.type !== 'stream') {
            return res.status(403).json({ error: 'Invalid token type for streaming' });
        }
        
        next();
    } catch (error) {
        return res.status(401).json({ error: 'Invalid stream token' });
    }
};

// ===============================
// ОСНОВНЫЕ ЭНДПОИНТЫ
// ===============================

// Статус сервера
app.get('/status', (req, res) => {
    res.json({
        status: 'running',
        timestamp: new Date().toISOString(),
        hls_dir: HLS_DIR,
        recordings_dir: RECORDINGS_DIR,
        active_recordings: activeRecordings.size
    });
});

// ===============================
// АУТЕНТИФИКАЦИЯ ЧЕРЕЗ PRISMA
// ===============================

// Получение токена
app.post('/auth/token', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || password === undefined) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    try {
        // Для совместимости с существующей системой, проверяем хардкод пароли
        const hardcodedUsers = {
            'admin': 'admin123',
            'operator': 'op123', 
            'user1': 'user123',
            'user2': 'user456',
            'user3': 'user789',
            'user4': 'user999'
        };
        
        // Проверяем хардкод пароль ИЛИ ищем в БД
        let user = null;
        let isValidPassword = false;
        
        if (hardcodedUsers[username] && hardcodedUsers[username] === password) {
            // Находим пользователя в БД
            user = await prisma.user.findUnique({
                where: { username },
                include: {
                    permissions: {
                        include: {
                            camera: true
                        }
                    }
                }
            });
            isValidPassword = true;
        }
        
        if (!user || !isValidPassword) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        
        // Получаем список камер для пользователя
        const userCameras = user.permissions.map(p => p.camera.channelId);
        
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
// УПРАВЛЕНИЕ КАМЕРАМИ ЧЕРЕЗ PRISMA
// ===============================

// Список доступных камер
app.get('/api/cameras', verifyToken, async (req, res) => {
    try {
        let cameraQuery = {};
        
        // Если не админ, ограничиваем доступ
        if (req.user.role !== 'ADMIN') {
            cameraQuery = {
                permissions: {
                    some: {
                        userId: req.user.userId,
                        canView: true
                    }
                }
            };
        }
        
        const cameras = await prisma.camera.findMany({
            where: cameraQuery,
            orderBy: { position: 'asc' }
        });
        
        // Проверяем статус HLS стримов
        const camerasWithStatus = cameras.map(camera => {
            let hasStream = false;
            
            if (fs.existsSync(HLS_DIR)) {
                const playlistPath = path.join(HLS_DIR, `camera_${camera.channelId}`, 'playlist.m3u8');
                hasStream = fs.existsSync(playlistPath);
            }
            
            return {
                id: camera.id,
                channelId: camera.channelId,
                name: camera.name,
                position: camera.position,
                isActive: camera.isActive,
                status: hasStream ? 'ONLINE' : 'OFFLINE',
                rtspUrl: camera.rtspUrl,
                hasStream
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

// Генерация токена для доступа к стриму
app.post('/api/stream/token', verifyApiKey, async (req, res) => {
    const { userId, cameraId } = req.body;
    
    if (!userId || !cameraId) {
        return res.status(400).json({ error: 'userId and cameraId required' });
    }
    
    try {
        // Находим пользователя
        const user = await prisma.user.findUnique({
            where: { id: parseInt(userId) },
            include: {
                permissions: {
                    include: {
                        camera: true
                    }
                }
            }
        });
        
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Находим камеру
        const camera = await prisma.camera.findUnique({
            where: { id: parseInt(cameraId) }
        });
        
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }
        
        // Проверяем права доступа
        const hasAccess = user.role === 'ADMIN' || 
            user.permissions.some(p => p.camera.channelId === camera.channelId && p.canView);
        
        if (!hasAccess) {
            return res.status(403).json({ error: 'Access denied to this camera' });
        }
        
        // Получаем список камер для пользователя
        const userCameras = user.permissions.map(p => p.camera.channelId);
        
        // Генерируем токен
        const streamToken = jwt.sign(
            { 
                userId: user.id,
                username: user.username,
                role: user.role,
                cameraId: camera.id,
                channelId: camera.channelId,
                type: 'stream',
                cameras: userCameras
            },
            JWT_SECRET,
            { expiresIn: '3600s' } // 1 час
        );
        
        res.json({ 
            success: true,
            token: streamToken,
            expiresIn: 3600,
            camera: {
                id: camera.id,
                channelId: camera.channelId,
                name: camera.name
            }
        });
    } catch (error) {
        console.error('Error generating stream token:', error);
        res.status(500).json({ error: 'Failed to generate stream token' });
    }
});

// ===============================
// HLS STREAMING
// ===============================

// Плейлист .m3u8
app.get('/stream/:cameraId/playlist.m3u8', verifySegmentToken, (req, res) => {
    const { cameraId } = req.params;
    
    const playlistPath = path.join(HLS_DIR, `camera_${cameraId}`, 'playlist.m3u8');
    
    if (!fs.existsSync(playlistPath)) {
        return res.status(404).json({ error: 'Stream not found' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(playlistPath);
});

// Видео сегменты .ts
app.get('/stream/:cameraId/:segment', verifySegmentToken, (req, res) => {
    const { cameraId, segment } = req.params;
    
    const segmentPath = path.join(HLS_DIR, `camera_${cameraId}`, segment);
    
    if (!fs.existsSync(segmentPath)) {
        return res.status(404).json({ error: 'Segment not found' });
    }
    
    res.setHeader('Content-Type', 'video/MP2T');
    res.setHeader('Cache-Control', 'max-age=10');
    res.sendFile(segmentPath);
});

// ===============================
// ЗАПИСЬ ВИДЕО
// ===============================

// Начать запись
app.post('/api/camera/:cameraId/start-recording', verifyToken, checkCameraAccess, async (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    if (activeRecordings.has(recordingKey)) {
        return res.status(400).json({ error: 'Recording already in progress for this camera' });
    }
    
    try {
        // Находим камеру в БД
        const camera = await prisma.camera.findFirst({
            where: { channelId: parseInt(cameraId) }
        });
        
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }
        
        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `camera_${cameraId}_${timestamp}.mp4`;
        const outputPath = path.join(RECORDINGS_DIR, filename);
        
        const rtspUrl = camera.rtspUrl || 
            `rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_BASE_IP}:${RTSP_PORT}/chID=${cameraId}`;
        
        console.log(`Starting recording for camera ${cameraId}: ${filename}`);
        
        const ffmpegArgs = [
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c:v', 'libx264',
            '-preset', 'fast',
            '-crf', '23',
            '-c:a', 'aac',
            '-f', 'mp4',
            '-y',
            outputPath
        ];
        
        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
        
        // Создаем запись в БД
        const recording = await prisma.recording.create({
            data: {
                cameraId: camera.id,
                filename: filename,
                startedBy: req.user.username,
                startedAt: new Date()
            }
        });
        
        activeRecordings.set(recordingKey, {
            process: ffmpegProcess,
            filename: filename,
            startTime: new Date(),
            outputPath: outputPath,
            cameraId: cameraId,
            recordingId: recording.id
        });
        
        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`FFmpeg camera ${cameraId}: ${data.toString()}`);
        });
        
        ffmpegProcess.on('close', async (code) => {
            console.log(`Recording for camera ${cameraId} ended with code ${code}`);
            
            const recordingData = activeRecordings.get(recordingKey);
            if (recordingData) {
                // Обновляем запись в БД
                try {
                    const stats = fs.statSync(outputPath);
                    const duration = Math.floor((new Date() - recordingData.startTime) / 1000);
                    
                    await prisma.recording.update({
                        where: { id: recordingData.recordingId },
                        data: {
                            endedAt: new Date(),
                            duration: duration,
                            fileSize: BigInt(stats.size)
                        }
                    });
                } catch (error) {
                    console.error('Error updating recording in DB:', error);
                }
                
                activeRecordings.delete(recordingKey);
            }
        });
        
        ffmpegProcess.on('error', (error) => {
            console.error(`FFmpeg error for camera ${cameraId}:`, error);
            activeRecordings.delete(recordingKey);
        });
        
        res.json({
            success: true,
            message: 'Recording started',
            filename: filename,
            camera: cameraId,
            startTime: new Date().toISOString(),
            recordingId: recording.id
        });
        
    } catch (error) {
        console.error(`Error starting recording for camera ${cameraId}:`, error);
        res.status(500).json({ error: 'Failed to start recording' });
    }
});

// Остановить запись
app.post('/api/camera/:cameraId/stop-recording', verifyToken, checkCameraAccess, async (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    const recording = activeRecordings.get(recordingKey);
    if (!recording) {
        return res.status(400).json({ error: 'No active recording for this camera' });
    }
    
    try {
        console.log(`Stopping recording for camera ${cameraId}: ${recording.filename}`);
        
        recording.process.stdin.write('q');
        
        setTimeout(() => {
            if (!recording.process.killed) {
                recording.process.kill('SIGTERM');
            }
        }, 5000);
        
        const endTime = new Date();
        const duration = Math.floor((endTime - recording.startTime) / 1000);
        
        res.json({
            success: true,
            message: 'Recording stopped',
            filename: recording.filename,
            camera: cameraId,
            duration: duration,
            downloadUrl: `/api/recordings/${recording.filename}`
        });
        
    } catch (error) {
        console.error(`Error stopping recording for camera ${cameraId}:`, error);
        res.status(500).json({ error: 'Failed to stop recording' });
    }
});

// Статус записи
app.get('/api/camera/:cameraId/recording-status', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    const recording = activeRecordings.get(recordingKey);
    
    res.json({
        success: true,
        isRecording: !!recording,
        recording: recording ? {
            filename: recording.filename,
            startTime: recording.startTime,
            duration: Math.floor((new Date() - recording.startTime) / 1000)
        } : null
    });
});

// Список записей
app.get('/api/recordings', verifyToken, async (req, res) => {
    try {
        let recordingQuery = {};
        
        // Если не админ, ограничиваем доступ
        if (req.user.role !== 'ADMIN') {
            recordingQuery = {
                camera: {
                    permissions: {
                        some: {
                            userId: req.user.userId,
                            canView: true
                        }
                    }
                }
            };
        }
        
        const recordings = await prisma.recording.findMany({
            where: recordingQuery,
            include: {
                camera: true
            },
            orderBy: { startedAt: 'desc' }
        });
        
        res.json({
            success: true,
            recordings: recordings.map(r => ({
                id: r.id,
                filename: r.filename,
                camera: {
                    id: r.camera.id,
                    channelId: r.camera.channelId,
                    name: r.camera.name
                },
                duration: r.duration,
                fileSize: r.fileSize.toString(),
                startedBy: r.startedBy,
                startedAt: r.startedAt,
                endedAt: r.endedAt,
                downloadUrl: `/api/recordings/${r.filename}`
            }))
        });
    } catch (error) {
        console.error('Error fetching recordings:', error);
        res.status(500).json({ error: 'Failed to fetch recordings' });
    }
});

// Скачивание записи
app.get('/api/recordings/:filename', verifyToken, async (req, res) => {
    const { filename } = req.params;
    
    try {
        // Проверяем доступ к записи
        const recording = await prisma.recording.findUnique({
            where: { filename },
            include: { camera: true }
        });
        
        if (!recording) {
            return res.status(404).json({ error: 'Recording not found' });
        }
        
        // Проверяем права доступа
        if (req.user.role !== 'ADMIN') {
            const hasAccess = req.user.cameras.includes(recording.camera.channelId);
            if (!hasAccess) {
                return res.status(403).json({ error: 'Access denied to this recording' });
            }
        }
        
        const filePath = path.join(RECORDINGS_DIR, filename);
        
        if (!fs.existsSync(filePath)) {
            return res.status(404).json({ error: 'Recording file not found on disk' });
        }
        
        res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
        res.setHeader('Content-Type', 'video/mp4');
        res.sendFile(filePath);
        
    } catch (error) {
        console.error('Error downloading recording:', error);
        res.status(500).json({ error: 'Failed to download recording' });
    }
});

// ===============================
// УПРАВЛЕНИЕ КАМЕРАМИ
// ===============================

// Обновление информации о камере
app.put('/api/cameras/:cameraId', verifyApiKey, async (req, res) => {
    const { cameraId } = req.params;
    const { name, position } = req.body;
    
    try {
        const camera = await prisma.camera.update({
            where: { channelId: parseInt(cameraId) },
            data: {
                ...(name && { name }),
                ...(position && { position: parseInt(position) })
            }
        });
        
        res.json({ 
            success: true,
            camera: {
                id: camera.id,
                channelId: camera.channelId,
                name: camera.name,
                position: camera.position
            }
        });
    } catch (error) {
        console.error('Error updating camera:', error);
        res.status(500).json({ error: 'Failed to update camera' });
    }
});

// ===============================
// ЗАПУСК СЕРВЕРА
// ===============================

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('Shutting down gracefully...');
    
    // Останавливаем все активные записи
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.kill('SIGTERM');
    }
    
    await prisma.$disconnect();
    process.exit(0);
});

app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ASKR Camera System running on port ${PORT}`);
    console.log(`📹 HLS Directory: ${HLS_DIR}`);
    console.log(`📼 Recordings Directory: ${RECORDINGS_DIR}`);
    console.log(`🎯 RTSP Base: ${RTSP_BASE_IP}:${RTSP_PORT}`);
    console.log(`🔐 JWT Secret: ${JWT_SECRET.substring(0, 10)}...`);
});