"""
WhisperX Transcription Engine
Extracts word-level timestamps from video/audio files.

Hardware target: RTX 3060 6GB VRAM
Uses int8 compute to stay within VRAM limits.
"""

import gc
import json
import logging
import os
import time
import warnings
from pathlib import Path

# Suppress noisy third-party warnings before importing them
warnings.filterwarnings("ignore", message="torchcodec is not installed")
warnings.filterwarnings("ignore", message="TensorFloat-32")
warnings.filterwarnings("ignore", category=FutureWarning)
warnings.filterwarnings("ignore", message="Lightning automatically upgraded")
logging.getLogger("whisperx").setLevel(logging.WARNING)
logging.getLogger("pyannote").setLevel(logging.WARNING)
logging.getLogger("lightning").setLevel(logging.WARNING)
logging.getLogger("lightning_fabric").setLevel(logging.WARNING)

import torch
import whisperx


# ─── Configuration ───────────────────────────────────────────
DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
COMPUTE_TYPE = "int8"        # CRITICAL: prevents OOM on 6GB VRAM
BATCH_SIZE = 4               # conservative for 6GB VRAM
MODEL_SIZE = "large-v2"      # best accuracy; fits in 6GB with int8
# ─────────────────────────────────────────────────────────────


def flush_gpu():
    """Free GPU memory between pipeline stages."""
    gc.collect()
    if torch.cuda.is_available():
        torch.cuda.empty_cache()


def get_vram_usage() -> dict:
    """Return current VRAM usage in MB."""
    if not torch.cuda.is_available():
        return {"allocated_mb": 0, "reserved_mb": 0, "total_mb": 0}
    return {
        "allocated_mb": round(torch.cuda.memory_allocated() / 1024**2, 1),
        "reserved_mb": round(torch.cuda.memory_reserved() / 1024**2, 1),
        "total_mb": round(torch.cuda.get_device_properties(0).total_memory / 1024**2, 1),
    }


def transcribe_video(video_path: str, output_dir: str | None = None,
                     hf_token: str | None = None,
                     min_speakers: int | None = None,
                     max_speakers: int | None = None,
                     model_id: str = "large-v2") -> dict:
    """
    Full transcription pipeline:
      1. Load audio from video
      2. Transcribe with WhisperX (batched, int8)
      3. Align to get word-level timestamps
      4. (Optional) Diarize to assign speaker labels
      5. Return structured JSON

    Args:
        video_path: Path to input video/audio file.
        output_dir:  Directory to write JSON output. If None, uses same dir as video.
        hf_token:    HuggingFace access token for speaker diarization (pyannote).
                     If None, diarization is skipped.
        min_speakers: Minimum expected number of speakers (optional hint).
        max_speakers: Maximum expected number of speakers (optional hint).

    Returns:
        dict with keys: words, metadata
    """
    video_path = Path(video_path).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    if output_dir is None:
        output_dir = video_path.parent
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[transcribe] Device: {DEVICE} | Compute: {COMPUTE_TYPE} | Batch: {BATCH_SIZE}")
    print(f"[transcribe] VRAM before start: {get_vram_usage()}")

    t_start = time.time()

    # ── Step 1: Load audio ──────────────────────────────────
    print("[transcribe] Loading audio...")
    audio = whisperx.load_audio(str(video_path))
    print(f"[transcribe] Audio loaded — {len(audio)/16000:.1f}s @ 16kHz")

    # ── Step 2: Transcribe ──────────────────────────────────
    print(f"[transcribe] Loading model '{model_id}' ({COMPUTE_TYPE})...")
    model = whisperx.load_model(
        model_id,
        DEVICE,
        compute_type=COMPUTE_TYPE,
    )
    print(f"[transcribe] VRAM after model load: {get_vram_usage()}")

    print("[transcribe] Transcribing (task=translate -> forced English output)...")
    result = model.transcribe(audio, batch_size=BATCH_SIZE, task="translate")
    detected_language = result.get("language", "en")  # original source language
    print(f"[transcribe] Detected source language: {detected_language} -> translating to English")
    print(f"[transcribe] Segments (pre-align): {len(result['segments'])}")

    # Free transcription model before loading alignment model
    del model
    flush_gpu()
    print(f"[transcribe] VRAM after model flush: {get_vram_usage()}")

    # ── Step 3: Align (word-level timestamps) ───────────────
    # Always align against English since translation output is always English.
    # Using source language here would misalign phonemes with translated text.
    print("[transcribe] Loading alignment model (en)...")
    model_a, metadata = whisperx.load_align_model(
        language_code="en",
        device=DEVICE,
    )
    print(f"[transcribe] VRAM after align model load: {get_vram_usage()}")

    print("[transcribe] Aligning...")
    result = whisperx.align(
        result["segments"],
        model_a,
        metadata,
        audio,
        DEVICE,
        return_char_alignments=False,
    )

    # Free alignment model
    del model_a
    flush_gpu()
    print(f"[transcribe] VRAM after align flush: {get_vram_usage()}")

    # ── Step 4: Speaker diarization (optional) ──────────────
    speakers_detected = 0
    if hf_token:
        try:
            from whisperx.diarize import DiarizationPipeline

            print("[transcribe] Loading diarization model (pyannote)...")
            diarize_model = DiarizationPipeline(
                use_auth_token=hf_token,
                device=DEVICE,
            )
            print(f"[transcribe] VRAM after diarize model load: {get_vram_usage()}")

            print("[transcribe] Running speaker diarization...")
            diarize_kwargs = {}
            if min_speakers is not None:
                diarize_kwargs["min_speakers"] = min_speakers
            if max_speakers is not None:
                diarize_kwargs["max_speakers"] = max_speakers

            diarize_segments = diarize_model(audio, **diarize_kwargs)
            result = whisperx.assign_word_speakers(diarize_segments, result)

            # Count unique speakers
            speaker_set = set()
            for seg in result.get("segments", []):
                if seg.get("speaker"):
                    speaker_set.add(seg["speaker"])
                for w in seg.get("words", []):
                    if w.get("speaker"):
                        speaker_set.add(w["speaker"])
            speakers_detected = len(speaker_set)
            print(f"[transcribe] Diarization complete — {speakers_detected} speakers detected")

            del diarize_model
            flush_gpu()
            print(f"[transcribe] VRAM after diarize flush: {get_vram_usage()}")

        except ImportError:
            print("[transcribe] WARNING: whisperx.diarize not available, skipping diarization")
        except Exception as e:
            print(f"[transcribe] WARNING: Diarization failed ({e}), continuing without speaker labels")
    else:
        print("[transcribe] No HuggingFace token provided — skipping diarization")

    # ── Step 5: Extract word-level data ─────────────────────
    words = []
    for segment in result.get("segments", []):
        segment_speaker = segment.get("speaker")
        for w in segment.get("words", []):
            word_entry = {
                "text": w.get("word", "").strip(),
                "start": round(w.get("start", 0), 3),
                "end": round(w.get("end", 0), 3),
            }
            # Add speaker label if available (from word or segment level)
            speaker = w.get("speaker") or segment_speaker
            if speaker:
                word_entry["speaker"] = speaker
            # Only include words that have valid timestamps
            if word_entry["text"] and word_entry["start"] >= 0 and word_entry["end"] > 0:
                words.append(word_entry)

    elapsed = round(time.time() - t_start, 1)

    output = {
        "metadata": {
            "source_file": video_path.name,
            "source_language": detected_language,
            "language": "en",  # output is always English (translated)
            "model": model_id,
            "compute_type": COMPUTE_TYPE,
            "device": DEVICE,
            "duration_seconds": round(len(audio) / 16000, 2),
            "processing_time_seconds": elapsed,
            "word_count": len(words),
            "speakers_detected": speakers_detected,
        },
        "words": words,
    }

    # ── Save JSON ───────────────────────────────────────────
    json_filename = video_path.stem + "_transcription.json"
    json_path = output_dir / json_filename
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"[transcribe] Done! {len(words)} words in {elapsed}s")
    if speakers_detected:
        print(f"[transcribe]   -> {speakers_detected} speaker(s) detected")
    print(f"[transcribe] JSON saved to: {json_path}")

    return output


# ─── CLI entrypoint ──────────────────────────────────────────
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <video_path> [output_dir]")
        sys.exit(1)

    video = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    result = transcribe_video(video, out)
    print(json.dumps(result["metadata"], indent=2))
