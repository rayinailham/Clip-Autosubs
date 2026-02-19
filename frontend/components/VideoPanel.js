import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import store, { getActiveGroups } from '../store.js';
import { videoURL } from '../api.js';

export default {
  name: 'VideoPanel',
  setup() {
    const videoEl = ref(null);
    let timeUpdateHandler = null;
    let lastGroupKey = null;  // track group changes for entrance animations

    function onTimeUpdate() {
      if (!videoEl.value) return;
      const t = videoEl.value.currentTime;
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
      const scaledMarginV = Math.round(marginVASS * displayedHeight / actualHeight);

      // Reset padding
      preview.style.paddingBottom = '';
      preview.style.paddingTop = '';
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

      // Static mode
      if (!store.useDynamicMode) {
        const groupKey = activeGroup.start + '_' + activeGroup.end;
        if (groupKey !== lastGroupKey) {
          lastGroupKey = groupKey;
          const sentence = activeGroup.words.map(w => upper ? w.text.toUpperCase() : w.text).join(' ');
          const animName = store.style.sentenceAnimation || 'none';
          const animSpeed = (store.style.staticAnimSpeed || 300) + 'ms';
          const animClass = animName !== 'none' ? ' subtitle-anim-' + animName : '';
          preview.innerHTML = `<span class="subtitle-word${animClass}" style="color:${textColor}; --anim-speed:${animSpeed}; font-style:${fontStyle}; font-weight:${fontWeight}; text-shadow:${textShadow}">${sentence}</span>`;
        }
        document.querySelectorAll('.word-chip.playing').forEach(el => el.classList.remove('playing'));
        return;
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
