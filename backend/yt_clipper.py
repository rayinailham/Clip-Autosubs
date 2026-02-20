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
import time
import urllib.request
from pathlib import Path
from typing import Optional

try:
    import yt_dlp
    YT_DLP_AVAILABLE = True
except ImportError:
    YT_DLP_AVAILABLE = False

try:
    from youtube_transcript_api import YouTubeTranscriptApi
    YT_TRANSCRIPT_API_AVAILABLE = True
except ImportError:
    YT_TRANSCRIPT_API_AVAILABLE = False

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


def _extract_video_id(url: str) -> str:
    """Extract video ID from a YouTube URL."""
    patterns = [
        r"(?:v=|/v/|youtu\.be/)([a-zA-Z0-9_-]{11})",
        r"(?:embed/)([a-zA-Z0-9_-]{11})",
        r"(?:shorts/)([a-zA-Z0-9_-]{11})",
    ]
    for pattern in patterns:
        match = re.search(pattern, url)
        if match:
            return match.group(1)
    return ""


def _get_cookie_opts_list() -> list[dict]:
    """Return a list of cookie configurations to try, in order of preference."""
    opts = []
    # 1. Local cookies.txt (most reliable, avoids browser lock/DPAPI completely)
    if Path("cookies.txt").exists():
        opts.append({"cookiefile": "cookies.txt"})
    # 2. Try browsers (excluding chrome initially if possible, or placing it last due to App-Bound Encryption DPAPI issues)
    opts.extend([
        {"cookiesfrombrowser": ("edge",)},
        {"cookiesfrombrowser": ("firefox",)},
        {"cookiesfrombrowser": ("brave",)},
        {"cookiesfrombrowser": ("opera",)},
        {"cookiesfrombrowser": ("chrome",)},
        {}  # Fallback: try without cookies
    ])
    return opts


def _extract_via_transcript_api(url: str) -> dict:
    """
    Fallback: use youtube_transcript_api to fetch captions directly.
    This avoids yt-dlp's subtitle download and its 429 issues.
    """
    video_id = _extract_video_id(url)
    if not video_id:
        raise RuntimeError(f"Could not extract video ID from URL: {url}")

    print(f"[yt-clipper] Trying youtube_transcript_api for {video_id}…")

    # Fetch transcript list via the API
    # Must use an instance as 'list' is a bound method
    transcript_list = YouTubeTranscriptApi().list(video_id)
    
    # Identify the best transcript:
    # 1. Prefer auto-generated original language (as requested by user)
    # 2. Fall back to manually created original language
    # 3. Fall back to any Japanese/English version
    # 4. Fall back to the first available
    try:
        transcript = transcript_list.find_generated_transcript()
    except Exception:
        try:
            transcript = transcript_list.find_manually_created_transcript()
        except Exception:
            try:
                # Specific search for common languages
                transcript = transcript_list.find_transcript(["ja", "en", "en-US"])
            except Exception:
                # Just take whatever is first
                transcript = next(iter(transcript_list))
    
    print(f"[yt-clipper] Using transcript language: {transcript.language} ({'auto-generated' if transcript.is_generated else 'manual'})")
    entries = transcript.fetch()

    segments = []
    for entry in entries:
        # Handle both dict-like and object-like entries (fix for 'FetchedTranscriptSnippet' not subscriptable)
        try:
            text = entry["text"].strip()
            start = float(entry["start"])
            duration = float(entry["duration"])
        except (TypeError, KeyError, AttributeError):
            text = getattr(entry, "text", "").strip()
            start = float(getattr(entry, "start", 0.0))
            duration = float(getattr(entry, "duration", 0.0))

        if not text or text.startswith("[") or text.startswith("♪"):
            continue
        
        end = round(start + duration, 2)
        segments.append({"start": round(start, 2), "end": end, "text": text})

    if not segments:
        raise RuntimeError("youtube_transcript_api returned empty transcript.")

    # We still need video metadata — do a quick yt-dlp info-only call (no subtitle download)
    title = "Unknown Video"
    duration = 0.0
    if YT_DLP_AVAILABLE:
        for cookie_opt in _get_cookie_opts_list():
            try:
                meta_opts = {
                    "skip_download": True,
                    "quiet": True,
                    "no_warnings": True,
                    "source_address": "0.0.0.0",
                    "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                }
                meta_opts.update(cookie_opt)
                
                with yt_dlp.YoutubeDL(meta_opts) as ydl:
                    info = ydl.extract_info(url, download=False)
                    title = info.get("title", title)
                    duration = float(info.get("duration") or 0)
                    break # Success!
            except Exception as e:
                pass
                
    return {
        "video_title": title,
        "video_id": video_id,
        "video_duration": duration,
        "segments": segments,
        "plain_text": _segments_to_plain_text(segments),
    }


def extract_transcript(url: str) -> dict:
    """
    Use yt-dlp to pull CC / auto-captions from a YouTube URL.
    Includes retry logic for 429 rate-limit errors and a fallback to
    youtube_transcript_api if yt-dlp keeps failing.

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

    max_retries = 3
    last_error = None

    for attempt in range(1, max_retries + 1):
        try:
            with tempfile.TemporaryDirectory() as tmpdir:
                # Try cookies in priority order until one succeeds at getting info
                info = None
                cookie_opts = _get_cookie_opts_list()
                
                for c_idx, cookie_opt in enumerate(cookie_opts):
                    try:
                        ydl_opts = {
                            "skip_download": True,
                            "writesubtitles": False,
                            "writeautomaticsub": True,
                            "subtitleslangs": [".*"],
                            "subtitlesformat": "json3/vtt/best",
                            "outtmpl": str(Path(tmpdir) / "%(id)s.%(ext)s"),
                            "quiet": True,
                            "no_warnings": True,
                            "user_agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
                            "referer": "https://www.youtube.com/",
                            "sleep_interval_subtitles": 7,
                            "source_address": "0.0.0.0",
                        }
                        ydl_opts.update(cookie_opt)

                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            info = ydl.extract_info(url, download=True)
                            break  # Success
                    except Exception as loop_e:
                        if c_idx == len(cookie_opts) - 1:
                            raise loop_e  # Last resort failed, let the outer retry block catch it
                

                # Identify the best subtitle file from the temp dir
                video_id = info.get("id", "unknown")
                title = info.get("title", "Unknown Video")
                duration = float(info.get("duration") or 0)
                video_lang = info.get("language")
                tmp_path = Path(tmpdir)
                
                # Priority 1: Match video language (original audio language)
                sub_files = []
                if video_lang:
                    # Match exact language code (e.g. .en.json3 or .en-US.json3)
                    sub_files = sorted(tmp_path.glob(f"{video_id}.{video_lang}*.json3")) or \
                                sorted(tmp_path.glob(f"{video_id}.{video_lang}*.vtt"))
                
                # Priority 2: Any auto-subs for this video ID
                if not sub_files:
                    sub_files = sorted(tmp_path.glob(f"{video_id}*.json3")) or \
                                sorted(tmp_path.glob(f"{video_id}*.vtt"))

                if not sub_files:
                    # Last resort fallback: any caption file found
                    sub_files = sorted(tmp_path.glob("*.json3")) + sorted(tmp_path.glob("*.vtt"))

                if not sub_files:
                    raise RuntimeError(
                        "No auto-generated captions found for this video in the original language. "
                        "The video may have auto-captions disabled."
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

        except Exception as e:
            last_error = e
            error_str = str(e)
            is_rate_limit = "429" in error_str or "Too Many Requests" in error_str

            if is_rate_limit and attempt < max_retries:
                wait_secs = 5 * (2 ** (attempt - 1))  # 5s, 10s, 20s
                print(f"[yt-clipper] 429 rate-limited (attempt {attempt}/{max_retries}), retrying in {wait_secs}s…")
                time.sleep(wait_secs)
                continue
            elif not is_rate_limit:
                # Non-429 error, don't retry
                break
            # else: last attempt failed with 429, fall through to fallback

    # ── Fallback: try youtube_transcript_api ──────────────────────────────────
    if YT_TRANSCRIPT_API_AVAILABLE:
        try:
            print("[yt-clipper] yt-dlp subtitle download failed, trying youtube_transcript_api fallback…")
            return _extract_via_transcript_api(url)
        except Exception as fallback_err:
            raise RuntimeError(
                f"Both yt-dlp and youtube_transcript_api failed.\n"
                f"  yt-dlp error: {last_error}\n"
                f"  Fallback error: {fallback_err}"
            )

    # No fallback available, raise original error
    raise RuntimeError(
        f"Subtitle download failed after {max_retries} attempts (HTTP 429 rate-limit).\n"
        f"  Error: {last_error}\n"
        f"  Fix: install the fallback library with: pip install youtube-transcript-api"
    )


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


def download_video(
    url: str, 
    output_dir: Path, 
    progress_cb=None,
    clip_range: Optional[tuple[float, float]] = None,
    filename_stem: Optional[str] = None
) -> Path:
    """
    Download the best-quality MP4 (up to 1080p) using yt-dlp.
    Returns the path to the downloaded file.
    """
    if not YT_DLP_AVAILABLE:
        raise RuntimeError("yt-dlp is not installed. Run: pip install yt-dlp")

    output_dir.mkdir(parents=True, exist_ok=True)
    video_id = _extract_video_id(url)
    stem = filename_stem if filename_stem else f"{video_id}_source"

    # Use a fixed output template so we know the filename
    outtmpl = str(output_dir / f"{stem}.%(ext)s")

    class _ProgressHook:
        def __call__(self, d):
            if progress_cb and d.get("status") == "downloading":
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                downloaded = d.get("downloaded_bytes", 0)
                if total:
                    progress_cb(int(downloaded / total * 100))

    cookie_opts = _get_cookie_opts_list()
    for c_idx, cookie_opt in enumerate(cookie_opts):
        try:
            ydl_opts = {
                "format": "bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4][height<=1080]/best",
                "merge_output_format": "mp4",
                "outtmpl": outtmpl,
                "quiet": True,
                "no_warnings": True,
                "progress_hooks": [_ProgressHook()],
                "concurrent_fragment_downloads": 5,
                "continuedl": True,
                "external_downloader_args": {"ffmpeg": ["-rw_timeout", "15000000"]}, # 15s timeout to prevent hang
            }
            if clip_range:
                from yt_dlp.utils import download_range_func
                ydl_opts["download_ranges"] = download_range_func(None, [clip_range])
                ydl_opts["force_keyframes_at_cuts"] = True

            ydl_opts.update(cookie_opt)

            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(url, download=True)
                break # Success!
        except Exception as e:
            err_msg = str(e)
            is_bot_error = "confirm you’re not a bot" in err_msg or "429" in err_msg or "Sign in" in err_msg
            
            # Print warning but don't abort unless it's the last try
            if c_idx < len(cookie_opts) - 1:
                if "Could not copy" in err_msg and "cookie" in err_msg:
                    print(f"[yt-clipper] Cookie database ({cookie_opt}) locked or inaccessible. Trying next…")
                elif is_bot_error:
                    print(f"[yt-clipper] Bot detection triggered with {cookie_opt}. Trying next option…")
                continue

            if is_bot_error:
                raise RuntimeError(
                    "YouTube is blocking the download (bot detection).\n"
                    "FIX: Create a 'cookies.txt' file in your project folder using a browser extension "
                    "like 'Get cookies.txt LOCALLY' so yt-dlp can authenticate."
                )
            raise RuntimeError(f"Video download failed: {e}")

    # Find the downloaded file
    matches = [p for p in output_dir.iterdir() if p.stem == stem]
    if not matches:
        raise RuntimeError(f"Downloaded file not found after yt-dlp finished (expected stem: {stem}).")
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
    duration = end - start
    output_path.parent.mkdir(parents=True, exist_ok=True)
    cmd = [
        "ffmpeg", "-y",
        "-ss", _seconds_to_ffmpeg_ts(start),
        "-i", str(source_video),
        "-t", _seconds_to_ffmpeg_ts(duration),
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-c:a", "aac",
        "-b:a", "192k",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
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
    Full pipeline: download directly to clip sections → save to uploads_dir.

    Args:
        url: YouTube URL
        clips: list of [{id, title, start, end, ...}]
        uploads_dir: destination folder for cut clips
        tmp_dir: unused
        progress_cb: callable(stage: str, pct: int) for progress updates

    Returns:
        list of [{id, title, start, end, filename, filepath}]
    """
    # Stage 0: Get metadata/transcript first to get the video title
    yt_transcript = None
    video_title = "Unknown Video"
    video_id = _extract_video_id(url)
    
    try:
        print("[yt-clipper] Extracting reference transcript for clips…")
        yt_transcript = extract_transcript(url)
        video_title = yt_transcript.get("video_title", video_title)
        video_id = yt_transcript.get("video_id", video_id)
    except Exception as e:
        print(f"[yt-clipper] Warning: Could not extract reference transcript/metadata: {e}")

    # Stage 1: Create folder named after video title
    # Sanitize title for folder name (remove illegal characters)
    clean_title = re.sub(r'[<>:"/\\|?*]', "", video_title).strip()
    if not clean_title:
        clean_title = "YouTube Video"
    
    # Use Title [video_id] format for uniqueness
    folder_name = f"{clean_title} [{video_id}]"
    folder_path = uploads_dir / folder_name
    folder_path.mkdir(parents=True, exist_ok=True)

    if progress_cb:
        progress_cb("cutting", 0)

    # Stage 2: Cut clips directly via download
    results = []
    total_clips = len(clips)
    for i, clip in enumerate(clips):
        safe_title = re.sub(r'[<>:"/\\|?*]', "", clip["title"])[:50].strip()
        safe_title = re.sub(r"\s+", "_", safe_title)
        filename_stem = f"yt_{clip['id']:02d}_{safe_title}"

        def _dl_progress(pct):
            if progress_cb:
                overall_pct = int(((i + (pct / 100)) / total_clips) * 100)
                progress_cb("downloading & cutting", overall_pct)

        print(f"[yt-clipper] Downloading clip section: {clip['start']}s - {clip['end']}s into {filename_stem}")
        out_path = download_video(
            url,
            folder_path,
            progress_cb=_dl_progress,
            clip_range=(clip["start"], clip["end"]),
            filename_stem=filename_stem
        )

        filename = out_path.name

        # Save reference YouTube captions for this specific clip (if available)
        if yt_transcript and yt_transcript.get("segments"):
            clip_start = clip["start"]
            clip_end = clip["end"]
            clip_segments = []
            for seg in yt_transcript["segments"]:
                if seg["start"] < clip_end and seg["end"] > clip_start:
                    shifted = {
                        "start": round(max(0, seg["start"] - clip_start), 3),
                        "end": round(seg["end"] - clip_start, 3),
                        "text": seg["text"]
                    }
                    clip_segments.append(shifted)
            
            if clip_segments:
                cap_path = out_path.with_suffix(".yt_captions.json")
                with open(cap_path, "w", encoding="utf-8") as f:
                    json.dump({"segments": clip_segments}, f, indent=2, ensure_ascii=False)
                print(f"[yt-clipper] Saved reference captions: {cap_path.name}")

        results.append({
            "id": clip["id"],
            "title": clip["title"],
            "start": clip["start"],
            "end": clip["end"],
            "duration": clip.get("duration", round(clip["end"] - clip["start"], 2)),
            "filename": f"{folder_name}/{filename}",
        })

        if progress_cb:
            progress_cb("cutting", int((i + 1) / total_clips * 100))

    return results
