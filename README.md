# PuryFideo

PuryFideo is a local WebSocket plugin for PuryFI that censors full videos by:

1. Extracting the source video into PNG frames.
2. Sending each frame through PuryFI's `censorStaticMedia` API.
3. Rebuilding the video at the original frame rate.
4. Reattaching audio from the source video.

This is implemented as a local Node.js service instead of a browser-only extension because the heavy work is file I/O and `ffmpeg` orchestration.

<video src="https://github.com/user-attachments/assets/98d53995-6e93-4d08-8462-1c0c16e0652b" controls muted>
</video>

## Requirements

- Node.js 20+
- PuryFI 0.8.6.0 or newer
- `ffmpeg.exe` and `ffprobe.exe`

`ffmpeg.exe`/`ffprobe.exe` are not included in this repository (binary size and licensing). Download a Windows build from [gyan.dev's ffmpeg builds](https://www.gyan.dev/ffmpeg/builds/) or [ffmpeg.org](https://ffmpeg.org/download.html), then satisfy the requirement in one of these ways:

- Put `ffmpeg.exe` and `ffprobe.exe` in this project root.
- Put them in `bin/` under this project.
- Set absolute paths for both in the PuryFI plugin configuration after connecting.
- Install ffmpeg globally so `ffmpeg` and `ffprobe` are on `PATH`.

## Install

```powershell
git clone https://github.com/PuryFideo/PuryFideo.git
cd PuryFideo
npm install
npm run build
```

## Run

```powershell
npm start
```

The service opens:

- WebSocket plugin endpoint: `ws://localhost:8080`
- Local control page: `http://localhost:8090`

## Register In PuryFI

1. Open the PuryFI options page.
2. Go to the Plugins tab.
3. Register a new `WebSocket` plugin with `ws://localhost:8080`.
4. Grant the `requestMediaProcesses` intent when prompted.

## Process A Video

1. Start the service with `npm start`.
2. Open `http://localhost:8090`.
3. Click Browse to pick the input video through the native file dialog.
4. Optionally use Browse to choose an output path and temp directory.
5. Submit the job.

If no output path is supplied, the plugin writes beside the source file using the configured suffix, which defaults to `-censored`.

If processing fails, the working temp folder is intentionally preserved for inspection even when temp cleanup is enabled.

## Notes

- Jobs run one at a time.
- Frames are extracted as PNG files before censorship.
- Output video is encoded with `libx264` and audio is encoded to AAC for broad compatibility.
