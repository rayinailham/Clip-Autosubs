"""
FastAPI Web Server — Phases 1-4: Transcription + Subtitle Preview + Rendering
Provides:
  - GET  /                          → Web UI
  - POST /transcribe                → Upload video → word-level JSON
  - GET  /status                    → GPU / FFmpeg info
  - GET  /video/{filename}          → Stream uploaded video
  - POST /render                    → Render video with subtitles (background)
  - GET  /render-status/{render_id} → Poll render progress
  - GET  /rendered/{filename}       → Download rendered video
  - GET  /outputs/{filename}        → Download transcription JSON
"""

import json
import shutil
import uuid
from pathlib import Path
from typing import Optional

import torch
from fastapi import BackgroundTasks, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from renderer import check_ffmpeg, get_video_info, render_video
from subtitle_generator import generate_ass, save_ass
from transcribe import get_vram_usage, transcribe_video

# ─── Paths ───────────────────────────────────────────────────
BASE_DIR = Path(__file__).resolve().parent.parent
UPLOAD_DIR = BASE_DIR / "uploads"
OUTPUT_DIR = BASE_DIR / "outputs"
RENDERED_DIR = BASE_DIR / "rendered"
FRONTEND_DIR = BASE_DIR / "frontend"

UPLOAD_DIR.mkdir(exist_ok=True)
OUTPUT_DIR.mkdir(exist_ok=True)
RENDERED_DIR.mkdir(exist_ok=True)

# ─── App ─────────────────────────────────────────────────────
app = FastAPI(title="Clipping Project", version="2.0.0")

ALLOWED_EXTENSIONS = {
    ".mp4", ".mkv", ".avi", ".mov", ".webm",
    ".mp3", ".wav", ".flac", ".m4a", ".ogg",
}
MAX_FILE_SIZE_MB = 500

# ─── In-memory render job tracker ────────────────────────────
render_jobs: dict = {}


# ─── Pydantic Models ────────────────────────────────────────

class WordStyle(BaseModel):
    """Per-word style overrides. Any None values use the global style."""
    highlight_color: Optional[str] = None
    normal_color: Optional[str] = None
    font_size: Optional[int] = None
    font_name: Optional[str] = None
    bold: Optional[bool] = None
    italic: Optional[bool] = None
    scale_highlight: Optional[int] = None
    outline_color: Optional[str] = None
    outline_width: Optional[int] = None


class WordItem(BaseModel):
    text: str
    start: float
    end: float
    style: Optional[WordStyle] = None  # Per-word style override


class WordGroup(BaseModel):
    """A group of words with custom timing control."""
    word_indices: list[int]  # Indices into the words array
    start: float  # Group display start time
    end: float    # Group display end time


class StyleConfig(BaseModel):
    # Grouping
    words_per_group: int = 4
    use_custom_groups: bool = False  # If True, use word_groups instead of auto-grouping
    
    # Font settings
    font_name: str = "Impact"
    font_size: int = 80
    bold: bool = True
    italic: bool = False
    
    # Colors
    highlight_color: str = "FFD700"
    normal_color: str = "FFFFFF"
    outline_color: str = "000000"
    shadow_color: str = "000000"
    
    # Effects
    outline_width: int = 4
    shadow_depth: int = 2
    scale_highlight: int = 115
    
    # Position
    position: str = "bottom"  # top, center, bottom
    margin_v: int = 60  # Vertical margin
    margin_h: int = 10  # Horizontal margin

    # Spacing
    letter_spacing: int = 0   # Character spacing (ASS \sp / Style Spacing)
    word_gap: int = 0         # Extra hard spaces between words

    # Animation
    animation: str = "scale"  # none, scale, fade, bounce
    
    # Text transform
    uppercase: bool = True


class TranscribeExistingRequest(BaseModel):
    filename: str


class RenderRequest(BaseModel):
    video_filename: str
    words: list[WordItem]
    word_groups: Optional[list[WordGroup]] = None  # Custom groups with timing control
    style: StyleConfig = StyleConfig()


# ─── Routes ──────────────────────────────────────────────────

@app.get("/status")
async def system_status():
    """Return GPU, VRAM, and FFmpeg availability."""
    gpu_info = {}
    if torch.cuda.is_available():
        gpu_info = {
            "gpu_name": torch.cuda.get_device_name(0),
            "cuda_available": True,
            **get_vram_usage(),
        }
    else:
        gpu_info = {"cuda_available": False}

    return {
        "status": "ok",
        "gpu": gpu_info,
        "ffmpeg": check_ffmpeg(),
    }


# ─── Phase 1: Transcription ─────────────────────────────────

@app.post("/transcribe")
async def transcribe_endpoint(file: UploadFile = File(...)):
    """Upload a video/audio file and run WhisperX transcription."""
    ext = Path(file.filename).suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(
            status_code=400,
            detail=f"Unsupported file type '{ext}'. Allowed: {', '.join(sorted(ALLOWED_EXTENSIONS))}",
        )

    upload_path = UPLOAD_DIR / file.filename
    try:
        with open(upload_path, "wb") as f:
            shutil.copyfileobj(file.file, f)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save file: {e}")
    finally:
        await file.close()

    file_size_mb = upload_path.stat().st_size / (1024 * 1024)
    if file_size_mb > MAX_FILE_SIZE_MB:
        upload_path.unlink(missing_ok=True)
        raise HTTPException(
            status_code=400,
            detail=f"File too large ({file_size_mb:.1f}MB). Max: {MAX_FILE_SIZE_MB}MB",
        )

    try:
        result = transcribe_video(str(upload_path), str(OUTPUT_DIR))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    return result


# ─── Video Serving ───────────────────────────────────────────

@app.get("/video/{filename}")
async def serve_video(filename: str):
    """Stream an uploaded video file for the browser player."""
    file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Video not found")

    media_types = {
        ".mp4": "video/mp4",
        ".webm": "video/webm",
        ".mkv": "video/x-matroska",
        ".avi": "video/x-msvideo",
        ".mov": "video/quicktime",
    }
    ext = file_path.suffix.lower()
    media_type = media_types.get(ext, "video/mp4")

    return FileResponse(file_path, media_type=media_type)


# ─── Phase 2-4: Render with Subtitles ───────────────────────

def _do_render(render_id: str, req: RenderRequest):
    """Background task: generate ASS subtitles and burn into video."""
    try:
        video_path = UPLOAD_DIR / req.video_filename
        if not video_path.exists():
            render_jobs[render_id] = {
                "status": "error",
                "error": f"Video file not found: {req.video_filename}",
            }
            return

        render_jobs[render_id]["status"] = "generating_subtitles"

        # Get video resolution
        info = get_video_info(str(video_path))

        # Prepare word dicts
        words_dicts = [w.model_dump() for w in req.words]
        
        # Prepare custom groups if provided
        groups_dicts = None
        if req.word_groups and req.style.use_custom_groups:
            groups_dicts = [g.model_dump() for g in req.word_groups]

        # Generate ASS subtitle file
        ass_content = generate_ass(
            words=words_dicts,
            video_width=info["width"],
            video_height=info["height"],
            words_per_group=req.style.words_per_group,
            custom_groups=groups_dicts,
            use_custom_groups=req.style.use_custom_groups,
            font_name=req.style.font_name,
            font_size=req.style.font_size,
            bold=req.style.bold,
            italic=req.style.italic,
            highlight_color=req.style.highlight_color,
            normal_color=req.style.normal_color,
            outline_color=req.style.outline_color,
            shadow_color=req.style.shadow_color,
            outline_width=req.style.outline_width,
            shadow_depth=req.style.shadow_depth,
            position=req.style.position,
            margin_v=req.style.margin_v,
            margin_h=req.style.margin_h,
            letter_spacing=req.style.letter_spacing,
            word_gap=req.style.word_gap,
            scale_highlight=req.style.scale_highlight,
            animation=req.style.animation,
            uppercase=req.style.uppercase,
        )

        ass_path = RENDERED_DIR / f"{render_id}_captions.ass"
        save_ass(ass_content, str(ass_path))

        render_jobs[render_id]["status"] = "rendering"

        # Render video with subtitles
        output_filename = f"{video_path.stem}_captioned_{render_id}.mp4"
        output_path = RENDERED_DIR / output_filename

        render_video(str(video_path), str(ass_path), str(output_path))

        render_jobs[render_id] = {
            "status": "done",
            "filename": output_filename,
            "url": f"/rendered/{output_filename}",
            "size_mb": round(output_path.stat().st_size / (1024 * 1024), 1),
        }

    except Exception as e:
        print(f"[render] Error: {e}")
        render_jobs[render_id] = {"status": "error", "error": str(e)}


@app.post("/render")
async def start_render(req: RenderRequest, background_tasks: BackgroundTasks):
    """Start a background render job. Returns a render_id for polling."""
    render_id = uuid.uuid4().hex[:8]
    render_jobs[render_id] = {"status": "queued"}
    background_tasks.add_task(_do_render, render_id, req)
    return {"render_id": render_id}


@app.get("/render-status/{render_id}")
async def get_render_status(render_id: str):
    """Poll the status of a render job."""
    if render_id not in render_jobs:
        raise HTTPException(status_code=404, detail="Render job not found")
    return render_jobs[render_id]


@app.get("/rendered/{filename}")
async def download_rendered(filename: str):
    """Download a rendered video."""
    file_path = RENDERED_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="Rendered file not found")
    return FileResponse(file_path, media_type="video/mp4", filename=filename)


@app.get("/rendered")
async def list_rendered():
    """List all rendered video files."""
    files = []
    for f in RENDERED_DIR.iterdir():
        if f.is_file() and f.suffix == ".mp4":
            files.append({
                "filename": f.name,
                "size_mb": round(f.stat().st_size / (1024 * 1024), 1),
                "url": f"/rendered/{f.name}",
            })
    return {"files": files}


# ─── Uploads listing ────────────────────────────────────────

@app.get("/uploads")
async def list_uploads():
    """List all uploaded video/audio files with their transcription status."""
    files = []
    for f in UPLOAD_DIR.iterdir():
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS:
            transcription_json = OUTPUT_DIR / (f.stem + "_transcription.json")
            has_transcription = transcription_json.exists()
            files.append({
                "filename": f.name,
                "size_mb": round(f.stat().st_size / (1024 * 1024), 1),
                "has_transcription": has_transcription,
                "transcription_file": (f.stem + "_transcription.json") if has_transcription else None,
            })
    files.sort(key=lambda x: x["filename"])
    return {"files": files}


@app.post("/transcribe-existing")
async def transcribe_existing_endpoint(payload: TranscribeExistingRequest):
    """Transcribe an already-uploaded file without re-uploading it."""
    filename = payload.filename.strip()
    if not filename:
        raise HTTPException(status_code=400, detail="filename is required")
    upload_path = UPLOAD_DIR / filename
    if not upload_path.exists():
        raise HTTPException(status_code=404, detail=f"Uploaded file not found: {filename}")

    ext = upload_path.suffix.lower()
    if ext not in ALLOWED_EXTENSIONS:
        raise HTTPException(status_code=400, detail=f"Unsupported file type '{ext}'")

    try:
        result = transcribe_video(str(upload_path), str(OUTPUT_DIR))
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    return result


# ─── Outputs (JSON) ─────────────────────────────────────────

@app.get("/outputs/{filename}")
async def download_output(filename: str):
    """Download a generated JSON file."""
    file_path = OUTPUT_DIR / filename
    if not file_path.exists():
        raise HTTPException(status_code=404, detail="File not found")
    return FileResponse(file_path, media_type="application/json", filename=filename)


@app.get("/outputs")
async def list_outputs():
    """List all generated output files."""
    files = []
    for f in OUTPUT_DIR.iterdir():
        if f.is_file() and f.suffix == ".json":
            files.append({
                "filename": f.name,
                "size_kb": round(f.stat().st_size / 1024, 1),
                "url": f"/outputs/{f.name}",
            })
    return {"files": files}


# ─── Static Files ──────────────────────────────────────────

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
