"""
Silence Cutter — Remove silent gaps from video using WhisperX word timestamps.

Strategy:
  1. Derive speech "keep" segments from word start/end timestamps + padding.
  2. Merge segments whose gap is smaller than the silence threshold.
  3. Use FFmpeg filter_complex with trim/atrim + concat for frame-accurate
     cutting — no audio looping or keyframe-seeking artifacts.

FFmpeg requirement: 3.0+ (practically universal).
"""

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Callable, Optional

from renderer import get_video_info


# ──────────────────────────────────────────────────────────────────────────────
# Audio detection helper
# ──────────────────────────────────────────────────────────────────────────────

def _has_audio_stream(video_path: str) -> bool:
    """Return True if the file contains at least one audio stream."""
    try:
        result = subprocess.run(
            [
                "ffprobe", "-v", "quiet",
                "-select_streams", "a",
                "-show_entries", "stream=codec_type",
                "-of", "csv=p=0",
                str(video_path),
            ],
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=10,
        )
        return bool(result.stdout.strip())
    except Exception:
        return True  # assume audio exists if probing fails


# ──────────────────────────────────────────────────────────────────────────────
# Standalone segment cutter (reusable by render pipeline)
# ──────────────────────────────────────────────────────────────────────────────

def cut_video_segments(
    video_path: str,
    segments: list[tuple[float, float]],
    output_path: str,
    progress_cb: Optional[Callable[[str], None]] = None,
) -> None:
    """
    Cut a video to only include the given (start, end) segments.

    Uses FFmpeg filter_complex with trim/atrim + concat for frame-accurate
    cutting without audio looping artifacts.
    """
    def log(msg: str):
        print(f"[cut_segments] {msg}")
        if progress_cb:
            progress_cb(msg)

    video_path_p = Path(video_path).resolve()
    output_path_p = Path(output_path).resolve()
    output_path_p.parent.mkdir(parents=True, exist_ok=True)

    has_audio = _has_audio_stream(str(video_path_p))

    filter_parts = []
    stream_labels = []

    for i, (start, end) in enumerate(segments):
        filter_parts.append(
            f"[0:v]trim=start={start:.4f}:end={end:.4f},setpts=PTS-STARTPTS[v{i}]"
        )
        if has_audio:
            filter_parts.append(
                f"[0:a]atrim=start={start:.4f}:end={end:.4f},asetpts=PTS-STARTPTS[a{i}]"
            )
            stream_labels.append(f"[v{i}][a{i}]")
        else:
            stream_labels.append(f"[v{i}]")

    n = len(segments)
    concat_inputs = "".join(stream_labels)
    if has_audio:
        filter_parts.append(f"{concat_inputs}concat=n={n}:v=1:a=1[outv][outa]")
    else:
        filter_parts.append(f"{concat_inputs}concat=n={n}:v=1:a=0[outv]")

    filter_complex = ";\n".join(filter_parts)

    filter_script = None
    try:
        with tempfile.NamedTemporaryFile(
            mode="w", suffix=".txt", delete=False, encoding="utf-8",
        ) as f:
            filter_script = f.name
            f.write(filter_complex)

        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path_p),
            "-filter_complex_script", filter_script,
            "-map", "[outv]",
        ]
        if has_audio:
            cmd.extend(["-map", "[outa]"])
        cmd.extend([
            "-c:v", "libx264", "-crf", "18", "-preset", "fast",
        ])
        if has_audio:
            cmd.extend(["-c:a", "aac", "-b:a", "192k"])
        cmd.extend(["-movflags", "+faststart", str(output_path_p)])

        log(f"Cutting {n} segments…")
        result = subprocess.run(cmd, capture_output=True, text=True, encoding="utf-8", errors="replace", timeout=600)

        if result.returncode != 0:
            stderr_tail = result.stderr[-1200:] if result.stderr else "No stderr"
            raise RuntimeError(f"FFmpeg cut failed (code {result.returncode}):\n{stderr_tail}")

        if not output_path_p.exists():
            raise RuntimeError("FFmpeg exited 0 but output file was not created.")

    finally:
        if filter_script and os.path.exists(filter_script):
            try:
                os.unlink(filter_script)
            except OSError:
                pass


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
        prev_end = seg_end - pad
        if w["start"] - prev_end < min_gap:
            # Gap too small → extend current segment
            seg_end = max(seg_end, w["end"] + pad)
        else:
            segments.append((max(0.0, seg_start), seg_end))
            seg_start = max(0.0, w["start"] - pad)
            seg_end = w["end"] + pad

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

    Uses FFmpeg filter_complex with trim/atrim + concat for frame-accurate
    cutting without audio looping artifacts.

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
    log(f"Video duration: {duration:.2f}s  ({info['width']}x{info['height']})")

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

    # ── Check for audio stream ───────────────────────────────────────────────
    has_audio = _has_audio_stream(str(video_path))
    if has_audio:
        log("Audio stream detected — will trim both video and audio.")
    else:
        log("No audio stream — trimming video only.")

    # ── Build filter_complex with trim/atrim ──────────────────────────────
    # Using trim/atrim + concat filter is frame-accurate and avoids the
    # audio looping artifacts caused by the concat demuxer's
    # inpoint/outpoint keyframe-seeking behavior.
    filter_script = None
    try:
        filter_parts = []
        stream_labels = []

        for i, (start, end) in enumerate(segments):
            filter_parts.append(
                f"[0:v]trim=start={start:.4f}:end={end:.4f},setpts=PTS-STARTPTS[v{i}]"
            )
            if has_audio:
                filter_parts.append(
                    f"[0:a]atrim=start={start:.4f}:end={end:.4f},asetpts=PTS-STARTPTS[a{i}]"
                )
                stream_labels.append(f"[v{i}][a{i}]")
            else:
                stream_labels.append(f"[v{i}]")

        n = len(segments)
        concat_inputs = "".join(stream_labels)
        if has_audio:
            filter_parts.append(
                f"{concat_inputs}concat=n={n}:v=1:a=1[outv][outa]"
            )
        else:
            filter_parts.append(
                f"{concat_inputs}concat=n={n}:v=1:a=0[outv]"
            )

        filter_complex = ";\n".join(filter_parts)

        # Write filter graph to a script file to avoid Windows
        # command-line length limits (8191 chars) for many segments
        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".txt",
            delete=False,
            encoding="utf-8",
        ) as f:
            filter_script = f.name
            f.write(filter_complex)

        log(f"Filter script written ({len(segments)} segments): {filter_script}")
        log("Running FFmpeg (trim + concat — frame-accurate)…")

        cmd = [
            "ffmpeg", "-y",
            "-i", str(video_path),
            "-filter_complex_script", filter_script,
            "-map", "[outv]",
        ]
        if has_audio:
            cmd.extend(["-map", "[outa]"])

        cmd.extend([
            "-c:v", "libx264",
            "-crf", "18",
            "-preset", "fast",
        ])
        if has_audio:
            cmd.extend([
                "-c:a", "aac",
                "-b:a", "192k",
            ])
        cmd.extend([
            "-movflags", "+faststart",
            str(output_path),
        ])

        log(f"Command: {' '.join(cmd)}")

        result = subprocess.run(
            cmd,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=600,
        )

        if result.returncode != 0:
            stderr_tail = result.stderr[-1200:] if result.stderr else "No stderr"
            raise RuntimeError(f"FFmpeg failed (code {result.returncode}):\n{stderr_tail}")

        if not output_path.exists():
            raise RuntimeError("FFmpeg exited 0 but output file was not created.")

    finally:
        if filter_script and os.path.exists(filter_script):
            try:
                os.unlink(filter_script)
            except OSError:
                pass

    elapsed = round(time.time() - t0, 1)
    size_mb = round(output_path.stat().st_size / (1024 * 1024), 2)

    log(f"Done in {elapsed}s -> {output_path.name} ({size_mb} MB)")

    return {
        "output_path": str(output_path),
        "output_filename": output_path.name,
        "segments_kept": len(segments),
        "segments": [[round(s, 4), round(e, 4)] for s, e in segments],
        "kept_duration_s": round(kept_duration, 2),
        "removed_duration_s": round(removed_duration, 2),
        "original_duration_s": round(duration, 2),
        "compression_ratio": round(kept_duration / duration, 3) if duration else 1.0,
        "size_mb": size_mb,
        "processing_time_s": elapsed,
    }
