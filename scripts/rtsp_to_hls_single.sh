#!/bin/bash
# 
# Исправленный скрипт для запуска адаптивного HLS с несколькими битрейтами
# Создает структуру папок как ожидает backend
# Аргумент: номер камеры (1-24)
#

set -euo pipefail

# Проверяем аргументы
if [[ $# -ne 1 ]]; then
    echo "❌ Использование: $0 <номер_камеры>" >&2
    exit 1
fi

cam_id="$1"

# Проверяем корректность номера камеры
if ! [[ "$cam_id" =~ ^[1-9]$|^1[0-9]$|^2[0-4]$ ]]; then
    echo "❌ Некорректный номер камеры: $cam_id (допустимо: 1-24)" >&2
    exit 1
fi

output_dir="./output"
camera_dir="$output_dir/camera_$cam_id"

# Создаем структуру папок для разных качеств
mkdir -p "$camera_dir/360p"
mkdir -p "$camera_dir/480p" 
mkdir -p "$camera_dir/720p"
mkdir -p "$camera_dir/1080p"

# Загрузка .env из папки backend
if [[ -f "../backend/.env" ]]; then
    export $(grep -v '^#' ../backend/.env | xargs)
    echo "✅ Загружен .env файл из backend/"
elif [[ -f ".env" ]]; then
    export $(grep -v '^#' .env | xargs)
    echo "✅ Загружен .env файл из текущей папки"
else
    echo "❌ .env не найден ни в scripts/, ни в backend/!"
    echo "Текущая папка: $(pwd)"
    exit 1
fi

# Проверяем, что все ключевые переменные загружены
if [[ -z "$RTSP_BASE_IP" || -z "$RTSP_PORT" || -z "$RTSP_USER" || -z "$RTSP_PASS" ]]; then
    echo "❌ Ошибка: .env файл не содержит все необходимые переменные (RTSP_BASE_IP, RTSP_PORT, RTSP_USER, RTSP_PASS)"
    exit 1
fi

# Функция для определения IP камеры
get_camera_ip() {
    local cam_id=$1
    # Если нужно, здесь можно добавить логику для разных IP камер
    echo "$RTSP_BASE_IP"
}

# Функция очистки файлов камеры
clean_camera_files() {
    local cam_id=$1
    if [[ -d "$camera_dir" ]]; then
        rm -f "$camera_dir"/*.m3u8 2>/dev/null || true
        rm -f "$camera_dir"/*/*.m3u8 2>/dev/null || true
        rm -f "$camera_dir"/*/*.ts 2>/dev/null || true
        echo "Очищены старые файлы камеры $cam_id"
    fi
}

# Проверка доступности камеры
check_camera_online() {
    local cam_id=$1
    local camera_ip
    local rtsp_url
    local error_file
    
    echo "🔍 Проверяем камеру $cam_id..."
    
    camera_ip=$(get_camera_ip "$cam_id")
    rtsp_url="rtsp://${RTSP_USER}:${RTSP_PASS}@${camera_ip}:${RTSP_PORT}/chID=$cam_id"
    
    # Создаем временный файл для ошибок
    error_file=$(mktemp)
    
    # Используем ffprobe для быстрой проверки потока
    if timeout 10s ffprobe \
        -rtsp_transport tcp \
        -i "$rtsp_url" \
        -v quiet \
        -select_streams v:0 \
        -show_entries stream=codec_name \
        -of csv=p=0 2>"$error_file"; then
        
        echo "✅ RTSP поток найден, проверяем видеоданные..."
        
        # Быстрая проверка реального потока данных
        if ffmpeg \
            -rtsp_transport tcp \
            -i "$rtsp_url" \
            -t 2 \
            -f null \
            - 2>"$error_file"; then
            
            echo "✅ Камера $cam_id успешно проверена"
            rm -f "$error_file"
            return 0
        fi
    fi
    
    # Диагностика ошибок
    echo "❌ Камера $cam_id недоступна:" >&2
    if grep -q "Invalid data found when processing input" "$error_file"; then
        echo "   📹 Не передает корректный видеопоток" >&2
    elif grep -q "Connection refused\|Connection timed out\|No route to host" "$error_file"; then
        echo "   🔗 Проблема с сетевым подключением" >&2
    elif grep -q "401 Unauthorized\|403 Forbidden" "$error_file"; then
        echo "   🔐 Проблема с авторизацией" >&2
    elif grep -q "404 Not Found\|Stream not found" "$error_file"; then
        echo "   📹 Камера не найдена (неверный chID?)" >&2
    else
        echo "   ❓ Неизвестная ошибка" >&2
    fi
    
    rm -f "$error_file"
    return 1
}

# Основная функция стриминга с мультибитрейтом
stream_camera() {
    local cam_id=$1
    local camera_ip
    local rtsp_url
    
    # Проверяем камеру
    if ! check_camera_online "$cam_id"; then
        echo "❌ Камера $cam_id не онлайн или недоступна!" >&2
        exit 1
    fi
    
    echo "✅ Камера $cam_id онлайн, запускаем адаптивный HLS стрим..."
    
    # Очищаем старые файлы
    clean_camera_files "$cam_id"
    
    camera_ip=$(get_camera_ip "$cam_id")
    rtsp_url="rtsp://${RTSP_USER}:${RTSP_PASS}@${camera_ip}:${RTSP_PORT}/chID=$cam_id"
    
    echo "🎥 Адаптивный HLS стрим камеры $cam_id запущен"
    echo "📁 Выход: $camera_dir/"
    echo "🔗 RTSP URL: rtsp://***:***@${camera_ip}:${RTSP_PORT}/chID=$cam_id"
    echo "📺 Качества: 360p, 480p, 720p, 1080p"
    
    # Обработка сигналов для graceful shutdown
    trap 'echo ""; echo "Получен сигнал завершения, останавливаем стрим камеры '$cam_id'..."; exit 0' SIGINT SIGTERM
    
    # Запускаем адаптивный HLS стрим с несколькими битрейтами
    exec ffmpeg \
        -rtsp_transport tcp \
        -i "$rtsp_url" \
        -c:v libx264 \
        -preset veryfast \
        -tune zerolatency \
        -c:a aac \
        \
        -map 0:v:0 -map 0:a:0 \
        -map 0:v:0 -map 0:a:0 \
        -map 0:v:0 -map 0:a:0 \
        -map 0:v:0 -map 0:a:0 \
        \
        -s:v:0 640x360   -b:v:0 800k  -maxrate:v:0 900k  -bufsize:v:0 1600k -b:a:0 64k \
        -s:v:1 854x480   -b:v:1 1400k -maxrate:v:1 1500k -bufsize:v:1 2800k -b:a:1 96k \
        -s:v:2 1280x720  -b:v:2 2800k -maxrate:v:2 3000k -bufsize:v:2 5600k -b:a:2 128k \
        -s:v:3 1920x1080 -b:v:3 5000k -maxrate:v:3 5500k -bufsize:v:3 10000k -b:a:3 128k \
        \
        -f hls \
        -hls_time 2 \
        -hls_list_size 6 \
        -hls_flags delete_segments+independent_segments \
        \
        -hls_segment_filename "$camera_dir/360p/segment_%03d.ts" \
        "$camera_dir/360p/playlist.m3u8" \
        \
        -hls_segment_filename "$camera_dir/480p/segment_%03d.ts" \
        "$camera_dir/480p/playlist.m3u8" \
        \
        -hls_segment_filename "$camera_dir/720p/segment_%03d.ts" \
        "$camera_dir/720p/playlist.m3u8" \
        \
        -hls_segment_filename "$camera_dir/1080p/segment_%03d.ts" \
        "$camera_dir/1080p/playlist.m3u8" \
        \
        -hide_banner \
        -loglevel info
}

# Создание master playlist файла
create_master_playlist() {
    local cam_id=$1
    local master_file="$camera_dir/master.m3u8"
    
    cat > "$master_file" << EOF
#EXTM3U
#EXT-X-VERSION:6
#EXT-X-STREAM-INF:BANDWIDTH=864000,RESOLUTION=640x360,CODECS="avc1.42e00a,mp4a.40.2"
360p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1496000,RESOLUTION=854x480,CODECS="avc1.42e01e,mp4a.40.2"
480p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=2928000,RESOLUTION=1280x720,CODECS="avc1.42e01f,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=5128000,RESOLUTION=1920x1080,CODECS="avc1.42e028,mp4a.40.2"
1080p/playlist.m3u8
EOF
    
    echo "✅ Создан master playlist: $master_file"
}

# Запуск
echo "Запуск адаптивного RTSP to HLS для камеры $cam_id"

# Создаем master playlist
create_master_playlist "$cam_id"

# Запускаем стрим
stream_camera "$cam_id"