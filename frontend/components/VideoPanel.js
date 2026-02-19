import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import store, { getActiveGroups, getSegments } from '../store.js';
import { videoURL } from '../api.js';

export default {
  name: 'VideoPanel',
  setup() {
    const videoEl = ref(null);
    let timeUpdateHandler = null;
    let lastGroupKey = null;  // track group changes for entrance animations
    let groupEntryTime = 0;   // timestamp of last group change

    function onTimeUpdate() {
      if (!videoEl.value) return;
      const v = videoEl.value;
      const t = v.currentTime;

      // ── Skip removed segments during playback ──────────────────
      if (store.splitPoints.length > 0 && !v.paused) {
        const dur = v.duration || 0;
        if (dur > 0) {
          const segs = getSegments(dur);
          // Check if current time is inside a removed segment
          for (const seg of segs) {
            if (!seg.active && t >= seg.start && t < seg.end - 0.05) {
              // Find the next active segment after this one
              const nextActive = segs.find(s => s.active && s.start >= seg.start);
              if (nextActive) {
                v.currentTime = nextActive.start;
              } else {
                // No more active segments — pause at the end
                v.pause();
              }
              return;
            }
          }
        }
      }
      const s = store.style;
      const upper = s.uppercase;
      const italic = s.italic;
      const bold = s.bold;
      const highlightColor = s.highlight;
      const textColor = s.textColor;
      const fontSizeASS = s.fontSize || 80;
      const fontFamily = s.fontFamily;
      const scale = s.scale / 100;
      const glowStrength = s.glow || 0;
      const glowColor = s.glowColor;
      const outlineColor = s.outlineColor;
      const outlineWidth = (s.outline !== undefined) ? s.outline : 4;
      const groups = getActiveGroups();

      const ve = videoEl.value;
      const displayedHeight = ve.clientHeight || ve.offsetHeight || 1;
      const actualHeight = ve.videoHeight || store.metadata.height || 1080;
      const scaledFontSize = (fontSizeASS * displayedHeight / actualHeight) + 'px';

      const shadowDepth = s.shadow || 0;
      const shadowColor = s.shadowColor || '#000000';

      /* 
         Fix for outline/glow visibility:
         1. Ensure we don't default s.outline=0 to 4.
         2. Ensure scaled values are substantial enough to be seen.
            We'll use a minimum of 0 so we can turn it off, but if >0, we scale it.
            We shouldn't divide by 2 aggressively if user wants thick outline.
      */
      const ratio = displayedHeight / actualHeight;
      const scaledOutline = outlineWidth > 0 ? Math.max(1, Math.round(outlineWidth * ratio)) : 0;
      const scaledGlow = glowStrength > 0 ? Math.max(2, Math.round(glowStrength * ratio)) : 0;
      const scaledShadow = Math.max(1, Math.round(shadowDepth * ratio));

      let textShadowParts = [];
      
      // 4-direction hard outline (only if size > 0)
      if (outlineWidth > 0) {
         // Create outline using multiple shadows to ensure thickness
         // For a thick outline, we might need more passes or offsets.
         // Current simple implementation: 4 corners.
         // If scaledOutline is large (e.g. >2), 4 corners might leave gaps.
         // But for now let's stick to 4 corners.
         const o = scaledOutline;
         if (o > 0) {
             textShadowParts.push(
               `${o}px ${o}px 0 ${outlineColor}`,
               `-${o}px -${o}px 0 ${outlineColor}`,
               `${o}px -${o}px 0 ${outlineColor}`,
               `-${o}px ${o}px 0 ${outlineColor}`,
               // Add cardinal points for better coverage if > 1px
               // This helps avoid gaps in corners if outline is thick
               `${o}px 0 0 ${outlineColor}`,
               `-${o}px 0 0 ${outlineColor}`,
               `0 ${o}px 0 ${outlineColor}`,
               `0 -${o}px 0 ${outlineColor}`
             );
         }
      }

      // Drop shadow - ensure it's distinct
      if (shadowDepth > 0) {
        textShadowParts.push(`${scaledShadow}px ${scaledShadow}px ${Math.max(scaledShadow, 2)}px ${shadowColor}`);
      }

      // Glow - ensure it's strong enough and layered correctly
      if (glowStrength > 0) {
        // Double up layer for intensity
        textShadowParts.push(
            `0 0 ${scaledGlow}px ${glowColor}`, 
            `0 0 ${scaledGlow * 2}px ${glowColor}`,
            `0 0 ${scaledGlow * 3}px ${glowColor}`
        );
      }

      const textShadow = textShadowParts.join(', ');

      // Find active group
      let activeGroup = null;
      for (const g of groups) {
        if (t >= g.start && t <= g.end + 0.15) { activeGroup = g; break; }
      }

      const preview = document.getElementById('subtitle-preview');
      if (!preview) return;

      // Margin
      const marginVASS = s.marginV || 60;
      const marginHASS = s.marginH || 10;
      const scaledMarginV = Math.round(marginVASS * displayedHeight / actualHeight);
      const actualWidth = ve.videoWidth || store.metadata.width || 1920;
      const displayedWidth = ve.clientWidth || ve.offsetWidth || 1;
      const scaledMarginH = Math.round(marginHASS * displayedWidth / actualWidth);

      // Reset padding
      preview.style.paddingBottom = '';
      preview.style.paddingTop = '';
      preview.style.paddingLeft = scaledMarginH + 'px';
      preview.style.paddingRight = scaledMarginH + 'px';
      if (s.position === 'bottom') preview.style.paddingBottom = scaledMarginV + 'px';
      else if (s.position === 'top') preview.style.paddingTop = scaledMarginV + 'px';

      if (!activeGroup) {
        preview.innerHTML = '';
        lastGroupKey = null;
        document.querySelectorAll('.word-chip.playing').forEach(el => el.classList.remove('playing'));
        return;
      }

      // Active word
      let activeIdx = -1;
      for (let i = 0; i < activeGroup.words.length; i++) {
        if (t >= activeGroup.words[i].start && t <= activeGroup.words[i].end) { activeIdx = i; break; }
      }
      if (activeIdx === -1) {
        for (let i = activeGroup.words.length - 1; i >= 0; i--) {
          if (t >= activeGroup.words[i].start) { activeIdx = i; break; }
        }
      }

      preview.style.fontSize = scaledFontSize;
      preview.style.fontFamily = fontFamily + ', Impact, sans-serif';
      preview.style.letterSpacing = (s.letterSpacing || 0) + 'px';
      preview.style.wordSpacing = (s.wordGap || 0) * 4 + 'px';
      preview.style.fontWeight = bold ? 'bold' : 'normal';
      // We apply textShadow and fontStyle directly to spans below to ensure they work
      // preview.style.textShadow = textShadow; 

      const fontStyle = italic ? 'italic' : 'normal';
      const fontWeight = bold ? 'bold' : 'normal';

      // ── All animation class names so we can clean them off the container ──
      const ALL_ANIM_CLASSES = [
        'subtitle-anim-fade-in','subtitle-anim-slide-up','subtitle-anim-slide-down',
        'subtitle-anim-slide-left','subtitle-anim-slide-right','subtitle-anim-pop-in',
        'subtitle-anim-bounce','subtitle-anim-blur-in','subtitle-anim-stretch',
        'subtitle-anim-zoom-drop','subtitle-anim-flip-in',
      ];

      // Static mode
      if (!store.useDynamicMode) {
        const groupKey = activeGroup.start + '_' + activeGroup.end;
        if (groupKey !== lastGroupKey) {
          lastGroupKey = groupKey;
          const words = activeGroup.words.map(w => upper ? w.text.toUpperCase() : w.text);
          const sentence = words.join(' ');
          const animName = store.style.sentenceAnimation || 'none';
          const animSpeedMs = store.style.staticAnimSpeed || 300;
          const animSpeed = animSpeedMs + 'ms';
          const baseStyle = `color:${textColor}; font-style:${fontStyle}; font-weight:${fontWeight}; text-shadow:${textShadow}`;

          if (animName === 'typewriter') {
            // Reveal each word with a fast fade, staggered across the animSpeed window
            const perWord = Math.max(80, Math.round(animSpeedMs / words.length));
            preview.innerHTML = words.map((word, i) =>
              `<span class="subtitle-word subtitle-anim-fade-in" style="${baseStyle}; --anim-speed:${perWord}ms; animation-delay:${i * perWord}ms">${word}</span>`
            ).join(' ');
          } else if (animName === 'cascade') {
            // Staggered pop-in per word
            const perWord = Math.max(60, Math.round(animSpeedMs / words.length));
            preview.innerHTML = words.map((word, i) =>
              `<span class="subtitle-word subtitle-anim-pop-in" style="${baseStyle}; --anim-speed:${perWord}ms; animation-delay:${i * perWord}ms">${word}</span>`
            ).join(' ');
          } else {
            const animClass = animName !== 'none' ? ' subtitle-anim-' + animName : '';
            preview.innerHTML = `<span class="subtitle-word${animClass}" style="${baseStyle}; --anim-speed:${animSpeed}">${sentence}</span>`;
          }
        }
        document.querySelectorAll('.word-chip.playing').forEach(el => el.classList.remove('playing'));
        return;
      }

      // Dynamic mode — track group changes for entrance animations
      const dynamicGroupKey = activeGroup.start + '_' + activeGroup.end;
      const isNewGroup = dynamicGroupKey !== lastGroupKey;
      if (isNewGroup) {
        lastGroupKey = dynamicGroupKey;
        groupEntryTime = performance.now();
        const rawAnim = store.style.groupAnimation || 'none';
        // typewriter / cascade don't work per-span in dynamic mode since innerHTML
        // is rebuilt every frame — map them to sensible container equivalents
        const groupAnim = rawAnim === 'typewriter' ? 'slide-up'
                        : rawAnim === 'cascade'    ? 'pop-in'
                        : rawAnim;
        ALL_ANIM_CLASSES.forEach(c => preview.classList.remove(c));
        void preview.offsetWidth; // force reflow to restart animation
        if (groupAnim !== 'none') {
          preview.style.setProperty('--anim-speed', (store.style.animSpeed || 200) + 'ms');
          preview.classList.add('subtitle-anim-' + groupAnim);
        }
      }

      // Dynamic mode
      preview.innerHTML = activeGroup.words.map((w, i) => {
        const text = upper ? w.text.toUpperCase() : w.text;
        const isActive = i === activeIdx;
        const ws = w.style || {};
        let color = isActive
          ? (ws.highlight_color ? '#' + ws.highlight_color : highlightColor)
          : (ws.normal_color ? '#' + ws.normal_color : textColor);
        const scaleVal = isActive ? 'scale(' + scale + ')' : 'scale(1)';
        const fs = ws.font_size ? 'font-size:' + Math.round(ws.font_size * displayedHeight / actualHeight) + 'px;' : '';
        return '<span class="subtitle-word" style="color:' + color + '; transform:' + scaleVal + '; ' + fs + '; font-style:' + fontStyle + '; font-weight:' + fontWeight + '; text-shadow:' + textShadow + '">' + text + '</span>';
      }).join(' ');

      // Highlight playing word in transcript
      document.querySelectorAll('.word-chip.playing').forEach(el => el.classList.remove('playing'));
      if (activeIdx >= 0) {
        const globalIdx = store.words.indexOf(activeGroup.words[activeIdx]);
        const chip = document.querySelector('.word-chip[data-index="' + globalIdx + '"]');
        if (chip) {
          chip.classList.add('playing');
          const wordList = document.getElementById('word-list');
          if (wordList) {
            const chipTop = chip.offsetTop - wordList.offsetTop;
            const chipBottom = chipTop + chip.offsetHeight;
            const scrollTop = wordList.scrollTop;
            const scrollBottom = scrollTop + wordList.clientHeight;
            if (chipTop < scrollTop) wordList.scrollTop = chipTop;
            else if (chipBottom > scrollBottom) wordList.scrollTop = chipBottom - wordList.clientHeight;
          }
        }
      }
    }

    // Set video source whenever the editor opens
    watch(() => store.currentView, (v) => {
      if (v === 'editor' && videoEl.value) {
        videoEl.value.src = videoURL(store.videoFilename);
        videoEl.value.load();
      }
    });

    // Reload video when the filename changes (e.g. after silence cutting)
    watch(() => store.videoFilename, (filename) => {
      if (filename && videoEl.value && store.currentView === 'editor') {
        videoEl.value.src = videoURL(filename);
        videoEl.value.load();
      }
    });

    // Reset group key so the first group re-animates after a mode switch
    watch(() => store.useDynamicMode, () => { lastGroupKey = null; });

    onMounted(() => {
      if (videoEl.value) {
        timeUpdateHandler = onTimeUpdate;
        videoEl.value.addEventListener('timeupdate', timeUpdateHandler);
        if (store.currentView === 'editor') {
          videoEl.value.src = videoURL(store.videoFilename);
          videoEl.value.load();
        }
      }
    });

    onBeforeUnmount(() => {
      if (videoEl.value && timeUpdateHandler) {
        videoEl.value.removeEventListener('timeupdate', timeUpdateHandler);
      }
    });

    function seekTo(time) {
      if (videoEl.value) videoEl.value.currentTime = time;
    }

    return { store, videoEl, seekTo };
  },
  template: `
    <div class="video-panel" id="video-container">
      <div class="subtitle-container" id="subtitle-box">
        <video ref="videoEl" id="editor-video" controls></video>
        <div class="subtitle-overlay" :class="'pos-' + store.style.position" id="subtitle-preview"></div>
      </div>
    </div>
  `,
};
