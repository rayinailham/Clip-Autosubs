"""
Transcription Engine — ElevenLabs Scribe ONLY.
No local models, no torch, no whisperx.

Uploads audio extracted from a video file to the ElevenLabs Speech-to-Text API
and returns word-level timestamps in the same shape the rest of the app expects.
"""

import json
import os
import subprocess
import tempfile
import time
from pathlib import Path
from typing import Optional

import requests


ELEVENLABS_STT_URL = "https://api.elevenlabs.io/v1/speech-to-text"


def transcribe_video(
    video_path: str,
    output_dir: Optional[str] = None,
    model_id: str = "scribe_v1",
    elevenlabs_api_key: Optional[str] = None,
    # Legacy args kept for back-compat — ignored.
    hf_token: Optional[str] = None,
    min_speakers: Optional[int] = None,
    max_speakers: Optional[int] = None,
    diarize: Optional[bool] = None,
    language_code: Optional[str] = None,
) -> dict:
    """
    Transcribe a video/audio file via ElevenLabs Scribe.

    Args:
        video_path: Path to the input file.
        output_dir: Directory to write the JSON output.
        model_id: ElevenLabs STT model id (e.g. "scribe_v1").
        elevenlabs_api_key: ElevenLabs API key. Required.
        diarize: If True, ask the API to return speaker labels.
        language_code: Optional ISO language hint.

    Returns:
        dict with keys: words, metadata
    """
    if not elevenlabs_api_key:
        raise RuntimeError(
            "ElevenLabs API key is required. Set it in the Settings page."
        )

    video_path = Path(video_path).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    if output_dir is None:
        output_dir = video_path.parent
    output_dir = Path(output_dir)
    output_dir.mkdir(parents=True, exist_ok=True)

    print(f"[transcribe] ElevenLabs Scribe ({model_id}) — {video_path.name}")
    t_start = time.time()

    # ── Extract audio (mp3 128k) to keep upload small ─────────────────────
    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        audio_path = tmp.name
    try:
        print("[transcribe] Extracting audio…")
        ff = subprocess.run(
            [
                "ffmpeg", "-y", "-i", str(video_path),
                "-vn", "-c:a", "libmp3lame", "-b:a", "128k",
                audio_path,
            ],
            capture_output=True, text=True, encoding="utf-8", errors="replace",
        )
        if ff.returncode != 0:
            raise RuntimeError(
                f"ffmpeg audio extraction failed:\n{ff.stderr[-1000:]}"
            )

        # ── Upload ─────────────────────────────────────────────────────────
        headers = {"xi-api-key": elevenlabs_api_key}
        data = {
            "model_id": model_id,
            "tag_audio_events": "false",
            "diarize": "true" if diarize else "false",
        }
        if language_code:
            data["language_code"] = language_code

        print(f"[transcribe] Uploading {Path(audio_path).stat().st_size / 1e6:.1f}MB to ElevenLabs…")
        with open(audio_path, "rb") as f:
            files = {"file": (Path(audio_path).name, f, "audio/mpeg")}
            res = requests.post(
                ELEVENLABS_STT_URL,
                headers=headers,
                data=data,
                files=files,
                timeout=600,
            )

        if res.status_code != 200:
            raise RuntimeError(
                f"ElevenLabs API error {res.status_code}: {res.text[:500]}"
            )
        payload = res.json()

    finally:
        try:
            os.remove(audio_path)
        except OSError:
            pass

    # ── Normalise word list ───────────────────────────────────────────────
    words = []
    for w in payload.get("words", []):
        text = (w.get("text") or "").strip()
        if not text:
            continue
        # ElevenLabs returns punctuation as separate "type":"spacing"/"punctuation" entries.
        # Skip non-word entries.
        wtype = w.get("type", "word")
        if wtype not in ("word", None):
            continue
        entry = {
            "text": text,
            "start": round(float(w.get("start", 0)), 3),
            "end": round(float(w.get("end", 0)), 3),
        }
        spk = w.get("speaker_id") or w.get("speaker")
        if spk:
            entry["speaker"] = str(spk)
        if entry["end"] > entry["start"]:
            words.append(entry)

    elapsed = round(time.time() - t_start, 1)
    speakers = sorted({w["speaker"] for w in words if "speaker" in w})

    duration = words[-1]["end"] if words else 0.0
    output = {
        "metadata": {
            "source_file": video_path.name,
            "source_language": payload.get("language_code", "auto"),
            "language": payload.get("language_code", "auto"),
            "model": model_id,
            "provider": "elevenlabs",
            "duration_seconds": round(duration, 2),
            "processing_time_seconds": elapsed,
            "word_count": len(words),
            "speakers_detected": len(speakers),
        },
        "words": words,
    }

    json_path = output_dir / (video_path.stem + "_transcription.json")
    with open(json_path, "w", encoding="utf-8") as f:
        json.dump(output, f, indent=2, ensure_ascii=False)

    print(f"[transcribe] Done — {len(words)} words in {elapsed}s -> {json_path.name}")
    return output


# ─── CLI entrypoint (for quick testing) ──────────────────────────────────
if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python transcribe.py <video_path> [output_dir]")
        print("  Set ELEVENLABS_API_KEY env var or pass via env.")
        sys.exit(1)

    key = os.environ.get("ELEVENLABS_API_KEY", "")
    if not key:
        print("ERROR: ELEVENLABS_API_KEY env var not set.")
        sys.exit(2)

    video = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else None
    result = transcribe_video(video, out, elevenlabs_api_key=key)
    print(json.dumps(result["metadata"], indent=2))
