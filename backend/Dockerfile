FROM node:20-slim

# Установка системных зависимостей
RUN apt-get update && apt-get install -y \
    ffmpeg \
    postgresql-client \
    curl \
    bash \
    openssl \
    && rm -rf /var/lib/apt/lists/*

# Создание пользователя
RUN groupadd -r askr && useradd -r -g askr askr

WORKDIR /app

# Копируем package.json и Prisma schema
COPY package.json ./
COPY prisma ./prisma/

# Устанавливаем зависимости и генерируем Prisma клиент
RUN npm install --omit=dev && \
    npx prisma generate && \
    npm cache clean --force

# Копируем остальные файлы
COPY . .

# Создаем директории и даем права
RUN mkdir -p /app/output /app/recordings && \
    chown -R askr:askr /app

USER askr

ENV TZ=Europe/Moscow

EXPOSE 8080

HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD curl -f http://localhost:8080/status || exit 1

CMD ["npm", "start"]
