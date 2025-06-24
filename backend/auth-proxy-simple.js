require('dotenv').config();
const express = require('express');
const jwt = require('jsonwebtoken');

const app = express();
const PORT = process.env.BACKEND_PORT || 8080;
const API_ACCESS_KEY = process.env.API_ACCESS_KEY || 'askr-api-key-2025';
const JWT_SECRET = process.env.JWT_SECRET || 'askr-secret-key-2025';

app.use(express.json());

// CORS
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.header('Access-Control-Allow-Headers', 'Authorization, Content-Type, X-API-Key');
    if (req.method === 'OPTIONS') return res.status(200).end();
    next();
});

// Проверка API ключа
const verifyApiKey = (req, res, next) => {
    const apiKey = req.headers['x-api-key'];
    if (!apiKey || apiKey !== API_ACCESS_KEY) {
        return res.status(401).json({ error: 'Invalid API key' });
    }
    next();
};

// Статус
app.get('/status', (req, res) => {
    res.json({
        status: 'ok',
        service: 'askr-camera-system-simple',
        version: '3.0.0-test',
        timestamp: new Date().toISOString(),
        note: 'Running without database for testing'
    });
});

// Токены
app.post('/api/stream-token', verifyApiKey, (req, res) => {
    const { scope, cameraIds, duration } = req.body;
    
    let cameras = [];
    if (scope === 'all') {
        cameras = Array.from({length: 24}, (_, i) => i + 1);
    } else if (cameraIds) {
        cameras = cameraIds;
    }
    
    const token = jwt.sign({
        type: 'stream',
        cameras: cameras,
        iat: Math.floor(Date.now() / 1000)
    }, JWT_SECRET, { expiresIn: duration || '1h' });
    
    res.json({
        success: true,
        token: token,
        cameras: cameras,
        expiresIn: duration || '1h'
    });
});

app.listen(PORT, () => {
    console.log(`🚀 ASKR Simple Test Server running on port ${PORT}`);
});
