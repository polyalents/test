require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');

const app = express();

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
    process.env.API_KEY || 'askr-api-key-2025'
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

// База данных пользователей (упрощенная, в памяти)
const USERS_DB = {
    'admin': {
        id: 1,
        username: 'admin',
        password: 'admin123',
        role: 'admin',
        cameras: Array.from({length: 24}, (_, i) => i + 1) // доступ ко всем камерам
    },
    'operator': {
        id: 2,
        username: 'operator',
        password: 'op123',
        role: 'operator',
        cameras: Array.from({length: 24}, (_, i) => i + 1) // доступ ко всем камерам
    },
    'user1': {
        id: 3,
        username: 'user1',
        password: 'user123',
        role: 'user',
        cameras: [1, 2, 3, 4, 5, 6] // первые 6 камер
    },
    'user2': {
        id: 4,
        username: 'user2',
        password: 'user456',
        role: 'user',
        cameras: [7, 8, 9, 10, 11, 12] // следующие 6 камер
    },
    'user3': {
        id: 5,
        username: 'user3',
        password: 'user789',
        role: 'user',
        cameras: [13, 14, 15, 16, 17, 18] // следующие 6 камер
    },
    'user4': {
        id: 6,
        username: 'user4',
        password: 'user999',
        role: 'user',
        cameras: [19, 20, 21, 22, 23, 24] // последние 6 камер
    }
};

// База данных камер (упрощенная)
const CAMERAS_DB = Array.from({length: 24}, (_, i) => ({
    id: i + 1,
    channelId: i + 1,
    name: `Камера ${i + 1}`,
    position: i + 1,
    isActive: true,
    rtspUrl: `rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_BASE_IP}:${RTSP_PORT}/chID=${i + 1}1`
}));

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
const checkCameraAccess = (req, res, next) => {
    const cameraId = parseInt(req.params.cameraId);
    const userCameras = req.user.cameras || [];
    
    if (req.user.role === 'admin') {
        return next();
    }
    
    if (!userCameras.includes(cameraId)) {
        return res.status(403).json({ 
            error: 'Access denied to this camera',
            camera: cameraId,
            allowed_cameras: userCameras
        });
    }
    
    next();
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
        if (decoded.role === 'admin') {
            req.user = decoded;
            return next();
        }
        
        // Проверяем доступ к конкретной камере
        if (decoded.cameras && decoded.cameras.includes(cameraId)) {
            req.user = decoded;
            return next();
        }
        
        // Токены для конкретного стрима
        if (decoded.type === 'stream' && decoded.channelId === cameraId) {
            req.user = decoded;
            return next();
        }
        
        return res.status(403).json({ error: 'Segment access denied: insufficient permissions' });
        
    } catch (error) {
        return res.status(401).json({ error: 'Segment access denied: invalid token' });
    }
};

// ===============================
// API ENDPOINTS ДЛЯ ИНТЕГРАЦИИ
// ===============================

// Список камер для основного API
app.get('/api/cameras/list', verifyApiKey, (req, res) => {
    try {
        const camerasWithStatus = CAMERAS_DB.map(camera => {
            // Проверяем статус камеры по наличию HLS файлов
            const hlsFile = path.join(HLS_DIR, `camera_${camera.channelId}.m3u8`);
            const adaptiveDir = path.join(HLS_DIR, `camera_${camera.channelId}`);
            const masterPlaylist = path.join(adaptiveDir, 'master.m3u8');
            
            let status = 'offline';
            let adaptiveHls = false;
            
            if (fs.existsSync(masterPlaylist)) {
                status = 'online';
                adaptiveHls = true;
            } else if (fs.existsSync(hlsFile)) {
                status = 'online';
            }
            
            return {
                id: camera.id,
                channelId: camera.channelId,
                name: camera.name,
                position: camera.position,
                status: status,
                isActive: camera.isActive,
                adaptiveHls: adaptiveHls
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
app.post('/api/stream/token', verifyApiKey, (req, res) => {
    const { userId, cameraId } = req.body;
    
    if (!userId || !cameraId) {
        return res.status(400).json({ error: 'userId and cameraId required' });
    }
    
    try {
        // Находим пользователя
        const user = Object.values(USERS_DB).find(u => u.id === parseInt(userId));
        if (!user) {
            return res.status(404).json({ error: 'User not found' });
        }
        
        // Находим камеру
        const camera = CAMERAS_DB.find(c => c.id === parseInt(cameraId));
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }
        
        // Проверяем права доступа
        const hasAccess = user.role === 'admin' || user.cameras.includes(camera.channelId);
        if (!hasAccess) {
            return res.status(403).json({ error: 'Access denied to this camera' });
        }
        
        // Генерируем токен
        const streamToken = jwt.sign(
            { 
                userId: user.id,
                username: user.username,
                role: user.role,
                cameraId: camera.id,
                channelId: camera.channelId,
                type: 'stream',
                cameras: user.cameras
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

// Обновление информации о камере
app.put('/api/cameras/:cameraId', verifyApiKey, (req, res) => {
    const { cameraId } = req.params;
    const { name, position } = req.body;
    
    try {
        const camera = CAMERAS_DB.find(c => c.id === parseInt(cameraId));
        if (!camera) {
            return res.status(404).json({ error: 'Camera not found' });
        }
        
        if (name) camera.name = name;
        if (position) camera.position = parseInt(position);
        
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
// АУТЕНТИФИКАЦИЯ
// ===============================

// Получение токена
app.post('/auth/token', (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    const user = USERS_DB[username];
    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    const token = jwt.sign(
        { 
            userId: user.id,
            username: user.username, 
            role: user.role,
            cameras: user.cameras
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
            cameras: user.cameras 
        } 
    });
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
app.get('/api/cameras', verifyToken, (req, res) => {
    try {
        let availableCameras = [];
        
        // Проверяем существует ли HLS_DIR
        if (fs.existsSync(HLS_DIR)) {
            const files = fs.readdirSync(HLS_DIR);
            
            // Проверяем adaptive HLS камеры
            const adaptiveDirs = files.filter(f => f.startsWith('camera_') && 
                fs.statSync(path.join(HLS_DIR, f)).isDirectory());
            
            adaptiveDirs.forEach(dir => {
                const match = dir.match(/camera_(\d+)/);
                if (match) {
                    const cameraId = parseInt(match[1]);
                    const masterPlaylist = path.join(HLS_DIR, dir, 'master.m3u8');
                    if (fs.existsSync(masterPlaylist)) {
                        // Проверяем что файл не пустой и обновлен в последние 5 минут
                        const stats = fs.statSync(masterPlaylist);
                        const isRecent = (Date.now() - stats.mtime.getTime()) < 300000; // 5 минут
                        if (stats.size > 0 && isRecent) {
                            availableCameras.push(cameraId);
                        } else {
                            console.log(`Camera ${cameraId}: outdated (${Math.round((Date.now() - stats.mtime.getTime()) / 1000)}s old) or empty (${stats.size}b)`);
                        }
                    }
                }
            });
            
            // Проверяем legacy HLS камеры
            const legacyFiles = files.filter(file => file.endsWith('.m3u8'));
            legacyFiles.forEach(file => {
                const match = file.match(/camera_(\d+)\.m3u8/);
                if (match) {
                    const cameraId = parseInt(match[1]);
                    if (!availableCameras.includes(cameraId)) {
                        // Проверяем что файл свежий (5 минут)
                        const filePath = path.join(HLS_DIR, file);
                        const stats = fs.statSync(filePath);
                        const isRecent = (Date.now() - stats.mtime.getTime()) < 300000; // 5 минут
                        if (stats.size > 0 && isRecent) {
                            availableCameras.push(cameraId);
                        } else {
                            console.log(`Camera ${cameraId} (legacy): outdated (${Math.round((Date.now() - stats.mtime.getTime()) / 1000)}s old) or empty (${stats.size}b)`);
                        }
                    }
                }
            });
        }
        
        // ВРЕМЕННО: если нет активных камер, проверим что файлы вообще есть
        if (availableCameras.length === 0) {
            console.log('No active cameras found. HLS files may not exist or are not recent.');
            console.log('HLS_DIR:', HLS_DIR);
            console.log('Directory contents:', files.length > 0 ? files.slice(0, 10) : 'empty');
            
            // Проверим все .m3u8 файлы для диагностики
            const allM3u8 = files.filter(f => f.endsWith('.m3u8'));
            allM3u8.forEach(file => {
                const filePath = path.join(HLS_DIR, file);
                const stats = fs.statSync(filePath);
                const ageSeconds = Math.round((Date.now() - stats.mtime.getTime()) / 1000);
                console.log(`  ${file}: ${stats.size}b, ${ageSeconds}s old`);
            });
        } else {
            console.log(`Found ${availableCameras.length} active cameras:`, availableCameras);
        }
        
        // Формируем информацию о камерах с названиями
        const camerasInfo = CAMERAS_DB
            .filter(camera => req.user.role === 'admin' || req.user.cameras.includes(camera.channelId))
            .map(camera => ({
                id: camera.channelId,
                name: camera.name,
                position: camera.position,
                status: availableCameras.includes(camera.channelId) ? 'online' : 'offline'
            }));
        
        const userCameraIds = req.user.cameras || [];
        const allowedCameras = req.user.role === 'admin' ? 
            availableCameras : 
            availableCameras.filter(id => userCameraIds.includes(id));
        
        res.json({ 
            cameras: allowedCameras.sort(),
            available: availableCameras.sort(),
            camerasInfo: camerasInfo,
            user_permissions: req.user.cameras,
            role: req.user.role,
            debug: {
                hls_dir_exists: fs.existsSync(HLS_DIR),
                total_cameras_found: availableCameras.length
            }
        });
    } catch (error) {
        console.error('Error listing cameras:', error);
        res.status(500).json({ error: 'Failed to list cameras' });
    }
});

// Информация о камере
app.get('/api/camera/:cameraId/info', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    
    // Проверяем adaptive HLS
    const adaptiveDir = path.join(HLS_DIR, `camera_${cameraId}`);
    const masterPlaylist = path.join(adaptiveDir, 'master.m3u8');
    
    // Проверяем legacy HLS
    const legacyPlaylist = path.join(HLS_DIR, `camera_${cameraId}.m3u8`);
    
    try {
        let cameraInfo = {
            camera_id: parseInt(cameraId),
            status: 'offline',
            adaptive_hls: false,
            legacy_hls: false
        };
        
        if (fs.existsSync(masterPlaylist)) {
            const stats = fs.statSync(masterPlaylist);
            const qualitiesAvailable = [];
            
            // Проверяем доступные качества
            for (const quality of ['360p', '480p', '720p', '1080p']) {
                const qualityPlaylist = path.join(adaptiveDir, quality, 'playlist.m3u8');
                if (fs.existsSync(qualityPlaylist)) {
                    qualitiesAvailable.push(quality);
                }
            }
            
            cameraInfo = {
                ...cameraInfo,
                status: 'online',
                adaptive_hls: true,
                last_updated: stats.mtime,
                qualities_available: qualitiesAvailable,
                playlist_url: `/stream/${cameraId}/playlist.m3u8`
            };
        } else if (fs.existsSync(legacyPlaylist)) {
            const stats = fs.statSync(legacyPlaylist);
            
            cameraInfo = {
                ...cameraInfo,
                status: 'online',
                legacy_hls: true,
                last_updated: stats.mtime,
                playlist_url: `/stream/${cameraId}/playlist.m3u8`
            };
        } else {
            return res.status(404).json({ error: 'Camera not found or offline' });
        }
        
        res.json(cameraInfo);
    } catch (error) {
        console.error(`Error getting camera ${cameraId} info:`, error);
        res.status(500).json({ error: 'Failed to get camera info' });
    }
});

// ДОБАВЛЯЮ ОТСУТСТВУЮЩИЙ ENDPOINT - Информация о доступных качествах
app.get('/api/camera/:cameraId/qualities', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    
    try {
        const qualities = [];
        
        // СНАЧАЛА проверяем есть ли adaptive HLS структура
        const cameraDir = path.join(HLS_DIR, `camera_${cameraId}`);
        
        for (const quality of ['360p', '480p', '720p', '1080p']) {
            const qualityDir = path.join(cameraDir, quality);
            const playlistPath = path.join(qualityDir, 'playlist.m3u8');
            
            if (fs.existsSync(playlistPath)) {
                qualities.push({
                    quality,
                    resolution: getResolutionForQuality(quality),
                    bitrate: getBitrateForQuality(quality),
                    available: true
                });
            }
        }
        
        // Проверяем наличие legacy формата
        const legacyPlaylist = path.join(HLS_DIR, `camera_${cameraId}.m3u8`);
        const hasLegacy = fs.existsSync(legacyPlaylist);
        
        // Если adaptive качеств нет, но есть legacy - возвращаем одно "качество"
        if (qualities.length === 0 && hasLegacy) {
            console.log(`Camera ${cameraId}: using legacy HLS (single quality)`);
            qualities.push({
                quality: 'auto',
                resolution: 'auto',
                bitrate: 'auto',
                available: true,
                legacy: true
            });
        }
        
        res.json({
            cameraId: parseInt(cameraId),
            adaptiveSupported: qualities.length > 1,
            legacySupported: hasLegacy,
            qualities,
            totalQualities: qualities.length,
            format: hasLegacy && qualities.length <= 1 ? 'legacy' : 'adaptive'
        });
        
    } catch (error) {
        console.error('Error getting qualities:', error);
        res.status(500).json({ error: 'Failed to get qualities' });
    }
});

// Вспомогательные функции для qualities endpoint
function getResolutionForQuality(quality) {
    const resolutions = {
        '360p': '640x360',
        '480p': '854x480', 
        '720p': '1280x720',
        '1080p': '1920x1080'
    };
    return resolutions[quality] || 'unknown';
}

function getBitrateForQuality(quality) {
    const bitrates = {
        '360p': 800,
        '480p': 1400,
        '720p': 2800, 
        '1080p': 5000
    };
    return bitrates[quality] || 0;
}

// ===============================
// HLS СТРИМИНГ
// ===============================

// HLS плейлист (адаптивный и legacy)
app.get('/stream/:cameraId/playlist.m3u8', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const quality = req.query.quality;
    
    let playlistPath;
    
    // СНАЧАЛА проверяем legacy формат (у пользователя именно такой)
    const legacyPath = path.join(HLS_DIR, `camera_${cameraId}.m3u8`);
    
    if (fs.existsSync(legacyPath)) {
        playlistPath = legacyPath;
        console.log(`Using legacy HLS for camera ${cameraId}: ${legacyPath}`);
    } else if (quality && ['360p', '480p', '720p', '1080p'].includes(quality)) {
        // Адаптивное качество (если есть)
        playlistPath = path.join(HLS_DIR, `camera_${cameraId}`, quality, 'playlist.m3u8');
    } else {
        // Адаптивный master плейлист
        const adaptivePath = path.join(HLS_DIR, `camera_${cameraId}`, 'master.m3u8');
        if (fs.existsSync(adaptivePath)) {
            playlistPath = adaptivePath;
        }
    }
    
    if (!playlistPath || !fs.existsSync(playlistPath)) {
        console.log(`Stream not found for camera ${cameraId}. Checked paths:`, {
            legacy: legacyPath,
            exists: fs.existsSync(legacyPath)
        });
        return res.status(404).json({ error: 'Stream not available' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
        let content = fs.readFileSync(playlistPath, 'utf8');
        
        // Генерируем токен для сегментов
        const segmentToken = jwt.sign(
            {
                userId: req.user.userId,
                username: req.user.username,
                role: req.user.role,
                channelId: parseInt(cameraId),
                type: 'segment',
                cameras: req.user.cameras
            },
            JWT_SECRET,
            { expiresIn: '300s' } // 5 минут
        );
        
        // Добавляем токены к сегментам
        if (playlistPath.includes('master.m3u8')) {
            // Master плейлист - токенизируем ссылки на плейлисты качества
            content = content.replace(
                /(\d+p\/playlist\.m3u8)/g, 
                `$1?token=${segmentToken}`
            );
        } else if (quality) {
            // Конкретное качество - токенизируем .ts файлы
            content = content.replace(
                /(segment_\d{3}\.ts)/g, 
                `$1?token=${segmentToken}`
            );
        } else {
            // Legacy формат - токенизируем camera_X_XXXX.ts файлы
            content = content.replace(
                /(camera_\d+_\d+\.ts)/g, 
                `$1?token=${segmentToken}`
            );
        }
        
        console.log(`Playlist served: ${req.user.username} → camera ${cameraId} → ${playlistPath}`);
        res.send(content);
    } catch (error) {
        console.error(`Error reading playlist for camera ${cameraId}:`, error);
        res.status(500).json({ error: 'Failed to read playlist' });
    }
});

// ДОБАВЛЯЮ ОТДЕЛЬНЫЙ МАРШРУТ ДЛЯ ПЛЕЙЛИСТОВ КАЧЕСТВА (для adaptive HLS - у вас не используется)
app.get('/stream/:cameraId/:quality/playlist.m3u8', verifySegmentToken, (req, res) => {
    const { cameraId, quality } = req.params;
    
    console.log(`Adaptive quality playlist request: camera ${cameraId}, quality ${quality} (not supported in legacy mode)`);
    
    if (!['360p', '480p', '720p', '1080p'].includes(quality)) {
        return res.status(400).json({ error: 'Invalid quality parameter' });
    }
    
    const playlistPath = path.join(HLS_DIR, `camera_${cameraId}`, quality, 'playlist.m3u8');
    
    if (!fs.existsSync(playlistPath)) {
        // У вас legacy формат, поэтому адаптивные плейлисты недоступны
        return res.status(404).json({ 
            error: 'Adaptive quality not available',
            message: 'This camera uses legacy HLS format. Use /stream/' + cameraId + '/playlist.m3u8 instead'
        });
    }
    
    // Если все же есть adaptive структура
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Access-Control-Allow-Origin', '*');
    
    try {
        let content = fs.readFileSync(playlistPath, 'utf8');
        
        const segmentToken = jwt.sign(
            {
                userId: req.user.userId,
                username: req.user.username,
                role: req.user.role,
                channelId: parseInt(cameraId),
                type: 'segment',
                cameras: req.user.cameras
            },
            JWT_SECRET,
            { expiresIn: '300s' }
        );
        
        content = content.replace(
            /(segment_\d{3}\.ts)/g, 
            `$1?token=${segmentToken}`
        );
        
        console.log(`Quality playlist served: ${req.user.username} → camera ${cameraId} → ${quality}`);
        res.send(content);
    } catch (error) {
        console.error(`Error reading quality playlist for camera ${cameraId}:`, error);
        res.status(500).json({ error: 'Failed to read quality playlist' });
    }
});

// Adaptive HLS сегменты (для adaptive структуры - у вас не используется)
app.get('/stream/:cameraId/:quality/:segment', verifySegmentToken, (req, res) => {
    const { cameraId, quality, segment } = req.params;
    
    if (!['360p', '480p', '720p', '1080p'].includes(quality)) {
        return res.status(400).json({ error: 'Invalid quality' });
    }
    
    if (!segment.endsWith('.ts')) {
        return res.status(400).json({ error: 'Invalid segment' });
    }
    
    const segmentPath = path.join(HLS_DIR, `camera_${cameraId}`, quality, segment);
    
    if (!fs.existsSync(segmentPath)) {
        // У вас legacy формат, поэтому adaptive сегменты недоступны
        return res.status(404).json({ 
            error: 'Adaptive segments not available',
            message: 'This camera uses legacy HLS format. Segments are accessed directly by name'
        });
    }
    
    console.log(`Adaptive segment served: ${req.user.username} → camera ${cameraId} → ${quality} → ${segment}`);
    
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=300');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(segmentPath);
});

// Legacy HLS сегменты (ваш формат: camera_X_XXXX.ts)
app.get('/stream/:cameraId/:segment', verifySegmentToken, (req, res) => {
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
    
    console.log(`Legacy segment served: ${req.user.username} → camera ${cameraId} → ${segment}`);
    
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=60');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.sendFile(filePath);
});

// ===============================
// ЗАПИСЬ ВИДЕО
// ===============================

// Начать запись
app.post('/api/camera/:cameraId/start-recording', verifyToken, checkCameraAccess, (req, res) => {
    const { cameraId } = req.params;
    const recordingKey = `camera_${cameraId}`;
    
    if (activeRecordings.has(recordingKey)) {
        return res.status(400).json({ error: 'Recording already in progress' });
    }
    
    try {
        const timestamp = new Date().toISOString().slice(0, 19).replace(/:/g, '-');
        const filename = `camera_${cameraId}_${timestamp}.mp4`;
        const outputPath = path.join(RECORDINGS_DIR, filename);
        
        const camera = CAMERAS_DB.find(c => c.channelId === parseInt(cameraId));
        const rtspUrl = camera ? camera.rtspUrl : 
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
        
        activeRecordings.set(recordingKey, {
            process: ffmpegProcess,
            filename: filename,
            startTime: new Date(),
            outputPath: outputPath,
            cameraId: cameraId
        });
        
        ffmpegProcess.stderr.on('data', (data) => {
            console.log(`FFmpeg camera ${cameraId}: ${data.toString()}`);
        });
        
        ffmpegProcess.on('close', (code) => {
            console.log(`Recording for camera ${cameraId} ended with code ${code}`);
            activeRecordings.delete(recordingKey);
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
            startTime: new Date().toISOString()
        });
        
    } catch (error) {
        console.error(`Error starting recording for camera ${cameraId}:`, error);
        res.status(500).json({ error: 'Failed to start recording' });
    }
});

// Остановить запись
app.post('/api/camera/:cameraId/stop-recording', verifyToken, checkCameraAccess, (req, res) => {
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
        
        activeRecordings.delete(recordingKey);
        
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
    
    if (recording) {
        const duration = Math.floor((Date.now() - recording.startTime) / 1000);
        res.json({
            isRecording: true,
            filename: recording.filename,
            startTime: recording.startTime,
            duration: duration
        });
    } else {
        res.json({
            isRecording: false
        });
    }
});

// ===============================
// УПРАВЛЕНИЕ ЗАПИСЯМИ
// ===============================

// Список записей
app.get('/api/recordings', verifyToken, (req, res) => {
    try {
        const files = fs.readdirSync(RECORDINGS_DIR);
        const recordings = files
            .filter(file => file.endsWith('.mp4'))
            .map(file => {
                const filePath = path.join(RECORDINGS_DIR, file);
                const stats = fs.statSync(filePath);
                const match = file.match(/camera_(\d+)_(.+)\.mp4/);
                
                return {
                    filename: file,
                    camera: match ? parseInt(match[1]) : null,
                    timestamp: match ? match[2] : null,
                    size: stats.size,
                    created: stats.birthtime,
                    downloadUrl: `/api/recordings/${file}`
                };
            })
            .filter(recording => {
                if (req.user.role === 'admin') return true;
                return recording.camera && req.user.cameras.includes(recording.camera);
            })
            .sort((a, b) => b.created - a.created);
        
        res.json({ recordings });
    } catch (error) {
        console.error('Error listing recordings:', error);
        res.status(500).json({ error: 'Failed to list recordings' });
    }
});

// Скачать запись
app.get('/api/recordings/:filename', verifyToken, (req, res) => {
    const { filename } = req.params;
    const filePath = path.join(RECORDINGS_DIR, filename);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Recording file not found' });
    }
    
    // Проверяем права доступа
    const cameraMatch = filename.match(/camera_(\d+)_/);
    if (cameraMatch && req.user.role !== 'admin') {
        const cameraId = parseInt(cameraMatch[1]);
        if (!req.user.cameras.includes(cameraId)) {
            return res.status(403).json({ error: 'Access denied to this recording' });
        }
    }
    
    console.log(`Downloading recording: ${filename}`);
    
    res.setHeader('Content-Type', 'video/mp4');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.sendFile(filePath);
});

// ===============================
// СИСТЕМНАЯ ИНФОРМАЦИЯ
// ===============================

// Статус системы
app.get('/status', (req, res) => {
    try {
        const files = fs.readdirSync(HLS_DIR);
        
        const m3u8Files = files.filter(f => f.endsWith('.m3u8')).length;
        const tsFiles = files.filter(f => f.endsWith('.ts')).length;
        const adaptiveDirs = files.filter(f => f.startsWith('camera_') && 
            fs.statSync(path.join(HLS_DIR, f)).isDirectory()).length;
        
        const recordingFiles = fs.existsSync(RECORDINGS_DIR) ? 
            fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('.mp4')).length : 0;
        
        res.json({ 
            status: 'ok', 
            service: 'askr-camera-system',
            version: '2.1.0-simplified',
            timestamp: new Date().toISOString(),
            hls_directory: HLS_DIR,
            recordings_directory: RECORDINGS_DIR,
            legacy_cameras: m3u8Files,
            adaptive_cameras: adaptiveDirs,
            total_segments: tsFiles,
            total_recordings: recordingFiles,
            active_recordings: activeRecordings.size,
            jwt_secret_configured: JWT_SECRET !== 'askr-secret-key-2025',
            features: {
                adaptive_hls: true,
                legacy_hls: true,
                simple_auth: true,
                api_integration: true
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            service: 'askr-camera-system', 
            error: error.message
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
process.on('SIGINT', () => {
    console.log('\n🛑 Завершение работы системы...');
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.stdin.write('q');
    }
    setTimeout(() => process.exit(0), 5000);
});

process.on('SIGTERM', () => {
    console.log('\n🛑 Получен SIGTERM, завершаем все записи...');
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.stdin.write('q');
    }
    setTimeout(() => process.exit(0), 5000);
});

// Запуск сервера
app.listen(PORT, () => {
    console.log(`🚀 ASKR Camera System v2.1 (Simplified) running on port ${PORT}`);
    console.log(`📁 HLS files: ${HLS_DIR}`);
    console.log(`🎬 Recordings: ${RECORDINGS_DIR}`);
    console.log(`🔑 JWT Secret: ${JWT_SECRET !== 'askr-secret-key-2025' ? 'Custom' : 'Default'}`);
    console.log(`📊 Status: http://localhost:${PORT}/status`);
    console.log(`🔗 Available users: admin, operator, user1, user2, user3, user4`);
    console.log(`🎥 HLS endpoints:`);
    console.log(`   GET /stream/:id/playlist.m3u8 - Master/Legacy playlist`);
    console.log(`   GET /stream/:id/:quality/:segment - Adaptive segments`);
    console.log(`   GET /stream/:id/:segment - Legacy segments`);
});

module.exports = app;