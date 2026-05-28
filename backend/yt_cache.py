"""
YT-Clipper checkpoint cache.

Stores per-video checkpoints so a Gemini failure (or any later-stage error)
does not force the user to re-download the transcript or chat replay.

Layout:
    .yt_cache/
        <video_id>.json     # {url, video_id, transcript, chat_msgs, chat_buckets, ts}

Single-slot policy: when a new video_id is processed, all OTHER cache files
are deleted. Only the most recent video's checkpoint is kept.

API:
    load(video_id) -> dict | None
    save_transcript(video_id, url, transcript)
    save_chat(video_id, chat_msgs, chat_buckets)
    clear_other(video_id)               # delete everything except this id
    clear_all()
"""

from __future__ import annotations

import json
import time
from pathlib import Path
from typing import Optional

from logger import get_logger

log = get_logger("yt_cache")

CACHE_DIR = Path(__file__).resolve().parent.parent / ".yt_cache"


def _ensure_dir() -> None:
    CACHE_DIR.mkdir(parents=True, exist_ok=True)


def _path(video_id: str) -> Path:
    return CACHE_DIR / f"{video_id}.json"


def load(video_id: str) -> Optional[dict]:
    """Return cached checkpoint for this video, or None if absent/corrupt."""
    if not video_id:
        return None
    p = _path(video_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError) as e:
        log.warning("Cache file corrupt, ignoring: %s (%s)", p.name, e)
        return None


def _write(video_id: str, data: dict) -> None:
    _ensure_dir()
    p = _path(video_id)
    tmp = p.with_suffix(".json.tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False), encoding="utf-8")
    tmp.replace(p)  # atomic on same filesystem


def save_transcript(video_id: str, url: str, transcript: dict) -> None:
    """Save transcript checkpoint. Preserves any existing chat data."""
    if not video_id:
        return
    existing = load(video_id) or {}
    existing.update({
        "url": url,
        "video_id": video_id,
        "transcript": transcript,
        "ts_transcript": time.time(),
    })
    _write(video_id, existing)
    log.info("Cached transcript for %s (%d segments)",
             video_id, len(transcript.get("segments", [])))


def save_chat(video_id: str,
              chat_msgs: list,
              chat_buckets: Optional[list]) -> None:
    """Save chat-replay checkpoint."""
    if not video_id:
        return
    existing = load(video_id) or {"video_id": video_id}
    existing.update({
        "chat_msgs": chat_msgs,
        "chat_buckets": chat_buckets,
        "ts_chat": time.time(),
    })
    _write(video_id, existing)
    log.info("Cached chat for %s (%d msgs, %d buckets)",
             video_id, len(chat_msgs or []),
             len(chat_buckets or []))


def clear_other(video_id: str) -> int:
    """
    Delete every cache file EXCEPT the one for `video_id`.
    Returns count of files removed. Used so each new URL session
    wipes the previous video's checkpoint.
    """
    if not CACHE_DIR.exists():
        return 0
    removed = 0
    for p in CACHE_DIR.glob("*.json"):
        if p.stem == video_id:
            continue
        try:
            p.unlink()
            removed += 1
        except OSError as e:
            log.warning("Could not remove stale cache %s: %s", p.name, e)
    if removed:
        log.info("Cleared %d stale cache file(s); active video=%s",
                 removed, video_id)
    return removed


def clear_all() -> int:
    """Wipe entire cache directory."""
    if not CACHE_DIR.exists():
        return 0
    removed = 0
    for p in CACHE_DIR.glob("*.json"):
        try:
            p.unlink()
            removed += 1
        except OSError:
            pass
    return removed
