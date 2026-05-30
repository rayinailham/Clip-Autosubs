"""
Subtitle grouping + SRT export.

  - Group word-level transcripts into display lines (auto / custom / char+gap aware)
  - Tune on-screen timing (linger, anti-flash) without overlapping
  - Export grouped captions to SRT (Premiere-friendly)
"""

from pathlib import Path


def group_words(
    words: list,
    words_per_group: int = 4,
    max_chars: int = 0,
    gap_threshold: float = 0.0,
) -> list:
    """
    Group consecutive words into display chunks.
    Each group is shown on screen simultaneously,
    with only the active word highlighted.

    Char/gap aware:
      - words_per_group : soft cap on word count (always enforced)
      - max_chars       : if >0, start a new group when the rendered line
                          (words + single spaces) would exceed this many chars.
                          Prevents long words overflowing a vertical screen.
      - gap_threshold   : if >0, force a new group when the silence before a
                          word is >= this many seconds (don't span pauses).

    Defaults (max_chars=0, gap_threshold=0) reproduce fixed N-per-group chunking.
    """
    groups: list = []
    current: list = []  # list of (idx, word)

    def flush():
        nonlocal current
        if not current:
            return
        idxs = [c[0] for c in current]
        chunk = [c[1] for c in current]
        groups.append(
            {
                "words": chunk,
                "word_indices": idxs,
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
            }
        )
        current = []

    for i, w in enumerate(words):
        # 1) Pause split — never span a long silence
        if current and gap_threshold > 0:
            prev = current[-1][1]
            if w.get("start", 0) - prev.get("end", 0) >= gap_threshold:
                flush()
        # 2) Size split — word count or char width
        if current:
            count_after = len(current) + 1
            over_count = count_after > words_per_group
            over_chars = False
            if max_chars > 0:
                chars_after = sum(len(c[1].get("text", "")) for c in current)
                chars_after += len(w.get("text", "")) + (count_after - 1)  # + spaces
                over_chars = chars_after > max_chars
            if over_count or over_chars:
                flush()
        current.append((i, w))

    flush()
    return groups


def adjust_group_timing(
    groups: list,
    min_duration: float = 0.0,
    max_hold: float = 0.0,
) -> list:
    """
    Tune how long each group stays on screen, in place.

      - min_duration : group is shown at least this long (kills sub-flashes).
      - max_hold     : group lingers up to this many seconds AFTER its last
                       word ends, filling silence so the line doesn't vanish
                       the instant the talker stops.

    A group is never extended past the next group's start, so subtitles never
    overlap. `start` is left untouched; only `end` is pushed later.
    """
    if min_duration <= 0 and max_hold <= 0:
        return groups
    n = len(groups)
    for i, g in enumerate(groups):
        natural_end = g["end"]
        end = natural_end
        if min_duration > 0:
            end = max(end, g["start"] + min_duration)
        if max_hold > 0:
            end = max(end, natural_end + max_hold)
        if i + 1 < n:
            next_start = groups[i + 1]["start"]
            if next_start > g["start"]:
                end = min(end, next_start)
        g["end"] = end
    return groups


def build_custom_groups(words: list, custom_groups: list) -> list:
    """
    Build groups from custom group definitions.
    Each custom group specifies word_indices, start, and end times.
    """
    groups = []
    for cg in custom_groups:
        word_indices = cg.get("word_indices", [])
        chunk = [words[idx] for idx in word_indices if idx < len(words)]
        if not chunk:
            continue
        groups.append({
            "words": chunk,
            "word_indices": word_indices,
            "start": cg.get("start", chunk[0]["start"]),
            "end": cg.get("end", chunk[-1]["end"]),
            "translation": (cg.get("translation") or "").strip(),
            "speaker": cg.get("speaker"),
        })
    return groups


def format_srt_time(seconds: float) -> str:
    """Convert seconds to SRT time format HH:MM:SS,mmm."""
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = int(seconds % 60)
    ms = int(round((seconds - int(seconds)) * 1000))
    if ms >= 1000:
        ms = 0
        s += 1
    return f"{h:02d}:{m:02d}:{s:02d},{ms:03d}"


def generate_srt(
    words: list,
    words_per_group: int = 4,
    custom_groups: list = None,
    use_custom_groups: bool = False,
    uppercase: bool = False,
) -> str:
    """
    Generate plain SRT subtitle content (Premiere Pro compatible).

    One cue per group. No styling — Premiere imports timing+text and you
    style inside Premiere's Captions panel. Animations / per-word highlight /
    glow / position are not portable to SRT.

    Args:
        words: list of {text, start, end, ...}
        words_per_group: auto-grouping size when use_custom_groups is False
        custom_groups: list of {word_indices, start, end} when use_custom_groups
        use_custom_groups: if True, build cues from custom_groups
        uppercase: uppercase the cue text

    Returns:
        SRT file content as a string.
    """
    if not words:
        return ""

    if use_custom_groups and custom_groups:
        groups = build_custom_groups(words, custom_groups)
    else:
        groups = group_words(words, words_per_group)

    cues = []
    cue_idx = 0
    for group in groups:
        group_words_list = group.get("words") or []
        if not group_words_list:
            continue

        text = " ".join(w["text"] for w in group_words_list).strip()
        # Prefer the explicit caption text (translation / hand-edited line) when set,
        # mirroring what the burned video shows in static mode.
        tr = (group.get("translation") or "").strip()
        if tr:
            text = tr
        if not text:
            continue
        if uppercase:
            text = text.upper()

        start = float(group.get("start", group_words_list[0]["start"]))
        end = float(group.get("end", group_words_list[-1]["end"]))

        # Guard: SRT requires end > start
        if end <= start:
            end = start + 0.5

        # Guard: avoid overlap with next cue (Premiere accepts overlaps but
        # caption-track import can stack badly). Trim end to just before the
        # next group's start when needed.
        cues.append({
            "start": start,
            "end": end,
            "text": text,
        })

    # Sort + de-overlap (clamp each cue's end to next cue's start - 1ms)
    cues.sort(key=lambda c: c["start"])
    for i in range(len(cues) - 1):
        nxt = cues[i + 1]["start"]
        if cues[i]["end"] > nxt:
            cues[i]["end"] = max(cues[i]["start"] + 0.05, nxt - 0.001)

    out_lines = []
    for c in cues:
        cue_idx += 1
        out_lines.append(str(cue_idx))
        out_lines.append(f"{format_srt_time(c['start'])} --> {format_srt_time(c['end'])}")
        out_lines.append(c["text"])
        out_lines.append("")  # blank line between cues

    return "\n".join(out_lines).rstrip() + "\n"


def save_srt(content: str, output_path: str) -> str:
    """Save SRT subtitle content to a file (UTF-8 with BOM for Premiere)."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Premiere Pro reads UTF-8 with BOM most reliably for non-ASCII chars.
    with open(path, "w", encoding="utf-8-sig") as f:
        f.write(content)
    return str(path)
