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

# For structured output parsing
from pydantic import BaseModel, Field

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

═══ TASK 1 — HOOK IDENTIFICATION ═══
Find the single most engaging, "scroll-stopping" moment that would work best as \
the opening of a short-form vertical video. Prioritize:
- Surprising or provocative statements
- Emotional peaks
- Interesting questions
- Key insights or revelations
Return the word index range of the hook.

═══ TASK 2 — OVERLAP HANDLING ═══
If there are words with overlapping time ranges (multiple people talking at the \
same time), decide which words are MORE important and mark the LESS \
important overlapping words for hiding. If no overlaps exist, return an empty list.

═══ TASK 3 — WASTED TIME REMOVAL ═══
Identify portions of the transcript where the speaker is excessively rambling, \
going off-topic, or just wasting time with unnecessary filler words. Mark the indices \
of these words to be cut out. Be brutal with cutting out boring parts to maintain \
audience retention, but do NOT cut out the hook or important context/punchlines. \
If no words should be cut, return an empty list.

═══ TASK 4 — TRANSCRIPT OPTIMIZATION (HYBRID MODE) ═══
You may be provided with TWO transcripts:
- SOURCE A (WhisperX): Word-level timing, but might have misspellings or poor punctuation.
- SOURCE B (YouTube CC): Better spelling for names/brands and more natural sentence grouping.

Compare them. If SOURCE B exists, use its spelling and punctuation to correct SOURCE A. Your FINAL 'words' in the output JSON should use the timing from SOURCE A but the optimized text from your hybrid analysis.

═══ TASK 5 — SMART SUBTITLE GROUPING (IMPORTANT) ═══
Group the REMAINING words into natural subtitle display chunks that are EASY TO READ as captions.
Rules (STRICT):
- Exclude ANY word indices you marked in Tasks 2 and 3 (hidden or wasted). Only group the words that are actually kept!
- Create natural, phrase-based groups that are easy to read. Do NOT arbitrarily limit length, but keep them easy to digest.
- MINIMUM 2 words per group, UNLESS a single word is isolated by a significant time gap (>1.0 second) from surrounding words. Pay attention to START and END timestamps!
  → The word AFTER a period starts a NEW group
- Break at natural pauses (commas, colons, semicolons, dashes)
- Keep short phrases together ("you know", "I mean", "of course")
- Provide the explicit array of `word_indices` for each group, so that gaps from cut words are naturally skipped.

═══ RESPONSE FORMAT ═══
{
  "hook": {
    "word_index_start": 10,
    "word_index_end": 25,
    "reason": "Why this is the best hook"
  },
  "hidden_word_ranges": [],
  "wasted_word_ranges": [],
  "optimized_words": [
     {"index": 0, "text": "Corrected word"}
  ],
  "groups": [
    {"word_indices": [0, 1, 2]},
    {"word_indices": [6, 7]}
  ]
}
Note: 'optimized_words' should only be returned if you found corrections to make.
If you return 'optimized_words', ensure the count and order exactly match the input.
"""


class HookModel(BaseModel):
    word_index_start: int
    word_index_end: int
    reason: str

class WordRangeModel(BaseModel):
    start_index: int
    end_index: int

class OptimizedWordModel(BaseModel):
    index: int
    text: str

class WordGroupModel(BaseModel):
    word_indices: list[int]

class RefineResponseModel(BaseModel):
    hook: Optional[HookModel] = None
    hidden_word_ranges: list[WordRangeModel] = Field(default_factory=list)
    wasted_word_ranges: list[WordRangeModel] = Field(default_factory=list)
    optimized_words: list[OptimizedWordModel] = Field(default_factory=list)
    groups: list[WordGroupModel] = Field(default_factory=list)

def analyze_with_gemini(words: list[dict], api_key: str, reference_text: Optional[str] = None) -> dict:
    """
    Send word-level transcript to Gemini for speaker identification,
    smart grouping, hook detection, and overlap handling.
    
    If reference_text (YouTube captions) is provided, Gemini will use it
     to improve spelling and punctuation.
    """
    if not GEMINI_AVAILABLE:
        raise RuntimeError("google-genai is not installed. Run: pip install google-genai")

    client = genai.Client(api_key=api_key)

    # Build compact transcript from Source A (WhisperX)
    lines = []
    for i, w in enumerate(words):
        lines.append(f"{i}|{w['start']:.2f}|{w['end']:.2f}|{w['text']}")

    transcript_text = "\n".join(lines)

    prompt_parts = [
        f"═══ SOURCE A (WhisperX Word-Level) ═══\nEach line: INDEX|START|END|WORD\n\n{transcript_text}\n"
    ]

    if reference_text:
        prompt_parts.append(
            f"\n═══ SOURCE B (YouTube CC Reference) ═══\nThis source has better spelling for names and brands:\n\n{reference_text}\n"
        )

    prompt_parts.append(
        f"\nTotal words to process: {len(words)}\n"
        f"Analyze following ALL instructions. Return ONLY valid JSON matching the schema."
    )

    prompt = "".join(prompt_parts)

    response = client.models.generate_content(
        model="gemini-2.5-flash",
        contents=prompt,
        config=genai_types.GenerateContentConfig(
            system_instruction=_REFINE_SYSTEM_PROMPT,
            temperature=0.15,
            response_mime_type="application/json",
            response_schema=RefineResponseModel,
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

def _validate_groups(groups: list[dict], words: list[dict], excluded_indices: set) -> list[dict]:
    """
    Validate Gemini-returned groups. If invalid, return None so caller
    falls back to auto-grouping.
    """
    if not groups:
        return None

    word_count = len(words)
    valid_words = set(i for i in range(word_count) if i not in excluded_indices)
    if not valid_words:
        return None

    seen = set()
    validated = []
    for g in groups:
        if "start_index" in g and "end_index" in g:
            indices = list(range(g["start_index"], g["end_index"] + 1))
        else:
            indices = g.get("word_indices", [])
            
        valid = [i for i in indices if isinstance(i, int) and i in valid_words]
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
        })

    # Check coverage — if <80% of kept words covered, reject
    if len(seen) < len(valid_words) * 0.8:
        return None

    # Fill any gaps
    missing = [i for i in valid_words if i not in seen]
    if missing:
        # Instead of appending indefinitely to the previous group, create minimal valid groups.
        missing.sort()
        for idx in missing:
            placed = False
            for g in validated:
                if g["word_indices"][-1] == idx - 1:
                    g["word_indices"].append(idx)
                    placed = True
                    break
            if not placed:
                validated.append({
                    "word_indices": [idx],
                })

    # Sort groups by first word index
    validated.sort(key=lambda g: g["word_indices"][0])

    # Final pass: Split any overstuffed groups or groups straddling punctuation or large gaps
    final_groups = []
    for g in validated:
        inds = g["word_indices"]
        current_chunk = []
        for idx in inds:
            # Check for large time gap before adding to current_chunk
            if current_chunk:
                prev_idx = current_chunk[-1]
                gap = words[idx]["start"] - words[prev_idx]["end"]
                if gap >= 1.0:
                    final_groups.append({"word_indices": current_chunk})
                    current_chunk = []
                    
            current_chunk.append(idx)
            text = words[idx].get("text", "").strip()
            # If the chunk ends in punctuation (or is excessively long as a fallback safety limit)
            has_punct = any(text.endswith(p) for p in [".", "?", "!", ","])
            if has_punct or len(current_chunk) >= 12:
                final_groups.append({"word_indices": current_chunk})
                current_chunk = []
        if current_chunk:
            final_groups.append({"word_indices": current_chunk})

    # Cleanup pass: eliminate 1-word groups if there isn't a significant time gap
    merged_groups = []
    for g in final_groups:
        inds = g["word_indices"]
        if not inds:
            continue
            
        if len(inds) == 1:
            idx = inds[0]
            curr_word = words[idx]
            
            # Check if we can merge backwards
            if merged_groups:
                prev_g = merged_groups[-1]
                prev_idx = prev_g["word_indices"][-1]
                prev_word = words[prev_idx]
                gap = curr_word["start"] - prev_word["end"]
                
                # If gap is small, merge it backwards
                if gap < 1.0 and len(prev_g["word_indices"]) < 12:
                    prev_g["word_indices"].append(idx)
                    continue
                    
            merged_groups.append(g)
        else:
            # Current group is >1 word. Check if we should merge the PREVIOUS group forwards into this one
            if merged_groups and len(merged_groups[-1]["word_indices"]) == 1:
                prev_idx = merged_groups[-1]["word_indices"][0]
                prev_word = words[prev_idx]
                curr_first_idx = inds[0]
                curr_first_word = words[curr_first_idx]
                gap = curr_first_word["start"] - prev_word["end"]
                
                if gap < 1.0:
                    merged_groups[-1]["word_indices"].extend(inds)
                    continue
            
            merged_groups.append(g)

    return merged_groups

def _fallback_groups(words: list[dict], excluded_indices: set, wpg: int = 4) -> list[dict]:
    """Smart N-words-per-group fallback that respects punctuation."""
    groups = []
    current_group = []

    for i in range(len(words)):
        if i in excluded_indices:
            continue
            
        if current_group:
            prev_idx = current_group[-1]
            gap = words[i]["start"] - words[prev_idx]["end"]
            if gap >= 1.0:
                groups.append({"word_indices": current_group})
                current_group = []

        current_group.append(i)
        
        # Check if this word has sentence-ending punctuation or a strong comma
        text = words[i].get("text", "").strip()
        has_punct = any(text.endswith(p) for p in [".", "?", "!", ","])
        
        if len(current_group) >= wpg or has_punct:
            groups.append({
                "word_indices": current_group,
            })
            current_group = []

    if current_group:
         groups.append({
             "word_indices": current_group,
         })

    return groups


# ─── Main Refine Pipeline ───────────────────────────────────

def refine_video(
    video_path: str,
    output_dir: str,
    rendered_dir: str,
    gemini_api_key: str,
    req_filename: str = "",
    transcription_model: str = "large-v2",
    min_silence_ms: int = 500,
    padding_ms: int = 100,
    do_cut_silence: bool = True,
    do_llm_filter: bool = True,
    do_grouping: bool = True,
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

    transcription = transcribe_video(
        str(video_path), 
        output_dir,
        model_id=transcription_model
    )
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

    if do_cut_silence:
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
    else:
        log("silence", "Skipping silence cutting")
        output_filename = req_filename if req_filename else video_path.name
        adjusted_words = words
        duration = metadata.get("duration", 0)
        if not duration and words:
            duration = words[-1]["end"]
        stats = {
            "original_duration_s": duration,
            "kept_duration_s": duration,
            "removed_duration_s": 0,
            "segments_kept": 1,
        }

    # ── Step 3: Check for reference captions (Optional) ──────
    reference_text = None
    # Try direct lookup first
    yt_caps_path = video_path.with_suffix(".yt_captions.json")
    
    # If not found directly (maybe file was reframed/renamed), try prefix matching in UPLOAD_DIR
    if not yt_caps_path.exists():
        # Match pattern: yt_01_...
        match = re.search(r'^(yt_\d{2}_)', video_path.name)
        if match:
            prefix = match.group(1)
            # Try to find a matching captions file in the uploads folder
            # We assume uploads is adjacent to rendered or can be inferred
            parent_dir = video_path.parent
            search_dirs = [parent_dir]
            if "rendered" in str(parent_dir):
                # Try sibling 'uploads' directory
                pot_uploads = parent_dir.parent / "uploads"
                if pot_uploads.exists():
                    search_dirs.append(pot_uploads)
            
            for d in search_dirs:
                matches = list(d.glob(f"{prefix}*.yt_captions.json"))
                if matches:
                    yt_caps_path = matches[0]
                    break

    if yt_caps_path.exists():
        try:
            log("analyze", f"Found reference captions: {yt_caps_path.name}")
            with open(yt_caps_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                segments = data.get("segments", [])
                reference_text = " ".join(s.get("text", "") for s in segments)
        except Exception as e:
            log("analyze", f"Warning: Failed to load reference captions: {e}")

    # ── Step 4: Gemini analysis ─────────────────────────────
    log("analyze", "Sending transcript to Gemini AI…")

    if do_llm_filter or do_grouping:
        analysis = analyze_with_gemini(adjusted_words, gemini_api_key, reference_text)
        log("analyze", "Gemini analysis complete")
    else:
        analysis = {}
        log("analyze", "Skipping Gemini analysis")

    # ── Step 4: Apply results ───────────────────────────────
    log("apply", "Applying refinements…")

    # 4a — Ensure default speakers
    for w in adjusted_words:
        if "speaker" not in w:
            w["speaker"] = "SPEAKER_00"

    # 4a-bis — Optimized words (Hybrid mode using reference)
    optimized = analysis.get("optimized_words", [])
    if optimized and len(optimized) == len(adjusted_words):
        log("apply", "Applying Optimized Text from source B (Hybrid Mode)")
        for item in optimized:
            idx = item.get("index")
            text = item.get("text")
            if isinstance(idx, int) and 0 <= idx < len(adjusted_words) and text:
                adjusted_words[idx]["text"] = text

    # 4b — Hidden (overlapping, less-important words)
    hidden_indices = []
    if do_llm_filter:
        for r in analysis.get("hidden_word_ranges", []):
            if isinstance(r, dict):
                start_idx = r.get("start_index", r.get("word_index_start"))
                end_idx = r.get("end_index", r.get("word_index_end"))
                if start_idx is not None and end_idx is not None:
                    hidden_indices.extend(range(start_idx, end_idx + 1))
            elif isinstance(r, (list, tuple)) and len(r) >= 2:
                hidden_indices.extend(range(r[0], r[1] + 1))
        hidden_indices.extend(analysis.get("hidden_word_indices", []))
        hidden_indices = [i for i in hidden_indices if isinstance(i, int) and 0 <= i < len(adjusted_words)]

    # 4c — Wasted (rambling, unnecessary words)
    wasted_indices = []
    if do_llm_filter:
        for r in analysis.get("wasted_word_ranges", []):
            if isinstance(r, dict):
                start_idx = r.get("start_index", r.get("word_index_start"))
                end_idx = r.get("end_index", r.get("word_index_end"))
                if start_idx is not None and end_idx is not None:
                    wasted_indices.extend(range(start_idx, end_idx + 1))
            elif isinstance(r, (list, tuple)) and len(r) >= 2:
                wasted_indices.extend(range(r[0], r[1] + 1))
        wasted_indices.extend(analysis.get("wasted_word_indices", []))
        wasted_indices = [i for i in wasted_indices if isinstance(i, int) and 0 <= i < len(adjusted_words)]

    excluded_indices = set(hidden_indices + wasted_indices)

    # 4d — Groups (validate, fallback if needed)
    raw_groups = analysis.get("groups", [])
    print(f"[DEBUG] raw_groups length = {len(raw_groups)}")
    if raw_groups and len(raw_groups) > 0:
        print(f"[DEBUG] first raw_group = {raw_groups[0]}")

    validated_groups = _validate_groups(raw_groups, adjusted_words, excluded_indices)

    if validated_groups and do_grouping:
        groups = validated_groups
        log("apply", f"Using {len(groups)} Gemini-generated groups")
    else:
        groups = _fallback_groups(adjusted_words, excluded_indices)
        log("apply", f"Gemini groups invalid/skipped — using {len(groups)} auto-groups")

    # Attach timing to groups
    for g in groups:
        indices = g["word_indices"]
        gw = [adjusted_words[i] for i in indices if i < len(adjusted_words)]
        if gw:
            g["start"] = gw[0]["start"]
            g["end"] = gw[-1]["end"]
            if "speaker" not in g:
                g["speaker"] = gw[0].get("speaker", "SPEAKER_00")

    # 4e — Hook
    hook = analysis.get("hook", None)

    # 4f — Speakers info
    seen_speakers = {w.get("speaker", "SPEAKER_00") for w in adjusted_words}
    speakers = {spk: spk.replace("_", " ").title() for spk in seen_speakers}

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
