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

from logger import get_logger

log = get_logger("yt_clipper")

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
    """Return a list of cookie configurations to try."""
    cookie_path = str(Path(__file__).resolve().parent.parent / "cookies.txt")
    return [
        {"cookiefile": cookie_path},
        {"cookiesfrombrowser": ("edge",)}, # fallback
        {"cookiesfrombrowser": ("chrome",)}, # fallback
        {} # fallback to no cookies
    ]

# Silent logger to prevent yt-dlp from polluting console with DPAPI errors when iterating
class _SilentLogger:
    def debug(self, msg): pass
    def warning(self, msg): pass
    def error(self, msg): pass



def _extract_via_transcript_api(url: str) -> dict:
    """
    Fallback: use youtube_transcript_api to fetch captions directly.
    This avoids yt-dlp's subtitle download and its 429 issues.
    """
    video_id = _extract_video_id(url)
    if not video_id:
        raise RuntimeError(f"Could not extract video ID from URL: {url}")

    log.info("Trying youtube_transcript_api for %s…", video_id)

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
    
    log.info("Using transcript language: %s (%s)",
             transcript.language,
             "auto-generated" if transcript.is_generated else "manual")
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
                    "logger": _SilentLogger(),
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
        "first_speech_t": float(segments[0]["start"]) if segments else 0.0,
        "plain_text": _segments_to_plain_text(segments),
    }


def extract_transcript(url: str, progress_cb=None) -> dict:
    """
    Use yt-dlp to pull CC / auto-captions from a YouTube URL.
    Includes retry logic for 429 rate-limit errors and a fallback to
    youtube_transcript_api if yt-dlp keeps failing.
    progress_cb(stage: str, info: dict) — optional callback for stage updates.

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

    def _emit(stage, **info):
        if progress_cb:
            try: progress_cb(stage, info)
            except Exception: pass

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
                        _emit("metadata", attempt=attempt, cookie_idx=c_idx)
                        # 1. Fetch metadata without subtitles to get original video language
                        meta_opts = {
                            "skip_download": True,
                            "quiet": True,
                            "no_warnings": True,
                            "logger": _SilentLogger(),
                        }
                        meta_opts.update(cookie_opt)
                        with yt_dlp.YoutubeDL(meta_opts) as ydl:
                            info = ydl.extract_info(url, download=False)
                            video_lang = info.get("language") or "en"

                        _emit("metadata_done",
                              title=info.get("title", ""),
                              duration=float(info.get("duration") or 0),
                              lang=video_lang)

                        # 2. Download ONLY the original language transcript
                        def _sub_hook(d):
                            st = d.get("status")
                            if st == "downloading":
                                _emit("downloading_subs",
                                      bytes=d.get("downloaded_bytes", 0),
                                      total=d.get("total_bytes") or d.get("total_bytes_estimate"),
                                      speed=d.get("speed"))
                            elif st == "finished":
                                _emit("subs_downloaded",
                                      bytes=d.get("downloaded_bytes", 0))

                        ydl_opts = {
                            "skip_download": True,
                            "writesubtitles": True,
                            "writeautomaticsub": True,
                            "subtitleslangs": [f"{video_lang}.*"],
                            "subtitlesformat": "json3/vtt/best",
                            "outtmpl": str(Path(tmpdir) / "%(id)s.%(ext)s"),
                            "quiet": True,
                            "no_warnings": True,
                            "logger": _SilentLogger(),
                            "sleep_interval_subtitles": 2,
                            "concurrent_fragment_downloads": 5,
                            "progress_hooks": [_sub_hook],
                        }
                        ydl_opts.update(cookie_opt)

                        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                            info = ydl.extract_info(url, download=True)
                            break  # Success
                    except Exception as loop_e:
                        is_rate_limit = "429" in str(loop_e) or "Too Many Requests" in str(loop_e)
                        if is_rate_limit or c_idx == len(cookie_opts) - 1:
                            raise loop_e  # Hit 429 or last resort failed, let outer block catch it


                _emit("parsing_subs")

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

                first_speech_t = float(segments[0]["start"]) if segments else 0.0

                return {
                    "video_title": title,
                    "video_id": video_id,
                    "video_duration": duration,
                    "segments": segments,
                    "first_speech_t": first_speech_t,
                    "plain_text": _segments_to_plain_text(segments),
                }

        except Exception as e:
            last_error = e
            error_str = str(e)
            is_rate_limit = "429" in error_str or "Too Many Requests" in error_str

            if is_rate_limit and attempt < max_retries:
                wait_secs = 5 * (2 ** (attempt - 1))  # 5s, 10s, 20s
                log.warning("429 rate-limited (attempt %d/%d), retrying in %ss…",
                            attempt, max_retries, wait_secs)
                time.sleep(wait_secs)
                continue
            elif not is_rate_limit:
                # Non-429 error, don't retry
                break
            # else: last attempt failed with 429, fall through to fallback

    # ── Fallback: try youtube_transcript_api ──────────────────────────────────
    if YT_TRANSCRIPT_API_AVAILABLE:
        try:
            log.warning("yt-dlp subtitle download failed: %s", last_error)
            log.info("trying youtube_transcript_api fallback…")
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


# ─── Live Chat Replay (hype signal) ──────────────────────────────────────────

# EN + JP laugh / hype regexes (case-insensitive on EN side via re.I)
_LAUGH_RE = re.compile(
    r"(?:\b(?:lol|lmao+|rofl|haha+|hehe+|kek+w?|lul+w?|omegalul|pepelaugh)\b"
    r"|w{2,}$|w{3,}|草+|笑+|涙|🤣|😂|💀)",
    re.IGNORECASE,
)
_HYPE_RE = re.compile(
    r"(?:\b(?:pog+|poggers|pogchamp|let'?s ?go+|holy|insane|cracked|sheesh|no way|wtf)\b"
    r"|🔥|神|やばい|ヤバい|えぐ|すご+|ぱねえ|うおお+)",
    re.IGNORECASE,
)

# Rough currency → USD multipliers. Used only for relative weighting of superchats,
# precision is irrelevant — a 5x off rate still ranks "$500 SC" above "$2 SC".
_CURRENCY_TO_USD = {
    "USD": 1.0, "$": 1.0, "US$": 1.0,
    "JPY": 0.0067, "¥": 0.0067, "JP¥": 0.0067, "円": 0.0067,
    "EUR": 1.08, "€": 1.08,
    "GBP": 1.27, "£": 1.27,
    "CAD": 0.74, "CA$": 0.74,
    "AUD": 0.66, "A$": 0.66,
    "NZD": 0.61, "NZ$": 0.61,
    "KRW": 0.00075, "₩": 0.00075,
    "TWD": 0.031, "NT$": 0.031,
    "HKD": 0.13, "HK$": 0.13,
    "INR": 0.012, "₹": 0.012,
    "BRL": 0.20, "R$": 0.20,
    "MXN": 0.060, "MX$": 0.060,
    "IDR": 0.000064, "Rp": 0.000064,
    "PHP": 0.018, "₱": 0.018,
    "THB": 0.029, "฿": 0.029,
    "VND": 0.000040, "₫": 0.000040,
    "SGD": 0.74, "SG$": 0.74,
    "MYR": 0.22, "RM": 0.22,
    "PLN": 0.25, "zł": 0.25,
    "RUB": 0.011, "₽": 0.011,
    "CHF": 1.13,
    "SEK": 0.094, "NOK": 0.090, "DKK": 0.14,
    "TRY": 0.029, "ZAR": 0.054, "ARS": 0.0010,
}
_CURRENCY_RE = re.compile(
    r"(US\$|CA\$|A\$|NZ\$|NT\$|HK\$|MX\$|JP¥|SG\$|R\$|RM|Rp|zł|"
    r"USD|JPY|EUR|GBP|CAD|AUD|NZD|KRW|TWD|HKD|INR|BRL|MXN|IDR|PHP|"
    r"THB|VND|SGD|MYR|PLN|RUB|CHF|SEK|NOK|DKK|TRY|ZAR|ARS|"
    r"[\$€£¥₩₹₱฿₫₽]|円)"
)


def _parse_purchase_amount_to_usd(amount_text: str) -> float:
    """
    Convert YouTube purchaseAmountText (e.g. '$5.00', '¥500', 'PHP100.00') to
    approximate USD. Returns 0.0 if unparseable.
    """
    if not amount_text:
        return 0.0
    m = _CURRENCY_RE.search(amount_text)
    rate = _CURRENCY_TO_USD.get(m.group(1), 0.0) if m else 0.0
    if rate == 0.0:
        return 0.0
    # Strip non-numeric except dot/comma, normalize comma → dot if it's decimal
    num_str = re.sub(r"[^0-9.,]", "", amount_text)
    if not num_str:
        return 0.0
    # If both . and , present, assume , is thousands sep
    if "." in num_str and "," in num_str:
        num_str = num_str.replace(",", "")
    elif "," in num_str and "." not in num_str:
        # Locale where comma is decimal sep (e.g. EU)
        num_str = num_str.replace(",", ".")
    try:
        return float(num_str) * rate
    except ValueError:
        return 0.0


def _runs_to_text(runs: list) -> str:
    """Flatten a YouTube chat 'runs' array (text + emoji) to plain text."""
    parts = []
    for r in runs or []:
        if "text" in r:
            parts.append(r["text"])
        elif "emoji" in r:
            emoji = r["emoji"]
            shortcuts = emoji.get("shortcuts") or []
            if shortcuts:
                parts.append(shortcuts[0])
            elif emoji.get("emojiId"):
                parts.append(emoji["emojiId"])
    return " ".join(parts).strip()


def fetch_chat_replay(url: str, progress_cb=None) -> list[dict]:
    """
    Pull live-chat replay JSONL via yt-dlp. Returns [{t: float_seconds, text: str}, ...].
    Returns [] silently if no chat replay (regular VOD, premieres without chat, etc).
    progress_cb(stage: str, info: dict) — optional callback for stage updates.
    """
    if not YT_DLP_AVAILABLE:
        return []

    def _emit(stage, **info):
        if progress_cb:
            try: progress_cb(stage, info)
            except Exception: pass

    msgs = []
    try:
        with tempfile.TemporaryDirectory() as tmpdir:
            for cookie_opt in _get_cookie_opts_list():
                try:
                    def _hook(d):
                        st = d.get("status")
                        if st == "downloading":
                            _emit("downloading",
                                  bytes=d.get("downloaded_bytes", 0),
                                  total=d.get("total_bytes") or d.get("total_bytes_estimate"),
                                  speed=d.get("speed"))
                        elif st == "finished":
                            _emit("downloaded", bytes=d.get("downloaded_bytes", 0))
                    ydl_opts = {
                        "skip_download": True,
                        "writesubtitles": True,
                        "subtitleslangs": ["live_chat"],
                        "subtitlesformat": "json",
                        "outtmpl": str(Path(tmpdir) / "%(id)s.%(ext)s"),
                        "quiet": True,
                        "no_warnings": True,
                        "logger": _SilentLogger(),
                        "progress_hooks": [_hook],
                        "concurrent_fragment_downloads": 5,
                    }
                    ydl_opts.update(cookie_opt)
                    _emit("starting", cookie=bool(cookie_opt))
                    with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                        ydl.extract_info(url, download=True)
                    break
                except Exception:
                    continue

            tmp_path = Path(tmpdir)
            chat_files = sorted(tmp_path.glob("*.live_chat.json"))
            if not chat_files:
                log.info("No live-chat replay available (skipping hype signal).")
                _emit("no_chat")
                return []

            _emit("parsing", file=str(chat_files[0].name))

            for line in chat_files[0].read_text(encoding="utf-8").splitlines():
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    continue

                # Path: replayChatItemAction.actions[0].addChatItemAction.item
                actions = (
                    obj.get("replayChatItemAction", {})
                    .get("actions", [])
                )
                if not actions:
                    continue
                offset_ms = int(obj.get("replayChatItemAction", {}).get("videoOffsetTimeMsec", 0) or 0)
                t = offset_ms / 1000.0

                for act in actions:
                    item = act.get("addChatItemAction", {}).get("item", {})

                    # Detect renderer type → kind + paid amount
                    text_renderer = item.get("liveChatTextMessageRenderer")
                    paid_msg     = item.get("liveChatPaidMessageRenderer")
                    paid_sticker = item.get("liveChatPaidStickerRenderer")
                    member       = (item.get("liveChatMembershipItemRenderer")
                                    or item.get("liveChatSponsorshipsGiftPurchaseAnnouncementRenderer"))

                    renderer = text_renderer or paid_msg or paid_sticker or member
                    if not renderer:
                        continue

                    # Extract message text (best-effort across renderer types)
                    if paid_sticker:
                        # Sticker has no message body; synthesize a marker
                        text = "[STICKER]"
                    elif member:
                        # Member-join / gift announcement: use header subtext if present
                        header_runs = (
                            renderer.get("headerSubtext", {}).get("runs")
                            or renderer.get("primaryText", {}).get("runs")
                            or renderer.get("message", {}).get("runs")
                            or []
                        )
                        text = _runs_to_text(header_runs) or "[MEMBER]"
                    else:
                        text = _runs_to_text(renderer.get("message", {}).get("runs", []))

                    if not text:
                        continue

                    # Author channel id (for unique-author counting)
                    author_id = (
                        renderer.get("authorExternalChannelId")
                        or renderer.get("authorName", {}).get("simpleText")
                        or ""
                    )

                    # Paid amount → USD (0.0 for free messages)
                    amt_text = ""
                    if paid_msg or paid_sticker:
                        amt_text = (renderer.get("purchaseAmountText", {}) or {}).get("simpleText", "")
                    paid_usd = _parse_purchase_amount_to_usd(amt_text) if amt_text else 0.0

                    # Classify kind
                    if paid_msg:
                        kind = "superchat"
                    elif paid_sticker:
                        kind = "supersticker"
                    elif member:
                        kind = "member"
                    else:
                        kind = "msg"

                    msgs.append({
                        "t": t,
                        "text": text,
                        "author": author_id,
                        "kind": kind,
                        "paid_usd": paid_usd,
                    })
    except Exception as e:
        log.warning("Chat replay fetch failed (non-fatal): %s", e)
        return []

    log.info("Loaded %d chat messages.", len(msgs))
    return msgs


def bucket_chat(chat_msgs: list[dict], video_duration: float, bucket_size: float = 15.0) -> list[dict]:
    """
    Aggregate chat into fixed-size time buckets with multi-signal scoring.

    Signals captured per bucket:
      - msgs:          total chat messages
      - unique_authors: distinct chatter count (breadth, not just spam)
      - laugh / hype:  regex hits on laugh + hype tokens
      - sc_count:      superchat count
      - sc_usd:        sum of superchat USD value (currency-converted)
      - members:       new memberships / gifted memberships
      - stickers:      paid super-stickers
      - emote_wall:    True if ≥70% of msgs are pure-emote/reaction tokens
      - top_emotes:    [(token, count), …]

    Score formula (relative weights tuned for "moments people care about"):
        msgs * 1.0
      + unique_authors * 1.5     (diversity beats spam)
      + laugh   * 2.0
      + hype    * 1.5
      + sc_count * 5.0           (any SC = strong vote)
      + sc_usd   * 0.5           (extra weight for big SCs)
      + members * 8.0            (rare, high signal)
      + stickers * 3.0
      + (emote_wall ? msgs * 0.5 : 0)
    """
    if not chat_msgs or video_duration <= 0:
        return []

    n = int(video_duration // bucket_size) + 1
    buckets = [
        {
            "t_start": i * bucket_size,
            "msgs": 0,
            "authors": set(),
            "laugh": 0,
            "hype": 0,
            "sc_count": 0,
            "sc_usd": 0.0,
            "members": 0,
            "stickers": 0,
            "emote_msgs": 0,
            "tokens": {},
        }
        for i in range(n)
    ]

    for m in chat_msgs:
        idx = int(m["t"] // bucket_size)
        if idx < 0 or idx >= n:
            continue
        b = buckets[idx]
        kind = m.get("kind", "msg")
        text = m["text"]

        b["msgs"] += 1
        if m.get("author"):
            b["authors"].add(m["author"])

        if _LAUGH_RE.search(text):
            b["laugh"] += 1
        if _HYPE_RE.search(text):
            b["hype"] += 1

        if kind == "superchat":
            b["sc_count"] += 1
            b["sc_usd"] += float(m.get("paid_usd") or 0.0)
        elif kind == "supersticker":
            b["stickers"] += 1
            b["sc_usd"] += float(m.get("paid_usd") or 0.0)
        elif kind == "member":
            b["members"] += 1

        # Emote-wall detection: msg is mostly emoji / single short reaction token
        # Heuristic: short msgs (≤6 chars) OR pure emoji-shortcut (starts with ':' or non-ascii letter)
        stripped = text.strip()
        is_emote_msg = (
            len(stripped) <= 6
            or _LAUGH_RE.fullmatch(stripped) is not None
            or _HYPE_RE.fullmatch(stripped) is not None
            or all(not ch.isascii() or not ch.isalnum() for ch in stripped)
        )
        if is_emote_msg:
            b["emote_msgs"] += 1

        for tok in text.split():
            if 2 <= len(tok) <= 24 and (tok.isupper() or tok.endswith("LUL") or tok.endswith("KEKW")):
                b["tokens"][tok] = b["tokens"].get(tok, 0) + 1

    out = []
    for b in buckets:
        if b["msgs"] == 0:
            continue
        unique_authors = len(b["authors"])
        emote_wall = b["msgs"] >= 5 and (b["emote_msgs"] / b["msgs"]) >= 0.70

        score = (
            b["msgs"] * 1.0
            + unique_authors * 1.5
            + b["laugh"] * 2.0
            + b["hype"] * 1.5
            + b["sc_count"] * 5.0
            + b["sc_usd"] * 0.5
            + b["members"] * 8.0
            + b["stickers"] * 3.0
            + (b["msgs"] * 0.5 if emote_wall else 0.0)
        )

        top_emotes = sorted(b["tokens"].items(), key=lambda kv: -kv[1])[:3]
        out.append({
            "t_start": b["t_start"],
            "msgs": b["msgs"],
            "unique_authors": unique_authors,
            "laugh": b["laugh"],
            "hype": b["hype"],
            "sc_count": b["sc_count"],
            "sc_usd": round(b["sc_usd"], 2),
            "members": b["members"],
            "stickers": b["stickers"],
            "emote_wall": emote_wall,
            "score": round(score, 1),
            "top_emotes": top_emotes,
        })
    return out


def annotate_baseline_signals(buckets: list[dict], window_buckets: int = 20) -> list[dict]:
    """
    Add rolling-baseline signals to each bucket (in-place + returned):
      - z_score: how many std-devs above local mean (rolling window of N buckets)
      - delta:   score - prev_bucket.score  (sudden reaction detection)
      - spike:   True if z_score >= 1.5 OR delta >= local_mean (whichever fires first)

    Why this matters:
      - Quiet stream where one bucket has msgs=15 vs busy stream where msgs=15 is
        baseline → only the first should be flagged. Absolute p80 misses this.
      - Sudden delta catches reaction-to-event moments even if absolute count
        isn't peak (e.g. shocked silence after big reveal still has a spike edge).

    window_buckets=20 at 15s/bucket = 5min rolling window. Good for both
    short streams (uses smaller effective window at edges) and long ones.
    """
    if not buckets:
        return buckets

    scores = [b["score"] for b in buckets]
    n = len(scores)
    half = max(1, window_buckets // 2)

    prev_score = 0.0
    for i, b in enumerate(buckets):
        lo = max(0, i - half)
        hi = min(n, i + half + 1)
        # Exclude self from baseline so spike doesn't dilute its own signal
        window = [scores[j] for j in range(lo, hi) if j != i]
        if window:
            mean = sum(window) / len(window)
            var = sum((x - mean) ** 2 for x in window) / len(window)
            std = var ** 0.5
        else:
            mean = 0.0
            std = 0.0

        z = (b["score"] - mean) / std if std > 1e-6 else 0.0
        delta = b["score"] - prev_score
        spike = (z >= 1.5) or (delta >= mean and mean > 0 and b["score"] > mean * 1.5)

        b["z_score"] = round(z, 2)
        b["delta"] = round(delta, 1)
        b["local_mean"] = round(mean, 1)
        b["spike"] = bool(spike)

        prev_score = b["score"]

    return buckets


def format_chat_timeline(buckets: list[dict], min_msgs: int = 2) -> str:
    """
    Compact, token-cheap timeline for Gemini.
    Skips empty / sub-threshold buckets to keep prompt small.
    Surfaces multi-signal cues:
      - HYPE     : score in top 20% globally (absolute spike)
      - SPIKE    : rolling-baseline z-score / delta spike (relative spike)
      - SC=$X.X  : superchat USD total in this bucket
      - MEM=N    : N new memberships
      - WALL     : emote-wall (chat is mostly reactions, not dialogue)
      - u=N      : unique authors (breadth)
    """
    if not buckets:
        return ""

    scores = sorted([b["score"] for b in buckets if b["msgs"] >= min_msgs])
    if not scores:
        return ""
    p80 = scores[int(len(scores) * 0.80)] if len(scores) >= 5 else scores[-1]

    lines = []
    for b in buckets:
        if b["msgs"] < min_msgs:
            continue
        t = int(b["t_start"])
        hh = t // 3600
        mm = (t % 3600) // 60
        ss = t % 60
        ts = f"{hh:02d}:{mm:02d}:{ss:02d}" if hh > 0 else f"{mm:02d}:{ss:02d}"

        parts = [f"msgs={b['msgs']}", f"u={b.get('unique_authors', 0)}"]
        if b["laugh"]:
            parts.append(f"laugh={b['laugh']}")
        if b["hype"]:
            parts.append(f"hype={b['hype']}")
        if b.get("sc_count"):
            parts.append(f"SC={b['sc_count']}x${b['sc_usd']:.0f}")
        if b.get("members"):
            parts.append(f"MEM={b['members']}")
        if b.get("stickers"):
            parts.append(f"stk={b['stickers']}")
        if b.get("emote_wall"):
            parts.append("WALL")
        if b["top_emotes"]:
            emotes_str = ",".join(f"{tok}x{cnt}" for tok, cnt in b["top_emotes"])
            parts.append(f"({emotes_str})")
        if b["score"] >= p80:
            parts.append("HYPE")
        if b.get("spike"):
            parts.append(f"SPIKE(z={b.get('z_score', 0):.1f})")
        lines.append(f"[{ts}] " + " ".join(parts))

    return "\n".join(lines)


# ─── Story-setup walkback ────────────────────────────────────────────────────

_SETUP_MARKERS_RE = re.compile(
    r"\b(today|so basically|let me show|let me try|okay so|alright|gonna|going to|"
    r"i'?ll|i will|the plan|step one|first(?:ly)?|introduce|so we'?re|so i'?m)\b"
    r"|今日は|これから|まず|やって|やる|挑戦|紹介",
    re.IGNORECASE,
)


def walkback_setup(
    clips: list[dict],
    segments: list[dict],
    first_speech_t: float = 0.0,
    max_back: float = 120.0,
) -> list[dict]:
    """
    For each clip, walk transcript backward from clip.start (≤max_back seconds)
    to find the nearest story-setup anchor (a question, a setup marker, or a topic
    pivot). If found, snap clip.start back to that anchor so the clip includes
    "what they're about to do" lead-in. Never crosses first_speech_t.
    """
    if not segments:
        return clips

    for clip in clips:
        original_start = float(clip["start"])
        floor = max(first_speech_t, original_start - max_back)
        best = None  # (segment_start, priority) — lower priority wins ties

        for seg in segments:
            s_start = float(seg["start"])
            if s_start >= original_start:
                break
            if s_start < floor:
                continue
            text = seg["text"].strip()
            if not text:
                continue

            priority = None
            # Priority 1: explicit setup marker
            if _SETUP_MARKERS_RE.search(text):
                priority = 1
            # Priority 2: setup-style question
            elif text.endswith("?") or text.endswith("？"):
                priority = 2

            if priority is not None:
                # Prefer earliest qualifying anchor (gives most lead-in context)
                if best is None or priority < best[1]:
                    best = (s_start, priority)
                elif priority == best[1] and s_start < best[0]:
                    best = (s_start, priority)

        if best is not None:
            new_start = max(floor, best[0])
            if new_start < original_start - 1.0:  # only snap if non-trivial
                clip["start"] = round(new_start, 2)
                clip["duration"] = round(float(clip["end"]) - new_start, 2)

    return clips


# ─── Gemini Analysis ─────────────────────────────────────────────────────────

_SYSTEM_PROMPT = """\
You are a YouTube content analyst. Your job is to identify the most clip-worthy moments
from a video transcript. The user will tell you their criteria. You must return ONLY valid JSON.

Rules:
- Each clip should be a self-contained, engaging moment.
- Minimum clip duration: 60 seconds. Maximum: 4 minutes (240 seconds).
- Each clip MUST include 5-30s of story setup before the peak moment — the streamer
  explaining what they're about to do, the question they're asking, or the situation
  they're walking into. Cold-open clips that start mid-action are bad clips.
- Do not overlap clips unless they represent clearly distinct highlights.
- Return 3–15 clips unless the user specifically asks for more or fewer.

Opening-song warning:
- The first 15-90 seconds of streams often contain an opening song or BGM intro with
  NO dialogue. Chat may spike during the song with hype emotes — IGNORE those spikes.
  A real clip needs actual transcript dialogue. Never start a clip inside an opening
  song or before the first spoken line.

Live chat hype signal (when provided):
- A separate timeline shows live-chat activity in 15s buckets. Each bucket lists:
    msgs=N      total chat messages
    u=N         unique authors (breadth — 50 different people > 5 spammers)
    laugh=N     laugh-token hits (lol/lmao/草/笑/🤣)
    hype=N      hype-token hits (pog/sheesh/🔥/やばい)
    SC=NxUSD    superchats: count and total USD value (real money on the line)
    MEM=N      new channel memberships (rare — strong "I love this" signal)
    stk=N       paid super-stickers
    WALL        emote-wall: chat is mostly short reactions, not dialogue
    HYPE        absolute top-20% spike across the whole stream
    SPIKE       relative spike vs local 5-min baseline (z-score ≥ 1.5)

Signal priority (highest to lowest):
  1. Superchats (SC=) and memberships (MEM=) — paid signal almost never lies
  2. SPIKE+HYPE together — both absolute and relative peak
  3. SPIKE alone in a quiet stream — viewers reacting to something specific
  4. WALL with high u= — many distinct people emoting at once = viral moment
  5. High laugh count — funny moments are very clippable
  6. Plain HYPE without SPIKE/u= — likely sustained vibe, may or may not be a moment

How to use:
- Use chat signals to CONFIRM clip-worthy transcript moments. Prefer moments where
  both transcript content AND chat signals peak together.
- Do NOT clip on chat spikes alone if the transcript at that point is silent or
  is just opening-song lyrics. The chat is the audience reaction; the transcript
  is the actual content.
- A WALL bucket near transcript dialogue is a stronger signal than a HYPE bucket
  with no WALL — it means viewers were reacting, not just chatting.
- When SC/MEM appear, the moment that triggered them is usually 5–30s BEFORE the
  payment posts (people watch, then pay). Walk backward in the transcript to find
  what caused it.

Timestamps:
- IMPORTANT: start and end values MUST be plain decimal numbers representing SECONDS
  from the start of the video. For example, if a moment occurs at 25 minutes and 30
  seconds, return "start": 1530.0 — NOT "start": 25 or "start": "25:30".

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
    chat_buckets: Optional[list[dict]] = None,
    include_setup: bool = True,
) -> list[dict]:
    """
    Send the transcript (and optional chat-hype timeline) to Gemini and ask it
    to identify clip-worthy moments.

    Args:
        transcript_data: output from extract_transcript()
        criteria: user's description of what clips they want (or empty for auto)
        api_key: Google Gemini API key (provided per-request, never stored)
        chat_buckets: optional output of bucket_chat() to inject hype signal
        include_setup: if True, walk start back ≤120s to nearest story-setup anchor

    Returns:
        list of clip dicts: [{id, title, start, end, reason, duration, selected}]
    """
    if not GEMINI_AVAILABLE:
        raise RuntimeError(
            "google-genai is not installed. Run: pip install google-genai"
        )

    client = genai.Client(api_key=api_key)

    title = transcript_data["video_title"]
    duration = transcript_data["video_duration"]
    plain_text = transcript_data["plain_text"]
    segments = transcript_data.get("segments", [])
    first_speech_t = float(transcript_data.get("first_speech_t", 0.0))

    user_criteria = criteria.strip() if criteria.strip() else "Find every clearly clippable moment — funny, insightful, emotional, or highly engaging."

    chat_block = ""
    if chat_buckets:
        chat_timeline = format_chat_timeline(chat_buckets)
        if chat_timeline:
            chat_block = (
                "\nLive chat hype timeline (15s buckets, only active buckets shown):\n"
                f"{chat_timeline}\n"
            )

    intro_note = ""
    if first_speech_t > 1.0:
        intro_note = (
            f"\nNote: first spoken transcript line starts at {first_speech_t:.1f}s. "
            f"Anything before that is opening song / BGM — never clip there.\n"
        )

    prompt = f"""\
Video title: {title}
Video total duration: {int(duration // 60)}m {int(duration % 60)}s

User criteria: {user_criteria}
{intro_note}{chat_block}
Transcript (format: [HH:MM:SS] text):
{plain_text}
"""

    response = client.models.generate_content(
        model="gemini-3-flash-preview",
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            system_instruction=_SYSTEM_PROMPT,
            temperature=0.3,
            response_mime_type="application/json",
            response_schema={
                "type": "ARRAY",
                "items": {
                    "type": "OBJECT",
                    "properties": {
                        "id":     {"type": "INTEGER"},
                        "title":  {"type": "STRING"},
                        "start":  {"type": "NUMBER"},
                        "end":    {"type": "NUMBER"},
                        "reason": {"type": "STRING"},
                    },
                    "required": ["id", "title", "start", "end", "reason"],
                    "propertyOrdering": ["id", "title", "start", "end", "reason"],
                },
            },
        ),
    )
    raw = response.text.strip()

    # Defensive: strip markdown fences if model still emits them despite schema
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

    # ── Opening-song guard: never start before first spoken line ──────────
    if first_speech_t > 0:
        for c in validated:
            if c["start"] < first_speech_t:
                c["start"] = round(first_speech_t, 2)
                if c["end"] - c["start"] < 30:
                    c["end"] = round(min(duration, c["start"] + 60), 2)
                c["duration"] = round(c["end"] - c["start"], 2)

    # ── Story-setup walkback (≤120s) ──────────────────────────────────────
    if include_setup and segments:
        validated = walkback_setup(
            validated,
            segments,
            first_speech_t=first_speech_t,
            max_back=120.0,
        )

    # ── Factor tagging: explain WHY each clip was chosen ──────────────────
    validated = tag_clip_factors(validated, chat_buckets, duration)

    return validated


def tag_clip_factors(
    clips: list[dict],
    chat_buckets: Optional[list[dict]],
    video_duration: float,
) -> list[dict]:
    """
    Attach a `factors` list to each clip explaining the signals that make it
    clip-worthy. Tag schema:
        {"key": str, "label": str, "tone": str, "detail": str}
    Tones: 'intro' | 'outro' | 'paid' | 'member' | 'spike' | 'wall' |
           'laughter' | 'hype' | 'sustained'
    """
    if not clips:
        return clips

    intro_cutoff = max(120.0, video_duration * 0.05) if video_duration else 120.0
    outro_cutoff = video_duration - max(120.0, video_duration * 0.05) if video_duration else 0.0

    for clip in clips:
        c_start = float(clip["start"])
        c_end = float(clip["end"])
        factors: list[dict] = []

        # ── position-based tags ──
        if c_start <= intro_cutoff:
            factors.append({
                "key": "intro",
                "label": "Intro",
                "tone": "intro",
                "detail": "Opening of the stream",
            })
        if video_duration and c_end >= outro_cutoff and c_start >= video_duration * 0.75:
            factors.append({
                "key": "outro",
                "label": "Outro",
                "tone": "outro",
                "detail": "Closing of the stream",
            })

        # ── chat-signal based tags ──
        if chat_buckets:
            in_range = [
                b for b in chat_buckets
                if b["t_start"] >= c_start - 30 and b["t_start"] <= c_end + 5
            ]
            if in_range:
                sc_count = sum(b.get("sc_count", 0) for b in in_range)
                sc_usd = sum(b.get("sc_usd", 0.0) for b in in_range)
                members = sum(b.get("members", 0) for b in in_range)
                stickers = sum(b.get("stickers", 0) for b in in_range)
                laugh = sum(b.get("laugh", 0) for b in in_range)
                hype = sum(b.get("hype", 0) for b in in_range)
                msgs = sum(b.get("msgs", 0) for b in in_range)
                emote_wall_buckets = sum(1 for b in in_range if b.get("emote_wall"))
                spike_buckets = sum(1 for b in in_range if b.get("spike"))
                max_z = max((b.get("z_score", 0) for b in in_range), default=0)
                top_emotes = []
                for b in in_range:
                    for tok, cnt in b.get("top_emotes") or []:
                        top_emotes.append((tok, cnt))
                top_emotes.sort(key=lambda kv: -kv[1])
                top_emotes = top_emotes[:3]

                if sc_count >= 1:
                    factors.append({
                        "key": "superchat",
                        "label": f"{sc_count} Superchat{'s' if sc_count > 1 else ''}" + (f" (~${sc_usd:.0f})" if sc_usd >= 1 else ""),
                        "tone": "paid",
                        "detail": "Viewers paid money during this moment",
                    })
                if members >= 1:
                    factors.append({
                        "key": "member",
                        "label": f"{members} New Member{'s' if members > 1 else ''}",
                        "tone": "member",
                        "detail": "Someone subscribed or gifted memberships here",
                    })
                if stickers >= 1 and sc_count == 0:
                    factors.append({
                        "key": "sticker",
                        "label": f"{stickers} Super Sticker{'s' if stickers > 1 else ''}",
                        "tone": "paid",
                        "detail": "Paid sticker reactions",
                    })
                if spike_buckets >= 1:
                    factors.append({
                        "key": "chat_spike",
                        "label": f"Chat Spike (z={max_z:.1f})",
                        "tone": "spike",
                        "detail": "Sudden surge in chat activity vs surrounding minutes",
                    })
                if emote_wall_buckets >= 1:
                    emote_str = ", ".join(f"{tok}×{cnt}" for tok, cnt in top_emotes) if top_emotes else "spammed reactions"
                    factors.append({
                        "key": "emote_wall",
                        "label": "Emote Wall",
                        "tone": "wall",
                        "detail": f"Chat flooded with reactions ({emote_str})",
                    })
                if laugh >= max(3, msgs * 0.15):
                    factors.append({
                        "key": "laughter",
                        "label": f"Laughter ×{laugh}",
                        "tone": "laughter",
                        "detail": "Lots of laugh tokens (lol/草/🤣)",
                    })
                if hype >= max(3, msgs * 0.15):
                    factors.append({
                        "key": "hype",
                        "label": f"Hype ×{hype}",
                        "tone": "hype",
                        "detail": "Hype tokens (pog/sheesh/やばい/🔥)",
                    })
                # Fallback: clip has chat activity but no specific spike -> "active chat"
                if not factors and msgs >= 5:
                    factors.append({
                        "key": "active_chat",
                        "label": f"Active Chat ({msgs} msgs)",
                        "tone": "sustained",
                        "detail": "Sustained chat activity during this moment",
                    })

        # If still empty, surface a transcript-only tag so the UI never shows blank
        if not factors:
            factors.append({
                "key": "transcript",
                "label": "Transcript Pick",
                "tone": "sustained",
                "detail": "Selected from dialogue content (no chat data)",
            })

        clip["factors"] = factors

    return clips


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
            if d.get("status") == "downloading":
                pct = 0
                total = d.get("total_bytes") or d.get("total_bytes_estimate", 0)
                downloaded = d.get("downloaded_bytes", 0)
                
                if total > 0:
                    pct = (downloaded / total) * 100
                elif d.get("fragment_count", 0) > 0:
                    pct = (d.get("fragment_index", 0) / d.get("fragment_count")) * 100
                
                if pct > 0:
                    speed = d.get('speed')
                    speed_str = ""
                    if speed:
                        speed_mb = speed / (1024 * 1024)
                        speed_str = f" @ {speed_mb:.1f} MB/s"
                    
                    if progress_cb:
                        import inspect
                        if 'speed_str' in inspect.signature(progress_cb).parameters:
                            progress_cb(pct, speed_str=speed_str)
                        else:
                            progress_cb(int(pct))
                            
                    import sys
                    sys.stdout.write(f"\r[yt-dlp] Downloading... {pct:.1f}%{speed_str}      ")
                    sys.stdout.flush()
            elif d.get("status") == "finished":
                import sys
                sys.stdout.write("\r[yt-dlp] Download finished!                           \n")
                sys.stdout.flush()

    cookie_opts = _get_cookie_opts_list()
    for c_idx, cookie_opt in enumerate(cookie_opts):
        try:
            ydl_opts = {
                # Format selection — prioritize MAX resolution, never trap
                # into 360p progressive MP4.
                #
                # Chain (best → worst):
                #   1. AVC1 + M4A   — clean MP4 mux, no transcode, plays everywhere.
                #                     Available up to 1080p on most videos.
                #   2. ANY bv* + ba — covers VP9/AV1 high-res (1440p/2160p/HDR).
                #                     ffmpeg remuxes into MP4 container.
                #   3. b            — single-file fallback (last resort).
                #
                # `format_sort` forces highest resolution → fps → bitrate
                # before codec preference, so we never silently downgrade.
                "format": (
                    "bv*[vcodec^=avc1][ext=mp4]+ba[acodec^=mp4a][ext=m4a]"
                    "/bv*[ext=mp4]+ba[ext=m4a]"
                    "/bv*+ba"
                    "/b"
                ),
                "format_sort": ["res", "fps", "vbr", "abr"],
                "merge_output_format": "mp4",
                "outtmpl": outtmpl,
                "quiet": True,
                "no_warnings": True,
                "logger": _SilentLogger(),
                "progress_hooks": [_ProgressHook()],
                "concurrent_fragment_downloads": 16,
                "continuedl": True,
                "postprocessors": [{
                    "key": "FFmpegMetadata",
                    "add_metadata": True,
                }],
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
            if c_idx < len(cookie_opts) - 1 and not (("429" in err_msg) and ("Too Many" in err_msg)):
                if "Could not copy" in err_msg and "cookie" in err_msg:
                    log.warning("Cookie database locked or inaccessible. Trying next…")
                elif is_bot_error:
                    log.warning("Bot detection triggered. Trying next option…")
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
    progress_cb=None,
) -> Path:
    """
    Cut a clip from source_video [start, end] (seconds) → output_path.

    Strategy (fastest path first):
      1. Stream copy (-c copy): instant, no re-encode, no quality loss.
         Snaps the start to the nearest keyframe at-or-before the requested
         second (typically ≤2s slack — fine because Gemini-picked clips
         already include setup walkback).
      2. h264_nvenc re-encode (audio copy) if stream copy fails.
      3. libx264 CPU fallback if NVENC is unavailable.

    progress_cb(pct: int) is called with 0..100 for this clip's progress
    when ffmpeg emits -progress pipe:1 events.
    """
    import threading

    duration = end - start
    output_path.parent.mkdir(parents=True, exist_ok=True)
    duration_us = max(1, int(duration * 1_000_000))

    def _run_with_progress(cmd: list) -> tuple[int, str]:
        """Run ffmpeg, parse -progress pipe:1 from stdout. Returns (rc, stderr_tail)."""
        proc = subprocess.Popen(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            errors="replace",
            bufsize=1,
        )
        stderr_lines: list[str] = []

        def _drain_stderr():
            assert proc.stderr is not None
            for line in proc.stderr:
                stderr_lines.append(line)

        t = threading.Thread(target=_drain_stderr, daemon=True)
        t.start()

        if proc.stdout:
            for line in proc.stdout:
                line = line.strip()
                if line.startswith("out_time_us=") and progress_cb:
                    try:
                        out_us = int(line.split("=", 1)[1])
                        pct = max(0, min(99, int(out_us / duration_us * 100)))
                        progress_cb(pct)
                    except (ValueError, ZeroDivisionError):
                        pass
                elif line == "progress=end" and progress_cb:
                    progress_cb(100)
        proc.wait()
        t.join(timeout=2)
        return proc.returncode, "".join(stderr_lines[-40:])

    # ── 1) Stream copy: instant, no re-encode ────────────────────────────
    cmd_copy = [
        "ffmpeg", "-y",
        "-ss", _seconds_to_ffmpeg_ts(start),
        "-i", str(source_video),
        "-t", _seconds_to_ffmpeg_ts(duration),
        "-c", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        str(output_path),
    ]
    rc, err = _run_with_progress(cmd_copy)
    if rc == 0 and output_path.exists() and output_path.stat().st_size > 0:
        return output_path

    log.warning("Stream copy failed, falling back to NVENC re-encode. stderr tail:\n%s", err)

    # ── 2) NVENC fallback (audio copy to preserve quality + speed) ───────
    cmd_gpu = [
        "ffmpeg", "-y",
        "-ss", _seconds_to_ffmpeg_ts(start),
        "-i", str(source_video),
        "-t", _seconds_to_ffmpeg_ts(duration),
        "-c:v", "h264_nvenc",
        "-cq", "18",
        "-preset", "p4",
        "-c:a", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        str(output_path),
    ]
    rc, err = _run_with_progress(cmd_gpu)
    if rc == 0 and output_path.exists() and output_path.stat().st_size > 0:
        return output_path

    if "h264_nvenc" not in err and "Unknown encoder" not in err:
        raise RuntimeError(f"FFmpeg error cutting clip:\n{err}")

    # ── 3) CPU libx264 fallback ──────────────────────────────────────────
    cmd_cpu = [
        "ffmpeg", "-y",
        "-ss", _seconds_to_ffmpeg_ts(start),
        "-i", str(source_video),
        "-t", _seconds_to_ffmpeg_ts(duration),
        "-c:v", "libx264",
        "-crf", "18",
        "-preset", "fast",
        "-c:a", "copy",
        "-avoid_negative_ts", "make_zero",
        "-movflags", "+faststart",
        "-progress", "pipe:1",
        "-nostats",
        str(output_path),
    ]
    rc, err = _run_with_progress(cmd_cpu)
    if rc != 0:
        raise RuntimeError(f"FFmpeg error cutting clip (CPU fallback):\n{err}")

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
        log.info("Extracting reference transcript for clips…")
        yt_transcript = extract_transcript(url)
        video_title = yt_transcript.get("video_title", video_title)
        video_id = yt_transcript.get("video_id", video_id)
    except Exception as e:
        log.warning("Could not extract reference transcript/metadata: %s", e)

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
        progress_cb("downloading full video", 0)

    # Stage 2: Download full video once
    log.info("Downloading full video for local clipping…")
    
    def _full_dl_progress(pct, speed_str=""):
        if progress_cb:
            progress_cb(f"downloading full video{speed_str}", int(pct))

    full_video_stem = f"{video_id}_full_source"
    full_video_path = download_video(
        url,
        folder_path,
        progress_cb=_full_dl_progress,
        clip_range=None,
        filename_stem=full_video_stem
    )

    # Stage 3: Cut clips locally
    results = []
    total_clips = len(clips)
    # Cut phase occupies progress 50→100. Each clip owns a slice of width
    # (50 / total_clips). Per-clip ffmpeg progress maps 0..100 into that slice.
    cut_slice = 50.0 / max(1, total_clips)

    for i, clip in enumerate(clips):
        safe_title = re.sub(r'[<>:"/\\|?*]', "", clip["title"])[:50].strip()
        safe_title = re.sub(r"\s+", "_", safe_title)
        filename_stem = f"yt_{clip['id']:02d}_{safe_title}"

        target_filename = f"{filename_stem}{full_video_path.suffix}"
        out_path = folder_path / target_filename

        log.info("Cutting clip: %ss - %ss into %s",
                 clip['start'], clip['end'], filename_stem)

        clip_base_pct = 50 + (i * cut_slice)

        def _clip_progress(pct: int, _i=i, _base=clip_base_pct):
            if progress_cb:
                overall = int(_base + (pct / 100.0) * cut_slice)
                progress_cb(f"cutting clip {_i+1}/{total_clips} ({pct}%)", overall)

        # Initial signal so UI doesn't flatline waiting for the first ffmpeg event
        if progress_cb:
            progress_cb(f"cutting clip {i+1}/{total_clips} (0%)", int(clip_base_pct))

        cut_clip(
            source_video=full_video_path,
            start=clip["start"],
            end=clip["end"],
            output_path=out_path,
            progress_cb=_clip_progress,
        )

        filename = out_path.name

        results.append({
            "id": clip["id"],
            "title": clip["title"],
            "start": clip["start"],
            "end": clip["end"],
            "duration": clip.get("duration", round(clip["end"] - clip["start"], 2)),
            "filename": f"{folder_name}/{filename}",
        })

        if progress_cb:
            progress_cb(f"cutting clip {i+1}/{total_clips} done",
                        int(50 + ((i + 1) * cut_slice)))

    # Clean up the full source video to save disk space
    try:
        if full_video_path.exists():
            full_video_path.unlink()
            log.info("Deleted full source video: %s", full_video_path.name)
    except Exception as e:
        log.warning("Could not delete full source video: %s", e)

    return results
