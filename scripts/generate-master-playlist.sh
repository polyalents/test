#!/bin/bash
# ASKR Camera System - Master Playlist Generator
# Создает master.m3u8 плейлист для адаптивного стриминга

CAMERA_ID=${1:-1}
OUTPUT_DIR=${HLS_DIR:-/root/askr-webcam-encoder/output}
CAMERA_DIR="${OUTPUT_DIR}/camera_${CAMERA_ID}"

# Создаем master плейлист
cat > "${CAMERA_DIR}/master.m3u8" << EOF
#EXTM3U
#EXT-X-VERSION:3
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=640x360,CODECS="avc1.66.30,mp4a.40.2"
360p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=1600000,RESOLUTION=854x480,CODECS="avc1.66.30,mp4a.40.2"
480p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=3200000,RESOLUTION=1280x720,CODECS="avc1.66.30,mp4a.40.2"
720p/playlist.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=6000000,RESOLUTION=1920x1080,CODECS="avc1.66.30,mp4a.40.2"
1080p/playlist.m3u8
EOF

echo "Master playlist created for Camera ${CAMERA_ID}"