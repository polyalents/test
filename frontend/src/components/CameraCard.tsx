import React, { useRef, useEffect, useState } from 'react';

interface Camera {
  id: string;
  name: string;
  rtsp_url: string;
  hls_url: string;
  status: 'active' | 'inactive' | 'error';
  resolution?: string;
  fps?: number;
  last_frame?: string;
}

interface Quality {
  quality: string;
  resolution: string;
  bitrate: number | string;
  available: boolean;
  legacy?: boolean;
}

interface CameraCardProps {
  camera: Camera;
  onDelete: (cameraId: string) => void;
  onUnauthorized?: () => void;
}

const CameraCard: React.FC<CameraCardProps> = ({ camera, onDelete, onUnauthorized }) => {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [isRecording, setIsRecording] = useState(false);
  const [recordingStartTime, setRecordingStartTime] = useState<Date | null>(null);
  const [recordedFile, setRecordedFile] = useState<string | null>(null);
  
  // СОСТОЯНИЯ ДЛЯ КАЧЕСТВА (упрощенные для legacy)
  const [qualities, setQualities] = useState<Quality[]>([]);
  const [selectedQuality, setSelectedQuality] = useState<string>('auto');
  const [adaptiveSupported, setAdaptiveSupported] = useState(false);
  const [isLegacyFormat, setIsLegacyFormat] = useState(true);

  const cameraNumber = camera.id.replace('camera_', '');

  // ЗАГРУЖАЕМ ДОСТУПНЫЕ КАЧЕСТВА
  const loadQualities = async () => {
    try {
      const savedUser = localStorage.getItem('hls_user');
      if (!savedUser) return;
      
      const user = JSON.parse(savedUser);
      const response = await fetch(`http://176.98.178.23:8080/api/camera/${cameraNumber}/qualities`, {
        headers: {
          'Authorization': `Bearer ${user.token}`
        }
      });

      if (response.ok) {
        const data = await response.json();
        setQualities(data.qualities || []);
        setAdaptiveSupported(data.adaptiveSupported || false);
        setIsLegacyFormat(data.format === 'legacy' || !data.adaptiveSupported);
        console.log(`Camera ${cameraNumber} qualities:`, data);
        
        // Для legacy формата всегда ставим 'auto'
        if (data.format === 'legacy' || !data.adaptiveSupported) {
          setSelectedQuality('auto');
        }
      }
    } catch (error) {
      console.log('Qualities not available for camera', cameraNumber);
      setAdaptiveSupported(false);
      setIsLegacyFormat(true);
      setQualities([]);
    }
  };

  // ПОЛУЧАЕМ HLS URL - упрощенно для legacy
  const getHlsUrl = () => {
    const savedUser = localStorage.getItem('hls_user');
    if (!savedUser) return '';
    
    const user = JSON.parse(savedUser);
    const token = user.token;
    const baseUrl = `http://176.98.178.23:8080/stream/${cameraNumber}/playlist.m3u8`;
    
    // Для legacy формата всегда используем базовый URL без параметра quality
    if (isLegacyFormat) {
      return `${baseUrl}?token=${token}`;
    }
    
    // Для adaptive формата (если есть)
    if (selectedQuality === 'auto') {
      return `${baseUrl}?token=${token}`;
    } else {
      return `${baseUrl}?quality=${selectedQuality}&token=${token}`;
    }
  };

  // ОБРАБОТЧИК СМЕНЫ КАЧЕСТВА (только для adaptive)
  const handleQualityChange = async (quality: string) => {
    if (isLegacyFormat) {
      console.log('Quality change not supported for legacy format');
      return;
    }
    
    setSelectedQuality(quality);
    
    // Если видео играет - перезапускаем с новым качеством
    if (isPlaying) {
      setLoading(true);
      stopStream();
      setTimeout(() => {
        startStream();
      }, 500);
    }
  };

  const startRecording = async () => {
    try {
      const savedUser = localStorage.getItem('hls_user');
      if (!savedUser) return;
      
      const user = JSON.parse(savedUser);
      
      console.log(`Starting recording for camera ${cameraNumber}`);
      
      const response = await fetch(`http://176.98.178.23:8080/api/camera/${cameraNumber}/start-recording`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsRecording(true);
        setRecordingStartTime(new Date());
        setRecordedFile(null);
        console.log(`Запись камеры ${cameraNumber} начата:`, data.filename);
      } else {
        const error = await response.json();
        console.error(`Recording error for camera ${cameraNumber}:`, error);
        alert(`Ошибка записи: ${error.error}`);
      }
    } catch (error) {
      console.error('Ошибка запуска записи:', error);
      alert('Ошибка запуска записи');
    }
  };

  const stopRecording = async () => {
    try {
      const savedUser = localStorage.getItem('hls_user');
      if (!savedUser) return;
      
      const user = JSON.parse(savedUser);
      
      console.log(`Stopping recording for camera ${cameraNumber}`);
      
      const response = await fetch(`http://176.98.178.23:8080/api/camera/${cameraNumber}/stop-recording`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${user.token}` }
      });
      
      if (response.ok) {
        const data = await response.json();
        setIsRecording(false);
        setRecordedFile(data.filename);
        console.log(`Запись камеры ${cameraNumber} остановлена:`, data.filename);
      } else {
        const error = await response.json();
        console.error(`Stop recording error for camera ${cameraNumber}:`, error);
        alert(`Ошибка остановки записи: ${error.error}`);
      }
    } catch (error) {
      console.error('Ошибка остановки записи:', error);
      alert('Ошибка остановки записи');
    }
  };

  const downloadRecording = () => {
    if (recordedFile) {
      const savedUser = localStorage.getItem('hls_user');
      if (!savedUser) return;
      
      const user = JSON.parse(savedUser);
      
      const link = document.createElement('a');
      link.href = `http://176.98.178.23:8080/api/recordings/${recordedFile}?token=${user.token}`;
      link.download = recordedFile;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      
      console.log(`Скачивание файла: ${recordedFile} (camera ${cameraNumber})`);
    }
  };

  const startStream = async () => {
    if (!videoRef.current) return;
    
    setLoading(true);
    setError(null);
    
    try {
      const hlsUrl = getHlsUrl();
      if (!hlsUrl) {
        throw new Error('Не авторизован');
      }
      
      console.log(`Запрашиваем HLS для камеры ${cameraNumber} (${isLegacyFormat ? 'legacy' : selectedQuality}):`, hlsUrl);
      
      // Проверяем доступность HLS потока
      const response = await fetch(hlsUrl);
      
      if (response.status === 401) {
        console.log('Токен истек для HLS потока');
        if (onUnauthorized) {
          onUnauthorized();
        }
        throw new Error('Необходимо перелогиниться');
      }
      
      if (!response.ok) {
        throw new Error(`HLS поток недоступен (${response.status})`);
      }

      const content = await response.text();
      console.log(`HLS содержимое для камеры ${cameraNumber}:`, content.substring(0, 200) + '...');
      
      if (!content.includes('#EXTM3U')) {
        throw new Error(`Неверный формат HLS потока`);
      }

      // Динамический импорт HLS.js
      const HlsModule = await import('hls.js');
      const Hls = HlsModule.default;
      
      if (Hls.isSupported()) {
        const hls = new Hls({
          enableWorker: false,
          lowLatencyMode: true,
          backBufferLength: 30,
          maxBufferLength: 600,
          maxMaxBufferLength: 1200,
          liveSyncDurationCount: 3,
          liveMaxLatencyDurationCount: 10,
          manifestLoadingTimeOut: 10000,
          manifestLoadingMaxRetry: 3,
          manifestLoadingRetryDelay: 1000,
          levelLoadingTimeOut: 10000,
          fragLoadingTimeOut: 20000,
          liveDurationInfinity: true
        });
        
        hls.loadSource(hlsUrl);
        hls.attachMedia(videoRef.current);
        
        hls.on(Hls.Events.MANIFEST_PARSED, () => {
          console.log(`HLS manifest parsed for camera ${cameraNumber} (${isLegacyFormat ? 'legacy' : selectedQuality})`);
          videoRef.current?.play().then(() => {
            setIsPlaying(true);
            setLoading(false);
          }).catch(err => {
            console.error(`Ошибка воспроизведения camera ${cameraNumber}:`, err);
            setError('Ошибка воспроизведения видео');
            setLoading(false);
          });
        });

        // Отслеживаем изменения уровня только для адаптивных потоков
        if (!isLegacyFormat) {
          hls.on(Hls.Events.LEVEL_SWITCHED, (event, data) => {
            if (hls.levels && hls.levels[data.level]) {
              const level = hls.levels[data.level];
              console.log(`Camera ${cameraNumber} switched to level ${data.level}, bitrate: ${level.bitrate}`);
            }
          });
        }
        
        hls.on(Hls.Events.LEVEL_LOADED, () => {
          console.log(`New level loaded for camera ${cameraNumber}`);
        });
        
        hls.on(Hls.Events.ERROR, (event, data) => {
          console.error(`HLS error for camera ${cameraNumber}:`, data);
          if (data.fatal) {
            setError(`Критическая ошибка HLS: ${data.type}`);
            setLoading(false);
          }
        });
        
        // Сохраняем инстанс для очистки
        (videoRef.current as any).hls = hls;
        
        // Принудительное обновление плейлиста каждые 5 секунд
        const refreshInterval = setInterval(() => {
          if (hls && !hls.destroyed) {
            hls.loadLevel = -1;
          }
        }, 5000);
        
        (videoRef.current as any).refreshInterval = refreshInterval;
      } else if (videoRef.current.canPlayType('application/vnd.apple.mpegurl')) {
        // Safari поддерживает HLS нативно
        videoRef.current.src = hlsUrl;
        await videoRef.current.play();
        setIsPlaying(true);
        setLoading(false);
      } else {
        throw new Error('HLS не поддерживается браузером');
      }
    } catch (err: any) {
      console.error(`Ошибка запуска потока camera ${cameraNumber}:`, err);
      setError(err.message || 'Неизвестная ошибка');
      setLoading(false);
    }
  };

  const stopStream = () => {
    if (videoRef.current) {
      const hls = (videoRef.current as any).hls;
      const refreshInterval = (videoRef.current as any).refreshInterval;
      
      if (refreshInterval) {
        clearInterval(refreshInterval);
        (videoRef.current as any).refreshInterval = null;
      }
      
      if (hls) {
        hls.destroy();
        (videoRef.current as any).hls = null;
      }
      videoRef.current.pause();
      videoRef.current.src = '';
      setIsPlaying(false);
      setError(null);
    }
  };

  // Загружаем качества при монтировании
  useEffect(() => {
    if (camera.status === 'active') {
      loadQualities();
    }
    return () => {
      stopStream();
    };
  }, [camera.status]);

  const getStatusColor = () => {
    switch (camera.status) {
      case 'active': return '#16a34a';
      case 'error': return '#dc2626';
      default: return '#64748b';
    }
  };

  const getStatusText = () => {
    switch (camera.status) {
      case 'active': return '🟢 Активна';
      case 'error': return '🔴 Ошибка';
      default: return '⚫ Неактивна';
    }
  };

  return (
    <div className="camera-card">
      <div className="camera-header">
        <h3 className="camera-name">{camera.name}</h3>
        <div className="camera-status" style={{ color: getStatusColor() }}>
          {getStatusText()}
        </div>
      </div>

      {/* СЕЛЕКТОР КАЧЕСТВА - ТОЛЬКО ДЛЯ ADAPTIVE HLS */}
      {adaptiveSupported && !isLegacyFormat && qualities.length > 1 && (
        <div className="quality-selector">
          <label style={{ fontSize: '12px', marginBottom: '4px', display: 'block', color: '#64748b' }}>
            🎥 Качество видео:
          </label>
          <select 
            value={selectedQuality}
            onChange={(e) => handleQualityChange(e.target.value)}
            style={{
              width: '100%',
              padding: '4px 8px',
              fontSize: '12px',
              border: '1px solid #d1d5db',
              borderRadius: '4px',
              backgroundColor: '#fff',
              marginBottom: '8px'
            }}
            disabled={loading}
          >
            <option value="auto">🎯 Автоматически</option>
            {qualities.filter(q => !q.legacy).map((q) => (
              <option key={q.quality} value={q.quality}>
                📺 {q.quality.toUpperCase()} ({q.resolution}, {typeof q.bitrate === 'number' ? `${Math.round(q.bitrate / 1000)}K` : q.bitrate})
              </option>
            ))}
          </select>
        </div>
      )}

      {/* ИНДИКАТОР LEGACY FORMAT */}
      {isLegacyFormat && (
        <div style={{ 
          fontSize: '11px', 
          color: '#64748b', 
          marginBottom: '8px',
          padding: '4px 8px',
          backgroundColor: '#f8fafc',
          borderRadius: '4px',
          border: '1px solid #e2e8f0'
        }}>
          📺 Стандартное качество (Legacy HLS)
        </div>
      )}

      <div 
        className="camera-video-container" 
        data-status={camera.status}
        data-camera-id={cameraNumber}
      >
        {error ? (
          <div className="camera-error">
            <div className="camera-error-icon">❌</div>
            <div className="camera-error-text">{error}</div>
            <button className="btn btn-primary btn-small" onClick={() => {
              setError(null);
              startStream();
            }}>
              🔄 Повторить
            </button>
          </div>
        ) : (
          <video
            ref={videoRef}
            className="camera-video"
            controls={isPlaying}
            muted
            autoPlay={false}
            playsInline
            poster="data:image/svg+xml;base64,PHN2ZyB3aWR0aD0iNDAwIiBoZWlnaHQ9IjI0MCIgeG1sbnM9Imh0dHA6Ly93d3cudzMub3JnLzIwMDAvc3ZnIj48cmVjdCB3aWR0aD0iMTAwJSIgaGVpZ2h0PSIxMDAlIiBmaWxsPSIjMGYxNzJhIi8+PHRleHQgeD0iNTAlIiB5PSI1MCUiIGZvbnQtZmFtaWx5PSJBcmlhbCIgZm9udC1zaXplPSIxNiIgZmlsbD0iIzY0NzQ4YiIgdGV4dC1hbmNob3I9Im1pZGRsZSIgZHk9Ii4zZW0iPvCfk7kg0JrQsNC80LXRgNCwPC90ZXh0Pjwvc3ZnPg=="
          />
        )}
        
        {loading && (
          <div className="camera-loading">
            <div className="loading-spinner">⏳</div>
            <div>Загрузка потока...</div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>
              Камера {cameraNumber} {isLegacyFormat ? '(Legacy)' : `(${selectedQuality})`}
            </div>
          </div>
        )}
      </div>

      <div className="camera-info">
        <div className="camera-info-item">
          <span>ID:</span> 
          <div className="info-value">camera_{cameraNumber}</div>
        </div>
        <div className="camera-info-item">
          <span>Статус:</span> 
          <div className="info-value">{camera.status}</div>
        </div>
        
        {/* ИНФОРМАЦИЯ О ФОРМАТЕ */}
        <div className="camera-info-item">
          <span>Формат:</span> 
          <div className="info-value" style={{ color: isLegacyFormat ? '#64748b' : '#16a34a' }}>
            {isLegacyFormat ? '📺 Legacy HLS' : '🎯 Adaptive HLS'}
          </div>
        </div>
        
        <div className="camera-info-item">
          <span>Время:</span> 
          <div className="info-value">{new Date().toLocaleString('ru-RU', {
            day: '2-digit',
            month: '2-digit', 
            year: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
          })}</div>
        </div>
        
        {isRecording && (
          <div className="camera-info-item">
            <span>📹 Запись:</span> 
            <div className="info-value" style={{color: '#ef4444'}}>
              {recordingStartTime ? 
                Math.floor((Date.now() - recordingStartTime.getTime()) / 1000) + 'с' 
                : 'Идет...'}
            </div>
          </div>
        )}
        
        {recordedFile && (
          <div className="camera-info-item">
            <span>💾 Файл:</span> 
            <div className="info-value" style={{color: '#16a34a', fontSize: '10px'}}>
              {recordedFile}
            </div>
          </div>
        )}
        
        {camera.resolution && (
          <div className="camera-info-item">
            <span>Разрешение:</span> 
            <div className="info-value">{camera.resolution}</div>
          </div>
        )}
        
        {camera.fps && (
          <div className="camera-info-item">
            <span>FPS:</span> 
            <div className="info-value">{camera.fps}</div>
          </div>
        )}
      </div>

      <div className="camera-controls">
        {!isPlaying ? (
          <button 
            className="btn btn-success"
            onClick={startStream}
            disabled={loading || camera.status !== 'active'}
            title="Запустить просмотр камеры"
          >
            {loading ? '⏳ Загрузка...' : '▶️ Смотреть'}
          </button>
        ) : (
          <button 
            className="btn btn-danger"
            onClick={stopStream}
            title="Остановить просмотр"
          >
            ⏹️ Остановить
          </button>
        )}
        
        {!isRecording ? (
          <button 
            className="btn btn-primary"
            onClick={startRecording}
            disabled={camera.status !== 'active'}
            title="Начать запись"
          >
            🎬 Запись
          </button>
        ) : (
          <button 
            className="btn btn-warning"
            onClick={stopRecording}
            title="Остановить запись"
          >
            ⏸️ Стоп запись
          </button>
        )}
        
        {recordedFile && (
          <button 
            className="btn btn-success"
            onClick={downloadRecording}
            title="Скачать запись"
          >
            💾 Скачать
          </button>
        )}
        
        <button 
          className="btn btn-danger"
          onClick={() => onDelete(camera.id)}
          title="Удалить камеру из списка"
        >
          🗑️ Удалить
        </button>
      </div>
    </div>
  );
};

export default CameraCard;