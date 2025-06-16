import React, { useState } from 'react';
import { apiClient } from '../services/api';

interface LoginFormProps {
  onLogin: (user: any) => void;
}

const LoginForm: React.FC<LoginFormProps> = ({ onLogin }) => {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError('');

    try {
      const response = await apiClient.login(username, password);
      localStorage.setItem('hls_user', JSON.stringify(response));
      onLogin(response);
    } catch (error: any) {
      console.error('Ошибка авторизации:', error);
      setError(error.message || 'Ошибка авторизации');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-container">
      <div className="login-form">
        <div className="login-header">
          <div className="login-icon">🎥</div>
          <h2>ASKR Camera System</h2>
          <p className="login-subtitle">
            Войдите в систему для управления камерами
          </p>
        </div>

        <form onSubmit={handleSubmit}>
          {error && (
            <div className="error-message">
              ❌ {error}
            </div>
          )}

          <div className="form-group">
            <label className="form-label">
              👤 Имя пользователя
            </label>
            <input
              type="text"
              className="form-input"
              placeholder="Введите имя пользователя"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <div className="form-group">
            <label className="form-label">
              🔒 Пароль
            </label>
            <input
              type="password"
              className="form-input"
              placeholder="Введите пароль"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              disabled={loading}
              required
            />
          </div>

          <button
            type="submit"
            className={`btn btn-primary btn-full ${loading ? 'btn-loading' : ''}`}
            disabled={loading}
          >
            {loading ? '⏳ Вход...' : '🚀 Войти в систему'}
          </button>
        </form>

        <div className="test-credentials">
          <div className="test-credentials-title">
            💡 Тестовые данные для входа:
          </div>
          <div className="test-credentials-data">
            <div>Пользователь: <code>admin</code></div>
            <div>Пароль: <code>password</code></div>
          </div>
        </div>

        <div className="login-footer">
          ASKR Webcam Encoder System v1.0
        </div>
      </div>
    </div>
  );
};

export default LoginForm;