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
import time
import uuid
from pathlib import Path
from typing import Optional

from fastapi import BackgroundTasks, FastAPI, File, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from logger import get_logger

log = get_logger("app")
http_log = get_logger("http")

from renderer import check_ffmpeg, get_video_info, render_video, cut_video_segments
from reframe_renderer import (
    render_vtuber_short,
    render_shorts_zoomed,
    render_shorts_blur_bg,
    render_shorts_black_bg,
)
from subtitle_generator import generate_ass, save_ass, generate_srt
from transcribe import transcribe_video
from yt_clipper import extract_transcript, analyze_with_gemini, download_and_cut_clips
from refine import refine_video
from settings import (
    load_settings, save_settings,
    test_elevenlabs_key, test_gemini_key,
    add_model, remove_model,
)

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


@app.middleware("http")
async def request_logging_middleware(request: Request, call_next):
    """Log every HTTP request with method, path, status, latency."""
    # Skip noisy static asset polling.
    path = request.url.path
    is_static = (
        path.startswith("/assets/")
        or path.startswith("/uploads/")
        or path.startswith("/video/")
        or path.startswith("/rendered/")
        or path.endswith((".js", ".css", ".png", ".jpg", ".svg", ".ico", ".woff", ".woff2"))
    )
    t0 = time.perf_counter()
    try:
        response = await call_next(request)
    except Exception as e:
        ms = (time.perf_counter() - t0) * 1000
        http_log.exception("[fail]%s[/]  %s  -> 500  (%.0fms)  %s",
                           f" {request.method} ", path, ms, e)
        raise
    ms = (time.perf_counter() - t0) * 1000
    if not is_static:
        status = response.status_code
        style = "ok" if status < 400 else "fail"
        http_log.info("[%s]%s[/] %-6s %s -> %d  (%.0fms)",
                      style, "", request.method, path, status, ms)
    return response


@app.on_event("startup")
async def _on_startup():
    log.info("FastAPI startup complete — all routes ready.")
    log.info("Uploads:  %s", UPLOAD_DIR)
    log.info("Outputs:  %s", OUTPUT_DIR)
    log.info("Rendered: %s", RENDERED_DIR)


@app.on_event("shutdown")
async def _on_shutdown():
    log.warning("FastAPI shutdown — draining %d render / %d reframe / %d trim / %d refine / %d yt jobs",
                len(render_jobs), len(reframe_jobs), len(trim_jobs),
                len(refine_jobs), len(yt_analyze_jobs) + len(yt_cut_jobs))

ALLOWED_EXTENSIONS = {
    ".mp4", ".mkv", ".avi", ".mov", ".webm",
    ".mp3", ".wav", ".flac", ".m4a", ".ogg",
}
MAX_FILE_SIZE_MB = 100000  # Increased to naturally allow huge files

# ─── In-memory render job tracker ────────────────────────────
render_jobs: dict = {}

# ─── In-memory reframe job tracker ───────────────────────────
reframe_jobs: dict = {}

# ─── In-memory YT Clipper job trackers ───────────────────────
yt_analyze_jobs: dict = {}
yt_cut_jobs: dict = {}

# ─── In-memory Trim job tracker ──────────────────────────────
trim_jobs: dict = {}

# ─── In-memory Refine job tracker ────────────────────────────
refine_jobs: dict = {}


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
    pos_x: int = 50     # Horizontal position 0-100%
    pos_y: int = 85     # Vertical position 0-100%

    # Spacing
    letter_spacing: int = 0   # Character spacing (ASS \sp / Style Spacing)
    word_gap: int = 0         # Extra hard spaces between words

    # Animation
    animation: str = "color-only"  # none, scale, color-only, bounce
    group_animation: str = "none"  # none, fade-in, slide-up, slide-down, pop-in, typewriter
    anim_speed: int = 200  # Animation duration in ms (dynamic mode)
    anim_intensity: int = 100  # Multiplier for animation amount (0-100+)
    sentence_animation: str = "fade-in"  # static mode entrance animation
    static_anim_speed: int = 300  # Animation duration in ms (static mode)

    # Text transform
    uppercase: bool = True


class TranscribeExistingRequest(BaseModel):
    filename: str
    transcription_model: Optional[str] = "large-v2"
    elevenlabs_api_key: Optional[str] = None
    diarize: bool = False                # Enable speaker diarization
    num_speakers: Optional[int] = None   # Exact speaker count hint (1-32)
    hf_token: Optional[str] = None       # Legacy — ignored
    min_speakers: Optional[int] = None   # Legacy — mapped to num_speakers
    max_speakers: Optional[int] = None   # Legacy — mapped to num_speakers


class SaveStyleRequest(BaseModel):
    video_filename: str
    style: StyleConfig


class ReframeRequest(BaseModel):
    video_filename: str
    # Mode: 'vtuber' | 'zoomed' | 'blur_bg' | 'black_bg'
    shorts_mode: str = "vtuber"
    # Split-screen ratio (top section percentage, 20-80)
    split_ratio: int = 40
    # Split-screen params
    top_zoom: float = 1.0
    top_pan_x: float = 0.0   # −100 … +100
    top_pan_y: float = 0.0
    bottom_zoom: float = 1.0
    bottom_pan_x: float = 0.0
    bottom_pan_y: float = 0.0
    # Single-section params (zoomed mode)
    single_zoom: float = 1.0
    single_pan_x: float = 0.0
    single_pan_y: float = 0.0
    out_width: int = 1080
    out_height: int = 1920
    crf: int = 18
    preset: str = "medium"


class RenderRequest(BaseModel):
    video_filename: str
    words: list[WordItem]
    word_groups: Optional[list[WordGroup]] = None  # Custom groups with timing control
    style: StyleConfig = StyleConfig()
    active_segments: Optional[list[list[float]]] = None  # [[start, end], ...] segments to keep


class TrimRequest(BaseModel):
    video_filename: str
    trim_start: float        # seconds
    trim_end: float          # seconds


class RefineRequest(BaseModel):
    video_filename: str
    gemini_api_key: str
    transcription_model: Optional[str] = "large-v2"
    elevenlabs_api_key: Optional[str] = None
    diarize: bool = False
    num_speakers: Optional[int] = None
    do_grouping: bool = True


class YtAnalyzeRequest(BaseModel):
    url: str
    criteria: str = ""          # empty → auto (find all clippable moments)
    gemini_api_key: str         # required — user provides it each time, never stored
    use_chat_signal: bool = True
    include_setup: bool = True


class YtClip(BaseModel):
    id: int
    title: str
    start: float
    end: float
    reason: str = ""


class YtCutRequest(BaseModel):
    url: str
    clips: list[YtClip]


# ─── Routes ──────────────────────────────────────────────────

@app.get("/status")
async def system_status():
    """Return ElevenLabs/Gemini key + model availability and FFmpeg status."""
    s = load_settings()
    return {
        "status": "ok",
        "ffmpeg": check_ffmpeg(),
        "elevenlabs": {
            "configured": bool(s.get("elevenlabs_api_key")),
            "model": s.get("elevenlabs_model", "scribe_v1"),
        },
        "gemini": {
            "configured": bool(s.get("gemini_api_key")),
            "model": s.get("gemini_model", "gemini-2.0-flash"),
        },
    }


# ─── Phase 1: Transcription ─────────────────────────────────

@app.post("/transcribe")
async def transcribe_endpoint(
    file: UploadFile = File(...),
    transcription_model: Optional[str] = Form("large-v2"),
    elevenlabs_api_key: Optional[str] = Form(None),
    diarize: bool = Form(False),
    num_speakers: Optional[int] = Form(None),
    hf_token: Optional[str] = Form(None),
    min_speakers: Optional[int] = Form(None),
    max_speakers: Optional[int] = Form(None),
):
    """Upload a video/audio file and transcribe via ElevenLabs Scribe.

    Pass diarize=true (with optional num_speakers hint) to get speaker labels.
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
            detail=f"File too large ({file_size_mb:.1f}MB). Max: {MAX_FILE_SIZE_MB}MB",
        )

    try:
        result = transcribe_video(
            str(upload_path),
            str(OUTPUT_DIR),
            model_id=transcription_model,
            elevenlabs_api_key=elevenlabs_api_key,
            diarize=bool(diarize),
            num_speakers=num_speakers,
            hf_token=hf_token or None,
            min_speakers=min_speakers,
            max_speakers=max_speakers,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    return result


# ─── Video Serving ───────────────────────────────────────────

@app.get("/video/{filename:path}")
async def serve_video(filename: str):
    """Stream an uploaded video file for the browser player."""
    file_path = UPLOAD_DIR / filename
    if not file_path.exists():
        # Fall back to rendered directory
        file_path = RENDERED_DIR / filename
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


def _remap_time(t: float, segments: list[tuple[float, float]]) -> float:
    """Map a timestamp from the original video to the cut video's timeline."""
    offset = 0.0
    for s, e in segments:
        if t <= e:
            if t >= s:
                return round(offset + (t - s), 4)
            return round(offset, 4)  # t was in a removed gap
        offset += e - s
    return round(offset, 4)


def _remap_words_for_segments(
    words: list[dict],
    segments: list[tuple[float, float]],
) -> list[dict]:
    """
    Filter + remap word timestamps to match a cut video.
    Words outside all active segments are dropped.
    """
    result = []
    for w in words:
        # Keep word if it overlaps with any active segment
        in_segment = any(w["start"] < e and w["end"] > s for s, e in segments)
        if in_segment:
            result.append({
                **w,
                "start": _remap_time(w["start"], segments),
                "end": _remap_time(w["end"], segments),
            })
    return result


def _do_render(render_id: str, req: RenderRequest):
    """Background task: generate ASS subtitles and burn into video."""
    temp_cut_path = None
    try:
        video_path = UPLOAD_DIR / req.video_filename
        # Also check rendered dir
        if not video_path.exists():
            video_path = RENDERED_DIR / req.video_filename
        if not video_path.exists():
            render_jobs[render_id] = {
                "status": "error",
                "error": f"Video file not found: {req.video_filename}",
            }
            return

        render_jobs[render_id]["status"] = "generating_subtitles"

        # Prepare word dicts
        words_dicts = [w.model_dump() for w in req.words]

        # Prepare custom groups if provided
        groups_dicts = None
        if req.word_groups and req.style.use_custom_groups:
            groups_dicts = [g.model_dump() for g in req.word_groups]

        # ── Handle timeline cuts (active_segments) ──────────────────
        actual_video_path = video_path
        if req.active_segments and len(req.active_segments) > 0:
            render_jobs[render_id]["status"] = "cutting_segments"
            log.info("render %s — cutting %d active segments", render_id, len(req.active_segments))

            segments_tuples = [(s[0], s[1]) for s in req.active_segments]
            temp_cut_path = RENDERED_DIR / f"{render_id}_temp_cut.mp4"

            cut_video_segments(
                video_path=str(video_path),
                segments=segments_tuples,
                output_path=str(temp_cut_path),
            )
            actual_video_path = temp_cut_path

            # Remap word timestamps to match the cut video
            words_dicts = _remap_words_for_segments(words_dicts, segments_tuples)

            # Remap custom groups too
            if groups_dicts:
                for g in groups_dicts:
                    g["start"] = _remap_time(g["start"], segments_tuples)
                    g["end"] = _remap_time(g["end"], segments_tuples)

            render_jobs[render_id]["status"] = "generating_subtitles"

        # Get video resolution
        info = get_video_info(str(actual_video_path))

        # Generate HTML subtitle file
        from subtitle_generator import build_custom_groups, group_words
        from html_renderer import generate_subtitle_html, render_html_sequence_to_video
        import asyncio

        if req.style.use_custom_groups and groups_dicts:
            final_groups = build_custom_groups(words_dicts, groups_dicts)
        else:
            final_groups = group_words(words_dicts, req.style.words_per_group)

        html_content = generate_subtitle_html(
            words=words_dicts,
            groups=final_groups,
            style=req.style.model_dump(),
            width=info["width"],
            height=info["height"]
        )

        render_jobs[render_id]["status"] = "rendering"

        # Render video with subtitles
        output_filename = f"{video_path.stem}_captioned_{render_id}.mp4"
        output_path = RENDERED_DIR / output_filename
        
        # Determine fps, default to 60 for smooth animations
        # We can also read it from info, but 60 is perfectly smooth.
        duration = info.get("duration", 0)
        
        if duration <= 0:
            raise RuntimeError("Invalid video duration (0s).")

        asyncio.run(
            render_html_sequence_to_video(
                html_content=html_content,
                video_path=str(actual_video_path),
                output_path=str(output_path),
                duration=duration,
                width=info["width"],
                height=info["height"],
                fps=60,
                crf=18,
                progress_callback=lambda p: render_jobs[render_id].update({"progress_pct": p})
            )
        )

        render_jobs[render_id] = {

            "status": "done",
            "filename": output_filename,
            "url": f"/rendered/{output_filename}",
            "size_mb": round(output_path.stat().st_size / (1024 * 1024), 1),
        }

    except Exception as e:
        log.exception("render %s failed: %s", render_id, e)
        render_jobs[render_id] = {"status": "error", "error": str(e)}
    finally:
        # Clean up temporary cut file
        if temp_cut_path and temp_cut_path.exists():
            try:
                temp_cut_path.unlink()
            except OSError:
                pass


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


@app.get("/rendered/{filename:path}")
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
            rel_path = f.relative_to(RENDERED_DIR).as_posix()
            files.append({
                "filename": rel_path,
                "size_mb": round(f.stat().st_size / (1024 * 1024), 1),
                "url": f"/rendered/{rel_path}",
            })
    return {"files": files}


# ─── Uploads listing ────────────────────────────────────────

@app.get("/uploads")
async def list_uploads():
    """List all uploaded video/audio files with their transcription and style status."""
    files = []
    for f in UPLOAD_DIR.rglob("*"):
        if f.is_file() and f.suffix.lower() in ALLOWED_EXTENSIONS:
            rel_path = f.relative_to(UPLOAD_DIR).as_posix()
            
            # Assume transcription json is in matching folder structure inside outputs
            rel_parent = f.parent.relative_to(UPLOAD_DIR)
            transcription_path = OUTPUT_DIR / rel_parent / (f.stem + "_transcription.json")
            style_path = OUTPUT_DIR / rel_parent / (f.stem + "_style.json")
            
            # Fallback to root if not found (for older files)
            if not transcription_path.exists():
                transcription_path = OUTPUT_DIR / (f.stem + "_transcription.json")
            if not style_path.exists():
                style_path = OUTPUT_DIR / (f.stem + "_style.json")

            has_transcription = transcription_path.exists()
            has_style = style_path.exists()
            
            files.append({
                "filename": rel_path,
                "name": f.name,
                "folder": rel_parent.as_posix() if str(rel_parent) != "." else "",
                "size_mb": round(f.stat().st_size / (1024 * 1024), 1),
                "created_at": f.stat().st_ctime,
                "has_transcription": has_transcription,
                "transcription_file": transcription_path.relative_to(OUTPUT_DIR).as_posix() if has_transcription else None,
                "has_style": has_style,
                "style_file": style_path.relative_to(OUTPUT_DIR).as_posix() if has_style else None,
            })
    files.sort(key=lambda x: x["created_at"], reverse=True)
    return {"files": files}


@app.delete("/uploads/{filename:path}")
async def delete_upload(filename: str):
    """Delete an uploaded video and its associated transcription / style files."""
    video_path = UPLOAD_DIR / filename
    if not video_path.exists():
        raise HTTPException(status_code=404, detail=f"File not found: {filename}")

    p_filename = Path(filename)
    stem = p_filename.stem
    rel_parent = p_filename.parent
    deleted = []

    try:
        video_path.unlink()
        deleted.append(filename)
        # remove parent dir if empty
        if video_path.parent != UPLOAD_DIR and not any(video_path.parent.iterdir()):
            video_path.parent.rmdir()
    except OSError as e:
        raise HTTPException(status_code=500, detail=f"Could not delete video: {e}")

    # Remove transcription JSON if present
    transcription_path = OUTPUT_DIR / rel_parent / f"{stem}_transcription.json"
    if not transcription_path.exists():
        transcription_path = OUTPUT_DIR / f"{stem}_transcription.json" # fallback
        
    if transcription_path.exists():
        try:
            transcription_path.unlink()
            deleted.append(transcription_path.name)
            if transcription_path.parent != OUTPUT_DIR and not any(transcription_path.parent.iterdir()):
                transcription_path.parent.rmdir()
        except OSError:
            pass

    # Remove style JSON if present
    style_path = OUTPUT_DIR / rel_parent / f"{stem}_style.json"
    if not style_path.exists():
        style_path = OUTPUT_DIR / f"{stem}_style.json"

    if style_path.exists():
        try:
            style_path.unlink()
            deleted.append(style_path.name)
        except OSError:
            pass

    return {"deleted": deleted}


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
        result = transcribe_video(
            str(upload_path),
            str(OUTPUT_DIR),
            model_id=payload.transcription_model,
            elevenlabs_api_key=payload.elevenlabs_api_key,
            diarize=bool(payload.diarize),
            num_speakers=payload.num_speakers,
            hf_token=payload.hf_token or None,
            min_speakers=payload.min_speakers,
            max_speakers=payload.max_speakers,
        )
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Transcription failed: {e}")

    return result


class ExportSrtRequest(BaseModel):
    """Request body for /export-srt — Premiere Pro compatible plain SRT."""
    video_filename: str
    words: list[WordItem]
    word_groups: Optional[list[WordGroup]] = None
    words_per_group: int = 4
    use_custom_groups: bool = False
    uppercase: bool = False
    active_segments: Optional[list[list[float]]] = None  # remap timing if cut


@app.post("/export-srt")
async def export_srt_endpoint(req: ExportSrtRequest):
    """
    Build a plain SRT file (group/sentence-level cues) for Premiere Pro.

    SRT carries only timing + text — styling is applied inside Premiere's
    Captions panel after import. Animations, glow, scale, per-word
    highlight, and custom positioning are not portable to SRT.
    """
    words_dicts = [w.model_dump() for w in req.words]
    groups_dicts: Optional[list[dict]] = None
    if req.word_groups and req.use_custom_groups:
        groups_dicts = [g.model_dump() for g in req.word_groups]

    # Apply timeline cuts (active_segments) so cue times match the cut video.
    if req.active_segments:
        segs = [(float(s[0]), float(s[1])) for s in req.active_segments]
        words_dicts = _remap_words_for_segments(words_dicts, segs)
        if groups_dicts:
            for g in groups_dicts:
                g["start"] = _remap_time(g["start"], segs)
                g["end"] = _remap_time(g["end"], segs)

    if not words_dicts:
        raise HTTPException(status_code=400, detail="No words to export.")

    content = generate_srt(
        words=words_dicts,
        words_per_group=req.words_per_group,
        custom_groups=groups_dicts,
        use_custom_groups=req.use_custom_groups and bool(groups_dicts),
        uppercase=req.uppercase,
    )

    if not content.strip():
        raise HTTPException(status_code=500, detail="SRT generation produced empty output.")

    stem = Path(req.video_filename).stem or "subtitles"
    srt_filename = f"{stem}.srt"
    srt_path = OUTPUT_DIR / srt_filename
    srt_path.parent.mkdir(parents=True, exist_ok=True)
    # UTF-8 with BOM — Premiere Pro reads non-ASCII reliably this way.
    with open(srt_path, "w", encoding="utf-8-sig") as f:
        f.write(content)

    return {
        "status": "ok",
        "filename": srt_filename,
        "url": f"/outputs/{srt_filename}",
        "size_bytes": srt_path.stat().st_size,
    }


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

@app.get("/outputs/{filename:path}")
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
    for f in OUTPUT_DIR.rglob("*"):
        if f.is_file() and f.suffix == ".json":
            rel_path = f.relative_to(OUTPUT_DIR).as_posix()
            files.append({
                "filename": rel_path,
                "size_kb": round(f.stat().st_size / 1024, 1),
                "url": f"/outputs/{rel_path}",
            })
    return {"files": files}


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
    """Background task: render a Shorts-format video using the chosen mode."""
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

        mode = req.shorts_mode or "vtuber"
        suffix = {"vtuber": "vtuber", "zoomed": "zoomed",
                  "blur_bg": "blurbg", "black_bg": "blackbg"}.get(mode, mode)
        output_filename = f"{video_path.stem}_{suffix}_{job_id}.mp4"
        output_path = RENDERED_DIR / output_filename

        if mode == "zoomed":
            render_shorts_zoomed(
                video_path=str(video_path),
                output_path=str(output_path),
                zoom=req.single_zoom,
                pan_x=req.single_pan_x,
                pan_y=req.single_pan_y,
                out_width=req.out_width,
                out_height=req.out_height,
                crf=req.crf,
                preset=req.preset,
                progress_cb=progress,
            )
        elif mode == "blur_bg":
            render_shorts_blur_bg(
                video_path=str(video_path),
                output_path=str(output_path),
                out_width=req.out_width,
                out_height=req.out_height,
                crf=req.crf,
                preset=req.preset,
                progress_cb=progress,
            )
        elif mode == "black_bg":
            render_shorts_black_bg(
                video_path=str(video_path),
                output_path=str(output_path),
                out_width=req.out_width,
                out_height=req.out_height,
                crf=req.crf,
                preset=req.preset,
                progress_cb=progress,
            )
        else:  # 'vtuber' (split-screen)
            render_vtuber_short(
                video_path=str(video_path),
                output_path=str(output_path),
                split_ratio=req.split_ratio,
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
        log.exception("reframe %s failed: %s", job_id, e)
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


# ─── Manual Trim ────────────────────────────────────────────

def _do_trim(job_id: str, req: TrimRequest):
    """Background task: trim video to [trim_start, trim_end] using FFmpeg."""
    logs: list[str] = []

    def log_msg(msg: str):
        logs.append(msg)
        trim_jobs[job_id]["log"] = msg
        log.info("trim %s — %s", job_id, msg)

    try:
        video_path = UPLOAD_DIR / req.video_filename
        if not video_path.exists():
            # Also check rendered dir
            video_path = RENDERED_DIR / req.video_filename
        if not video_path.exists():
            trim_jobs[job_id] = {"status": "error", "error": f"Video not found: {req.video_filename}"}
            return

        trim_jobs[job_id]["status"] = "processing"

        duration = req.trim_end - req.trim_start
        if duration <= 0:
            trim_jobs[job_id] = {"status": "error", "error": "trim_end must be greater than trim_start"}
            return

        log(f"Trimming {video_path.name}  {req.trim_start:.3f}s -> {req.trim_end:.3f}s  ({duration:.3f}s)")

        output_filename = f"{video_path.stem}_trim_{job_id}.mp4"
        output_path = RENDERED_DIR / output_filename

        import subprocess, time as _time
        t0 = _time.time()

        cmd_gpu = [
            "ffmpeg", "-y",
            "-ss", str(req.trim_start),
            "-i", str(video_path),
            "-t", str(duration),
            "-c:v", "h264_nvenc",
            "-cq", "18",
            "-preset", "p4",
            "-c:a", "aac",
            "-b:a", "192k",
            "-avoid_negative_ts", "make_zero",
            "-movflags", "+faststart",
            str(output_path),
        ]

        log(f"Running FFmpeg…")
        result = subprocess.run(cmd_gpu, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)

        if result.returncode != 0:
            if "h264_nvenc" in result.stderr or "Unknown encoder" in result.stderr:
                cmd_cpu = [
                    "ffmpeg", "-y",
                    "-ss", str(req.trim_start),
                    "-i", str(video_path),
                    "-t", str(duration),
                    "-c:v", "libx264",
                    "-crf", "18",
                    "-preset", "fast",
                    "-c:a", "aac",
                    "-b:a", "192k",
                    "-avoid_negative_ts", "make_zero",
                    "-movflags", "+faststart",
                    str(output_path),
                ]
                result = subprocess.run(cmd_cpu, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
                if result.returncode != 0:
                    tail = result.stderr[-1200:] if result.stderr else "No stderr"
                    raise RuntimeError(f"FFmpeg failed (CPU fallback) (code {result.returncode}):\n{tail}")
            else:
                tail = result.stderr[-1200:] if result.stderr else "No stderr"
                raise RuntimeError(f"FFmpeg failed (GPU) (code {result.returncode}):\n{tail}")

        if not output_path.exists():
            raise RuntimeError("FFmpeg exited 0 but output file was not created.")

        elapsed = round(_time.time() - t0, 1)
        size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)
        log(f"Done in {elapsed}s -> {output_filename} ({size_mb} MB)")

        trim_jobs[job_id] = {
            "status": "done",
            "filename": output_filename,
            "url": f"/rendered/{output_filename}",
            "trim_start": req.trim_start,
            "trim_end": req.trim_end,
            "duration_s": round(duration, 3),
            "size_mb": size_mb,
            "processing_time_s": elapsed,
        }

    except Exception as e:
        log.exception("trim %s failed: %s", job_id, e)
        trim_jobs[job_id] = {"status": "error", "error": str(e)}


@app.post("/trim")
async def start_trim(req: TrimRequest, background_tasks: BackgroundTasks):
    """Start a background trim job. Returns job_id for polling."""
    job_id = uuid.uuid4().hex[:8]
    trim_jobs[job_id] = {"status": "queued", "log": "Queued…"}
    background_tasks.add_task(_do_trim, job_id, req)
    return {"job_id": job_id}


@app.get("/trim-status/{job_id}")
async def get_trim_status(job_id: str):
    """Poll the status of a trim job."""
    if job_id not in trim_jobs:
        raise HTTPException(status_code=404, detail="Trim job not found")
    return trim_jobs[job_id]


# ─── YT Clipper ───────────────────────────────────────────────


def _do_yt_analyze(job_id: str, url: str, criteria: str, api_key: str,
                   use_chat_signal: bool = True, include_setup: bool = True):
    """Background task: extract transcript + optional chat-hype + Gemini analysis."""
    import time as _time
    t0 = _time.time()
    def _elapsed():
        return int(_time.time() - t0)
    try:
        yt_analyze_jobs[job_id] = {
            "status": "extracting",
            "message": "Extracting captions from YouTube…",
            "elapsed": _elapsed(),
        }

        def _tx_progress(stage: str, info: dict):
            if stage == "metadata":
                msg = "Fetching video metadata…"
            elif stage == "metadata_done":
                title = info.get("title") or ""
                dur = info.get("duration") or 0
                lang = info.get("lang") or "?"
                msg = f"Metadata ready — {title[:60]} ({int(dur)}s, lang={lang})"
            elif stage == "downloading_subs":
                b = info.get("bytes") or 0
                total = info.get("total")
                mb = b / (1024 * 1024)
                if total:
                    tot_mb = total / (1024 * 1024)
                    pct = (b / total) * 100 if total else 0
                    msg = f"Downloading captions… {mb:.2f}/{tot_mb:.2f} MB ({pct:.0f}%)"
                else:
                    msg = f"Downloading captions… {mb:.2f} MB"
            elif stage == "subs_downloaded":
                b = info.get("bytes") or 0
                msg = f"Captions downloaded ({b / (1024*1024):.2f} MB)"
            elif stage == "parsing_subs":
                msg = "Parsing captions…"
            else:
                msg = f"Captions: {stage}"
            yt_analyze_jobs[job_id] = {
                "status": "extracting",
                "message": msg,
                "elapsed": _elapsed(),
            }

        transcript_data = extract_transcript(url, progress_cb=_tx_progress)

        chat_buckets = None
        if use_chat_signal:
            yt_analyze_jobs[job_id] = {
                "status": "chat",
                "message": "Fetching live-chat replay for hype signal…",
                "elapsed": _elapsed(),
            }
            try:
                from yt_clipper import fetch_chat_replay, bucket_chat, annotate_baseline_signals

                def _chat_progress(stage: str, info: dict):
                    if stage == "starting":
                        msg = "Connecting to YouTube for chat replay…"
                    elif stage == "downloading":
                        b = info.get("bytes") or 0
                        total = info.get("total")
                        mb = b / (1024 * 1024)
                        if total:
                            tot_mb = total / (1024 * 1024)
                            pct = (b / total) * 100 if total else 0
                            msg = f"Downloading chat replay… {mb:.1f}/{tot_mb:.1f} MB ({pct:.0f}%)"
                        else:
                            msg = f"Downloading chat replay… {mb:.1f} MB"
                    elif stage == "downloaded":
                        b = info.get("bytes") or 0
                        msg = f"Chat replay downloaded ({b / (1024*1024):.1f} MB), parsing…"
                    elif stage == "parsing":
                        msg = "Parsing chat messages…"
                    elif stage == "no_chat":
                        msg = "No chat replay available, skipping hype signal."
                    else:
                        msg = f"Chat: {stage}"
                    yt_analyze_jobs[job_id] = {
                        "status": "chat",
                        "message": msg,
                        "elapsed": _elapsed(),
                    }

                chat_msgs = fetch_chat_replay(url, progress_cb=_chat_progress)
                if chat_msgs:
                    yt_analyze_jobs[job_id] = {
                        "status": "chat",
                        "message": f"Bucketing {len(chat_msgs)} chat messages…",
                        "elapsed": _elapsed(),
                    }
                    chat_buckets = bucket_chat(
                        chat_msgs,
                        transcript_data["video_duration"],
                        bucket_size=15.0,
                    )
                    if chat_buckets:
                        chat_buckets = annotate_baseline_signals(chat_buckets)
            except Exception as chat_err:
                log.warning("yt-analyze %s — chat signal skipped: %s", job_id, chat_err)
                chat_buckets = None

        yt_analyze_jobs[job_id] = {
            "status": "analyzing",
            "message": "Sending transcript to Gemini AI…",
            "elapsed": _elapsed(),
        }
        clips = analyze_with_gemini(
            transcript_data,
            criteria,
            api_key,
            chat_buckets=chat_buckets,
            include_setup=include_setup,
        )

        yt_analyze_jobs[job_id] = {
            "status": "done",
            "message": f"Found {len(clips)} clip(s).",
            "video_title": transcript_data["video_title"],
            "video_duration": transcript_data["video_duration"],
            "clips": clips,
            "elapsed": _elapsed(),
        }
    except Exception as e:
        log.exception("yt-analyze %s failed: %s", job_id, e)
        yt_analyze_jobs[job_id] = {
            "status": "error",
            "message": str(e),
            "elapsed": _elapsed(),
        }


@app.post("/yt-clip/analyze")
async def yt_clip_analyze(req: YtAnalyzeRequest, background_tasks: BackgroundTasks):
    """Start background job: extract YT captions → Gemini analysis → proposed clips."""
    api_key = req.gemini_api_key.strip()
    if not api_key:
        api_key = (load_settings().get("gemini_api_key") or "").strip()
    if not api_key:
        raise HTTPException(status_code=400, detail="Gemini API key is required.")
    job_id = uuid.uuid4().hex[:8]
    yt_analyze_jobs[job_id] = {"status": "queued", "message": "Queued…"}
    background_tasks.add_task(
        _do_yt_analyze,
        job_id,
        req.url,
        req.criteria,
        api_key,
        req.use_chat_signal,
        req.include_setup,
    )
    return {"job_id": job_id}


@app.get("/yt-clip/analyze-status/{job_id}")
async def yt_clip_analyze_status(job_id: str):
    """Poll the status of a YT analyze job."""
    if job_id not in yt_analyze_jobs:
        raise HTTPException(status_code=404, detail="Analyze job not found")
    return yt_analyze_jobs[job_id]


def _do_yt_cut(job_id: str, url: str, clips: list[dict]):
    """Background task: download video + cut all selected clips."""
    try:
        total = len(clips)

        def progress(stage: str, pct: int):
            status = "downloading" if "download" in stage.lower() else "cutting"
            yt_cut_jobs[job_id] = {
                "status": status,
                "message": f"{stage.capitalize()}… {pct}%",
                "progress": pct,
                "clips": yt_cut_jobs[job_id].get("clips", []),
            }

        yt_cut_jobs[job_id] = {"status": "downloading", "message": "Starting download…", "progress": 0, "clips": []}
        results = download_and_cut_clips(url, clips, UPLOAD_DIR, progress_cb=progress)

        yt_cut_jobs[job_id] = {
            "status": "done",
            "message": f"✅ {len(results)} clip(s) saved to uploads folder.",
            "progress": 100,
            "clips": results,
        }
    except Exception as e:
        log.exception("yt-cut %s failed: %s", job_id, e)
        yt_cut_jobs[job_id] = {"status": "error", "message": str(e), "progress": 0, "clips": []}


@app.post("/yt-clip/cut")
async def yt_clip_cut(req: YtCutRequest, background_tasks: BackgroundTasks):
    """Start background job: download video → cut selected clips → save to uploads/."""
    if not req.clips:
        raise HTTPException(status_code=400, detail="No clips provided.")
    clips_dict = [c.model_dump() for c in req.clips]
    job_id = uuid.uuid4().hex[:8]
    yt_cut_jobs[job_id] = {"status": "queued", "message": "Queued…", "progress": 0, "clips": []}
    background_tasks.add_task(_do_yt_cut, job_id, req.url, clips_dict)
    return {"job_id": job_id}


@app.get("/yt-clip/cut-status/{job_id}")
async def yt_clip_cut_status(job_id: str):
    """Poll the status of a YT cut job."""
    if job_id not in yt_cut_jobs:
        raise HTTPException(status_code=404, detail="Cut job not found")
    return yt_cut_jobs[job_id]


# ─── Refine ─────────────────────────────────────────────────

def _do_refine(job_id: str, req: RefineRequest):
    """Background task: run full refine pipeline."""
    def progress(step: str, msg: str):
        refine_jobs[job_id]["step"] = step
        refine_jobs[job_id]["message"] = msg

    try:
        video_path = UPLOAD_DIR / req.video_filename
        if not video_path.exists():
            video_path = RENDERED_DIR / req.video_filename
        if not video_path.exists():
            refine_jobs[job_id] = {
                "status": "error",
                "error": f"Video file not found: {req.video_filename}",
            }
            return

        refine_jobs[job_id]["status"] = "processing"

        result = refine_video(
            video_path=str(video_path),
            output_dir=str(OUTPUT_DIR),
            rendered_dir=str(RENDERED_DIR),
            gemini_api_key=req.gemini_api_key,
            req_filename=req.video_filename,
            transcription_model=req.transcription_model,
            elevenlabs_api_key=req.elevenlabs_api_key,
            diarize=req.diarize,
            num_speakers=req.num_speakers,
            do_grouping=req.do_grouping,
            progress_cb=progress,
        )

        refine_jobs[job_id] = {
            "status": "done",
            **result,
        }

        # Save to JSON so it can be reloaded
        import json
        req_path = Path(req.video_filename)
        rel_parent = req_path.parent
        stem = req_path.stem
        tx_path = OUTPUT_DIR / rel_parent / f"{stem}_transcription.json"
        tx_path.parent.mkdir(parents=True, exist_ok=True)
        try:
            with open(tx_path, "w", encoding="utf-8") as f:
                json.dump(result, f, ensure_ascii=False)
        except Exception as e:
            log.warning("refine %s — failed to save JSON: %s", job_id, e)
    except Exception as e:
        log.exception("refine %s failed: %s", job_id, e)
        import traceback
        traceback.print_exc()
        refine_jobs[job_id] = {"status": "error", "error": str(e)}


@app.post("/refine")
async def start_refine(req: RefineRequest, background_tasks: BackgroundTasks):
    """Start a background refine job. Returns job_id for polling."""
    if not req.gemini_api_key.strip():
        raise HTTPException(status_code=400, detail="Gemini API key is required.")
    video_path = UPLOAD_DIR / req.video_filename
    if not video_path.exists():
        video_path = RENDERED_DIR / req.video_filename
    if not video_path.exists():
        raise HTTPException(status_code=404, detail=f"Video not found: {req.video_filename}")
    job_id = uuid.uuid4().hex[:8]
    refine_jobs[job_id] = {"status": "queued", "step": "init", "message": "Queued…"}
    background_tasks.add_task(_do_refine, job_id, req)
    return {"job_id": job_id}


@app.get("/refine-status/{job_id}")
async def get_refine_status(job_id: str):
    """Poll the status of a refine job."""
    if job_id not in refine_jobs:
        raise HTTPException(status_code=404, detail="Refine job not found")
    return refine_jobs[job_id]


# ─── Settings ───────────────────────────────────────────────


class SettingsPatch(BaseModel):
    elevenlabs_api_key: Optional[str] = None
    elevenlabs_model: Optional[str] = None
    elevenlabs_models: Optional[list[str]] = None
    gemini_api_key: Optional[str] = None
    gemini_model: Optional[str] = None
    gemini_models: Optional[list[str]] = None


class TestKeyRequest(BaseModel):
    api_key: str
    model: Optional[str] = None


class ModelMutation(BaseModel):
    provider: str  # "elevenlabs" | "gemini"
    model: str


def _redact(s: dict) -> dict:
    """Mask API keys before sending to client."""
    out = dict(s)
    for k in ("elevenlabs_api_key", "gemini_api_key"):
        v = out.get(k) or ""
        if v:
            out[k] = "•" * 6 + v[-4:]
            out[f"{k}_set"] = True
        else:
            out[f"{k}_set"] = False
    return out


@app.get("/settings")
async def get_settings():
    """Return the current settings (keys are redacted)."""
    return _redact(load_settings())


@app.put("/settings")
async def update_settings(patch: SettingsPatch):
    """Persist a partial settings patch."""
    payload = {k: v for k, v in patch.model_dump().items() if v is not None}
    saved = save_settings(payload)
    return _redact(saved)


@app.post("/settings/models/add")
async def add_settings_model(req: ModelMutation):
    try:
        saved = add_model(req.provider, req.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _redact(saved)


@app.post("/settings/models/remove")
async def remove_settings_model(req: ModelMutation):
    try:
        saved = remove_model(req.provider, req.model)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    return _redact(saved)


@app.post("/settings/test/elevenlabs")
async def test_elevenlabs(req: TestKeyRequest):
    """Test an ElevenLabs key (and optional model). Falls back to saved values."""
    s = load_settings()
    key = req.api_key.strip() or s.get("elevenlabs_api_key", "")
    model = (req.model or s.get("elevenlabs_model") or "").strip() or None
    return test_elevenlabs_key(key, model)


@app.post("/settings/test/gemini")
async def test_gemini(req: TestKeyRequest):
    """Test a Gemini key against a specific model."""
    s = load_settings()
    key = req.api_key.strip() or s.get("gemini_api_key", "")
    model = (req.model or s.get("gemini_model") or "gemini-2.0-flash").strip()
    return test_gemini_key(key, model)


# ─── Static Files ──────────────────────────────────────────

app.mount("/uploads", StaticFiles(directory=UPLOAD_DIR), name="uploads")
app.mount("/", StaticFiles(directory=FRONTEND_DIR, html=True), name="frontend")
