#!/bin/bash
# ASKR Camera System - Adaptive HLS Stream Generator
# Создает адаптивные HLS потоки в разных качествах

CAMERA_ID=${1:-1}
OUTPUT_DIR=${HLS_DIR:-/root/askr-webcam-encoder/output}

# Создать директории для каждого качества
CAMERA_DIR="${OUTPUT_DIR}/camera_${CAMERA_ID}"
mkdir -p "${CAMERA_DIR}/360p"
mkdir -p "${CAMERA_DIR}/480p" 
mkdir -p "${CAMERA_DIR}/720p"
mkdir -p "${CAMERA_DIR}/1080p"

# RTSP URL из env переменных
RTSP_URL="rtsp://${RTSP_USER}:${RTSP_PASS}@${RTSP_BASE_IP}:${RTSP_PORT}/chID=${CAMERA_ID}"

echo "Starting adaptive HLS for Camera ${CAMERA_ID}"
echo "RTSP URL: ${RTSP_URL}"
echo "Output: ${CAMERA_DIR}"

# Функция graceful shutdown
cleanup() {
    echo "Stopping adaptive HLS for Camera ${CAMERA_ID}..."
    kill $FFMPEG_PID 2>/dev/null
    exit 0
}

trap cleanup SIGTERM SIGINT

# FFmpeg с множественными выходами для разных битрейтов
ffmpeg -hide_banner -loglevel error \
    -rtsp_transport tcp \
    -i "${RTSP_URL}" \
    -c:v libx264 -preset veryfast -tune zerolatency \
    -c:a aac -ac 2 -ar 44100 \
    \
    -map 0:v -map 0:a \
    -s 640x360 -b:v 800k -maxrate 900k -bufsize 1200k \
    -f hls -hls_time 4 -hls_list_size 3 -hls_flags delete_segments \
    -hls_segment_filename "${CAMERA_DIR}/360p/segment_%03d.ts" \
    "${CAMERA_DIR}/360p/playlist.m3u8" \
    \
    -map 0:v -map 0:a \
    -s 854x480 -b:v 1400k -maxrate 1600k -bufsize 2000k \
    -f hls -hls_time 4 -hls_list_size 3 -hls_flags delete_segments \
    -hls_segment_filename "${CAMERA_DIR}/480p/segment_%03d.ts" \
    "${CAMERA_DIR}/480p/playlist.m3u8" \
    \
    -map 0:v -map 0:a \
    -s 1280x720 -b:v 2800k -maxrate 3200k -bufsize 4000k \
    -f hls -hls_time 4 -hls_list_size 3 -hls_flags delete_segments \
    -hls_segment_filename "${CAMERA_DIR}/720p/segment_%03d.ts" \
    "${CAMERA_DIR}/720p/playlist.m3u8" \
    \
    -map 0:v -map 0:a \
    -s 1920x1080 -b:v 5000k -maxrate 6000k -bufsize 8000k \
    -f hls -hls_time 4 -hls_list_size 3 -hls_flags delete_segments \
    -hls_segment_filename "${CAMERA_DIR}/1080p/segment_%03d.ts" \
    "${CAMERA_DIR}/1080p/playlist.m3u8" &

FFMPEG_PID=$!

# Генерировать master плейлист после старта
sleep 5
/root/askr-webcam-encoder/scripts/generate-master-playlist.sh ${CAMERA_ID}

echo "Adaptive HLS started for Camera ${CAMERA_ID} (PID: ${FFMPEG_PID})"

# Ждать завершения
wait $FFMPEG_PID
