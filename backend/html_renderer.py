import os
import json
import subprocess
import asyncio
from pathlib import Path

from logger import get_logger

log = get_logger("html_renderer")

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

def generate_subtitle_html(words, groups, style, width, height, speakers=None):
    """Generates a standalone HTML file that perfectly mimics the frontend subtitle rendering.

    `speakers` is the SpeakersConfig dict — { entries: { speaker_id: { ... } } }.
    Each enabled entry renders an avatar + dialog box at its configured pos_x/pos_y
    instead of using the global subtitle position.
    """

    style_css_url = (FRONTEND_DIR / "style.css").resolve().as_uri()
    speakers_json = json.dumps(speakers or {"entries": {}})
    # Avatars live under uploads/avatars/. Burned renders run via file:// in
    # Playwright, so we need an absolute file URI base instead of /avatars/.
    avatars_base = (BASE_DIR / "uploads" / "avatars").resolve().as_uri()
    
    # Provide the style object and the data
    html = f"""<!DOCTYPE html>
<html>
<head>
  <link rel="stylesheet" href="{style_css_url}">
  <style>
    body, html {{
      margin: 0;
      padding: 0;
      width: {width}px;
      height: {height}px;
      background: transparent !important;
      overflow: hidden;
    }}
    /* The video panel creates a specific DOM layout. We match it to use identical rules. */
    #mock-app {{
      width: 100%;
      height: 100%;
      position: relative;
    }}
    #video-container {{
      width: 100%;
      height: 100%;
      position: relative;
    }}
  </style>
</head>
<body style="background: transparent;">
  <div id="mock-app">
    <div class="video-panel" id="video-container" style="background: transparent;">
      <div class="subtitle-container" id="subtitle-box" style="width: 100%; height: 100%;">
          <div class="subtitle-overlay" id="subtitle-preview"></div>
      </div>
    </div>
  </div>

  <script>
    // Injected Data
    window.WORDS = {json.dumps(words)};
    window.GROUPS = {json.dumps(groups)};
    window.STYLE = {json.dumps(style)};
    window.SPEAKERS = {speakers_json};
    window.AVATARS_BASE = {json.dumps(avatars_base)};
    
    // We recreate VideoPanel.js logic inside this autonomous page
    const s = window.STYLE;
    const groupsList = window.GROUPS;
    const preview = document.getElementById('subtitle-preview');
    
    // Derived style values
    const upper = s.uppercase;
    const italic = s.italic;
    const bold = s.bold;
    const highlightColor = s.highlight_color && !s.highlight_color.startsWith('#') ? '#' + s.highlight_color : (s.highlight_color || '#FFD700');
    const textColor = s.normal_color && !s.normal_color.startsWith('#') ? '#' + s.normal_color : (s.normal_color || '#FFFFFF');
    const fontSizeASS = s.font_size || 80;
    const fontFamily = s.font_name || 'Impact';
    const scale = (s.scale_highlight || 115) / 100;
    const glowStrength = s.glow_strength || 0;
    const glowColor = s.glow_color && !s.glow_color.startsWith('#') ? '#' + s.glow_color : (s.glow_color || '#FFD700');
    const outlineColor = s.outline_color && !s.outline_color.startsWith('#') ? '#' + s.outline_color : (s.outline_color || '#000000');
    const outlineWidth = s.outline_width !== undefined ? s.outline_width : 4;
    const shadowDepth = s.shadow_depth || 0;
    const shadowColor = s.shadow_color && !s.shadow_color.startsWith('#') ? '#' + s.shadow_color : (s.shadow_color || '#000000');
    
    // Scaled dimensions (assuming rendered 1:1)
    const displayedHeight = {height};
    const actualHeight = {height};
    const scaledFontSize = (fontSizeASS * displayedHeight / actualHeight) + 'px';
    
    const ratio = displayedHeight / actualHeight;
    const scaledOutline = outlineWidth > 0 ? Math.max(1, Math.round(outlineWidth * ratio)) : 0;
    const scaledGlow = glowStrength > 0 ? Math.max(2, Math.round(glowStrength * ratio)) : 0;
    const scaledShadow = Math.max(1, Math.round(shadowDepth * ratio));
    
    let textShadowParts = [];
    if (outlineWidth > 0) {{
       const o = scaledOutline;
       if (o > 0) {{
         textShadowParts.push(
           `${{o}}px ${{o}}px 0 ${{outlineColor}}`, `-${{o}}px -${{o}}px 0 ${{outlineColor}}`,
           `${{o}}px -${{o}}px 0 ${{outlineColor}}`, `-${{o}}px ${{o}}px 0 ${{outlineColor}}`,
           `${{o}}px 0 0 ${{outlineColor}}`, `-${{o}}px 0 0 ${{outlineColor}}`,
           `0 ${{o}}px 0 ${{outlineColor}}`, `0 -${{o}}px 0 ${{outlineColor}}`
         );
       }}
    }}
    if (shadowDepth > 0) {{
      textShadowParts.push(`${{scaledShadow}}px ${{scaledShadow}}px ${{Math.max(scaledShadow, 2)}}px ${{shadowColor}}`);
    }}
    if (glowStrength > 0) {{
      textShadowParts.push(`0 0 ${{scaledGlow}}px ${{glowColor}}`, `0 0 ${{scaledGlow * 2}}px ${{glowColor}}`, `0 0 ${{scaledGlow * 3}}px ${{glowColor}}`);
    }}
    const textShadow = textShadowParts.join(', ');
    
    const posX = s.pos_x != null ? s.pos_x : 50;
    const posY = s.pos_y != null ? s.pos_y : 85;
    
    // Apply static styles
    preview.style.fontSize = scaledFontSize;
    preview.style.fontFamily = fontFamily + ', Impact, sans-serif';
    // Scale spacing by ratio (matches VideoPanel.js). ratio=1 here at full res.
    preview.style.letterSpacing = ((s.letter_spacing || 0) * ratio) + 'px';
    preview.style.wordSpacing = ((s.word_gap || 0) * 4 * ratio) + 'px';
    preview.style.fontWeight = bold ? 'bold' : 'normal';
    const fontStyle = italic ? 'italic' : 'normal';
    const fontWeight = bold ? 'bold' : 'normal';
    
    let posWrapper = document.getElementById('subtitle-pos-wrapper');
    if (!posWrapper) {{
      posWrapper = document.createElement('div');
      posWrapper.id = 'subtitle-pos-wrapper';
      posWrapper.style.position = 'absolute';
      posWrapper.style.textAlign = 'center';
      posWrapper.style.whiteSpace = 'normal';
      posWrapper.style.wordBreak = 'break-word';
      posWrapper.style.width = 'max-content';
      posWrapper.style.maxWidth = '90%';
      preview.appendChild(posWrapper);
    }}
    posWrapper.style.left = posX + '%';
    posWrapper.style.top = posY + '%';
    posWrapper.style.transform = 'translate(-50%, -50%)';

    let animWrapper = document.createElement('div');
    animWrapper.id = 'subtitle-anim-wrapper';
    posWrapper.appendChild(animWrapper);

    // ── Speaker avatar+box layout ────────────────────────────
    const SPK = (window.SPEAKERS && window.SPEAKERS.entries) || {{}};
    const REF_HEIGHT = 1080;
    const refRatio = displayedHeight / REF_HEIGHT;
    let avatarEl = null;
    let lastSpeakerId = null;

    function ensureAvatar() {{
      if (avatarEl) return avatarEl;
      avatarEl = document.createElement('img');
      avatarEl.id = 'subtitle-speaker-avatar';
      avatarEl.style.borderRadius = '50%';
      avatarEl.style.objectFit = 'cover';
      avatarEl.style.flexShrink = '0';
      avatarEl.style.display = 'block';
      return avatarEl;
    }}

    function hexToCss(c, fallback) {{
      if (!c) return fallback;
      return c.startsWith('#') ? c : '#' + c;
    }}

    function applySpeakerLayout(speakerId) {{
      if (speakerId === lastSpeakerId) return;
      lastSpeakerId = speakerId;
      const cfg = speakerId ? SPK[speakerId] : null;
      const enabled = cfg && cfg.enabled;
      if (enabled) {{
        const px = cfg.pos_x != null ? cfg.pos_x : 50;
        const py = cfg.pos_y != null ? cfg.pos_y : 85;
        posWrapper.style.left = px + '%';
        posWrapper.style.top = py + '%';
        posWrapper.style.transform = 'translate(-50%, -50%)';
        const bgHex = hexToCss(cfg.bg_color, '#FFFFFF');
        const alpha = cfg.bg_alpha != null ? cfg.bg_alpha : 0.92;
        const bdHex = hexToCss(cfg.border_color, '#000000');
        const bdW = cfg.border_width || 0;
        const scaleK = cfg.box_scale || 1.0;
        const padPx = Math.round(20 * refRatio * scaleK);
        const radiusPx = Math.round(28 * refRatio * scaleK);
        const gapPx = Math.round(16 * refRatio * scaleK);
        // Convert hex bg to rgba w/ alpha
        const r = parseInt(bgHex.slice(1, 3), 16) || 255;
        const g = parseInt(bgHex.slice(3, 5), 16) || 255;
        const b = parseInt(bgHex.slice(5, 7), 16) || 255;
        posWrapper.style.background = 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
        posWrapper.style.border = bdW > 0 ? (Math.round(bdW * refRatio) + 'px solid ' + bdHex) : 'none';
        posWrapper.style.borderRadius = radiusPx + 'px';
        posWrapper.style.padding = padPx + 'px ' + Math.round(padPx * 1.2) + 'px';
        posWrapper.style.display = 'flex';
        posWrapper.style.alignItems = 'center';
        posWrapper.style.gap = gapPx + 'px';
        posWrapper.style.maxWidth = '70%';
        posWrapper.style.boxShadow = '0 ' + Math.round(8 * refRatio) + 'px ' + Math.round(28 * refRatio) + 'px rgba(0,0,0,0.35)';
        // Avatar
        const av = ensureAvatar();
        const avSize = Math.round((cfg.avatar_size || 120) * refRatio);
        av.style.width = avSize + 'px';
        av.style.height = avSize + 'px';
        av.style.border = Math.max(2, Math.round(3 * refRatio)) + 'px solid ' + bgHex;
        if (cfg.avatar) {{
          const url = (window.AVATARS_BASE || '/avatars') + '/' + cfg.avatar;
          if (av.getAttribute('data-src') !== url) {{
            av.setAttribute('data-src', url);
            av.src = url;
          }}
          if (av.parentElement !== posWrapper) {{
            posWrapper.insertBefore(av, posWrapper.firstChild);
          }}
        }} else if (av.parentElement) {{
          av.parentElement.removeChild(av);
        }}
        // Override text color to speaker text color
        const tc = hexToCss(cfg.text_color, '#111111');
        animWrapper.style.color = tc;
        animWrapper.style.flex = '1 1 auto';
      }} else {{
        // Reset to global subtitle layout
        posWrapper.style.left = posX + '%';
        posWrapper.style.top = posY + '%';
        posWrapper.style.transform = 'translate(-50%, -50%)';
        posWrapper.style.background = '';
        posWrapper.style.border = '';
        posWrapper.style.borderRadius = '';
        posWrapper.style.padding = '';
        posWrapper.style.display = '';
        posWrapper.style.alignItems = '';
        posWrapper.style.gap = '';
        posWrapper.style.maxWidth = '90%';
        posWrapper.style.boxShadow = '';
        animWrapper.style.color = '';
        animWrapper.style.flex = '';
        if (avatarEl && avatarEl.parentElement) avatarEl.parentElement.removeChild(avatarEl);
      }}
    }}

    let lastGroupKey = null;

    window.ANIM_MS = Math.max(s.anim_speed || 200, s.static_anim_speed || 300);

    window.seekTo = function(t) {{
      let activeGroup = null;
      for (const g of groupsList) {{
        if (t >= g.start && t <= g.end + 0.15) {{ activeGroup = g; break; }}
      }}
      if (!activeGroup) {{
        applySpeakerLayout(null);
        if (lastGroupKey === null && animWrapper.innerHTML === '') return false;
        animWrapper.innerHTML = '';
        lastGroupKey = null;
        animWrapper.dataset.last = '';
        return "frame";
      }}

      // Apply speaker-specific layout (avatar + dialog box) if configured.
      // Falls back to the global subtitle layout when speaker is null/disabled.
      applySpeakerLayout(activeGroup.speaker || null);
      
      let activeIdx = -1;
      for (let i = 0; i < activeGroup.words.length; i++) {{
        if (t >= activeGroup.words[i].start && t <= activeGroup.words[i].end) {{ activeIdx = i; break; }}
      }}
      if (activeIdx === -1) {{
        for (let i = activeGroup.words.length - 1; i >= 0; i--) {{
          if (t >= activeGroup.words[i].start) {{ activeIdx = i; break; }}
        }}
      }}
      
      const isDynamic = s.dynamic_mode !== false;
      const groupKey = activeGroup.start + '_' + activeGroup.end;
      const isNewGroup = groupKey !== lastGroupKey;
      
      if (!isDynamic) {{
        if (!isNewGroup) return false;
        if (isNewGroup) {{
          lastGroupKey = groupKey;
          const words = activeGroup.words.map(w => upper ? w.text.toUpperCase() : w.text);
          const sentence = words.join(' ');
          const animName = s.sentence_animation || 'none';
          const animSpeedMs = s.static_anim_speed || 300;
          const baseStyle = `color:${{textColor}}; font-style:${{fontStyle}}; font-weight:${{fontWeight}}; text-shadow:${{textShadow}}; --anim-intensity:${{s.anim_intensity/100||1}}`;
          let html = '';
          if (animName === 'typewriter') {{
            const perWord = Math.max(80, Math.round(animSpeedMs / words.length));
            html = words.map((w, i) => `<span class="subtitle-word subtitle-anim-fade-in" style="${{baseStyle}}; --anim-speed:${{perWord}}ms; animation-delay:${{i * perWord}}ms">${{w}}</span>`).join(' ');
          }} else if (animName === 'cascade') {{
            const perWord = Math.max(60, Math.round(animSpeedMs / words.length));
            html = words.map((w, i) => `<span class="subtitle-word subtitle-anim-pop-in" style="${{baseStyle}}; --anim-speed:${{perWord}}ms; animation-delay:${{i * perWord}}ms">${{w}}</span>`).join(' ');
          }} else {{
            const animClass = animName !== 'none' ? 'subtitle-anim-' + animName : '';
            html = `<span class="subtitle-word ${{animClass}}" style="${{baseStyle}}; --anim-speed:${{animSpeedMs}}ms">${{sentence}}</span>`;
          }}
          animWrapper.innerHTML = html;
          return "frame";
        }}
        return false;
      }}

      // Dynamic Mode Loop
      if (isNewGroup) {{
        lastGroupKey = groupKey;
        const groupAnim = (s.group_animation === 'typewriter') ? 'slide-up' : (s.group_animation === 'cascade') ? 'pop-in' : (s.group_animation || 'none');
        animWrapper.className = ''; 
        void animWrapper.offsetWidth;
        if (groupAnim !== 'none') {{
          animWrapper.style.setProperty('--anim-speed', (s.anim_speed || 200) + 'ms');
          animWrapper.style.setProperty('--anim-intensity', ((s.anim_intensity || 100) / 100).toString());
          animWrapper.classList.add('subtitle-anim-' + groupAnim);
        }}
      }}
      
      const html = activeGroup.words.map((w, i) => {{
        const text = upper ? w.text.toUpperCase() : w.text;
        const isActive = i === activeIdx;
        const ws = w.style || {{}};
        
        let hlCol = highlightColor;
        let noCol = textColor;
        if (ws.highlight_color) hlCol = '#' + ws.highlight_color;
        if (ws.normal_color) noCol = '#' + ws.normal_color;
        
        let color = isActive ? hlCol : noCol;
        const scaleVal = isActive ? `scale(${{scale}})` : 'scale(1)';
        const fs = ws.font_size ? `font-size:${{Math.round(ws.font_size * displayedHeight / actualHeight)}}px;` : '';
        
        return `<span class="subtitle-word" style="color:${{color}}; transform:${{scaleVal}}; ${{fs}}; font-style:${{fontStyle}}; font-weight:${{fontWeight}}; text-shadow:${{textShadow}};">${{text}}</span>`;
      }}).join(' ');
      
      // Update DOM
      const stateKey = activeGroup.start + "_" + activeIdx;
      if (animWrapper.dataset.last === stateKey && !isNewGroup) return false;
      animWrapper.innerHTML = html;
      animWrapper.dataset.last = stateKey;
      return isNewGroup ? "frame" : true;
    }};
    
    // Disable CSS animations infinite looping or pausing issues if any. Wait for fonts.
    document.fonts.ready.then(() => {{ window.fontsLoaded = true; }});
  </script>
</body>
</html>
"""
    return html


async def render_html_sequence_to_video(html_content: str, video_path: str, output_path: str, duration: float, width: int, height: int, fps: int = 60, crf: int = 18, progress_callback=None):
    from playwright.async_api import async_playwright
    import tempfile

    # Capture at half the output rate; ffmpeg duplicates frames to reach output fps.
    # Subtitles are static between word changes, so 30fps capture is visually identical to 60fps.
    capture_fps = max(15, fps // 2)

    fd, temp_html_path = tempfile.mkstemp(suffix=".html", text=True)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(html_content)
        
    log.info("HTML saved to %s", temp_html_path)
    log.info("capture_fps=%d output_fps=%d", capture_fps, fps)
    
    # We use FFmpeg to read images from stdin. We output 32-bit (rgba) to overlay seamlessly
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-f", "image2pipe",
        "-vcodec", "png",
        "-r", str(capture_fps),
        "-i", "-", # stdin
        # Use shortest=1 to guarantee FFmpeg terminates when input ends
        "-filter_complex", "[0:v][1:v]overlay=0:0:shortest=1[out]",
        "-map", "[out]",
        "-map", "0:a?",
        "-c:v", "h264_nvenc",
        "-cq", str(crf),
        "-c:a", "copy",
        "-r", str(fps),
        "-movflags", "+faststart",
        str(output_path)
    ]
    
    log.info("Starting FFmpeg process…")
    # Use a file for stderr to prevent OS pipe deadlocks since we are writing to stdin
    stderr_fd, stderr_path = tempfile.mkstemp(suffix=".log", text=True)
    
    process = subprocess.Popen(ffmpeg_cmd, stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=stderr_fd)
    
    try:
        async with async_playwright() as p:
            browser = await p.chromium.launch(args=["--disable-web-security", "--disable-features=IsolateOrigins,site-per-process"])
            page = await browser.new_page(
                viewport={"width": width, "height": height},
                device_scale_factor=1,
                has_touch=False
            )
            
            # Navigate to the HTML
            url = f"file://{Path(temp_html_path).resolve().as_posix()}"
            await page.goto(url)
            await page.wait_for_function("window.fontsLoaded === true", timeout=10000)
            
            # Optionally wait a tiny bit for the page to settle
            await page.evaluate("document.body.style.background = 'transparent'; document.documentElement.style.background = 'transparent';")
            
            anim_ms = await page.evaluate("window.ANIM_MS || 200")
            anim_window_s = (anim_ms + 50) / 1000.0  # small safety margin

            total_frames = int(duration * capture_fps)
            last_screenshot = None
            reused = 0
            force_until = -1.0
            for f in range(total_frames):
                t = f / capture_fps
                changed = await page.evaluate(f"window.seekTo({t})")

                # "frame" return = group/sentence transition started → force-capture during anim window
                if changed == "frame":
                    force_until = t + anim_window_s

                must_capture = bool(changed) or last_screenshot is None or t < force_until

                if must_capture:
                    screenshot = await page.screenshot(type="png", omit_background=True)
                    last_screenshot = screenshot
                else:
                    screenshot = last_screenshot
                    reused += 1

                process.stdin.write(screenshot)

                pct = (f / total_frames) * 100
                if progress_callback and f % 5 == 0:
                    progress_callback(pct)
                if f % 150 == 0:
                    log.info("Rendered %d/%d frames (%.1f%%) — reused=%d",
                             f, total_frames, pct, reused)

            log.info(
                "Finished sending all %d frames to FFmpeg (100.0%%) — reused=%d/%d (%.1f%%)",
                total_frames, reused, total_frames,
                reused * 100 / max(1, total_frames),
            )

            if progress_callback:
                progress_callback(100.0)

            await browser.close()

            log.info("Playwright browser closed. Waiting for FFmpeg to finalize file…")
            # Close stdin so ffmpeg can finish
            process.stdin.close()
            process.wait()
            log.info("FFmpeg finalized successfully.")
            
            if process.returncode != 0:
                with open(stderr_path, 'r', encoding='utf-8', errors='replace') as sf:
                    stderr_content = sf.read()
                log.error("FFmpeg Error:\n%s", stderr_content[-1500:])
                raise RuntimeError("FFmpeg crashed during piped rendering.")
            
    finally:
        if not process.stdin.closed:
            process.stdin.close()
        process.wait()
        os.close(stderr_fd)
        try:
            os.unlink(temp_html_path)
        except OSError:
            pass
        try:
            os.unlink(stderr_path)
        except OSError:
            pass
