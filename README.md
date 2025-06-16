<<<<<<< HEAD
# A script to manage RTSP camera streams and HLS segmenting.
=======
# RTSP to HLS Webcam Encoder

A script to manage RTSP camera streams and HLS segmenting.
>>>>>>> 65ba8df (fix: make README use numbered lists for clarity)

## Features
1. Check which cameras are online.
2. Start HLS streaming for a single camera, multiple cameras, or all cameras.
3. Automatically clean old `.ts` and `.m3u8` files in the `output/` folder.
4. Debug mode for detailed camera diagnostics.
5. Reads settings from `.env` file for secure configuration.

## Environment Variables
<<<<<<< HEAD
- Configure a `.env` file in the script directory with the following variables:
  - `RTSP_BASE_IP=xxx.xxx.x.xxx`
  - `RTSP_PORT=xxxxx`
  - `RTSP_USER=your_username`
  - `RTSP_PASS=yourpassword`

## Usage
- Run the script:
  - `bash rtsp_to_hls.sh`
- Modes:
  - `1` - Start streaming a single camera.
  - `2` - Start streaming multiple cameras (comma-separated IDs).
  - `3` - Start streaming all cameras (1-24).
  - `4` - Quick check of all cameras (no recording).
  - `5` - Clean the `output/` directory.
  - `0` - Debug mode for detailed logs.

## Output Files
- All streams are stored in the `output/` directory.
- To stop all streams:
  - `pkill ffmpeg`
=======
Create a `.env` file in the script directory with the following variables:

1. `RTSP_BASE_IP=xxx.xxx.x.xxx`
2. `RTSP_PORT=xxxxx`
3. `RTSP_USER=your_username`
4. `RTSP_PASS=yourpassword`

## Usage
1. Run the script:
   ```bash
   bash rtsp_to_hls.sh
>>>>>>> 65ba8df (fix: make README use numbered lists for clarity)
