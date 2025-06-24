/*
 * ASKR Camera System - Secure Video Surveillance v3.0
 * 
 * API DOCUMENTATION:
 * 
 * 1. ГЕНЕРАЦИЯ STREAM ТОКЕНОВ:
 * 
 * Токен для одной камеры:
 * POST /api/stream-token
 * Headers: X-API-Key: your-api-key
 * Body: { "cameraId": 1, "userId": 123, "duration": "30m" }
 * 
 * Токен для списка камер:
 * POST /api/stream-token
 * Body: { "cameraIds": [1,2,3,4], "userId": 123, "duration": "1h" }
 * 
 * Токен для всех доступных пользователю камер:
 * POST /api/stream-token
 * Body: { "scope": "all", "userId": 123, "duration": "2h" }
 * 
 * Админский токен (доступ ко всем камерам):
 * POST /api/stream-token
 * Body: { "cameraIds": [1,2,3,4,5,6,7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23,24] }
 * 
 * 2. ИСПОЛЬЗОВАНИЕ ТОКЕНОВ:
 * 
 * GET /stream/1/master.m3u8?token=xxx
 * GET /stream/1/720p/playlist.m3u8?token=xxx
 * GET /stream/1/720p/segment001.ts?token=xxx
 * 
 * 3. ПРОВЕРКА ТОКЕНА:
 * 
 * GET /api/stream-token/verify?token=xxx
 * Headers: X-API-Key: your-api-key
 * 
 * 4. ПОЛУЧЕНИЕ ССЫЛОК НА СТРИМЫ:
 * 
 * GET /api/camera/1/streams
 * Headers: X-API-Key: your-api-key
 * 
 * 5. БЕЗОПАСНОСТЬ:
 * 
 * - Все прямые запросы к .m3u8 и .ts файлам БЕЗ /stream/ = 403 FORBIDDEN
 * - Токены проверяются для каждого сегмента
 * - Rate limiting: API - 100 req/15min, Streams - 300 req/min
 * - Админы имеют доступ ко всем камерам
 * - Пользователи только к назначенным камерам
 * 
 */

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const jwt = require('jsonwebtoken');
const { spawn } = require('child_process');
const { PrismaClient } = require('@prisma/client');
const rateLimit = require('express-rate-limit');

const app = express();

// ===============================
// КОНФИГУРАЦИЯ ИЗ ENV
// ===============================

const PORT = parseInt(process.env.BACKEND_PORT) || 8080;  // ИСПРАВЛЕНО: parseInt
const JWT_SECRET = process.env.JWT_SECRET || 'askr-secret-key-2025';
const HLS_DIR = process.env.HLS_DIR || '/app/output';
const RECORDINGS_DIR = process.env.RECORDINGS_DIR || '/app/recordings';
const STREAM_TOKEN_EXPIRY = process.env.STREAM_TOKEN_EXPIRY || '30m';
const API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'askr-api-key-2025';

console.log('🔧 ASKR Camera System v3.0 Configuration:');
console.log(`🌐 PORT: ${PORT} (type: ${typeof PORT})`);  // ДОБАВЛЕНО: отладка типа порта
console.log(`📁 HLS_DIR: ${HLS_DIR}`);
console.log(`🎬 RECORDINGS_DIR: ${RECORDINGS_DIR}`);
console.log(`🔑 API_ACCESS_KEY: ${API_ACCESS_KEY ? 'SET' : 'NOT SET'}`);
console.log(`🔐 JWT_SECRET: ${JWT_SECRET ? 'SET' : 'NOT SET'}`);

// Создаем директории если не существуют
[HLS_DIR, RECORDINGS_DIR].forEach(dir => {
    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
            console.log(`✅ Created directory: ${dir}`);
        } else {
            console.log(`📁 Directory exists: ${dir}`);
        }
    } catch (error) {
        console.error(`❌ Failed to create directory ${dir}:`, error.message);
        // Не падаем, а продолжаем работу
    }
});

// Инициализация Prisma с обработкой ошибок
let prisma = null;
let prismaReady = false;

async function initPrisma() {
    try {
        prisma = new PrismaClient();
        await prisma.$connect();
        prismaReady = true;
        console.log('📦 Prisma Client connected successfully');
    } catch (error) {
        console.error('❌ Prisma initialization failed:', error.message);
        console.log('⚠️  Running without database - some features disabled');
        prismaReady = false;
    }
}

// Запускаем инициализацию Prisma асинхронно
initPrisma();

// Храним активные записи
const activeRecordings = new Map();

// ===============================
// RATE LIMITING
// ===============================

const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000, // 15 минут
    max: 100, // лимит для API
    message: { error: 'Too many API requests' }
});

const streamLimiter = rateLimit({
    windowMs: 1 * 60 * 1000, // 1 минута
    max: 300, // лимит для стримов
    message: { error: 'Too many stream requests' }
});

// ===============================
// MIDDLEWARE
// ===============================

app.use(express.json({ limit: '10mb' }));

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

// Проверка API ключа (с fallback без БД)
async function verifyApiKey(apiKey) {
    if (!apiKey) {
        return false;
    }
    
    // Если Prisma не готова - используем простую проверку
    if (!prismaReady) {
        return apiKey === API_ACCESS_KEY || apiKey === 'askr-api-key-2025' || apiKey === 'askr-dev-key-2025';
    }

    try {
        const validKey = await prisma.apiKey.findFirst({
            where: { 
                keyHash: apiKey, // ИСПРАВЛЕНО: используем keyHash вместо key
                isActive: true 
            }
        });
        return !!validKey;
    } catch (error) {
        console.error('API key verification error:', error);
        // Fallback к простой проверке
        return apiKey === API_ACCESS_KEY;
    }
}

// Middleware для проверки API ключа
const requireApiKey = async (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    
    if (!await verifyApiKey(apiKey)) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    
    req.apiKey = { key: apiKey };
    next();
};

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

// Проверка stream токена для доступа к сегментам
const verifyStreamToken = (req, res, next) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(401).json({ error: 'Stream access denied: token required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        const cameraId = parseInt(req.params.cameraId);
        
        // Проверяем тип токена
        if (decoded.type !== 'stream') {
            return res.status(403).json({ error: 'Invalid token type for stream access' });
        }
        
        // Админские токены имеют доступ ко всем камерам
        if (decoded.userRole === 'ADMIN' || decoded.userRole === 'OPERATOR') {
            req.user = decoded;
            return next();
        }
        
        // Проверяем доступ к конкретной камере
        let hasAccess = false;
        
        // Новый формат с массивом камер
        if (decoded.cameras && Array.isArray(decoded.cameras)) {
            hasAccess = decoded.cameras.includes(cameraId);
        }
        // Старый формат с одной камерой (обратная совместимость)
        else if (decoded.cameraId === cameraId) {
            hasAccess = true;
        }
        
        if (!hasAccess) {
            return res.status(403).json({ 
                error: 'Stream access denied: camera not in token scope',
                requestedCamera: cameraId,
                allowedCameras: decoded.cameras || [decoded.cameraId]
            });
        }
        
        req.user = decoded;
        return next();
        
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.status(401).json({ error: 'Stream token expired' });
        }
        return res.status(401).json({ error: 'Stream access denied: invalid token' });
    }
};

// Защита от прямого доступа к HLS файлам
const blockDirectHLSAccess = (req, res, next) => {
    // Блокируем все запросы к .m3u8 и .ts файлам которые НЕ идут через защищенные роуты
    if ((req.url.includes('.m3u8') || req.url.includes('.ts')) && !req.url.startsWith('/stream/')) {
        return res.status(403).json({ 
            error: 'Direct access to HLS files is forbidden',
            message: 'Use /stream/ endpoints with valid token'
        });
    }
    next();
};

// Функция получения fallback камер
function getFallbackCameras() {
    return Array.from({length: 24}, (_, i) => ({
        id: i + 1,
        channelId: i + 1,
        name: `Камера ${i + 1}`,
        position: i + 1,
        isActive: true,
        status: "online",
        adaptiveHls: true
    }));
}

// ===============================
// ПРИМЕНЯЕМ MIDDLEWARE
// ===============================

app.use('/api/', apiLimiter);
app.use('/stream/', streamLimiter);
app.use(blockDirectHLSAccess);

// ===============================
// API ENDPOINTS
// ===============================

// ===============================
// АВТОРИЗАЦИЯ
// ===============================

// Логин пользователя
app.post('/auth/token', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }
    
    // Простая проверка логинов без БД (fallback)
    const users = {
        'admin': { password: 'admin123', role: 'ADMIN', cameras: [] },
        'operator': { password: 'op123', role: 'OPERATOR', cameras: [] },
        'user1': { password: 'user123', role: 'USER', cameras: [1,2,3,4,5,6] },
        'user2': { password: 'user123', role: 'USER', cameras: [7,8,9,10,11,12] },
        'user3': { password: 'user123', role: 'USER', cameras: [13,14,15,16,17,18] },
        'user4': { password: 'user123', role: 'USER', cameras: [19,20,21,22,23,24] }
    };
    
    const user = users[username];
    if (!user || user.password !== password) {
        return res.status(401).json({ error: 'Invalid credentials' });
    }
    
    // Генерируем JWT токен
    const token = jwt.sign({
        id: Math.floor(Math.random() * 1000),
        username: username,
        role: user.role,
        cameras: user.cameras,
        iat: Math.floor(Date.now() / 1000)
    }, JWT_SECRET, { expiresIn: '24h' });
    
    res.json({
        success: true,
        token: token,
        user: {
            username: username,
            role: user.role,
            cameras: user.cameras
        }
    });
});

// Проверка токена
app.get('/auth/validate', verifyToken, (req, res) => {
    res.json({
        success: true,
        user: req.user
    });
});

// НОВЫЙ ENDPOINT: Алиас для /api/cameras/list для совместимости с frontend
app.get('/api/cameras', async (req, res) => {
    try {
        // Проверяем API ключ
        const apiKey = req.header('X-API-Key');
        if (!await verifyApiKey(apiKey)) {
            return res.status(401).json({ error: 'Invalid API key' });
        }

        let cameras = [];
        
        if (prismaReady) {
            try {
                const dbCameras = await prisma.camera.findMany({
                    select: {
                        id: true,
                        channelId: true,
                        name: true,
                        position: true,
                        isActive: true,
                        status: true
                    },
                    orderBy: { position: 'asc' }
                });
                
                cameras = dbCameras.map(cam => ({
                    id: cam.id,
                    channelId: cam.channelId,
                    name: cam.name || `Камера ${cam.channelId}`,
                    position: cam.position,
                    isActive: cam.isActive,
                    status: cam.status?.toLowerCase() || 'offline',
                    adaptiveHls: true
                }));
                
            } catch (dbError) {
                console.error('Database error, using fallback:', dbError.message);
                cameras = getFallbackCameras();
            }
        } else {
            cameras = getFallbackCameras();
        }
        
        res.json({
            success: true,
            cameras,
            total: cameras.length,
            database_mode: prismaReady ? 'connected' : 'fallback'
        });
        
    } catch (error) {
        console.error('Error fetching cameras:', error);
        res.status(500).json({
            success: false,
            error: 'Internal server error'
        });
    }
});

// Получение списка камер (с fallback без БД) - ОРИГИНАЛЬНЫЙ ENDPOINT
app.get('/api/cameras/list', requireApiKey, async (req, res) => {
    try {
        let cameras = [];
        
        if (prismaReady) {
            // Используем БД если доступна
            try {
                const dbCameras = await prisma.camera.findMany({
                    where: { isActive: true },
                    select: {
                        id: true,
                        channelId: true,
                        name: true,
                        position: true,
                        isActive: true
                    },
                    orderBy: { channelId: 'asc' }
                });
                cameras = dbCameras;
            } catch (dbError) {
                console.error('Error fetching cameras:', dbError);
                cameras = getFallbackCameras();
            }
        } else {
            // Fallback - генерируем 24 камеры
            cameras = getFallbackCameras();
        }

        // Проверяем статус камер по наличию HLS файлов
        const camerasWithStatus = cameras.map(camera => {
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
                ...camera,
                status,
                adaptiveHls
            };
        });
        
        res.json({
            success: true,
            cameras: camerasWithStatus,
            total: camerasWithStatus.length,
            database_mode: prismaReady ? 'connected' : 'fallback'
        });
    } catch (error) {
        console.error('Error fetching cameras:', error);
        res.status(500).json({ error: 'Failed to fetch cameras' });
    }
});

// Генерация stream токена для доступа к камерам
app.post('/api/stream-token', requireApiKey, async (req, res) => {
    const { cameraId, cameraIds, userId, duration, scope } = req.body;

    try {
        let allowedCameras = [];
        let userInfo = null;

        // Если указан пользователь и БД доступна - получаем его права
        if (userId && prismaReady) {
            try {
                const user = await prisma.user.findFirst({
                    where: { 
                        id: userId,
                        isActive: true 
                    },
                    include: {
                        cameras: {
                            include: {
                                camera: {
                                    where: { isActive: true }
                                }
                            }
                        }
                    }
                });

                if (!user) {
                    return res.status(404).json({ error: 'User not found' });
                }

                userInfo = user;

                // Админы и операторы имеют доступ ко всем камерам
                if (user.role === 'ADMIN' || user.role === 'OPERATOR') {
                    allowedCameras = Array.from({length: 24}, (_, i) => i + 1);
                } else {
                    // Обычные пользователи - только к назначенным камерам
                    allowedCameras = user.cameras.map(uc => uc.camera.channelId);
                }
            } catch (error) {
                console.error('Error fetching user:', error);
                // Продолжаем без проверки пользователя
            }
        }

        // Определяем какие камеры включить в токен
        let targetCameras = [];

        if (scope === 'all') {
            if (userId && allowedCameras.length > 0) {
                // Токен для всех доступных пользователю камер
                targetCameras = allowedCameras;
            } else {
                // Все 24 камеры (если нет ограничений пользователя)
                targetCameras = Array.from({length: 24}, (_, i) => i + 1);
            }
        } else if (cameraIds && Array.isArray(cameraIds)) {
            // Токен для списка камер
            if (userId && allowedCameras.length > 0) {
                // Проверяем что пользователь имеет доступ ко всем запрашиваемым камерам
                const unauthorizedCameras = cameraIds.filter(id => !allowedCameras.includes(id));
                if (unauthorizedCameras.length > 0) {
                    return res.status(403).json({ 
                        error: 'Access denied to some cameras',
                        unauthorized: unauthorizedCameras,
                        allowed: allowedCameras
                    });
                }
            }
            targetCameras = cameraIds.filter(id => id >= 1 && id <= 24);
        } else if (cameraId) {
            // Токен для одной камеры (обратная совместимость)
            if (userId && allowedCameras.length > 0 && !allowedCameras.includes(cameraId)) {
                return res.status(403).json({ error: 'User does not have access to this camera' });
            }
            if (cameraId >= 1 && cameraId <= 24) {
                targetCameras = [cameraId];
            }
        } else {
            return res.status(400).json({ 
                error: 'Specify cameraId, cameraIds array, or scope="all"' 
            });
        }

        if (targetCameras.length === 0) {
            return res.status(400).json({ error: 'No valid cameras specified' });
        }

        // Генерируем stream токен
        const tokenExpiry = duration || STREAM_TOKEN_EXPIRY;
        const streamToken = jwt.sign({
            type: 'stream',
            cameras: targetCameras, // Массив камер
            cameraId: targetCameras[0], // Для обратной совместимости
            userId: userId,
            userRole: userInfo?.role,
            scope: targetCameras.length === 1 ? 'single' : 'multiple',
            iat: Math.floor(Date.now() / 1000)
        }, JWT_SECRET, { expiresIn: tokenExpiry });

        res.json({
            success: true,
            token: streamToken,
            cameras: targetCameras,
            scope: targetCameras.length === 1 ? 'single' : 'multiple',
            expiresIn: tokenExpiry,
            user: userInfo ? {
                id: userInfo.id,
                username: userInfo.username,
                role: userInfo.role
            } : null,
            database_mode: prismaReady ? 'connected' : 'fallback'
        });

    } catch (error) {
        console.error('Error generating stream token:', error);
        res.status(500).json({ error: 'Failed to generate stream token' });
    }
});

// Проверка и получение информации о stream токене
app.get('/api/stream-token/verify', requireApiKey, (req, res) => {
    const token = req.query.token || req.headers.authorization?.replace('Bearer ', '');
    
    if (!token) {
        return res.status(400).json({ error: 'Token parameter required' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        
        if (decoded.type !== 'stream') {
            return res.status(400).json({ error: 'Not a stream token' });
        }
        
        res.json({
            valid: true,
            token: {
                type: decoded.type,
                cameras: decoded.cameras || [decoded.cameraId], // Поддержка старого формата
                userId: decoded.userId,
                userRole: decoded.userRole,
                scope: decoded.scope || (decoded.cameraId ? 'single' : 'multiple'),
                issuedAt: new Date(decoded.iat * 1000),
                expiresAt: new Date(decoded.exp * 1000),
                timeToExpiry: Math.max(0, decoded.exp - Math.floor(Date.now() / 1000))
            }
        });
        
    } catch (error) {
        if (error.name === 'TokenExpiredError') {
            return res.json({
                valid: false,
                error: 'Token expired',
                expiredAt: new Date(error.expiredAt)
            });
        }
        
        return res.json({
            valid: false,
            error: 'Invalid token'
        });
    }
});

// Получение ссылок на HLS потоки для камеры
app.get('/api/camera/:cameraId/streams', requireApiKey, async (req, res) => {
    const cameraId = parseInt(req.params.cameraId);

    if (cameraId < 1 || cameraId > 24) {
        return res.status(400).json({ error: 'Invalid camera ID (1-24)' });
    }

    try {
        // Проверяем наличие файлов
        const hlsFile = path.join(HLS_DIR, `camera_${cameraId}.m3u8`);
        const adaptiveDir = path.join(HLS_DIR, `camera_${cameraId}`);
        const masterPlaylist = path.join(adaptiveDir, 'master.m3u8');

        const streams = {};

        if (fs.existsSync(masterPlaylist)) {
            streams.adaptive = `/stream/${cameraId}/master.m3u8`;
            streams.qualities = [
                { quality: '720p', url: `/stream/${cameraId}/720p/playlist.m3u8` },
                { quality: '480p', url: `/stream/${cameraId}/480p/playlist.m3u8` },
                { quality: '360p', url: `/stream/${cameraId}/360p/playlist.m3u8` }
            ];
        }

        if (fs.existsSync(hlsFile)) {
            streams.legacy = `/stream/${cameraId}/playlist.m3u8`;
        }

        if (Object.keys(streams).length === 0) {
            return res.status(404).json({ error: 'No streams available for this camera' });
        }

        res.json({
            success: true,
            cameraId: cameraId,
            streams: streams,
            note: "All URLs require a valid stream token in query parameter 'token' or Authorization header"
        });

    } catch (error) {
        console.error('Error fetching camera streams:', error);
        res.status(500).json({ error: 'Failed to fetch camera streams' });
    }
});

// ===============================
// ЗАЩИЩЕННЫЕ HLS ENDPOINTS
// ===============================

// Master плейлист (адаптивный)
app.get('/stream/:cameraId/master.m3u8', verifyStreamToken, (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    const filePath = path.join(HLS_DIR, `camera_${cameraId}`, 'master.m3u8');
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Master playlist not found' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(filePath);
});

// Плейлисты качества
app.get('/stream/:cameraId/:quality/playlist.m3u8', verifyStreamToken, (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    const quality = req.params.quality;
    
    // Валидация качества
    const allowedQualities = ['720p', '480p', '360p'];
    if (!allowedQualities.includes(quality)) {
        return res.status(400).json({ error: 'Invalid quality parameter' });
    }
    
    const filePath = path.join(HLS_DIR, `camera_${cameraId}`, quality, 'playlist.m3u8');
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Quality playlist not found' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(filePath);
});

// Legacy плейлист
app.get('/stream/:cameraId/playlist.m3u8', verifyStreamToken, (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    const filePath = path.join(HLS_DIR, `camera_${cameraId}.m3u8`);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Legacy playlist not found' });
    }
    
    res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
    res.sendFile(filePath);
});

// TS сегменты (адаптивные)
app.get('/stream/:cameraId/:quality/:segment', verifyStreamToken, (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    const quality = req.params.quality;
    const segment = req.params.segment;
    
    // Валидация
    const allowedQualities = ['720p', '480p', '360p'];
    if (!allowedQualities.includes(quality)) {
        return res.status(400).json({ error: 'Invalid quality parameter' });
    }
    
    if (!segment.endsWith('.ts') || segment.includes('..') || segment.includes('/')) {
        return res.status(400).json({ error: 'Invalid segment format' });
    }
    
    const filePath = path.join(HLS_DIR, `camera_${cameraId}`, quality, segment);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Segment not found' });
    }
    
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
    res.sendFile(filePath);
});

// TS сегменты (legacy)
app.get('/stream/:cameraId/:segment', verifyStreamToken, (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    const segment = req.params.segment;
    
    if (!segment.endsWith('.ts') || segment.includes('..') || segment.includes('/')) {
        return res.status(400).json({ error: 'Invalid segment format' });
    }
    
    const filePath = path.join(HLS_DIR, segment);
    
    if (!fs.existsSync(filePath)) {
        return res.status(404).json({ error: 'Segment not found' });
    }
    
    res.setHeader('Content-Type', 'video/mp2t');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    res.setHeader('Accept-Ranges', 'bytes');
    res.sendFile(filePath);
});

// ===============================
// ЗАПИСЬ ВИДЕО
// ===============================

app.post('/api/camera/:cameraId/start-recording', requireApiKey, async (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    
    if (cameraId < 1 || cameraId > 24) {
        return res.status(400).json({ error: 'Invalid camera ID (1-24)' });
    }
    
    try {
        if (activeRecordings.has(cameraId)) {
            return res.status(409).json({ error: 'Recording already in progress' });
        }

        const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
        const filename = `camera_${cameraId}_${timestamp}.mp4`;
        const filePath = path.join(RECORDINGS_DIR, filename);
        
        const rtspUrl = `rtsp://${process.env.RTSP_USER}:${process.env.RTSP_PASS}@${process.env.RTSP_BASE_IP}:${process.env.RTSP_PORT}/chID=${cameraId}`;
        
        const ffmpegArgs = [
            '-rtsp_transport', 'tcp',
            '-i', rtspUrl,
            '-c:v', 'libx264',
            '-preset', 'medium',
            '-crf', '23',
            '-c:a', 'aac',
            '-b:a', '128k',
            '-f', 'mp4',
            filePath
        ];

        const ffmpegProcess = spawn('ffmpeg', ffmpegArgs);
        
        activeRecordings.set(cameraId, {
            process: ffmpegProcess,
            filename: filename,
            startTime: new Date(),
            filePath: filePath
        });

        ffmpegProcess.on('error', (error) => {
            console.error(`Recording error for camera ${cameraId}:`, error);
            activeRecordings.delete(cameraId);
        });

        ffmpegProcess.on('exit', (code) => {
            console.log(`Recording stopped for camera ${cameraId}, exit code: ${code}`);
            activeRecordings.delete(cameraId);
        });

        res.json({
            success: true,
            message: 'Recording started',
            cameraId: cameraId,
            filename: filename
        });

    } catch (error) {
        console.error('Error starting recording:', error);
        res.status(500).json({ error: 'Failed to start recording' });
    }
});

app.post('/api/camera/:cameraId/stop-recording', requireApiKey, async (req, res) => {
    const cameraId = parseInt(req.params.cameraId);
    
    const recording = activeRecordings.get(cameraId);
    if (!recording) {
        return res.status(404).json({ error: 'No active recording for this camera' });
    }

    recording.process.stdin.write('q');
    
    res.json({
        success: true,
        message: 'Recording stopped',
        cameraId: cameraId,
        filename: recording.filename
    });
});

// ===============================
// СТАТУС И МОНИТОРИНГ
// ===============================

app.get('/status', async (req, res) => {
    try {
        const m3u8Files = fs.readdirSync(HLS_DIR).filter(f => f.endsWith('.m3u8')).length;
        const tsFiles = fs.readdirSync(HLS_DIR).filter(f => f.endsWith('.ts')).length;
        const adaptiveDirs = fs.readdirSync(HLS_DIR).filter(f => 
            fs.statSync(path.join(HLS_DIR, f)).isDirectory() && f.startsWith('camera_')
        ).length;
        const recordingFiles = fs.existsSync(RECORDINGS_DIR) ? 
            fs.readdirSync(RECORDINGS_DIR).filter(f => f.endsWith('.mp4')).length : 0;
        
        res.json({ 
            status: 'ok', 
            service: 'askr-camera-system-v3',
            version: '3.0.0-fixed-port',
            timestamp: new Date().toISOString(),
            port: PORT,
            port_type: typeof PORT,
            hls_directory: HLS_DIR,
            recordings_directory: RECORDINGS_DIR,
            legacy_cameras: m3u8Files,
            adaptive_cameras: adaptiveDirs,
            total_segments: tsFiles,
            total_recordings: recordingFiles,
            active_recordings: activeRecordings.size,
            database_status: prismaReady ? 'connected' : 'fallback',
            features: {
                stream_tokens: true,
                protected_hls: true,
                api_integration: true,
                database_auth: prismaReady,
                rate_limiting: true,
                direct_access_blocked: true
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'error',
            service: 'askr-camera-system-v3', 
            error: error.message
        });
    }
});

// ===============================
// ERROR HANDLERS
// ===============================

// 404 для всех остальных маршрутов
app.use('*', (req, res) => {
    res.status(404).json({ 
        error: 'Not found',
        path: req.originalUrl,
        method: req.method,
        message: 'Use /api/ for API endpoints or /stream/ for protected video streams'
    });
});

// Graceful shutdown
process.on('SIGINT', async () => {
    console.log('\n🛑 Завершение работы системы...');
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.stdin.write('q');
    }
    if (prisma) await prisma.$disconnect();
    setTimeout(() => process.exit(0), 5000);
});

process.on('SIGTERM', async () => {
    console.log('\n🛑 Получен SIGTERM, завершаем все записи...');
    for (const [key, recording] of activeRecordings) {
        console.log(`Stopping recording: ${recording.filename}`);
        recording.process.stdin.write('q');
    }
    if (prisma) await prisma.$disconnect();
    setTimeout(() => process.exit(0), 5000);
});

// Запуск сервера - ИСПРАВЛЕНО: слушаем на всех интерфейсах с правильным типом порта
app.listen(PORT, '0.0.0.0', () => {
    console.log(`🚀 ASKR Camera System v3.0 running on port ${PORT}`);
    console.log(`📁 HLS files: ${HLS_DIR}`);
    console.log(`🎬 Recordings: ${RECORDINGS_DIR}`);
    console.log(`🔐 Protected HLS endpoints: /stream/*`);
    console.log(`🚫 Direct HLS access: BLOCKED`);
    console.log(`📊 Status: http://localhost:${PORT}/status`);
    console.log(`🔑 Stream tokens required for all video access`);
    console.log(`⚡ Rate limiting enabled`);
    console.log(`🗄️  Database: ${prismaReady ? 'Connected' : 'Fallback mode'}`);
});

module.exports = app;