"""
Refine Engine — Automated vertical video refinement pipeline.

Orchestrates:
  1. WhisperX transcription (word-level timestamps)
  2. Silence removal (using word gaps)
  3. Gemini AI analysis:
     - Speaker identification & diarization
     - Natural subtitle grouping (sentence-boundary aware)
     - Best hook moment detection
     - Overlap resolution
"""

import json
import re
import time
import uuid
from pathlib import Path
from typing import Optional, Callable

try:
    from google import genai
    from google.genai import types as genai_types
    GEMINI_AVAILABLE = True
except ImportError:
    GEMINI_AVAILABLE = False

from transcribe import transcribe_video
from silence_cutter import detect_speech_segments, clamp_segments, cut_silence
from renderer import get_video_info


# ─── Timestamp adjustment after silence cut ──────────────────

def adjust_timestamps(
    words: list[dict],
    kept_segments: list[tuple[float, float]],
) -> list[dict]:
    """
    Adjust word timestamps to match the silence-cut output video.

    In the output video, kept_segments are concatenated back-to-back.
    Words that fall within a kept segment get their timestamps shifted
    so they line up with the concatenated timeline.
    Words outside all kept segments are dropped.
    """
    adjusted = []
    for word in words:
        w_start = word["start"]
        w_end = word["end"]
        running_time = 0.0

        for seg_start, seg_end in kept_segments:
            seg_dur = seg_end - seg_start

            # Word starts within (or very close to) this kept segment
            if w_start >= seg_start - 0.05 and w_start <= seg_end + 0.05:
                new_start = running_time + max(0.0, w_start - seg_start)
                new_end = running_time + min(seg_dur, w_end - seg_start)
                if new_end <= new_start:
                    new_end = new_start + (w_end - w_start)

                adj = dict(word)
                adj["start"] = round(new_start, 3)
                adj["end"] = round(new_end, 3)
                adjusted.append(adj)
                break

            running_time += seg_dur

    return adjusted


# ─── Gemini Analysis ────────────────────────────────────────

_REFINE_SYSTEM_PROMPT = """\
You are a professional video editor and subtitle expert. You will be given a word-level \
transcript with timestamps from a video. Perform ALL of the following tasks and \
return ONLY valid JSON (no markdown, no explanation).

═══ TASK 1 — SPEAKER IDENTIFICATION ═══
Analyze the dialogue for different speakers. Look at:
- Conversation turn-taking patterns
- Topic shifts, "I" vs "you" references
- Question–response pairs
- Timestamps gaps that indicate a speaker change
Assign each word to SPEAKER_1, SPEAKER_2, etc. If only one person is talking, \
assign everything to SPEAKER_1.

═══ TASK 2 — SMART SUBTITLE GROUPING ═══
Group words into natural subtitle display chunks that are EASY TO READ as captions.
Rules (STRICT):
- Each group: 2–6 words
- ALWAYS break AFTER sentence-ending punctuation (. ! ?)
  → The word AFTER a period starts a NEW group
- Break at natural pauses (commas, colons, semicolons, dashes)
- Keep short phrases together ("you know", "I mean", "of course")
- Never mix speakers in one group — speaker boundary = group boundary
- Every word index from 0 to N-1 must appear in exactly one group
- Indices within each group must be consecutive (no gaps)
- Groups must be in order (group 2 starts after group 1 ends)

═══ TASK 3 — HOOK IDENTIFICATION ═══
Find the single most engaging, "scroll-stopping" moment that would work best as \
the opening of a short-form vertical video. Prioritize:
- Surprising or provocative statements
- Emotional peaks
- Interesting questions
- Key insights or revelations
Return the word index range of the hook.

═══ TASK 4 — OVERLAP HANDLING ═══
If different speakers have words with overlapping time ranges (they talked at the \
same time), decide which speaker's words are MORE important and mark the LESS \
important overlapping words for hiding. If no overlaps exist, return an empty list.

═══ TASK 5 — WASTED TIME REMOVAL ═══
Identify portions of the transcript where the speaker is excessively rambling, \
going off-topic, or just wasting time with unnecessary filler words. Mark the indices \
of these words to be cut out. Be brutal with cutting out boring parts to maintain \
audience retention, but do NOT cut out the hook or important context/punchlines. \
If no words should be cut, return an empty list.

═══ RESPONSE FORMAT ═══
{
  "speakers": {
    "SPEAKER_1": "Brief description",
    "SPEAKER_2": "Brief description"
  },
  "word_speakers": [
    {"indices": [0,1,2,3], "speaker": "SPEAKER_1"},
    {"indices": [4,5,6], "speaker": "SPEAKER_2"}
  ],
  "groups": [
    {"word_indices": [0,1,2], "speaker": "SPEAKER_1"},
    {"word_indices": [3,4,5,6], "speaker": "SPEAKER_2"}
  ],
  "hook": {
    "word_index_start": 10,
    "word_index_end": 25,
    "reason": "Why this is the best hook"
  },
  "hidden_word_indices": [],
  "wasted_word_indices": []
}
"""


def analyze_with_gemini(words: list[dict], api_key: str) -> dict:
    """
    Send word-level transcript to Gemini for speaker identification,
    smart grouping, hook detection, and overlap handling.
    """
    if not GEMINI_AVAILABLE:
        raise RuntimeError("google-genai is not installed. Run: pip install google-genai")

    client = genai.Client(api_key=api_key)

    # Build compact transcript
    lines = []
    for i, w in enumerate(words):
        lines.append(f"{i}|{w['start']:.2f}|{w['end']:.2f}|{w['text']}")

    transcript_text = "\n".join(lines)

    prompt = (
        f"Here is a word-level transcript. Each line: INDEX|START|END|WORD\n\n"
        f"{transcript_text}\n\n"
        f"Total words: {len(words)}\n"
        f"Analyze this transcript following ALL instructions. Return ONLY valid JSON."
    )

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            system_instruction=_REFINE_SYSTEM_PROMPT,
            temperature=0.15,
        ),
    )

    raw = response.text.strip()

    # Strip markdown code fences
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE)

    try:
        result = json.loads(raw)
    except json.JSONDecodeError as e:
        raise RuntimeError(
            f"Gemini returned invalid JSON: {e}\nRaw response:\n{raw[:1500]}"
        )

    return result


# ─── Validation helpers ─────────────────────────────────────

def _validate_groups(groups: list[dict], word_count: int) -> list[dict]:
    """
    Validate Gemini-returned groups. If invalid, return None so caller
    falls back to auto-grouping.
    """
    if not groups:
        return None

    seen = set()
    validated = []
    for g in groups:
        indices = g.get("word_indices", [])
        valid = [i for i in indices if isinstance(i, int) and 0 <= i < word_count]
        if not valid:
            continue
        # Check for duplicates
        dupes = [i for i in valid if i in seen]
        valid = [i for i in valid if i not in seen]
        if not valid:
            continue
        for i in valid:
            seen.add(i)
        validated.append({
            "word_indices": valid,
            "speaker": g.get("speaker", "SPEAKER_1"),
        })

    # Check coverage — if <80% of words covered, reject
    if len(seen) < word_count * 0.8:
        return None

    # Fill any gaps
    missing = [i for i in range(word_count) if i not in seen]
    if missing:
        # Append missing words to nearest preceding group, or create new group
        for idx in missing:
            # Find the group whose last index is just before this idx
            placed = False
            for g in validated:
                if g["word_indices"][-1] == idx - 1:
                    g["word_indices"].append(idx)
                    placed = True
                    break
            if not placed:
                validated.append({
                    "word_indices": [idx],
                    "speaker": "SPEAKER_1",
                })

    # Sort groups by first word index
    validated.sort(key=lambda g: g["word_indices"][0])

    return validated


def _fallback_groups(words: list[dict], wpg: int = 4) -> list[dict]:
    """Simple N-words-per-group fallback."""
    groups = []
    for i in range(0, len(words), wpg):
        chunk = words[i : i + wpg]
        if not chunk:
            continue
        groups.append({
            "word_indices": list(range(i, i + len(chunk))),
            "speaker": chunk[0].get("speaker", "SPEAKER_1"),
        })
    return groups


# ─── Main Refine Pipeline ───────────────────────────────────

def refine_video(
    video_path: str,
    output_dir: str,
    rendered_dir: str,
    gemini_api_key: str,
    min_silence_ms: int = 500,
    padding_ms: int = 100,
    progress_cb: Optional[Callable[[str, str], None]] = None,
) -> dict:
    """
    Full automated refine pipeline.

    Args:
        video_path:      Path to the input video.
        output_dir:      Directory for transcription JSON.
        rendered_dir:    Directory for rendered / cut videos.
        gemini_api_key:  Google Gemini API key.
        min_silence_ms:  Minimum silence gap to cut (ms).
        padding_ms:      Padding around speech blocks (ms).
        progress_cb:     Callback(step, message) for progress updates.

    Returns:
        dict with video_filename, words (with speakers), groups, hook,
        speakers, hidden_indices, silence_stats, metadata.
    """
    def log(step: str, msg: str):
        print(f"[refine:{step}] {msg}")
        if progress_cb:
            progress_cb(step, msg)

    t0 = time.time()
    video_path = Path(video_path).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    log("init", f"Starting refine for: {video_path.name}")

    # ── Step 1: Transcribe ──────────────────────────────────
    log("transcribe", "Transcribing video with WhisperX…")

    transcription = transcribe_video(str(video_path), output_dir)
    words = transcription["words"]
    metadata = transcription["metadata"]

    log(
        "transcribe",
        f"Done — {len(words)} words in {metadata.get('processing_time_seconds', 0)}s",
    )

    if not words:
        raise ValueError("Transcription produced no words.")

    # ── Step 2: Cut silences ────────────────────────────────
    log("silence", "Cutting silences from video…")

    job_id = uuid.uuid4().hex[:8]
    output_filename = f"{video_path.stem}_refined_{job_id}.mp4"
    output_path = Path(rendered_dir) / output_filename

    stats = cut_silence(
        video_path=str(video_path),
        words=words,
        output_path=str(output_path),
        min_silence_ms=min_silence_ms,
        padding_ms=padding_ms,
        progress_cb=lambda msg: log("silence", msg),
    )

    # Adjust timestamps to match the silence-cut output
    kept_segments = [(s[0], s[1]) for s in stats["segments"]]
    adjusted_words = adjust_timestamps(words, kept_segments)

    log(
        "silence",
        f"Done — {stats['removed_duration_s']}s removed, "
        f"{len(adjusted_words)} words remain",
    )

    # ── Step 3: Gemini analysis ─────────────────────────────
    log("analyze", "Sending transcript to Gemini AI…")

    analysis = analyze_with_gemini(adjusted_words, gemini_api_key)

    log("analyze", "Gemini analysis complete")

    # ── Step 4: Apply results ───────────────────────────────
    log("apply", "Applying refinements…")

    # 4a — Speaker labels
    speaker_map: dict[int, str] = {}
    for seg in analysis.get("word_speakers", []):
        speaker = seg.get("speaker", "SPEAKER_1")
        for idx in seg.get("indices", []):
            if isinstance(idx, int) and 0 <= idx < len(adjusted_words):
                speaker_map[idx] = speaker

    for i, w in enumerate(adjusted_words):
        w["speaker"] = speaker_map.get(i, "SPEAKER_1")

    # 4b — Groups (validate, fallback if needed)
    raw_groups = analysis.get("groups", [])
    validated_groups = _validate_groups(raw_groups, len(adjusted_words))

    if validated_groups:
        groups = validated_groups
        log("apply", f"Using {len(groups)} Gemini-generated groups")
    else:
        groups = _fallback_groups(adjusted_words)
        log("apply", f"Gemini groups invalid — using {len(groups)} auto-groups")

    # Attach timing to groups
    for g in groups:
        indices = g["word_indices"]
        gw = [adjusted_words[i] for i in indices if i < len(adjusted_words)]
        if gw:
            g["start"] = gw[0]["start"]
            g["end"] = gw[-1]["end"]
            if "speaker" not in g:
                g["speaker"] = gw[0].get("speaker", "SPEAKER_1")

    # 4c — Hook
    hook = analysis.get("hook", None)

    # 4d — Hidden (overlapping, less-important words)
    hidden_indices = [
        i for i in analysis.get("hidden_word_indices", [])
        if isinstance(i, int) and 0 <= i < len(adjusted_words)
    ]

    # 4e — Speakers info
    speakers = analysis.get("speakers", {"SPEAKER_1": "Speaker 1"})

    # 4f — Wasted (rambling, unnecessary words)
    wasted_indices = [
        i for i in analysis.get("wasted_word_indices", [])
        if isinstance(i, int) and 0 <= i < len(adjusted_words)
    ]

    elapsed = round(time.time() - t0, 1)
    log("done", f"Refine complete in {elapsed}s!")

    return {
        "video_filename": output_filename,
        "original_filename": video_path.name,
        "words": adjusted_words,
        "groups": groups,
        "hook": hook,
        "speakers": speakers,
        "hidden_indices": hidden_indices,
        "wasted_indices": wasted_indices,
        "metadata": metadata,
        "silence_stats": {
            "original_duration_s": stats["original_duration_s"],
            "kept_duration_s": stats["kept_duration_s"],
            "removed_duration_s": stats["removed_duration_s"],
            "segments_kept": stats["segments_kept"],
        },
        "processing_time_s": elapsed,
    }
