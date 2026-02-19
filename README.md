# Clipping Project — Dynamic Video Captions

A strictly local, GPU-accelerated tool for generating "Hormozi-style" dynamic captions. This project uses **WhisperX** for high-precision transcription and forced alignment, and **FFmpeg** to burn animated ASS subtitles into videos.

![Status](https://img.shields.io/badge/Status-Active-success)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![GPU](https://img.shields.io/badge/GPU-NVIDIA%20RTX%20(6GB%2B)-green)

## ✨ Features

- **Start-to-Finish Pipeline**: Upload video -> Transcribe -> Edit Styles -> Render.
- **Hardware Optimized**: Specifically tuned for **6GB VRAM GPUs (RTX 3060)** using `int8` quantization.
- **High-Precision Transcription**: Uses [WhisperX](https://github.com/m-bain/whisperX) for word-level timestamps.
- **Dynamic Animations**: Generates `.ass` subtitles where the active word is highlighted (color change + scale up).
- **Web Interface**: Clean, dark-mode UI for uploading files and configuring font styles.
- **Fast Rendering**: Uses FFmpeg's `libass` filter for efficient subtitle burning.

## 🛠️ Prerequisites

1. **Python 3.10+**
2. **NVIDIA GPU** with CUDA drivers installed.
3. **FFmpeg**: Must be working and added to your system `PATH`.
   - Verify by running: `ffmpeg -version` and `ffprobe -version` in a terminal.
   - [FFmpeg Download](https://ffmpeg.org/download.html)

## 📦 Installation

1. **Clone the repository**
   ```bash
   git clone <repo-url>
   cd clipping-project
   ```

2. **Create a Conda environment (Recommended)**
   WhisperX and PyTorch dependencies are best managed with Conda.
   ```bash
   conda create --name clipping python=3.10
   conda activate clipping
   ```

3. **Install PyTorch (CUDA 11.8 or 12.x)**
   *Check [pytorch.org](https://pytorch.org/) for the command matching your drivers.*
   ```bash
   # Example for CUDA 11.8
   pip install torch torchvision torchaudio --index-url https://download.pytorch.org/whl/cu118
   ```

4. **Install Dependencies**
   ```bash
   pip install -r requirements.txt
   ```
   *Note: If `requirements.txt` is missing, you typically need:*
   `fastapi`, `uvicorn`, `python-multipart`, `whisperx`, `pydantic`

## 🚀 Usage

1. **Start the Application**
   Run the entry script from the root directory:
   ```bash
   python run.py
   ```
   *This starts the backend server on `http://localhost:8000`.*

2. **Open the Web UI**
   Go to **[http://localhost:8000](http://localhost:8000)** in your browser.

3. **Workflow**
   1. **Upload**: Drag & drop a video file (mp4, mkv, mov, etc.).
   2. **Transcribe**: The system extracts audio and runs WhisperX.
   3. **Configure**: Choose font colors, size, and styling preferences.
   4. **Render**: Click "Render Video". The backend burns the subtitles.
   5. **Download**: Get your final captioned video.

## 📂 Project Structure

```
clipping-project/
├── run.py                  # Entry point script
├── requirements.txt        # Python dependencies
├── backend/
│   ├── app.py              # FastAPI server & routes
│   ├── transcribe.py       # WhisperX loading & inference
│   ├── subtitle_generator.py # Logic for creating .ass files
│   └── renderer.py         # FFmpeg subprocess wrapper
├── frontend/
│   └── index.html          # Single-file Web UI
├── uploads/                # Temp storage for uploaded raw videos
├── outputs/                # Transcription Data (JSON) & ASS files
└── rendered/               # Final rendered videos
```

## ⚙️ Technical Details

- **Transcription**: Uses `whisperx` with `compute_type="int8"` to reduce memory usage.
- **Batch Size**: Default is set to `4` in `transcribe.py` to prevent OOM errors on 6GB cards.
- **Rendering**: 
  - Audio is **copied** (`-c:a copy`) to preserve original quality.
  - Video is re-encoded using `libx264` (CRF 18) to burn in the subtitles.
  - The subtitle format is **Advanced Substation Alpha (ASS)**, which supports the specific positioning and animation required for the "active word" effect.
