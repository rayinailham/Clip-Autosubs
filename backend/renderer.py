"""
Video Renderer — Burns ASS subtitles into video using FFmpeg.

Runs FFmpeg as a subprocess to combine the original video
with the generated .ass subtitle file.
"""

import json
import shutil
import subprocess
from pathlib import Path

from logger import get_logger

log = get_logger("renderer")


def check_ffmpeg() -> dict:
    """Check if ffmpeg and ffprobe binaries are available on PATH."""
    ffmpeg_path = shutil.which("ffmpeg")
    ffprobe_path = shutil.which("ffprobe")
    return {
        "ffmpeg": ffmpeg_path is not None,
        "ffprobe": ffprobe_path is not None,
        "ffmpeg_path": ffmpeg_path,
        "ffprobe_path": ffprobe_path,
    }


def get_video_info(video_path: str) -> dict:
    """Get video width, height, and duration using ffprobe."""
    try:
        result = subprocess.run(
            [
                "ffprobe",
                "-v", "quiet",
                "-print_format", "json",
                "-show_streams",
                "-show_format",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=30,
        )
        info = json.loads(result.stdout)

        video_stream = None
        for stream in info.get("streams", []):
            if stream.get("codec_type") == "video":
                video_stream = stream
                break

        width = int(video_stream.get("width", 1920)) if video_stream else 1920
        height = int(video_stream.get("height", 1080)) if video_stream else 1080
        
        # Check rotation tags (e.g., from smartphones) to ensure horizontal vs vertical is correct
        tags = video_stream.get("tags", {}) if video_stream else {}
        rotate = tags.get("rotate", "0")
        
        # Also check side_data for displaymatrix rotation
        side_data_list = video_stream.get("side_data_list", []) if video_stream else []
        rotation = 0
        try:
            rotation = abs(int(float(rotate)))
        except ValueError:
            pass
            
        for sd in side_data_list:
            if sd.get("side_data_type") == "Display Matrix":
                rot = sd.get("rotation", 0)
                try:
                    rotation = abs(int(float(rot)))
                except ValueError:
                    pass

        # If rotated 90 or 270 degrees, swap width and height
        if rotation in (90, 270, -90, -270):
            width, height = height, width

        duration = float(info.get("format", {}).get("duration", 0))

        return {"width": width, "height": height, "duration": duration}
    except Exception as e:
        log.warning("ffprobe failed, using defaults: %s", e)
        return {"width": 1920, "height": 1080, "duration": 0}


def escape_ffmpeg_filter_path(path: str) -> str:
    """
    Escape a file path for use inside an FFmpeg filter string on Windows.
    - Backslashes → forward slashes
    - Colons → escaped colons
    """
    return str(path).replace("\\", "/").replace(":", "\\:")


def render_video(
    video_path: str,
    ass_path: str,
    output_path: str,
    crf: int = 18,
    preset: str = "medium",
) -> str:
    """
    Render video with burned-in ASS subtitles.

    Uses the 'subtitles' filter (libass) to overlay the .ass file
    onto the original video. Audio is copied without re-encoding.
    """
    video_path = Path(video_path).resolve()
    ass_path = Path(ass_path).resolve()
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")
    if not ass_path.exists():
        raise FileNotFoundError(f"ASS subtitle file not found: {ass_path}")

    # Escape the ASS path for use in the FFmpeg filter graph
    ass_escaped = escape_ffmpeg_filter_path(str(ass_path))

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-vf", f"ass='{ass_escaped}'",
        "-c:v", "h264_nvenc",
        "-cq", str(crf),
        "-r", "60",
        "-preset", "p4",
        "-c:a", "copy",
        "-movflags", "+faststart",
        str(output_path),
    ]

    log.debug("Command: %s", " ".join(cmd))
    log.info("Rendering…")

    result = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=600,  # 10 minutes max
    )

    if result.returncode != 0:
        # Try fallback with 'subtitles' filter instead of 'ass'
        log.warning("'ass' filter failed, trying 'subtitles' filter…")
        cmd_fallback = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-vf", f"subtitles='{ass_escaped}'",
            "-c:v", "h264_nvenc",
            "-cq", str(crf),
            "-r", "60",
            "-preset", "p4",
            "-c:a", "copy",
            "-movflags", "+faststart",
            str(output_path),
        ]
        result = subprocess.run(
            cmd_fallback,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )
        if result.returncode != 0:
            error_tail = result.stderr[-800:] if result.stderr else "Unknown error"
            raise RuntimeError(f"FFmpeg rendering failed:\n{error_tail}")

    if not output_path.exists():
        raise RuntimeError("FFmpeg completed but output file was not created")

    size_mb = output_path.stat().st_size / (1024 * 1024)
    log.info("Done — output: %s ([ok]%.1f MB[/])", output_path, size_mb)
    return str(output_path)


def _has_audio_stream(video_path: str) -> bool:
    """Return True if the file contains at least one audio stream."""
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "quiet", "-select_streams", "a",
             "-show_entries", "stream=codec_type", "-of", "csv=p=0", str(video_path)],
            capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=10,
        )
        return bool(result.stdout.strip())
    except Exception:
        return True


def cut_video_segments(
    video_path: str,
    segments: list,
    output_path: str,
    progress_cb=None,
) -> None:
    """Cut video to only the given (start, end) segments using FFmpeg trim+concat."""
    import os, tempfile

    def log(msg: str):
        if progress_cb:
            progress_cb(msg)
        else:
            log.info("cut_segments — %s", msg)

    vp = Path(video_path).resolve()
    op = Path(output_path).resolve()
    op.parent.mkdir(parents=True, exist_ok=True)

    has_audio = _has_audio_stream(str(vp))
    filter_parts, stream_labels = [], []

    for i, (start, end) in enumerate(segments):
        filter_parts.append(f"[0:v]trim=start={start:.4f}:end={end:.4f},setpts=PTS-STARTPTS[v{i}]")
        if has_audio:
            filter_parts.append(f"[0:a]atrim=start={start:.4f}:end={end:.4f},asetpts=PTS-STARTPTS[a{i}]")
            stream_labels.append(f"[v{i}][a{i}]")
        else:
            stream_labels.append(f"[v{i}]")

    n = len(segments)
    concat = "".join(stream_labels)
    if has_audio:
        filter_parts.append(f"{concat}concat=n={n}:v=1:a=1[outv][outa]")
    else:
        filter_parts.append(f"{concat}concat=n={n}:v=1:a=0[outv]")

    filter_script = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".txt", delete=False, encoding="utf-8") as f:
            filter_script = f.name
            f.write(";\n".join(filter_parts))

        cmd = ["ffmpeg", "-y", "-i", str(vp), "-filter_complex_script", filter_script, "-map", "[outv]"]
        if has_audio:
            cmd.extend(["-map", "[outa]"])
        cmd.extend(["-c:v", "libx264", "-crf", "18", "-preset", "fast"])
        if has_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        cmd.extend(["-movflags", "+faststart", str(op)])

        log(f"Cutting {n} segments…")
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)
        if result.returncode != 0:
            raise RuntimeError(f"FFmpeg cut failed (code {result.returncode}):\n{result.stderr[-1200:]}")
        if not op.exists():
            raise RuntimeError("FFmpeg exited 0 but output file was not created.")
    finally:
        if filter_script and os.path.exists(filter_script):
            try:
                os.unlink(filter_script)
            except OSError:
                pass
