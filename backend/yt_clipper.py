"""
YT Clipper — Three-stage pipeline
  1. extract_transcript(url)      → full timestamped transcript from YT CC or auto-captions
  2. analyze_with_gemini(...)     → list of clip suggestions [{title,start,end,reason}]
  3. download_and_cut(url, clips) → downloads video, cuts each clip → saves to uploads/
"""

import json
import os
import re
import subprocess
import tempfile
import urllib.request
from pathlib import Path
from typing import Optional

try:
    import yt_dlp
    YT_DLP_AVAILABLE = True
except ImportError:
    YT_DLP_AVAILABLE = False

try:
    from google import genai
    from google.genai import types as genai_types
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False


# ─── Transcript Extraction ────────────────────────────────────────────────────

def _parse_json3(data: dict) -> list[dict]:
    """Parse yt-dlp json3 subtitle format to list of {start, end, text} segments."""
    segments = []
    events = data.get("events", [])
    for ev in events:
        t_start = ev.get("tStartMs", 0) / 1000.0
        duration = ev.get("dDurationMs", 0) / 1000.0
        t_end = t_start + duration
        segs = ev.get("segs", [])
        text = "".join(s.get("utf8", "") for s in segs).strip()
        # Skip empty lines or music/sound effect annotation lines
        if not text or text.startswith("[") or text.startswith("♪"):
            continue
        segments.append({"start": round(t_start, 2), "end": round(t_end, 2), "text": text})
    return segments


def _parse_vtt(vtt_text: str) -> list[dict]:
    """Parse WebVTT subtitle text to list of {start, end, text} segments."""
    segments = []
    blocks = re.split(r"\n\n+", vtt_text.strip())
    time_re = re.compile(
        r"(\d+):(\d{2}):(\d{2})\.(\d+)\s+-->\s+(\d+):(\d{2}):(\d{2})\.(\d+)"
    )
    for block in blocks:
        lines = block.strip().splitlines()
        timestamp_line = None
        text_lines = []
        for line in lines:
            m = time_re.match(line)
            if m:
                timestamp_line = m
            elif timestamp_line and line and not line.isdigit():
                # Strip VTT positioning tags
                clean = re.sub(r"<[^>]+>", "", line).strip()
                if clean:
                    text_lines.append(clean)
        if timestamp_line and text_lines:
            h1, m1, s1, ms1 = int(timestamp_line.group(1)), int(timestamp_line.group(2)), int(timestamp_line.group(3)), int(timestamp_line.group(4))
            h2, m2, s2, ms2 = int(timestamp_line.group(5)), int(timestamp_line.group(6)), int(timestamp_line.group(7)), int(timestamp_line.group(8))
            start = h1 * 3600 + m1 * 60 + s1 + ms1 / 1000
            end   = h2 * 3600 + m2 * 60 + s2 + ms2 / 1000
            text  = " ".join(text_lines)
            if text and not text.startswith("["):
                segments.append({"start": round(start, 2), "end": round(end, 2), "text": text})
    return segments


def _segments_to_plain_text(segments: list[dict]) -> str:
    """Convert segments to a timestamped plain-text block for sending to Gemini."""
    lines = []
    for seg in segments:
        start = int(seg["start"])
        mm, ss = divmod(start, 60)
        hh, mm = divmod(mm, 60)
        ts = f"{hh:02d}:{mm:02d}:{ss:02d}"
        lines.append(f"[{ts}] {seg['text']}")
    return "\n".join(lines)


def extract_transcript(url: str) -> dict:
    """
    Use yt-dlp to pull CC / auto-captions from a YouTube URL.
    Returns:
        {
            "video_title": str,
            "video_id": str,
            "video_duration": float,  # seconds
            "segments": [{"start": float, "end": float, "text": str}, ...],
            "plain_text": str,        # timestamped text for Gemini
        }
    Raises RuntimeError if no captions are found.
    """
    if not YT_DLP_AVAILABLE:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")

    with tempfile.TemporaryDirectory() as tmpdir:
        ydl_opts = {
            "skip_download": True,
            "writesubtitles": True,
            "writeautomaticsub": True,
            "subtitleslangs": ["en", "en-US", "en-GB", "en-orig"],
            "subtitlesformat": "json3/vtt/best",
            "outtmpl": str(Path(tmpdir) / "%(id)s.%(ext)s"),
            "quiet": True,
            "no_warnings": True,
        }

        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)

        video_id = info.get("id", "unknown")
        title = info.get("title", "Unknown Video")
        duration = float(info.get("duration") or 0)

        # Find a subtitle file in the temp dir
        tmp_path = Path(tmpdir)
        sub_files = sorted(tmp_path.glob(f"{video_id}*.json3")) or sorted(tmp_path.glob(f"{video_id}*.vtt"))

        if not sub_files:
            # Try without language suffix
            sub_files = sorted(tmp_path.glob("*.json3")) + sorted(tmp_path.glob("*.vtt"))

        if not sub_files:
            raise RuntimeError(
                "No captions found for this video. "
                "The video may have no CC or auto-generated subtitles."
            )

        sub_file = sub_files[0]
        raw = sub_file.read_text(encoding="utf-8")

        if sub_file.suffix == ".json3":
            try:
                parsed_json = json.loads(raw)
                segments = _parse_json3(parsed_json)
            except json.JSONDecodeError:
                segments = _parse_vtt(raw)
        else:
            segments = _parse_vtt(raw)

        if not segments:
            raise RuntimeError("Captions were found but could not be parsed.")

        return {
            "video_title": title,
            "video_id": video_id,
            "video_duration": duration,
            "segments": segments,
            "plain_text": _segments_to_plain_text(segments),
        }


# ─── Gemini Analysis ─────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are a YouTube content analyst. Your job is to identify the most clip-worthy moments 
from a video transcript. The user will tell you their criteria. You must return ONLY valid JSON.

Rules:
- Each clip should be a self-contained, engaging moment.
- Minimum clip duration: 30 seconds. Maximum: 4 minutes (240 seconds).
- Include some context before and after the key moment (a few seconds).
- Do not overlap clips unless they represent clearly distinct highlights.
- Return 3–15 clips unless the user specifically asks for more or fewer.
- IMPORTANT: start and end values MUST be plain decimal numbers representing SECONDS from the
  start of the video. For example, if a moment occurs at 25 minutes and 30 seconds,
  return "start": 1530.0 — NOT "start": 25 or "start": "25:30".

Respond ONLY with a JSON array in this exact format (no markdown, no explanation):
[
  {
    "id": 1,
    "title": "Short descriptive title",
    "start": 1530.0,
    "end": 1620.0,
    "reason": "One sentence explaining why this is clip-worthy."
  },
  ...
]
"""


def analyze_with_gemini(
    transcript_data: dict,
    criteria: str,
    api_key: str,
) -> list[dict]:
    """
    Send the transcript to Gemini and ask it to identify clip-worthy moments.

    Args:
        transcript_data: output from extract_transcript()
        criteria: user's description of what clips they want (or empty for auto)
        api_key: Google Gemini API key (provided per-request, never stored)

    Returns:
        list of clip dicts: [{id, title, start, end, reason, duration}]
    """
    if not GEMINI_AVAILABLE:
        raise RuntimeError(
            "google-genai is not installed. Run: pip install google-genai"
        )

    client = genai.Client(api_key=api_key)

    title = transcript_data["video_title"]
    duration = transcript_data["video_duration"]
    plain_text = transcript_data["plain_text"]

    user_criteria = criteria.strip() if criteria.strip() else "Find every clearly clippable moment — funny, insightful, emotional, or highly engaging."

    prompt = f"""\
Video title: {title}
Video total duration: {int(duration // 60)}m {int(duration % 60)}s

User criteria: {user_criteria}

Transcript (format: [HH:MM:SS] text):
{plain_text}
"""

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            temperature=0.3,
        ),
    )
    raw = response.text.strip()

    # Strip markdown code fences if present
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE)

    try:
        clips = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(f"Gemini returned invalid JSON: {e}\nRaw response:\n{raw[:500]}")

    # ── Heuristic: detect if Gemini returned minutes instead of seconds ──────
    # If the video is long (>5 min) but all clip timestamps are tiny (<3 min
    # total range), Gemini likely returned minutes as if they were seconds.
    if clips and duration > 300:
        max_end = max(float(c.get("end", 0)) for c in clips)
        if max_end < 180 and duration > max_end * 30:
            # Scale all timestamps by 60
            for c in clips:
                c["start"] = float(c.get("start", 0)) * 60
                c["end"]   = float(c.get("end",   0)) * 60

    # Validate and enrich each clip
    validated = []
    for i, clip in enumerate(clips):
        start = float(clip.get("start", 0))
        end = float(clip.get("end", start + 60))
        # Clamp to video duration
        if duration > 0:
            start = min(start, duration - 1)
            end = min(end, duration)
        if end <= start:
            end = start + 60
        # Enforce minimum clip length of 30 seconds
        if end - start < 30:
            end = start + 60
        validated.append({
            "id": clip.get("id", i + 1),
            "title": clip.get("title", f"Clip {i+1}"),
            "start": round(start, 2),
            "end": round(end, 2),
            "duration": round(end - start, 2),
            "reason": clip.get("reason", ""),
            "selected": True,
        })

    return validated


# ─── Download + FFmpeg Cut ────────────────────────────────────────────────────

def _seconds_to_ffmpeg_ts(secs: float) -> str:
    """Convert float seconds to HH:MM:SS.mmm for FFmpeg."""
    hh = int(secs // 3600)
    mm = int((secs % 3600) // 60)
    ss = secs % 60
    return f"{hh:02d}:{mm:02d}:{ss:06.3f}"


def download_video(url: str, output_dir: Path, progress_cb=None) -> Path:
    """
    Download the best-quality MP4 (up to 1080p) using yt-dlp.
    Returns the path to the downloaded file.
    """
    if not YT_DLP_AVAILABLE:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")

    output_dir.mkdir(parents=True, exist_ok=True)
    # Use a fixed output template so we know the filename
    outtmpl = str(output_dir / "%(id)s_source.%(ext)s")

    class _ProgressHook:
        def __call__(self, d):
            if progress_cb and d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                downloaded = d.get("downloaded_bytes", 0)
                if total:
                    progress_cb(int(downloaded / total * 100))

    ydl_opts = {
        "format": "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best",
        "merge_output_format": "mp4",
        "outtmpl": outtmpl,
        "quiet": True,
        "no_warnings": True,
        "progress_hooks": [_ProgressHook()],
    }

    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(url, download=True)
        video_id = info["id"]

    # Find the downloaded file
    matches = list(output_dir.glob(f"{video_id}_source.*"))
    if not matches:
        raise RuntimeError("Downloaded file not found after yt-dlp finished.")
    return matches[0]


def cut_clip(
    source_video: Path,
    start: float,
    end: float,
    output_path: Path,
) -> Path:
    """
    Cut a clip from source_video [start, end] (seconds) and save to output_path.
    Uses FFmpeg stream copy for speed (no re-encode).
    """
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-ss", _seconds_to_ffmpeg_ts(start),
        "-to", _seconds_to_ffmpeg_ts(end),
        "-i", str(source_video),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        str(output_path),
    ]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"FFmpeg error cutting clip:\n{result.stderr[-1000:]}")
    return output_path


def download_and_cut_clips(
    url: str,
    clips: list[dict],
    uploads_dir: Path,
    tmp_dir: Optional[Path] = None,
    progress_cb=None,
) -> list[dict]:
    """
    Full pipeline: download video → cut each clip → save to uploads_dir.

    Args:
        url: YouTube URL
        clips: list of [{id, title, start, end, ...}]
        uploads_dir: destination folder for cut clips
        tmp_dir: temp folder for the full download (cleaned up after)
        progress_cb: callable(stage: str, pct: int) for progress updates

    Returns:
        list of [{id, title, start, end, filename, filepath}]
    """
    use_tmp = tmp_dir is None
    if use_tmp:
        _tmp = tempfile.mkdtemp(prefix="yt_clipper_")
        tmp_path = Path(_tmp)
    else:
        tmp_path = tmp_dir
        tmp_path.mkdir(parents=True, exist_ok=True)

    try:
        # Stage 1: Download
        if progress_cb:
            progress_cb("downloading", 0)

        def _dl_progress(pct):
            if progress_cb:
                progress_cb("downloading", pct)

        source_file = download_video(url, tmp_path, progress_cb=_dl_progress)

        if progress_cb:
            progress_cb("cutting", 0)

        # Stage 2: Cut clips
        results = []
        for i, clip in enumerate(clips):
            # Build safe filename from title
            safe_title = re.sub(r'[<>:"/\\|?*]', "", clip["title"])[:50].strip()
            safe_title = re.sub(r"\s+", "_", safe_title)
            filename = f"yt_{clip['id']:02d}_{safe_title}.mp4"
            out_path = uploads_dir / filename

            cut_clip(source_file, clip["start"], clip["end"], out_path)

            results.append({
                "id": clip["id"],
                "title": clip["title"],
                "start": clip["start"],
                "end": clip["end"],
                "duration": clip.get("duration", round(clip["end"] - clip["start"], 2)),
                "filename": filename,
            })

            if progress_cb:
                progress_cb("cutting", int((i + 1) / len(clips) * 100))

        return results

    finally:
        if use_tmp:
            import shutil
            shutil.rmtree(_tmp, ignore_errors=True)
