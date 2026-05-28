"""
Refine Engine — Automated subtitle pipeline.

Orchestrates:
  1. WhisperX (or other) transcription (word-level timestamps)
  2. Gemini AI analysis:
     - Spelling/punctuation correction (hybrid mode w/ YouTube CC)
     - Natural subtitle grouping (sentence-boundary aware)
"""

import json
import re
import time
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
from renderer import get_video_info
from logger import get_logger

log = get_logger("refine")


# ─── Gemini Analysis ────────────────────────────────────────

_REFINE_SYSTEM_PROMPT = """\
You are a professional video editor and subtitle expert. You will be given a word-level \
transcript with timestamps from a video. Perform ALL of the following tasks and \
return ONLY valid JSON (no markdown, no explanation).

═══ TASK 1 — TRANSCRIPT OPTIMIZATION (HYBRID MODE) ═══
You may be provided with TWO transcripts:
- SOURCE A (WhisperX): Word-level timing, but might have misspellings or poor punctuation.
- SOURCE B (YouTube CC): Better spelling for names/brands and more natural sentence grouping.

Compare them. If SOURCE B exists, use its spelling and punctuation to correct SOURCE A. ONLY return words in 'optimized_words' that actually needed correcting (i.e. changing the text from SOURCE A). Do NOT return words that are unchanged.

═══ TASK 2 — SMART SUBTITLE GROUPING (IMPORTANT & FOOLPROOF) ═══
Group the words into perfectly natural, readable subtitle chunks. You MUST strictly obey these rules:
- MINIMUM 2 words per group. The ONLY exception is if a word has a >1.0s gap from its neighbors. DO NOT create random 1-word groups.
- MAXIMUM 6-8 words per group so they fit well on a vertical screen.
- NEVER split grammatical pairs (e.g., keep "going to", "to be", "I am" together).
- NEW GROUP triggers: ALWAYS start a new group after sentence-ending punctuation (`.`, `?`, `!`) or strong pauses like commas.
- Provide the explicit array of `word_indices` for each group. They must flow consecutively without repeating indices.

═══ TASK 3 — PER-GROUP ENGLISH TRANSLATION ═══
For EACH group you produce, also produce a `translation` field containing a natural,
fluent English rendering of that group's content.
- If SOURCE A is Japanese (or any non-English language), translate the GROUPED
  phrase as a whole — never word-by-word. Word-by-word machine translation reads
  unnatural and breaks idioms; translate the meaning.
- If SOURCE A is already English, copy the joined group text into `translation`
  verbatim (lightly cleaned — keep capitalization and punctuation natural).

VOICE & REGISTER (very important):
- Target voice = a casual American high-schooler talking on stream / to friends.
  Think relaxed, spoken, everyday English. NOT formal. NOT literary. NOT
  textbook-translation stiff.
- Use natural contractions: "I'm", "it's", "don't", "gonna", "wanna", "kinda".
- Sprinkle light, common slang where it fits the mood — but tastefully, not
  every line. Acceptable: "bro", "dude", "lowkey", "ngl", "bruh", "no way",
  "for real", "kinda", "literally", "so good", "wild", "nah", "yeah", "okay
  okay", "wait what". Reactions like "let's gooo", "oh my god", "what the
  heck" are fine in hype moments.
- AVOID: cringe / overused / forced Gen-Alpha brainrot ("skibidi", "rizz",
  "gyatt", "fanum tax", "sigma", "ohio", "mewing", "edging it") — never use
  those. They date the subtitles and read corny.
- AVOID: profanity stronger than "damn" / "hell" / "crap" unless the source is
  clearly cursing — keep it streamer-safe by default.
- AVOID: textbook phrasings like "I am going to", "It is very interesting",
  "Indeed", "Truly", "Henceforth". Real teens don't talk like that.
- Match the energy of the moment: hype scene → punchy and excited; calm
  exposition → chill and conversational; confused reaction → "huh?", "wait
  what", "no way".

LENGTH & FIT:
- Keep the translation tight enough to fit a vertical-video subtitle line
  (roughly the same length budget as the source group). Prefer concise, spoken
  English over literal long renderings.
- Preserve names, brands, and proper nouns from SOURCE B (YouTube CC) when
  available — do not romanize or "translate" names that are already English.
- Never leave `translation` null. If a group is purely interjection/laugh and has
  no meaningful content, still emit a sensible English equivalent (e.g. "Haha",
  "Wait what", "Yeah", "Bro", "No way").

═══ RESPONSE FORMAT ═══
Return ONLY valid JSON, no markdown, no commentary. The JSON object MUST have BOTH keys present, even when empty:
{
  "optimized_words": [
     {"index": 0, "text": "Corrected word"}
  ],
  "groups": [
    {"word_indices": [0, 1, 2], "translation": "English version of these words."},
    {"word_indices": [6, 7],    "translation": "Next chunk in English."}
  ]
}
Rules for `optimized_words`:
- Only include words you actually corrected by exact INDEX. Do NOT echo unchanged words.
- If you have no corrections, return `"optimized_words": []` (an empty array — never omit the key).
Rules for `groups`:
- ALWAYS produce groups covering every input index exactly once.
- Indices must be consecutive within a group and groups must appear in order.
- EVERY group MUST include a non-empty `translation` string.
- If you cannot group (input is empty), return `"groups": []`.
"""


class WordRangeModel(BaseModel):
    start_index: int
    end_index: int

class OptimizedWordModel(BaseModel):
    index: int
    text: str

class WordGroupModel(BaseModel):
    word_indices: list[int]
    # Natural English translation of the group. Empty string when source is
    # already English or translation not requested.
    translation: str = ""

class RefineResponseModel(BaseModel):
    # Required fields with empty-list defaults. Gemini structured output is more
    # reliable when fields are required than when marked optional, so we keep
    # them required and instruct the model to return [] when there is nothing.
    optimized_words: list[OptimizedWordModel] = Field(default_factory=list)
    groups: list[WordGroupModel] = Field(default_factory=list)

def _analyze_chunk(
    words: list[dict],
    api_key: str,
    reference_text: Optional[str],
    index_offset: int,
    model: str = "gemini-2.5-flash",
) -> dict:
    """Send a single chunk of words to Gemini. Indices in returned result are LOCAL to the chunk."""
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


def _split_into_chunks(
    words: list[dict],
    target_size: int = 400,
    max_size: int = 600,
    gap_threshold: float = 0.5,
) -> list[tuple[int, list[dict]]]:
    """
    Split words into chunks at natural pause boundaries.
    Returns list of (start_index, chunk_words) tuples.
    Aims for target_size words/chunk; splits at first gap >= gap_threshold
    after target_size, hard-cuts at max_size.
    """
    chunks: list[tuple[int, list[dict]]] = []
    n = len(words)
    cursor = 0
    while cursor < n:
        end = min(cursor + max_size, n)
        # If we still have room after the target, look for a natural pause to split.
        if cursor + target_size < end:
            split_at = end
            for i in range(cursor + target_size, end - 1):
                gap = words[i + 1]["start"] - words[i]["end"]
                if gap >= gap_threshold:
                    split_at = i + 1
                    break
            end = split_at
        chunks.append((cursor, words[cursor:end]))
        cursor = end
    return chunks


def analyze_with_gemini(
    words: list[dict],
    api_key: str,
    reference_text: Optional[str] = None,
    progress_cb: Optional[Callable[[str, str], None]] = None,
    model: str = "gemini-2.5-flash",
) -> dict:
    """
    Send word-level transcript to Gemini for smart grouping and spell correction.

    For long transcripts, splits into chunks at natural pause boundaries to keep
    prompt size and latency reasonable. Reference text is only sent with the first
    chunk to save tokens.
    """
    if not GEMINI_AVAILABLE:
        raise RuntimeError("google-genai is not installed. Run: pip install google-genai")

    # Short transcripts: single call.
    if len(words) <= 500:
        return _analyze_chunk(words, api_key, reference_text, index_offset=0, model=model)

    # Long transcripts: chunk + merge.
    chunks = _split_into_chunks(words)
    merged = {"optimized_words": [], "groups": []}
    for ci, (start_idx, chunk_words) in enumerate(chunks):
        if progress_cb:
            progress_cb("analyze", f"Gemini chunk {ci + 1}/{len(chunks)} ({len(chunk_words)} words)…")
        ref = reference_text if ci == 0 else None
        result = _analyze_chunk(chunk_words, api_key, ref, index_offset=start_idx, model=model)
        for ow in result.get("optimized_words", []) or []:
            local = ow.get("index")
            if isinstance(local, int):
                merged["optimized_words"].append({
                    "index": local + start_idx,
                    "text": ow.get("text", ""),
                })
        for g in result.get("groups", []) or []:
            indices = g.get("word_indices") or []
            merged["groups"].append({
                "word_indices": [i + start_idx for i in indices if isinstance(i, int)],
                "translation": (g.get("translation") or "").strip(),
            })

    return merged


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
            "translation": (g.get("translation") or "").strip(),
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
                    "translation": "",
                })

    # Sort groups by first word index
    validated.sort(key=lambda g: g["word_indices"][0])

    # Final pass: Split any overstuffed groups or groups straddling punctuation or large gaps
    final_groups = []
    for g in validated:
        inds = g["word_indices"]
        # If we never split this group, the original translation stays attached.
        # If we DO split, we keep the translation only on the FIRST piece because
        # the original Gemini translation covered the full original group span;
        # downstream splits do not have a per-piece translation, so we leave them
        # blank rather than duplicate text incorrectly.
        original_translation = g.get("translation", "")
        is_first_piece = True
        current_chunk = []
        for idx in inds:
            # Check for large time gap before adding to current_chunk
            if current_chunk:
                prev_idx = current_chunk[-1]
                gap = words[idx]["start"] - words[prev_idx]["end"]
                if gap >= 1.0:
                    final_groups.append({
                        "word_indices": current_chunk,
                        "translation": original_translation if is_first_piece else "",
                    })
                    is_first_piece = False
                    current_chunk = []

            current_chunk.append(idx)
            text = words[idx].get("text", "").strip()
            # If the chunk ends in punctuation (or is excessively long as a fallback safety limit)
            has_punct = any(text.endswith(p) for p in [".", "?", "!", ","])
            if has_punct or len(current_chunk) >= 12:
                final_groups.append({
                    "word_indices": current_chunk,
                    "translation": original_translation if is_first_piece else "",
                })
                is_first_piece = False
                current_chunk = []
        if current_chunk:
            final_groups.append({
                "word_indices": current_chunk,
                "translation": original_translation if is_first_piece else "",
            })

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
    gemini_model: Optional[str] = None,
    req_filename: str = "",
    transcription_model: str = "large-v2",
    elevenlabs_api_key: Optional[str] = None,
    diarize: bool = False,
    num_speakers: Optional[int] = None,
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
        progress_cb:     Callback(step, message) for progress updates.

    Returns:
        dict with video_filename, words (with speakers), groups,
        speakers, metadata.
    """
    def log_step(step: str, msg: str):
        log.info("[bold]%s[/] — %s", step, msg)
        if progress_cb:
            progress_cb(step, msg)

    t0 = time.time()
    video_path = Path(video_path).resolve()
    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    log_step("init", f"Starting refine for: {video_path.name}")

    # ── Step 1: Transcribe ──────────────────────────────────
    if transcription_model == "scribe_v2":
        log_step("transcribe", "Transcribing video with ElevenLabs Scribe v2…")
    elif transcription_model == "flyfront/anime-whisper-faster":
        log_step("transcribe", "Transcribing video with Anime-Whisper…")
    else:
        log_step("transcribe", "Transcribing video with WhisperX…")

    transcription = transcribe_video(
        str(video_path), 
        output_dir,
        model_id=transcription_model,
        elevenlabs_api_key=elevenlabs_api_key,
        diarize=diarize,
        num_speakers=num_speakers,
    )
    words = transcription["words"]
    metadata = transcription["metadata"]

    log_step(
        "transcribe",
        f"Done — {len(words)} words in {metadata.get('processing_time_seconds', 0)}s",
    )

    if not words:
        raise ValueError("Transcription produced no words.")

    # ── Step 2: Use original video ─────────────────────────
    output_filename = req_filename if req_filename else video_path.name
    adjusted_words = words

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
                matches = list(d.rglob(f"{prefix}*.yt_captions.json"))
                if matches:
                    yt_caps_path = matches[0]
                    break

    if yt_caps_path.exists():
        try:
            log_step("analyze", f"Found reference captions: {yt_caps_path.name}")
            with open(yt_caps_path, "r", encoding="utf-8") as f:
                data = json.load(f)
                segments = data.get("segments", [])
                reference_text = " ".join(s.get("text", "") for s in segments)
        except Exception as e:
            log_step("analyze", f"Warning: Failed to load reference captions: {e}")

    # ── Step 4: Gemini analysis ─────────────────────────────
    log_step("analyze", "Sending transcript to Gemini AI…")

    if do_grouping:
        analysis = analyze_with_gemini(
            adjusted_words,
            gemini_api_key,
            reference_text,
            progress_cb=progress_cb,
            model=(gemini_model or "gemini-2.5-flash"),
        )
        log_step("analyze", "Gemini analysis complete")
    else:
        analysis = {}
        log_step("analyze", "Skipping Gemini analysis")

    # ── Step 4: Apply results ───────────────────────────────
    log_step("apply", "Applying refinements…")

    # 4a — Ensure default speakers
    for w in adjusted_words:
        if "speaker" not in w:
            w["speaker"] = "SPEAKER_00"

    # 4a-bis — Optimized words (Hybrid mode using reference)
    optimized = analysis.get("optimized_words", [])
    if optimized:
        log_step("apply", f"Applying Optimized Text from source B (Hybrid Mode) for {len(optimized)} words")
        for item in optimized:
            idx = item.get("index")
            text = item.get("text")
            if isinstance(idx, int) and 0 <= idx < len(adjusted_words) and text:
                adjusted_words[idx]["text"] = text

    # We don't hide words anymore
    hidden_indices = []
    excluded_indices = set()

    # 4d — Groups (validate, fallback if needed)
    raw_groups = analysis.get("groups", [])
    log.debug("raw_groups length = %d", len(raw_groups))
    if raw_groups and len(raw_groups) > 0:
        log.debug("first raw_group = %s", raw_groups[0])

    validated_groups = _validate_groups(raw_groups, adjusted_words, excluded_indices)

    if validated_groups and do_grouping:
        groups = validated_groups
        log_step("apply", f"Using {len(groups)} Gemini-generated groups")
    else:
        groups = _fallback_groups(adjusted_words, excluded_indices)
        log_step("apply", f"Gemini groups invalid/skipped — using {len(groups)} auto-groups")

    # Attach timing to groups
    for g in groups:
        indices = g["word_indices"]
        gw = [adjusted_words[i] for i in indices if i < len(adjusted_words)]
        if gw:
            g["start"] = gw[0]["start"]
            g["end"] = gw[-1]["end"]
            if "speaker" not in g:
                g["speaker"] = gw[0].get("speaker", "SPEAKER_00")
        # Guarantee every group exposes a translation key. Fallback groups have
        # none; Gemini-generated groups already do. Empty string is the
        # contract for "no translation available" so the frontend never has to
        # null-check.
        if "translation" not in g:
            g["translation"] = ""

    # 4f — Speakers info
    seen_speakers = {w.get("speaker", "SPEAKER_00") for w in adjusted_words}
    speakers = {spk: spk.replace("_", " ").title() for spk in seen_speakers}

    elapsed = round(time.time() - t0, 1)
    log_step("done", f"Refine complete in {elapsed}s!")

    return {
        "video_filename": output_filename,
        "original_filename": video_path.name,
        "words": adjusted_words,
        "groups": groups,
        "speakers": speakers,
        "metadata": metadata,
        "processing_time_s": elapsed,
    }
