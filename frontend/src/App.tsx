import React, { useEffect, useState } from 'react';
import { apiClient } from './services/api';
import LoginForm from './components/LoginForm';
import CameraCard from './components/CameraCard';
import './styles.css';

interface Camera {
  id: string;
  name: string;
  rtsp_url: string;
  hls_url: string;
  status: 'active' | 'inactive' | 'error';
  resolution?: string;
  fps?: number;
  last_frame?: string;
  adaptiveSupported?: boolean;
}

function App() {
  const [user, setUser] = useState(null);
  const [status, setStatus] = useState(null);
  const [cameras, setCameras] = useState<Camera[]>([]);
  const [loading, setLoading] = useState(true);
  const [camerasLoading, setCamerasLoading] = useState(false);

  useEffect(() => {
    loadInitialData();
  }, []);

  const loadInitialData = async () => {
    const savedUser = localStorage.getItem('hls_user');
    if (savedUser) {
      setUser(JSON.parse(savedUser));
    }
    await loadStatus();
    setLoading(false);
  };

  const loadStatus = async () => {
    try {
      const data = await apiClient.getStatus();
      setStatus(data);
    } catch (error) {
      console.error('Ошибка получения статуса:', error);
    }
  };

  const loadCameras = async () => {
    setCamerasLoading(true);
    try {
      const savedUser = localStorage.getItem('hls_user');
      if (!savedUser) {
        throw new Error('Не авторизован');
      }
      
      const user = JSON.parse(savedUser);
      
      // ПОЛУЧАЕМ РЕАЛЬНЫЙ СТАТУС КАМЕР
      const response = await fetch('http://176.98.178.23:8080/api/cameras', {
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });
      
      // Если 401 - перелогиниваем
      if (response.status === 401) {
        console.log('Токен истек, нужно перелогиниться');
        localStorage.removeItem('hls_user');
        setUser(null);
        setCameras([]);
        return;
      }
      
      if (!response.ok) {
        throw new Error('Ошибка получения камер');
      }
      
      const data = await response.json();
      
      // ПРАВИЛЬНАЯ ОБРАБОТКА API ОТВЕТА
      console.log('API Response:', data);
      
      if (!data.success || !data.cameras) {
        throw new Error('Некорректный ответ API');
      }
      
      // КОНВЕРТИРУЕМ ИЗ API ФОРМАТА В ФОРМАТ ФРОНТЕНДА
      const cameras: Camera[] = data.cameras.map((apiCamera: any) => {
        // Маппинг статусов: API -> Frontend
        let status: 'active' | 'inactive' | 'error' = 'inactive';
        
        if (apiCamera.status === 'ONLINE' && apiCamera.hasStream) {
          status = 'active';
        } else if (apiCamera.status === 'OFFLINE') {
          status = 'inactive';  
        } else {
          status = 'error';
        }
        
        return {
          id: `camera_${apiCamera.channelId}`,
          name: apiCamera.name || `Камера ${apiCamera.channelId}`,
          rtsp_url: apiCamera.rtspUrl || `rtsp://192.168.4.200:62342/chID=${apiCamera.channelId}`,
          hls_url: `http://176.98.178.23:8080/stream/${apiCamera.channelId}/playlist.m3u8`,
          status: status,
          resolution: '1920x1080',
          fps: 25,
          adaptiveSupported: apiCamera.streamType === 'adaptive'
        };
      });
      
      console.log('Converted cameras:', cameras);
      setCameras(cameras);
      
      // ПРОВЕРЯЕМ АДАПТИВНУЮ ПОДДЕРЖКУ АСИНХРОННО
      checkAdaptiveSupport(cameras, user.token);
      
    } catch (error) {
      console.error('Ошибка получения камер:', error);
      
      // ЗАГЛУШКИ С ПРАВИЛЬНЫМ СТАТУСОМ ЕСЛИ API НЕДОСТУПНО
      const cameras: Camera[] = [];
      for (let i = 1; i <= 24; i++) {
        cameras.push({
          id: `camera_${i}`,
          name: `Камера ${i}`,
          rtsp_url: `rtsp://192.168.4.200:62342/chID=${i}`,
          hls_url: `http://176.98.178.23:8080/stream/${i}/playlist.m3u8`,
          status: 'error', // Все в ошибке если API недоступно
          resolution: '1920x1080',
          fps: 25,
          adaptiveSupported: false
        });
      }
      setCameras(cameras);
    } finally {
      setCamerasLoading(false);
    }
  };

  // ПРОВЕРЯЕМ АДАПТИВНУЮ ПОДДЕРЖКУ
  const checkAdaptiveSupport = async (cameras: Camera[], token: string) => {
    const updatedCameras = [...cameras];
    
    for (let i = 0; i < updatedCameras.length; i++) {
      const camera = updatedCameras[i];
      const cameraNumber = camera.id.replace('camera_', '');
      
      try {
        const response = await fetch(`http://176.98.178.23:8080/api/camera/${cameraNumber}/qualities`, {
          headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (response.ok) {
          const qualityData = await response.json();
          updatedCameras[i] = {
            ...camera,
            adaptiveSupported: qualityData.adaptiveSupported || false
          };
        }
      } catch (error) {
        // Не критично, просто не будет адаптивной поддержки
      }
    }
    
    setCameras(updatedCameras);
  };

  const handleCameraDelete = async (cameraId: string) => {
    if (!confirm('Вы уверены, что хотите удалить эту камеру?')) {
      return;
    }
    // Удаляем камеру из списка
    setCameras(prev => prev.filter(c => c.id !== cameraId));
  };

  const handleStartAll = async () => {
    // Меняем статус ТОЛЬКО доступных камер на активные
    setCameras(prev => prev.map(cam => ({
      ...cam,
      status: cam.status === 'error' ? 'active' : cam.status
    })));
  };

  const handleStopAll = async () => {
    // Меняем статус всех камер на неактивные
    setCameras(prev => prev.map(cam => ({ ...cam, status: 'inactive' })));
  };

  const handleUnauthorized = () => {
    console.log('Сессия истекла, перелогиниваемся...');
    localStorage.removeItem('hls_user');
    setUser(null);
    setCameras([]);
  };

  const handleLogout = () => {
    apiClient.logout();
    setUser(null);
    setCameras([]);
  };

  // СЧИТАЕМ СТАТИСТИКУ ПРАВИЛЬНО
  const activeCamerasCount = cameras.filter(c => c.status === 'active').length;
  const errorCamerasCount = cameras.filter(c => c.status === 'error').length;
  const inactiveCamerasCount = cameras.filter(c => c.status === 'inactive').length;
  const adaptiveCamerasCount = cameras.filter(c => c.adaptiveSupported).length;

  if (loading) {
    return (
      <div className="login-container">
        <div className="login-form">
          <div className="login-header">
            <div className="login-icon">⏳</div>
            <div>Загрузка...</div>
          </div>
        </div>
      </div>
    );
  }

  if (!user) {
    return <LoginForm onLogin={setUser} />;
  }

  return (
    <div className="container">
      <header className="header">
        <h1>🎥 ASKR Camera System v2.1</h1>
        <div className="user-info">
          <span>Привет, {user.username}!</span>
          <button className="btn btn-danger" onClick={handleLogout}>
            Выйти
          </button>
        </div>
      </header>

      <div className="stats-grid">
        <div className="stat-card status-online">
          <div className="stat-value">{activeCamerasCount}</div>
          <div className="stat-label">Активных камер</div>
        </div>
        <div className="stat-card status-error">
          <div className="stat-value">{errorCamerasCount}</div>
          <div className="stat-label">Ошибки камер</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{adaptiveCamerasCount}</div>
          <div className="stat-label">Адаптивных HLS</div>
        </div>
        <div className="stat-card">
          <div className="stat-value">{status?.status === 'ok' ? '✅' : '❌'}</div>
          <div className="stat-label">Статус системы</div>
        </div>
      </div>

      <div className="grid">
        <div className="card">
          <h2>📊 Статус системы</h2>
          {status ? (
            <div>
              <p><strong>Сервис:</strong> {status.service}</p>
              <p><strong>Версия:</strong> {status.version}</p>
              <p><strong>Время:</strong> {new Date(status.timestamp).toLocaleString()}</p>
              <p><strong>HLS папка:</strong> {status.hls_accessible ? '✅ Доступна' : '❌ Недоступна'}</p>
              <p><strong>Legacy камер:</strong> {status.legacy_cameras || 0}</p>
              <p><strong>Адаптивных камер:</strong> {status.adaptive_cameras || 0}</p>
              <button className="btn btn-primary btn-equal" onClick={loadStatus}>
                🔄 Обновить
              </button>
            </div>
          ) : (
            <p>Загрузка данных...</p>
          )}
        </div>

        <div className="card">
          <h2>📹 Управление камерами</h2>
          <p>Активных: <strong style={{color: '#16a34a'}}>{activeCamerasCount}</strong></p>
          <p>Ошибки: <strong style={{color: '#dc2626'}}>{errorCamerasCount}</strong></p>
          <p>Неактивных: <strong style={{color: '#64748b'}}>{inactiveCamerasCount}</strong></p>
          <p>Адаптивных: <strong style={{color: '#2563eb'}}>{adaptiveCamerasCount}</strong></p>
          <div className="camera-controls">
            <button className="btn btn-primary" onClick={handleStartAll}>
              ▶️ Запустить доступные
            </button>
            <button className="btn btn-danger" onClick={handleStopAll}>
              ⏹️ Остановить все
            </button>
          </div>
        </div>
      </div>

      <div className="card">
        <div className="cameras-header">
          <h2>🎬 Камеры (24)</h2>
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <span style={{ fontSize: '12px', color: '#64748b' }}>
              🟢 Активна ({activeCamerasCount}) | 
              🔴 Ошибка ({errorCamerasCount}) | 
              ⚫ Неактивна ({inactiveCamerasCount})
            </span>
            <button 
              className="btn btn-primary" 
              onClick={loadCameras}
              disabled={camerasLoading}
            >
              {camerasLoading ? '⏳ Загрузка...' : '📋 Обновить список'}
            </button>
          </div>
        </div>

        {cameras.length === 0 ? (
          <div className="cameras-empty">
            <div className="cameras-empty-icon">📷</div>
            <div>Загружаем 24 камеры...</div>
            <button className="btn btn-primary" onClick={loadCameras}>
              🔄 Загрузить камеры
            </button>
          </div>
        ) : (
          <div className="cameras-grid">
            {cameras.map(camera => (
              <CameraCard
                key={camera.id}
                camera={camera}
                onDelete={handleCameraDelete}
                onUnauthorized={handleUnauthorized}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default App;