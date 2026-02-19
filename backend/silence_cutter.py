"""
Silence Cutter — Remove silent gaps from video using WhisperX word timestamps.

Strategy:
  1. Derive speech "keep" segments from word start/end timestamps + padding.
  2. Merge segments whose gap is smaller than the silence threshold.
  3. Use FFmpeg concat demuxer (inpoint/outpoint) with -c copy for a
     quality-preserving output — no re-encoding, no quality loss.

FFmpeg requirement: 3.0+ (practically universal).
"""

import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

from renderer import get_video_info


# ──────────────────────────────────────────────────────────────────────────────
# Segment logic
# ──────────────────────────────────────────────────────────────────────────────

def detect_speech_segments(
    words: list[dict],
    min_silence_ms: int = 500,
    padding_ms: int = 100,
) -> list[tuple[float, float]]:
    """
    Convert word-level timestamps into (start, end) speech segments.

    Any gap between consecutive words that is >= min_silence_ms is treated
    as a silence boundary.  Each segment is extended by padding_ms on both
    sides so cut transitions feel natural (no clipped syllables).

    Args:
        words:          List of {"text", "start", "end"} word dicts.
        min_silence_ms: Minimum gap length (ms) that counts as silence.
        padding_ms:     Extra time (ms) kept around each speech segment.

    Returns:
        List of (start_s, end_s) float tuples in seconds, merged and sorted.
    """
    if not words:
        return []

    pad = padding_ms / 1000.0
    min_gap = min_silence_ms / 1000.0

    # Start first segment
    seg_start = max(0.0, words[0]["start"] - pad)
    seg_end = words[0]["end"] + pad

    segments: list[tuple[float, float]] = []

    for w in words[1:]:
        w_start = w["start"] - pad
        w_end = w["end"] + pad

        if w_start - seg_end < min_gap:
            # Gap too small → extend current segment
            seg_end = max(seg_end, w_end)
        else:
            segments.append((max(0.0, seg_start), seg_end))
            seg_start = max(0.0, w_start)
            seg_end = w_end

    segments.append((max(0.0, seg_start), seg_end))
    return segments


def clamp_segments(
    segments: list[tuple[float, float]],
    duration: float,
) -> list[tuple[float, float]]:
    """Clamp segment endpoints to [0, duration] and drop empty ones."""
    result = []
    for s, e in segments:
        s = max(0.0, s)
        e = min(e, duration)
        if e > s:
            result.append((s, e))
    return result


# ──────────────────────────────────────────────────────────────────────────────
# Main function
# ──────────────────────────────────────────────────────────────────────────────

def cut_silence(
    video_path: str,
    words: list[dict],
    output_path: str,
    min_silence_ms: int = 500,
    padding_ms: int = 100,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> dict:
    """
    Remove silent gaps from *video_path* and write to *output_path*.

    Uses FFmpeg's concat demuxer with ``-c copy`` so the video stream is
    never re-encoded — same bitrate, same codec, same quality.

    Args:
        video_path:     Absolute path to the source video.
        words:          Word-level timestamp list from WhisperX.
        output_path:    Where to write the silence-cut output video.
        min_silence_ms: Gaps >= this (ms) are removed.
        padding_ms:     Extra context kept around each speech block (ms).
        progress_cb:    Optional callback(str) for status messages.

    Returns:
        dict with statistics about the operation.
    """
    def log(msg: str):
        print(f"[silence_cutter] {msg}")
        if progress_cb:
            progress_cb(msg)

    video_path = Path(video_path).resolve()
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    log(f"Source: {video_path.name}")
    log(f"Settings: min_silence={min_silence_ms}ms  padding={padding_ms}ms")

    # ── Get video duration ──────────────────────────────────────────────────
    info = get_video_info(str(video_path))
    duration = info["duration"]
    log(f"Video duration: {duration:.2f}s  ({info['width']}×{info['height']})")

    # ── Prepare segments ────────────────────────────────────────────────────
    t0 = time.time()
    raw_segments = detect_speech_segments(words, min_silence_ms, padding_ms)
    segments = clamp_segments(raw_segments, duration)

    if not segments:
        raise ValueError(
            "No speech segments detected. "
            "Check that the transcription contains valid word timestamps."
        )

    kept_duration = sum(e - s for s, e in segments)
    removed_duration = max(0.0, duration - kept_duration)
    log(
        f"Segments: {len(segments)} kept  |  "
        f"{kept_duration:.1f}s kept  |  "
        f"{removed_duration:.1f}s removed  |  "
        f"{100 * kept_duration / duration:.0f}% of original"
    )

    # ── Build concat demuxer file ────────────────────────────────────────────
    # The concat demuxer with inpoint/outpoint can reference the same source
    # file multiple times — efficient and avoids temporary clips.
    safe_src = str(video_path).replace("\\", "/")

    concat_file = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".txt",
            delete=False,
            encoding="utf-8",
        ) as f:
            concat_file = f.name
            for start, end in segments:
                f.write(f"file '{safe_src}'\n")
                f.write(f"inpoint {start:.4f}\n")
                f.write(f"outpoint {end:.4f}\n")

        log(f"Concat list written: {concat_file}")
        log("Running FFmpeg (stream copy — no re-encoding)…")

        cmd = [
            "ffmpeg", "-y",
            "-f", "concat",
            "-safe", "0",
            "-i", concat_file,
            "-c", "copy",               # copy all streams — no quality loss
            "-movflags", "+faststart",  # browser-friendly MP4
            str(output_path),
        ]

        log(f"Command: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            timeout=600,
        )

        if result.returncode != 0:
            # Tail of stderr is usually most informative
            stderr_tail = result.stderr[-1200:] if result.stderr else "No stderr"
            raise RuntimeError(f"FFmpeg failed (code {result.returncode}):\n{stderr_tail}")

        if not output_path.exists():
            raise RuntimeError("FFmpeg exited 0 but output file was not created.")

    finally:
        if concat_file and os.path.exists(concat_file):
            try:
                os.unlink(concat_file)
            except OSError:
                pass

    elapsed = round(time.time() - t0, 1)
    size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)

    log(f"Done in {elapsed}s → {output_path.name} ({size_mb} MB)")

    return {
        "output_path": str(output_path),
        "output_filename": output_path.name,
        "segments_kept": len(segments),
        "kept_duration_s": round(kept_duration, 2),
        "removed_duration_s": round(removed_duration, 2),
        "original_duration_s": round(duration, 2),
        "compression_ratio": round(kept_duration / duration, 3) if duration else 1.0,
        "size_mb": size_mb,
        "processing_time_s": elapsed,
    }
