import os
import json
import subprocess
import asyncio
from pathlib import Path

# Paths
BASE_DIR = Path(__file__).resolve().parent.parent
FRONTEND_DIR = BASE_DIR / "frontend"

def generate_subtitle_html(words, groups, style, width, height):
    """Generates a standalone HTML file that perfectly mimics the frontend subtitle rendering."""
    
    style_css_url = (FRONTEND_DIR / "style.css").resolve().as_uri()
    
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
    preview.style.letterSpacing = (s.letter_spacing || 0) + 'px';
    preview.style.wordSpacing = (s.word_gap || 0) * 4 + 'px';
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

    let lastGroupKey = null;

    window.seekTo = function(t) {{
      let activeGroup = null;
      for (const g of groupsList) {{
        if (t >= g.start && t <= g.end + 0.15) {{ activeGroup = g; break; }}
      }}
      if (!activeGroup) {{
        animWrapper.innerHTML = '';
        lastGroupKey = null;
        return;
      }}
      
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
            html = words.map((w, i) => `<span class="subtitle-word subtitle-anim-fade-in" style="${{baseStyle}}; padding-bottom:10px; --anim-speed:${{perWord}}ms; animation-delay:${{i * perWord}}ms">${{w}}</span>`).join(' ');
          }} else if (animName === 'cascade') {{
            const perWord = Math.max(60, Math.round(animSpeedMs / words.length));
            html = words.map((w, i) => `<span class="subtitle-word subtitle-anim-pop-in" style="${{baseStyle}}; padding-bottom:10px; --anim-speed:${{perWord}}ms; animation-delay:${{i * perWord}}ms">${{w}}</span>`).join(' ');
          }} else {{
            const animClass = animName !== 'none' ? 'subtitle-anim-' + animName : '';
            html = `<span class="subtitle-word ${{animClass}}" style="${{baseStyle}}; padding-bottom:10px; --anim-speed:${{animSpeedMs}}ms">${{sentence}}</span>`;
          }}
          animWrapper.innerHTML = html;
        }}
        return;
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
        
        return `<span class="subtitle-word" style="color:${{color}}; transform:${{scaleVal}}; ${{fs}}; font-style:${{fontStyle}}; font-weight:${{fontWeight}}; text-shadow:${{textShadow}}; padding-bottom: 20px;">${{text}}</span>`;
      }}).join(' ');
      
      // Update DOM
      if (animWrapper.dataset.last === activeGroup.start + "_" + activeIdx) return;
      animWrapper.innerHTML = html;
      animWrapper.dataset.last = activeGroup.start + "_" + activeIdx;
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
    
    fd, temp_html_path = tempfile.mkstemp(suffix=".html", text=True)
    with os.fdopen(fd, 'w', encoding='utf-8') as f:
        f.write(html_content)
        
    print(f"[html_renderer] HTML saved to {temp_html_path}")
    
    # We use FFmpeg to read images from stdin. We output 32-bit (rgba) to overlay seamlessly
    ffmpeg_cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-f", "image2pipe",
        "-vcodec", "png",
        "-r", str(fps),
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
    
    print(f"[html_renderer] Starting FFmpeg process...")
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
            
            total_frames = int(duration * fps)
            for f in range(total_frames):
                t = f / fps
                await page.evaluate(f"window.seekTo({t})")
                
                screenshot = await page.screenshot(type="png", omit_background=True)
                process.stdin.write(screenshot)
                
                pct = (f / total_frames) * 100
                if progress_callback and f % 5 == 0:
                    progress_callback(pct)
                if f % 300 == 0:
                    print(f"[html_renderer] Rendered {f}/{total_frames} frames ({pct:.1f}%)...")
            
            print(f"[html_renderer] Finished sending all {total_frames} frames to FFmpeg. (100.0%)")
            
            if progress_callback:
                progress_callback(100.0)
            
            await browser.close()
            
            print(f"[html_renderer] Playwright browser closed. Waiting for FFmpeg to finalize file...")
            # Close stdin so ffmpeg can finish
            process.stdin.close()
            process.wait()
            print(f"[html_renderer] FFmpeg finalized successfully.")
            
            if process.returncode != 0:
                with open(stderr_path, 'r', encoding='utf-8', errors='replace') as sf:
                    stderr_content = sf.read()
                print(f"[html_renderer] FFmpeg Error:\n{stderr_content[-1500:]}")
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
