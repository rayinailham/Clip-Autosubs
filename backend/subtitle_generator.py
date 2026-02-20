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
    elif animation == "color-only":
        # Just color change, no scaling
        return "", ""
    else:  # "none"
        return "", ""


def calculate_word_positions(
    words_text: list,
    font_size: int,
    video_width: int,
    video_height: int,
    margin_h: int,
    margin_v: int,
    position: str,
    word_gap: int,
    pos_x: int = 50,
    pos_y: int = 85,
) -> dict:
    """
    Calculate the absolute center (x, y) for each word in the group.

    Words are packed left-to-right into lines. Each word gets a FIXED center
    coordinate regardless of which word is currently highlighted, so the scale
    animation never shifts neighbouring words.

    Returns: dict mapping word_index -> (center_x, center_y)
    """
    # Approximate px width per uppercase character for Impact-style bold fonts.
    # Bold Impact uppercase averages ~0.72× font size; using a generous estimate
    # prevents individual words from overflowing the video edge (which causes
    # libass to wrap mid-word, splitting e.g. "MISSING" into "MISSIN" + "G").
    char_width = font_size * 0.72
    # Space between words (one normal space + optional extra hard-spaces)
    gap_width = char_width * (1 + word_gap * 0.6)
    available_width = video_width - margin_h * 2

    # --- pack words into lines (no highlight scale — layout is fixed) ---
    lines: list[list[tuple[int, float]]] = []  # each line = [(word_idx, word_px_width)]
    current_line: list[tuple[int, float]] = []
    current_width = 0.0

    for i, text in enumerate(words_text):
        w = len(text) * char_width
        needed = w if not current_line else gap_width + w
        if current_line and current_width + needed > available_width:
            lines.append(current_line)
            current_line = [(i, w)]
            current_width = w
        else:
            current_line.append((i, w))
            current_width += needed

    if current_line:
        lines.append(current_line)

    # --- calculate Y for each line ---
    line_height = font_size * 1.25  # vertical spacing between lines
    total_block_height = len(lines) * line_height

    # Use pos_x/pos_y percentage to place the block center
    center_x_px = int(video_width * pos_x / 100)
    center_y_px = int(video_height * pos_y / 100)
    block_top_y = center_y_px - total_block_height / 2

    # --- assign center (x, y) per word ---
    word_positions: dict[int, tuple[int, int]] = {}
    for line_idx, line in enumerate(lines):
        # center y of this line  (\an5 anchor = bounding-box center)
        line_center_y = block_top_y + line_idx * line_height + line_height / 2

        # total width of this line
        line_word_widths = [w for _, w in line]
        total_line_w = sum(line_word_widths) + gap_width * (len(line) - 1)
        x_start = center_x_px - total_line_w / 2

        cursor_x = x_start
        for word_idx, w in line:
            center_x = cursor_x + w / 2
            word_positions[word_idx] = (round(center_x), round(line_center_y))
            cursor_x += w + gap_width

    return word_positions


def generate_ass(
    words: list,
    video_width: int = 1920,
    video_height: int = 1080,
    words_per_group: int = 4,
    custom_groups: list = None,
    use_custom_groups: bool = False,
    dynamic_mode: bool = True,
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
    glow_strength: int = 0,
    glow_color: str = "FFD700",
    position: str = "bottom",
    margin_v: int = 60,
    margin_h: int = 10,
    letter_spacing: int = 0,
    word_gap: int = 0,
    pos_x: int = 50,
    pos_y: int = 85,
    scale_highlight: int = 100,
    animation: str = "color-only",
    group_animation: str = "none",
    anim_speed: int = 200,
    anim_intensity: int = 100,
    sentence_animation: str = "fade-in",
    static_anim_speed: int = 200,
    uppercase: bool = True,
) -> str:
    """
    Generate ASS subtitle content.
    
    If dynamic_mode is True: per-word highlighting with animations.
    If dynamic_mode is False: static sentence display (whole group shown at once).
    """
    if not words:
        return ""

    highlight_ass = rgb_to_ass_color(highlight_color)
    normal_ass = rgb_to_ass_color(normal_color)
    outline_ass = rgb_to_ass_color(outline_color)
    shadow_ass = rgb_to_ass_color(shadow_color) if shadow_color else "&H80000000&"

    # Bold/Italic flags for ASS: -1 = true, 0 = false
    bold_flag = -1 if bold else 0
    italic_flag = -1 if italic else 0

    # Style uses an2 (bottom-center) as fallback; events override with \an5\pos
    header = (
        "[Script Info]\n"
        "Title: Dynamic Captions\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {video_width}\n"
        f"PlayResY: {video_height}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n"
        "\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, "
        "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, "
        "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{font_size},{normal_ass},&H000000FF,"
        f"{outline_ass},{shadow_ass},{bold_flag},{italic_flag},0,0,100,100,{letter_spacing},0,1,"
        f"{outline_width},{shadow_depth},5,0,0,0,1\n"
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

    # ========== STATIC MODE: Simple sentence subtitles ==========
    if not dynamic_mode:
        # Pre-compute anchor position using pos_x/pos_y percentages
        cx_s = int(video_width * pos_x / 100)
        cy_s = int(video_height * pos_y / 100)

        for group in groups:
            group_words_list = group["words"]
            group_start = group["start"]
            group_end = group["end"]

            sentence = " ".join(
                w["text"].upper() if uppercase else w["text"]
                for w in group_words_list
            )

            start_str = format_ass_time(group_start)
            end_str   = format_ass_time(group_end)
            speed = static_anim_speed

            # Base color and glow tags (shared)
            normal_ass_s = rgb_to_ass_color(normal_color)

            def base_color_glow():
                t = [f"\\c{normal_ass_s}"]
                if glow_strength > 0:
                    t.append(f"\\blur{glow_strength // 2}")
                    t.append(f"\\4c{rgb_to_ass_color(glow_color)}")
                return t

            # ---- typewriter: word-by-word positioned reveal ----
            if sentence_animation == "typewriter":
                words_text_list = [
                    w["text"].upper() if uppercase else w["text"]
                    for w in group_words_list
                ]
                word_pos = calculate_word_positions(
                    words_text=words_text_list,
                    font_size=font_size,
                    video_width=video_width,
                    video_height=video_height,
                    margin_h=margin_h,
                    margin_v=margin_v,
                    position=position,
                    word_gap=word_gap,
                )
                total_words = max(len(words_text_list), 1)
                word_interval = min(speed / total_words / 1000.0, 0.1)
                for widx, word_text in enumerate(words_text_list):
                    wcx, wcy = word_pos.get(widx, (cx_s, cy_s))
                    word_appear = group_start + widx * word_interval
                    if word_appear >= group_end:
                        word_appear = group_start
                    w_tags = [f"\\q2\\an5\\pos({wcx},{wcy})\\c{normal_ass_s}"]
                    if glow_strength > 0:
                        w_tags.append(f"\\blur{glow_strength // 2}")
                        w_tags.append(f"\\4c{rgb_to_ass_color(glow_color)}")
                    w_tags.append("\\fad(40,0)")
                    w_tags_str = "".join(w_tags)
                    events.append(
                        f"Dialogue: 0,{format_ass_time(word_appear)},{end_str},Default,,0,0,0,,"
                        f"{{{w_tags_str}}}{word_text}"
                    )

            else:
                tags = [f"\\q2\\an5\\pos({cx_s},{cy_s})"]
                tags.extend(base_color_glow())

                if sentence_animation == "none":
                    pass

                elif sentence_animation == "fade-in":
                    tags.append(f"\\fad({speed},0)")

                elif sentence_animation == "pop-in":
                    tags.append(f"\\fscx0\\fscy0\\t(0,{speed},\\fscx100\\fscy100)")

                elif sentence_animation == "slide-up":
                    offset = font_size * anim_intensity // 100
                    tags = [
                        f"\\q2\\an5\\move({cx_s},{cy_s + offset},{cx_s},{cy_s},0,{speed})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]

                elif sentence_animation == "slide-down":
                    offset = font_size * anim_intensity // 100
                    tags = [
                        f"\\q2\\an5\\move({cx_s},{cy_s - offset},{cx_s},{cy_s},0,{speed})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]

                elif sentence_animation == "slide-left":
                    offset = (video_width // 3) * anim_intensity // 100
                    tags = [
                        f"\\q2\\an5\\move({cx_s - offset},{cy_s},{cx_s},{cy_s},0,{speed})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]

                elif sentence_animation == "slide-right":
                    offset = (video_width // 3) * anim_intensity // 100
                    tags = [
                        f"\\q2\\an5\\move({cx_s + offset},{cy_s},{cx_s},{cy_s},0,{speed})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]

                elif sentence_animation == "bounce":
                    # Drop from above then return to position (two-phase move via sequential events)
                    drop_offset = font_size * 2 * anim_intensity // 100
                    overshoot = (font_size // 3) * anim_intensity // 100
                    mid_t = int(speed * 0.65)
                    tags = [
                        f"\\q2\\an5\\move({cx_s},{cy_s - drop_offset},{cx_s},{cy_s + overshoot},0,{mid_t})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]
                    tags.append(f"\\fad({speed // 4},0)")
                    # First event: overshoot
                    tag_str = "".join(tags)
                    events.append(
                        f"Dialogue: 0,{start_str},{format_ass_time(group_start + mid_t / 1000.0)},Default,,0,0,0,,"
                        f"{{{tag_str}}}{sentence}"
                    )
                    # Second event: settle
                    settle_tags = [
                        f"\\q2\\an5\\move({cx_s},{cy_s + overshoot},{cx_s},{cy_s},0,{speed - mid_t})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]
                    settle_str = "".join(settle_tags)
                    events.append(
                        f"Dialogue: 0,{format_ass_time(group_start + mid_t / 1000.0)},{end_str},Default,,0,0,0,,"
                        f"{{{settle_str}}}{sentence}"
                    )
                    continue  # skip normal append below

                elif sentence_animation == "blur-in":
                    tags.append(f"\\blur20\\t(0,{speed},\\blur0)")

                elif sentence_animation == "stretch":
                    tags.append(f"\\fscx0\\fscy100\\t(0,{speed},\\fscx100\\fscy100)")

                elif sentence_animation == "zoom-drop":
                    offset = (font_size // 2) * anim_intensity // 100
                    zoom_amt = 100 + (30 * anim_intensity // 100)
                    tags = [
                        f"\\q2\\an5\\move({cx_s},{cy_s - offset},{cx_s},{cy_s},0,{speed})"
                        f"\\c{normal_ass_s}"
                    ] + base_color_glow()[1:]
                    tags.append(f"\\fscx{zoom_amt}\\fscy{zoom_amt}\\t(0,{speed},\\fscx100\\fscy100)")
                    tags.append(f"\\fad({speed // 2},0)")

                elif sentence_animation == "flip-in":
                    # Horizontal flip (flip around vertical axis = scale X from 0)
                    tags.append(f"\\fscx0\\t(0,{speed},\\fscx100)")
                    tags.append(f"\\fad({speed // 3},0)")

                elif sentence_animation == "cascade":
                    # Staggered pop-in per word (similar to typewriter but all pop in)
                    words_text_list = [
                        w["text"].upper() if uppercase else w["text"]
                        for w in group_words_list
                    ]
                    word_pos = calculate_word_positions(
                        words_text=words_text_list,
                        font_size=font_size,
                        video_width=video_width,
                        video_height=video_height,
                        margin_h=margin_h,
                        margin_v=margin_v,
                        position=position,
                        word_gap=word_gap,
                    )
                    total_words = max(len(words_text_list), 1)
                    stagger = speed / total_words / 1000.0
                    for widx, word_text in enumerate(words_text_list):
                        wcx, wcy = word_pos.get(widx, (cx_s, cy_s))
                        delay = int(widx * stagger * 1000)
                        w_tags = [f"\\q2\\an5\\pos({wcx},{wcy})\\c{normal_ass_s}"]
                        if glow_strength > 0:
                            w_tags.append(f"\\blur{glow_strength // 2}")
                            w_tags.append(f"\\4c{rgb_to_ass_color(glow_color)}")
                        pop_dur = max(80, speed // 3)
                        zoom_amt = 100 + (30 * anim_intensity // 100) if anim_intensity > 100 else 100
                        start_scale = max(0, 100 - anim_intensity)
                        w_tags.append(f"\\fscx{start_scale}\\fscy{start_scale}\\t({delay},{delay + pop_dur},\\fscx100\\fscy100)")
                        events.append(
                            f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,"
                            f"{{{''.join(w_tags)}}}{word_text}"
                        )
                    continue

                tag_str = "".join(tags)
                events.append(
                    f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,"
                    f"{{{tag_str}}}{sentence}"
                )

        return header + "\n".join(events) + "\n"

    # ========== DYNAMIC MODE: Per-word highlighting ==========
    for group in groups:
        group_words_list = group["words"]
        group_start = group["start"]
        group_end = group["end"]

        # --- Calculate fixed absolute center (x, y) for every word in the group ---
        words_text = [
            w["text"].upper() if uppercase else w["text"]
            for w in group_words_list
        ]
        word_positions = calculate_word_positions(
            words_text=words_text,
            font_size=font_size,
            video_width=video_width,
            video_height=video_height,
            margin_h=margin_h,
            margin_v=margin_v,
            position=position,
            word_gap=word_gap,
            pos_x=pos_x,
            pos_y=pos_y,
        )

        # --- Calculate group animation tags ---
        group_anim_duration = anim_speed  # milliseconds

        def get_group_anim_tags(group_animation: str, cx: int, cy: int, is_first_word: bool) -> str:
            """Generate ASS tags for group-level animations."""
            if group_animation == "none":
                return ""
            elif group_animation == "fade-in":
                return f"\\fad({group_anim_duration},0)"
            elif group_animation == "slide-up":
                offset = (font_size // 2) * anim_intensity // 100
                return f"\\move({cx},{cy + offset},{cx},{cy},0,{group_anim_duration})"
            elif group_animation == "slide-down":
                offset = (font_size // 2) * anim_intensity // 100
                return f"\\move({cx},{cy - offset},{cx},{cy},0,{group_anim_duration})"
            elif group_animation == "slide-left":
                offset = (video_width // 3) * anim_intensity // 100
                return f"\\move({cx - offset},{cy},{cx},{cy},0,{group_anim_duration})"
            elif group_animation == "slide-right":
                offset = (video_width // 3) * anim_intensity // 100
                return f"\\move({cx + offset},{cy},{cx},{cy},0,{group_anim_duration})"
            elif group_animation == "pop-in":
                start_scale = max(0, 100 - anim_intensity)
                return f"\\fscx{start_scale}\\fscy{start_scale}\\t(0,{group_anim_duration},\\fscx100\\fscy100)"
            elif group_animation == "bounce":
                offset = font_size * anim_intensity // 100
                return f"\\move({cx},{cy - offset},{cx},{cy},0,{group_anim_duration})"
            elif group_animation == "blur-in":
                blur_amt = 20 * anim_intensity // 100
                return f"\\blur{blur_amt}\\t(0,{group_anim_duration},\\blur0)"
            elif group_animation == "stretch":
                start_scale = max(0, 100 - anim_intensity)
                return f"\\fscx{start_scale}\\fscy100\\t(0,{group_anim_duration},\\fscx100\\fscy100)"
            elif group_animation == "zoom-drop":
                offset = (font_size // 2) * anim_intensity // 100
                zoom_amt = 100 + (30 * anim_intensity // 100)
                return (f"\\move({cx},{cy - offset},{cx},{cy},0,{group_anim_duration})"
                        f"\\fscx{zoom_amt}\\fscy{zoom_amt}\\t(0,{group_anim_duration},\\fscx100\\fscy100)"
                        f"\\fad({group_anim_duration // 2},0)")
            elif group_animation == "flip-in":
                return f"\\fscx0\\t(0,{group_anim_duration},\\fscx100)\\fad({group_anim_duration // 3},0)"
            elif group_animation == "typewriter":
                # Per-word reveal handled below; small fade for when word appears
                return f"\\fad(50,0)"
            return ""

        # --- For each highlight state (one per word), emit one Dialogue per word ---
        for i, active_word in enumerate(group_words_list):
            # Time window: this word is the highlighted one
            word_start = active_word["start"]
            if i + 1 < len(group_words_list):
                word_end = group_words_list[i + 1]["start"]
            else:
                word_end = active_word["end"]

            if word_end <= word_start:
                word_end = word_start + 0.15

            word_start = max(word_start, group_start)
            word_end = min(word_end, group_end)

            start_str = format_ass_time(word_start)
            end_str = format_ass_time(word_end)

            # Emit one Dialogue event per word in the group (all visible at the same time)
            for j, w in enumerate(group_words_list):
                # Typewriter: only words up to current active word are visible
                if group_animation == "typewriter" and j > i:
                    continue

                text = w["text"].upper() if uppercase else w["text"]
                is_active = (j == i)

                cx, cy = word_positions.get(j, (video_width // 2, video_height // 2))

                # Per-word style overrides
                word_style = w.get("style") or {}

                if is_active:
                    word_color = word_style.get("highlight_color") or highlight_color
                else:
                    word_color = word_style.get("normal_color") or normal_color

                word_color_ass = rgb_to_ass_color(word_color)

                word_font_size   = word_style.get("font_size")
                word_font_name   = word_style.get("font_name")
                word_bold        = word_style.get("bold")
                word_italic      = word_style.get("italic")
                word_outline_col = word_style.get("outline_color")
                word_outline_w   = word_style.get("outline_width")
                word_scale       = word_style.get("scale_highlight") or scale_highlight

                # Build base tags
                # For group animations that use \move, we skip the \pos tag
                _move_anims = ("slide-up", "slide-down", "slide-left", "slide-right",
                               "bounce", "zoom-drop")
                if group_animation in _move_anims and i == 0:
                    # Use \move for the first highlight window only
                    group_anim_tag = get_group_anim_tags(group_animation, cx, cy, j == 0)
                    if group_anim_tag and "\\move" in group_anim_tag:
                        tags = [f"\\q2\\an5{group_anim_tag}\\c{word_color_ass}"]
                    else:
                        tags = [f"\\q2\\an5\\pos({cx},{cy})\\c{word_color_ass}"]
                else:
                    tags = [f"\\q2\\an5\\pos({cx},{cy})\\c{word_color_ass}"]

                # Add glow effect (using blur in ASS)
                if glow_strength > 0:
                    glow_color_ass = rgb_to_ass_color(glow_color)
                    # Use shadow color for glow and blur for the effect
                    tags.append(f"\\blur{glow_strength // 2}")
                    tags.append(f"\\4c{glow_color_ass}")

                # Add group animation (fade, pop) if on first highlight window
                if i == 0:
                    group_anim_tag = get_group_anim_tags(group_animation, cx, cy, j == 0)
                    if group_anim_tag and "\\move" not in group_anim_tag:
                        tags.append(group_anim_tag)

                if word_font_size is not None:
                    tags.append(f"\\fs{word_font_size}")
                if word_font_name is not None:
                    tags.append(f"\\fn{word_font_name}")
                if word_bold is not None:
                    tags.append(f"\\b{1 if word_bold else 0}")
                if word_italic is not None:
                    tags.append(f"\\i{1 if word_italic else 0}")
                if word_outline_col is not None:
                    tags.append(f"\\3c{rgb_to_ass_color(word_outline_col)}")
                if word_outline_w is not None:
                    tags.append(f"\\bord{word_outline_w}")

                if is_active:
                    anim_start, _ = get_animation_tags(animation, True, word_scale)
                    if anim_start:
                        tags.append(anim_start)

                tag_str = "".join(tags)
                events.append(
                    f"Dialogue: 0,{start_str},{end_str},Default,,0,0,0,,"
                    f"{{{tag_str}}}{text}"
                )


    return header + "\n".join(events) + "\n"


def save_ass(content: str, output_path: str) -> str:
    """Save ASS subtitle content to a file."""
    path = Path(output_path)
    path.parent.mkdir(parents=True, exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        f.write(content)
    return str(path)
