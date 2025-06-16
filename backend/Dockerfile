# ASKR Camera System - Production Dockerfile
FROM node:20-alpine

# Установка FFmpeg и системных зависимостей
RUN apk add --no-cache \
    ffmpeg \
    postgresql-client \
    tzdata \
    curl \
    bash

# Создание пользователя приложения
RUN addgroup -g 1001 -S askr && \
    adduser -S askr -u 1001 -G askr

# Рабочая директория
WORKDIR /app

# Копирование package.json и установка зависимостей
COPY package*.json ./
RUN npm ci --only=production && npm cache clean --force

# Копирование исходного кода
COPY . .

# Генерация Prisma Client
COPY prisma ./prisma/
RUN npx prisma generate

# Создание директорий для HLS и записей
RUN mkdir -p /app/output /app/recordings && \
    chown -R askr:askr /app

# Переключение на пользователя приложения
USER askr

# Настройка часового пояса
ENV TZ=Europe/Moscow

# Порты
EXPOSE 8080

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/status || exit 1

# Команда запуска
CMD ["npm", "start"]