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
from reframe_renderer import render_vtuber_short
from silence_cutter import cut_silence
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

# ─── In-memory cut-silence job tracker ───────────────────────
cut_silence_jobs: dict = {}

# ─── In-memory reframe job tracker ───────────────────────────
reframe_jobs: dict = {}


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
    dynamic_mode: bool = True  # True = per-word highlighting, False = static sentence
    
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
    glow_strength: int = 0
    glow_color: str = "FFD700"
    scale_highlight: int = 100
    
    # Position
    position: str = "bottom"  # top, center, bottom
    margin_v: int = 60  # Vertical margin
    margin_h: int = 10  # Horizontal margin

    # Spacing
    letter_spacing: int = 0   # Character spacing (ASS \sp / Style Spacing)
    word_gap: int = 0         # Extra hard spaces between words

    # Animation
    animation: str = "color-only"  # none, scale, color-only, bounce
    group_animation: str = "none"  # none, fade-in, slide-up, slide-down, pop-in, typewriter
    anim_speed: int = 200  # Animation duration in ms (dynamic mode)
    sentence_animation: str = "fade-in"  # static mode entrance animation
    static_anim_speed: int = 300  # Animation duration in ms (static mode)

    # Text transform
    uppercase: bool = True


class TranscribeExistingRequest(BaseModel):
    filename: str


class CutSilenceRequest(BaseModel):
    video_filename: str
    words: list[WordItem]                # word-level timestamps from transcription
    min_silence_ms: int = 500           # gaps >= this (ms) are removed
    padding_ms: int = 100               # context kept around each speech block (ms)


class SaveStyleRequest(BaseModel):
    video_filename: str
    style: StyleConfig


class ReframeRequest(BaseModel):
    video_filename: str
    top_zoom: float = 1.0
    top_pan_x: float = 0.0   # −100 … +100
    top_pan_y: float = 0.0
    bottom_zoom: float = 1.0
    bottom_pan_x: float = 0.0
    bottom_pan_y: float = 0.0
    out_width: int = 1080
    out_height: int = 1920
    crf: int = 18
    preset: str = "medium"


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
            dynamic_mode=req.style.dynamic_mode,
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
            glow_strength=req.style.glow_strength,
            glow_color=req.style.glow_color,
            position=req.style.position,
            margin_v=req.style.margin_v,
            margin_h=req.style.margin_h,
            letter_spacing=req.style.letter_spacing,
            word_gap=req.style.word_gap,
            scale_highlight=req.style.scale_highlight,
            animation=req.style.animation,
            group_animation=req.style.group_animation,
            anim_speed=req.style.anim_speed,
            sentence_animation=req.style.sentence_animation,
            static_anim_speed=req.style.static_anim_speed,
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
    """List all uploaded video/audio files with their transcription and style status."""
    files = []
    for f in UPLOAD_DIR.iterdir():
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS:
            transcription_json = OUTPUT_DIR / (f.stem + "_transcription.json")
            style_json = OUTPUT_DIR / (f.stem + "_style.json")
            has_transcription = transcription_json.exists()
            has_style = style_json.exists()
            files.append({
                "filename": f.name,
                "size_mb": round(f.stat().st_size / (1024 * 1024), 1),
                "has_transcription": has_transcription,
                "transcription_file": (f.stem + "_transcription.json") if has_transcription else None,
                "has_style": has_style,
                "style_file": (f.stem + "_style.json") if has_style else None,
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


@app.post("/save-style")
async def save_style_endpoint(payload: SaveStyleRequest):
    """Save style settings for a video file."""
    video_filename = payload.video_filename.strip()
    if not video_filename:
        raise HTTPException(status_code=400, detail="video_filename is required")
    
    # Derive stem from video filename
    video_stem = Path(video_filename).stem
    style_path = OUTPUT_DIR / f"{video_stem}_style.json"
    
    try:
        with open(style_path, "w", encoding="utf-8") as f:
            json.dump(payload.style.model_dump(), f, indent=2)
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to save style: {e}")
    
    return {"status": "ok", "style_file": f"{video_stem}_style.json"}


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


# ─── Cut Silence ────────────────────────────────────────────

def _do_cut_silence(job_id: str, req: CutSilenceRequest):
    """Background task: detect silence from word timestamps and cut it out."""
    logs: list[str] = []

    def progress(msg: str):
        logs.append(msg)
        cut_silence_jobs[job_id]["log"] = logs[-1]

    try:
        video_path = UPLOAD_DIR / req.video_filename
        if not video_path.exists():
            cut_silence_jobs[job_id] = {
                "status": "error",
                "error": f"Video file not found: {req.video_filename}",
            }
            return

        cut_silence_jobs[job_id]["status"] = "processing"

        words_dicts = [w.model_dump() for w in req.words]

        output_filename = f"{video_path.stem}_silencecut_{job_id}.mp4"
        output_path = RENDERED_DIR / output_filename

        stats = cut_silence(
            video_path=str(video_path),
            words=words_dicts,
            output_path=str(output_path),
            min_silence_ms=req.min_silence_ms,
            padding_ms=req.padding_ms,
            progress_cb=progress,
        )

        cut_silence_jobs[job_id] = {
            "status": "done",
            "filename": output_filename,
            "url": f"/rendered/{output_filename}",
            **stats,
        }

    except Exception as e:
        print(f"[cut_silence] Error: {e}")
        cut_silence_jobs[job_id] = {"status": "error", "error": str(e)}


@app.post("/cut-silence")
async def start_cut_silence(req: CutSilenceRequest, background_tasks: BackgroundTasks):
    """Start a background silence-cutting job. Returns a job_id for polling."""
    job_id = uuid.uuid4().hex[:8]
    cut_silence_jobs[job_id] = {"status": "queued", "log": "Queued…"}
    background_tasks.add_task(_do_cut_silence, job_id, req)
    return {"job_id": job_id}


@app.get("/cut-silence-status/{job_id}")
async def get_cut_silence_status(job_id: str):
    """Poll the status of a cut-silence job."""
    if job_id not in cut_silence_jobs:
        raise HTTPException(status_code=404, detail="Job not found")
    return cut_silence_jobs[job_id]


# ─── Upload-only (for Reframe / VTuber short) ───────────────

@app.post("/upload-only")
async def upload_only(file: UploadFile = File(...)):
    """
    Upload a video file without transcribing it.
    Used by the VTuber Reframe workflow.
    """
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
            detail=f"File too large ({file_size_mb:.1f} MB). Max: {MAX_FILE_SIZE_MB} MB",
        )

    return {"filename": file.filename, "size_mb": round(file_size_mb, 1)}


# ─── VTuber Short Reframe Render ─────────────────────────────

def _do_reframe(job_id: str, req: ReframeRequest):
    """Background task: render VTuber split-screen short."""
    logs: list[str] = []

    def progress(msg: str):
        logs.append(msg)
        reframe_jobs[job_id]["log"] = msg

    try:
        video_path = UPLOAD_DIR / req.video_filename
        if not video_path.exists():
            reframe_jobs[job_id] = {
                "status": "error",
                "error": f"Video file not found: {req.video_filename}",
            }
            return

        reframe_jobs[job_id]["status"] = "processing"

        output_filename = f"{video_path.stem}_vtuber_{job_id}.mp4"
        output_path = RENDERED_DIR / output_filename

        render_vtuber_short(
            video_path=str(video_path),
            output_path=str(output_path),
            top_zoom=req.top_zoom,
            top_pan_x=req.top_pan_x,
            top_pan_y=req.top_pan_y,
            bottom_zoom=req.bottom_zoom,
            bottom_pan_x=req.bottom_pan_x,
            bottom_pan_y=req.bottom_pan_y,
            out_width=req.out_width,
            out_height=req.out_height,
            crf=req.crf,
            preset=req.preset,
            progress_cb=progress,
        )

        reframe_jobs[job_id] = {
            "status": "done",
            "filename": output_filename,
            "url": f"/rendered/{output_filename}",
            "size_mb": round(output_path.stat().st_size / (1024 * 1024), 1),
        }

    except Exception as e:
        print(f"[reframe] Error: {e}")
        reframe_jobs[job_id] = {"status": "error", "error": str(e)}


@app.post("/render-reframe")
async def start_reframe(req: ReframeRequest, background_tasks: BackgroundTasks):
    """Start a background VTuber reframe render job. Returns job_id for polling."""
    job_id = uuid.uuid4().hex[:8]
    reframe_jobs[job_id] = {"status": "queued", "log": "Queued…"}
    background_tasks.add_task(_do_reframe, job_id, req)
    return {"job_id": job_id}


@app.get("/reframe-status/{job_id}")
async def get_reframe_status(job_id: str):
    """Poll the status of a reframe render job."""
    if job_id not in reframe_jobs:
        raise HTTPException(status_code=404, detail="Reframe job not found")
    return reframe_jobs[job_id]


# ─── Static Files ──────────────────────────────────────────

app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
