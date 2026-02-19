"""
ASS Subtitle Generator — Hormozi-style dynamic captions.

Generates .ass subtitle files with word-level highlighting:
  - Words grouped into display chunks (automatic or custom groups)
  - Active word highlighted with different color + scale + animation
  - Per-word style overrides supported
  - Strong outline/shadow for readability
"""

from pathlib import Path


def format_ass_time(seconds: float) -> str:
    """Convert seconds to ASS time format H:MM:SS.cc (centiseconds)."""
    if seconds < 0:
        seconds = 0
    h = int(seconds // 3600)
    m = int((seconds % 3600) // 60)
    s = seconds % 60
    return f"{h}:{m:02d}:{s:05.2f}"


def group_words(words: list, words_per_group: int = 4) -> list:
    """
    Group consecutive words into display chunks.
    Each group is shown on screen simultaneously,
    with only the active word highlighted.
    """
    groups = []
    for i in range(0, len(words), words_per_group):
        chunk = words[i : i + words_per_group]
        if not chunk:
            continue
        groups.append(
            {
                "words": chunk,
                "word_indices": list(range(i, i + len(chunk))),
                "start": chunk[0]["start"],
                "end": chunk[-1]["end"],
            }
        )
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
        })
    return groups


def rgb_to_ass_color(rgb_hex: str) -> str:
    """
    Convert RGB hex string (e.g. 'FFD700') to ASS color format (&H00BBGGRR&).
    ASS uses BGR byte order.
    """
    rgb_hex = rgb_hex.lstrip("#")
    if len(rgb_hex) != 6:
        rgb_hex = "FFFFFF"
    r, g, b = rgb_hex[0:2], rgb_hex[2:4], rgb_hex[4:6]
    return f"&H00{b}{g}{r}&"


def get_animation_tags(animation: str, is_highlight: bool, scale: int) -> tuple[str, str]:
    """
    Return ASS override tags for animation effects.
    Returns (start_tags, end_tags).
    """
    if not is_highlight:
        return "", ""
    
    if animation == "scale":
        return f"\\fscx{scale}\\fscy{scale}", ""
    elif animation == "bounce":
        # Bounce effect using transform - move up slightly
        return f"\\fscx{scale}\\fscy{scale}\\fry-5", ""
    elif animation == "fade":
        # Fade doesn't change visually much in ASS, use subtle effect
        return f"\\fscx{scale}\\fscy{scale}", ""
    else:  # "none"
        return "", ""


def generate_ass(
    words: list,
    video_width: int = 1920,
    video_height: int = 1080,
    words_per_group: int = 4,
    custom_groups: list = None,
    use_custom_groups: bool = False,
    font_name: str = "Impact",
    font_size: int = 80,
    bold: bool = True,
    italic: bool = False,
    highlight_color: str = "FFD700",
    normal_color: str = "FFFFFF",
    outline_color: str = "000000",
    shadow_color: str = "000000",
    outline_width: int = 4,
    shadow_depth: int = 2,
    position: str = "bottom",
    margin_v: int = 60,
    margin_h: int = 10,
    letter_spacing: int = 0,
    word_gap: int = 0,
    scale_highlight: int = 115,
    animation: str = "scale",
    uppercase: bool = True,
) -> str:
    """
    Generate ASS subtitle content with word-level highlighting.

    For each word group, generates multiple dialogue events — one per word —
    where the active word is rendered in the highlight color and scaled up,
    while other words in the group are rendered in the normal color.
    
    Supports:
    - Custom word groups with user-defined timing
    - Per-word style overrides
    - Multiple animation types
    """
    if not words:
        return ""

    # ASS alignment: 1-3 bottom, 4-6 middle, 7-9 top (centered = 2, 5, 8)
    alignment_map = {"bottom": 2, "center": 5, "top": 8}
    alignment = alignment_map.get(position, 2)
    
    # Adjust margin for center position
    actual_margin_v = 0 if position == "center" else margin_v

    highlight_ass = rgb_to_ass_color(highlight_color)
    normal_ass = rgb_to_ass_color(normal_color)
    outline_ass = rgb_to_ass_color(outline_color)
    shadow_ass = rgb_to_ass_color(shadow_color) if shadow_color else "&H80000000&"
    
    # Bold/Italic flags for ASS: -1 = true, 0 = false
    bold_flag = -1 if bold else 0
    italic_flag = -1 if italic else 0

    header = (
        "[Script Info]\n"
        "Title: Dynamic Captions\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {video_width}\n"
        f"PlayResY: {video_height}\n"
        "WrapStyle: 0\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{font_size},{normal_ass},&H000000FF,"
        f"{outline_ass},{shadow_ass},{bold_flag},{italic_flag},0,0,100,100,{letter_spacing},0,1,"
        f"{outline_width},{shadow_depth},{alignment},{margin_h},{margin_h},{actual_margin_v},1\n"
        "\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, "
        "Effect, Text\n"
    )

    events = []
    
    # Build groups (either custom or automatic)
    if use_custom_groups and custom_groups:
        groups = build_custom_groups(words, custom_groups)
    else:
        groups = group_words(words, words_per_group)

    for group in groups:
        group_words_list = group["words"]
        group_start = group["start"]
        group_end = group["end"]

        for i, word in enumerate(group_words_list):
            # Word highlight timing (based on original word timestamps)
            word_start = word["start"]
            
            # End at next word's start (continuous display), or word's own end
            if i + 1 < len(group_words_list):
                word_end = group_words_list[i + 1]["start"]
            else:
                word_end = word["end"]

            # Ensure positive duration
            if word_end <= word_start:
                word_end = word_start + 0.15
                
            # Clamp to group bounds
            word_start = max(word_start, group_start)
            word_end = min(word_end, group_end)

            # Build text line with ASS override tags for highlighting
            parts = []
            for j, w in enumerate(group_words_list):
                text = w["text"].upper() if uppercase else w["text"]
                is_active = (j == i)
                
                # Get per-word style overrides
                word_style = w.get("style") or {}
                
                # Determine colors for this word
                if is_active:
                    word_color = word_style.get("highlight_color") or highlight_color
                else:
                    word_color = word_style.get("normal_color") or normal_color
                
                word_color_ass = rgb_to_ass_color(word_color)
                
                # Per-word font size
                word_font_size = word_style.get("font_size")
                word_font_name = word_style.get("font_name")
                word_bold = word_style.get("bold")
                word_italic = word_style.get("italic")
                word_outline_color = word_style.get("outline_color")
                word_outline_width = word_style.get("outline_width")
                word_scale = word_style.get("scale_highlight") or scale_highlight
                
                # Build override tags
                tags = [f"\\c{word_color_ass}"]
                
                if word_font_size is not None:
                    tags.append(f"\\fs{word_font_size}")
                if word_font_name is not None:
                    tags.append(f"\\fn{word_font_name}")
                if word_bold is not None:
                    tags.append(f"\\b{1 if word_bold else 0}")
                if word_italic is not None:
                    tags.append(f"\\i{1 if word_italic else 0}")
                if word_outline_color is not None:
                    tags.append(f"\\3c{rgb_to_ass_color(word_outline_color)}")
                if word_outline_width is not None:
                    tags.append(f"\\bord{word_outline_width}")
                
                # Animation for highlighted word
                if is_active:
                    anim_start, anim_end = get_animation_tags(animation, True, word_scale)
                    if anim_start:
                        tags.append(anim_start)
                
                tag_str = "".join(tags)
                parts.append(f"{{{tag_str}}}{text}{{\\r}}")

            # Join words with optional extra hard spaces for word gap
            hard_spaces = '\\h' * word_gap
            line_text = (' ' + hard_spaces).join(parts)
            start_str = format_ass_time(word_start)
            end_str = format_ass_time(word_end)

            events.append(
                f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,{line_text}"
            )

    return header + "\n".join(events) + "\n"


def save_ass(content: str, output_path: str) -> str:
    """Save ASS subtitle content to a file."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return str(path)
