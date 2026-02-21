"""
Video Renderer — Burns ASS subtitles into video using FFmpeg.

Runs FFmpeg as a subprocess to combine the original video
with the generated .ass subtitle file.
"""

import json
import shutil
import subprocess
from pathlib import Path


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
        duration = float(info.get("format", {}).get("duration", 0))

        return {"width": width, "height": height, "duration": duration}
    except Exception as e:
        print(f"[renderer] ffprobe failed, using defaults: {e}")
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

    print(f"[renderer] Command: {' '.join(cmd)}")
    print(f"[renderer] Rendering...")

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
        print(f"[renderer] 'ass' filter failed, trying 'subtitles' filter...")
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
    print(f"[renderer] Done! Output: {output_path} ({size_mb:.1f} MB)")
    return str(output_path)
