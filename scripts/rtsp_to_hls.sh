#!/bin/bash

echo "🔥 Выбор режима:"
echo "1 — Открыть одну камеру (foreground)"
echo "2 — Открыть несколько камер (через запятую, напр. 1,5,8)"
echo "3 — Открыть все камеры (1-24)"
echo "4 — Быстрая проверка всех камер (без записи)"
echo "5 — Очистить папку output"
echo "0 — Режим отладки (покажет детали ошибок)"
read -p "Выберите режим (0/1/2/3/4/5): " mode

output_dir="./output"
mkdir -p "$output_dir"

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

# Функция для определения IP камеры (если используются разные IP)
get_camera_ip() {
    cam_id=$1
    # Если нужно, здесь можно добавить логику для разных IP камер
    # Например: if [[ $cam_id -eq 1 ]]; then echo "192.168.10.2"; elif [[ $cam_id -eq 2 ]]; then echo "192.168.10.3"; else echo "$RTSP_BASE_IP"; fi
    echo "$RTSP_BASE_IP"
}

# Функция очистки output папки
clean_output() {
    if [[ -d "$output_dir" ]]; then
        file_count=$(find "$output_dir" -name "*.m3u8" -o -name "*.ts" 2>/dev/null | wc -l)
        if [[ $file_count -gt 0 ]]; then
            echo "🧹 Найдено $file_count старых файлов в папке output"
            read -p "Удалить все старые файлы? (y/N): " confirm
            if [[ "$confirm" =~ ^[Yy]$ ]]; then
                rm -f "$output_dir"/*.m3u8 "$output_dir"/*.ts 2>/dev/null
                echo "✅ Папка output очищена"
            else
                echo "↩️ Очистка отменена"
            fi
        else
            echo "✨ Папка output уже пуста"
        fi
    else
        echo "📁 Папка output не существует"
    fi
}

# Функция очистки файлов конкретной камеры
clean_camera_files() {
    cam_id=$1
    if [[ -d "$output_dir" ]]; then
        rm -f "$output_dir"/camera_${cam_id}.m3u8 "$output_dir"/camera_${cam_id}_*.ts 2>/dev/null
        echo "🧹 Очищены старые файлы камеры $cam_id"
    fi
}

# Проверяем онлайн ли камера
check_camera_online() {
    cam_id=$1
    check_only=${2:-false}  # Второй параметр - только проверка без запуска стрима
    
    if [[ "$check_only" == "false" ]]; then
        echo "🔍 Проверяем камеру $cam_id..."
    fi
    
    camera_ip=$(get_camera_ip $cam_id)
    rtsp_url="rtsp://${RTSP_USER}:${RTSP_PASS}@${camera_ip}:${RTSP_PORT}/chID=$cam_id"
    
    # Создаем временный файл для ошибок
    error_file=$(mktemp)
    
    # Сначала проверяем доступность порта (только в режиме отладки)
    if [[ "$DEBUG" == "1" ]]; then
        echo "🔗 Проверяем доступность ${camera_ip}:${RTSP_PORT}..."
        timeout 5 nc -z "$camera_ip" "$RTSP_PORT" && echo "✅ Порт доступен" || echo "❌ Порт недоступен"
    fi
    
    # Используем ffprobe для быстрой проверки потока
    if [[ "$check_only" == "false" && "$DEBUG" != "1" ]]; then
        echo "🔍 Проверяем RTSP поток..."
    fi
    
    timeout 10s ffprobe \
        -rtsp_transport tcp \
        -i "$rtsp_url" \
        -v quiet \
        -select_streams v:0 \
        -show_entries stream=codec_name \
        -of csv=p=0 2>"$error_file"
    
    result=$?
    
    # Если ffprobe прошел успешно, делаем дополнительную проверку через ffmpeg
    if [[ $result -eq 0 ]]; then
        if [[ "$check_only" == "false" && "$DEBUG" != "1" ]]; then
            echo "✅ RTSP поток найден, проверяем видеоданные..."
        fi
        # Быстрая проверка реального потока данных без timeout
        ffmpeg \
            -rtsp_transport tcp \
            -i "$rtsp_url" \
            -t 2 \
            -f null \
            - 2>"$error_file"
        result=$?
    fi
    
    # Если есть отладочный режим, показываем ошибки
    if [[ "$DEBUG" == "1" ]]; then
        echo "--- Отладка для камеры $cam_id ---"
        echo "RTSP URL: $rtsp_url"
        echo "Exit code: $result"
        echo "Последние строки ошибок:"
        tail -15 "$error_file" | grep -v "configuration:\|built with\|lib[a-z]*[[:space:]]*[0-9]"
        echo "--- Конец отладки ---"
    fi
    
    # Определяем статус камеры
    if [[ $result -eq 0 ]]; then
        if [[ "$check_only" == "true" ]]; then
            echo "✅ Камера $cam_id: ОНЛАЙН"
        else
            echo "✅ Камера $cam_id успешно проверена"
        fi
    else
        if [[ "$check_only" == "true" ]]; then
            if [[ $result -eq 124 ]]; then
                echo "⏱️ Камера $cam_id: ОФЛАЙН (таймаут)"
            else
                echo "❌ Камера $cam_id: ОФЛАЙН"
            fi
        else
            # Подробная диагностика только для режимов запуска стримов
            if grep -q "Invalid data found when processing input" "$error_file"; then
                echo "📹 Камера $cam_id не передает корректный видеопоток (офлайн)"
            elif grep -q "Connection refused\|Connection timed out\|No route to host" "$error_file"; then
                echo "🔗 Проблема с сетевым подключением к камере $cam_id"
            elif grep -q "401 Unauthorized\|403 Forbidden" "$error_file"; then
                echo "🔐 Проблема с авторизацией для камеры $cam_id"
            elif grep -q "404 Not Found\|Stream not found" "$error_file"; then
                echo "📹 Камера $cam_id не найдена (неверный chID?)"
            elif grep -q "Input/output error\|Server returned 404" "$error_file"; then
                echo "🚫 Камера $cam_id вернула ошибку сервера"
            elif [[ $result -eq 124 ]]; then
                echo "⏱️ Камера $cam_id не отвечает (таймаут при проверке потока)"
            else
                echo "❓ Неизвестная ошибка для камеры $cam_id (код: $result)"
            fi
        fi
    fi
    
    # Удаляем временный файл
    rm -f "$error_file"
    
    return $result
}

# Быстрая проверка всех камер
quick_check_all_cameras() {
    echo "🔍 Быстрая проверка всех камер (1-24)..."
    echo "═══════════════════════════════════════"
    
    online_count=0
    offline_count=0
    
    for cam_id in {1..24}; do
        check_camera_online $cam_id true
        if [[ $? -eq 0 ]]; then
            ((online_count++))
        else
            ((offline_count++))
        fi
        
        # Небольшая пауза чтобы не перегружать сеть
        sleep 0.5
    done
    
    echo "═══════════════════════════════════════"
    echo "📊 Итого: ✅ Онлайн: $online_count | ❌ Офлайн: $offline_count"
}

# Функция запуска стриминга в foreground режиме (для одной камеры)
stream_camera_foreground() {
    cam_id=$1
    
    if check_camera_online $cam_id false; then
        echo "✅ Камера $cam_id онлайн, запускаем стрим..."
        
        # Автоочистка старых файлов этой камеры
        clean_camera_files $cam_id
        
        camera_ip=$(get_camera_ip $cam_id)
        rtsp_url="rtsp://${RTSP_USER}:${RTSP_PASS}@${camera_ip}:${RTSP_PORT}/chID=$cam_id"
        
        echo "🎥 Стрим камеры $cam_id запущен в foreground режиме"
        echo "📁 Выход: $output_dir/camera_${cam_id}.m3u8"
        echo "🛑 Для остановки нажмите Ctrl+C"
        
        # Обработка сигналов для graceful shutdown
        trap 'echo ""; echo "🛑 Получен сигнал завершения, останавливаем стрим камеры '$cam_id'..."; exit 0' SIGINT SIGTERM
        
        # Запускаем стрим в foreground с predictable именем файла
        ffmpeg \
            -rtsp_transport tcp \
            -i "$rtsp_url" \
            -c:v libx264 \
            -c:a aac \
            -f hls \
            -hls_time 4 \
            -hls_list_size 5 \
            -hls_flags delete_segments+append_list+omit_endlist \
            -hls_segment_filename "$output_dir/camera_${cam_id}_%03d.ts" \
            "$output_dir/camera_${cam_id}.m3u8" \
            -hide_banner \
            -loglevel info
    else
        echo "❌ Камера $cam_id не онлайн или недоступна!"
        exit 1
    fi
}

# Функция запуска стриминга в background режиме (для множественных камер)
stream_camera_background() {
    cam_id=$1
    
    if check_camera_online $cam_id false; then
        echo "✅ Камера $cam_id онлайн, запускаем стрим в фоне..."
        
        # Автоочистка старых файлов этой камеры
        clean_camera_files $cam_id
        
        camera_ip=$(get_camera_ip $cam_id)
        rtsp_url="rtsp://${RTSP_USER}:${RTSP_PASS}@${camera_ip}:${RTSP_PORT}/chID=$cam_id"
        
        # Запускаем стрим в фоне с predictable именем файла
        ffmpeg \
            -rtsp_transport tcp \
            -i "$rtsp_url" \
            -c:v libx264 \
            -c:a aac \
            -f hls \
            -hls_time 4 \
            -hls_list_size 5 \
            -hls_flags delete_segments+append_list+omit_endlist \
            -hls_segment_filename "$output_dir/camera_${cam_id}_%03d.ts" \
            "$output_dir/camera_${cam_id}.m3u8" \
            -nostdin \
            -hide_banner \
            -loglevel error \
            </dev/null >/dev/null 2>&1 &
        
        echo "✅ Камера $cam_id успешно запущена в фоне (PID: $!)"
        
        # Создаем PID файл для systemd
        echo $! > "/tmp/rtsp_camera_${cam_id}.pid"
    else
        echo "❌ Камера $cam_id не онлайн или недоступна!"
    fi
}

case $mode in
    0)
        DEBUG=1
        echo ""
        echo "📋 Текущие настройки:"
        echo "   IP: $RTSP_BASE_IP:$RTSP_PORT"
        echo "   Пользователь: $RTSP_USER"
        echo ""
        read -p "Хотите изменить IP адрес? (y/N): " change_ip
        if [[ "$change_ip" =~ ^[Yy]$ ]]; then
            read -p "Введите новый IP (текущий: $RTSP_BASE_IP): " new_ip
            if [[ -n "$new_ip" ]]; then
                RTSP_BASE_IP="$new_ip"
                echo "✅ IP изменен на: $RTSP_BASE_IP"
            fi
        fi
        read -p "Введите номер камеры для отладки (1-24): " cam
        stream_camera_foreground $cam
        ;;
    1)
        read -p "Введите номер камеры (1-24): " cam
        stream_camera_foreground $cam
        ;;
    2)
        read -p "Введите номера камер через запятую: " cams
        IFS=',' read -ra cam_array <<< "$cams"
        
        echo "🚀 Запуск камер в фоне..."
        for cam_id in "${cam_array[@]}"; do
            # Убираем пробелы
            cam_id=$(echo $cam_id | tr -d ' ')
            stream_camera_background $cam_id
            sleep 2
        done
        
        echo ""
        echo "✅ Запуск завершен. Камеры работают в фоне."
        echo "📋 Для просмотра: ps aux | grep ffmpeg"
        echo "🛑 Для остановки: pkill ffmpeg"
        ;;
    3)
        echo "🚀 Запуск всех камер (1-24) в фоне..."
        read -p "Очистить папку output перед запуском? (y/N): " clean_before
        if [[ "$clean_before" =~ ^[Yy]$ ]]; then
            clean_output
        fi
        echo ""
        for cam_id in {1..24}; do
            stream_camera_background $cam_id
            sleep 2
        done
        
        echo ""
        echo "✅ Запуск завершен. Онлайн камеры работают в фоне."
        echo "📋 Для просмотра: ps aux | grep ffmpeg"
        echo "🛑 Для остановки: pkill ffmpeg"
        ;;
    4)
        quick_check_all_cameras
        exit 0
        ;;
    5)
        clean_output
        exit 0
        ;;
    *)
        echo "❌ Неверный режим."
        exit 1
        ;;
esac

echo ""
echo "📁 Файлы потоков сохраняются в: $output_dir/"
echo "🔧 Для быстрой проверки порта: nc -z $RTSP_BASE_IP $RTSP_PORT"
