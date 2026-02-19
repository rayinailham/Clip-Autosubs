import { ref, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import store, { getActiveGroups } from '../store.js';
import { videoURL } from '../api.js';

export default {
  name: 'VideoPanel',
  setup() {
    const videoEl = ref(null);
    let timeUpdateHandler = null;

    function onTimeUpdate() {
      if (!videoEl.value) return;
      const t = videoEl.value.currentTime;
      const s = store.style;
      const upper = s.uppercase;
      const highlightColor = s.highlight;
      const textColor = s.textColor;
      const fontSizeASS = s.fontSize || 80;
      const fontFamily = s.fontFamily;
      const scale = s.scale / 100;
      const glowStrength = s.glow || 0;
      const glowColor = s.glowColor;
      const outlineColor = s.outlineColor;
      const outlineWidth = s.outline || 4;
      const groups = getActiveGroups();

      const ve = videoEl.value;
      const displayedHeight = ve.clientHeight || ve.offsetHeight || 1;
      const actualHeight = ve.videoHeight || store.metadata.height || 1080;
      const scaledFontSize = (fontSizeASS * displayedHeight / actualHeight) + 'px';

      const scaledOutline = Math.max(1, Math.round(outlineWidth * displayedHeight / actualHeight / 2));
      const scaledGlow = Math.round(glowStrength * displayedHeight / actualHeight);
      let textShadow = `${scaledOutline}px ${scaledOutline}px 0 ${outlineColor}, ` +
                        `-${scaledOutline}px -${scaledOutline}px 0 ${outlineColor}, ` +
                        `${scaledOutline}px -${scaledOutline}px 0 ${outlineColor}, ` +
                        `-${scaledOutline}px ${scaledOutline}px 0 ${outlineColor}`;
      if (glowStrength > 0) {
        textShadow += `, 0 0 ${scaledGlow}px ${glowColor}, 0 0 ${scaledGlow * 2}px ${glowColor}`;
      }

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
      preview.style.textShadow = textShadow;

      // Static mode
      if (!store.useDynamicMode) {
        const sentence = activeGroup.words.map(w => upper ? w.text.toUpperCase() : w.text).join(' ');
        preview.innerHTML = '<span class="subtitle-word" style="color:' + textColor + ';">' + sentence + '</span>';
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
        return '<span class="subtitle-word" style="color:' + color + '; transform:' + scaleVal + '; ' + fs + '">' + text + '</span>';
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
