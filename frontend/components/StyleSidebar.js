import { ref, computed } from 'vue';
import store, { regenerateAutoGroups, saveUndoSnapshot } from '../store.js';
import { DYNAMIC_PRESETS } from '../presets/dynamicPresets.js';
import { STATIC_PRESETS } from '../presets/staticPresets.js';
import { EMOTION_PRESETS } from '../presets/emotionPresets.js';

export default {
  name: 'StyleSidebar',
  setup() {
    const currentDynamicPreset = ref('vtuber');
    const currentStaticPreset = ref('classic');
    const emotionInfo = ref('Select words, then click an emotion to apply');
    const emotionWarning = ref(false);

    // Dynamic preset info for template
    const dynamicIconMap = {
      vtuber:    { icon: '🔥', iconText: null,    iconClass: '' },
      neon:      { icon: '',   iconText: 'RAVE',  iconClass: 'neon-text' },
      anime:     { icon: '',   iconText: 'アニメ', iconClass: 'anime-text' },
      clean:     { icon: '',   iconText: 'PRO',   iconClass: '' },
      retro:     { icon: '',   iconText: 'GAME',  iconClass: 'retro-text' },
      idol:      { icon: '💗', iconText: null,    iconClass: '' },
      newsflash: { icon: '📰', iconText: null,    iconClass: '' },
      cybergold: { icon: '',   iconText: 'GOLD',  iconClass: 'neon-text' },
      horror:    { icon: '💀', iconText: null,    iconClass: '' },
    };
    const dynamicPresetList = Object.entries(DYNAMIC_PRESETS).map(([key, p]) => ({
      key,
      name: p.name,
      ...(dynamicIconMap[key] || { icon: '✨', iconText: null, iconClass: '' }),
    }));

    const staticPresetList = [
      { key: 'classic',    icon: '🎬', name: 'Classic' },
      { key: 'cinematic',  icon: '🎥', name: 'Cinematic' },
      { key: 'minimal',    icon: '—',  name: 'Minimal' },
      { key: 'neonStatic', icon: '',   iconText: 'GLOW', iconClass: 'neon-text', name: 'Neon Glow' },
      { key: 'retrostatic',icon: '',   iconText: 'VHS',  iconClass: 'retro-text', name: 'Retro VHS' },
      { key: 'elegant',    icon: '✦',  name: 'Elegant' },
      { key: 'goldenhour', icon: '🌅', name: 'Golden Hour' },
      { key: 'icecold',    icon: '🧊', name: 'Ice Cold' },
      { key: 'boldstrike', icon: '⚡', name: 'Bold Strike' },
    ];

    const emotionList = [
      { key: 'angry', label: '😡 Angry' },
      { key: 'creepy', label: '👻 Creepy' },
      { key: 'shy', label: '😳 Shy' },
      { key: 'gloomy', label: '😔 Gloomy' },
      { key: 'bright', label: '☀️ Bright' },
      { key: 'energetic', label: '⚡ Energetic' },
      { key: 'obnoxious', label: '🤪 Obnoxious' },
      { key: 'romantic', label: '💕 Romantic' },
    ];

    function applyDynamicPreset(key) {
      const p = DYNAMIC_PRESETS[key]; if (!p) return;
      saveUndoSnapshot('Apply preset: ' + p.name);
      currentDynamicPreset.value = key;
      Object.assign(store.style, {
        fontFamily: p.fontFamily, fontSize: p.fontSize, bold: p.bold, italic: p.italic,
        uppercase: p.uppercase, highlight: p.highlight, textColor: p.textColor,
        outlineColor: p.outlineColor, shadowColor: p.shadowColor, outline: p.outline,
        shadow: p.shadow, glow: p.glow, glowColor: p.glowColor, scale: p.scale,
        animation: p.animation, groupAnimation: p.groupAnimation, animSpeed: p.animSpeed,
      });
      if (!store.useCustomGroups) regenerateAutoGroups();
    }

    function applyStaticPreset(key) {
      const p = STATIC_PRESETS[key]; if (!p) return;
      saveUndoSnapshot('Apply preset: ' + p.name);
      currentStaticPreset.value = key;
      Object.assign(store.style, {
        fontFamily: p.fontFamily, fontSize: p.fontSize, bold: p.bold, italic: p.italic,
        uppercase: p.uppercase, textColor: p.textColor,
        outlineColor: p.outlineColor, shadowColor: p.shadowColor, outline: p.outline,
        shadow: p.shadow, glow: p.glow, glowColor: p.glowColor,
        sentenceAnimation: p.sentenceAnimation, staticAnimSpeed: p.animSpeed,
      });
      if (!store.useCustomGroups) regenerateAutoGroups();
    }

    function setSubtitleMode(mode) {
      store.useDynamicMode = (mode === 'dynamic');
      if (store.useDynamicMode) applyDynamicPreset('vtuber');
      else applyStaticPreset('classic');
    }

    function applyEmotion(key) {
      const emotion = EMOTION_PRESETS[key]; if (!emotion) return;
      if (store.selectedWordIndices.size === 0) {
        emotionInfo.value = '⚠️ Select words first, then apply emotion';
        emotionWarning.value = true;
        setTimeout(() => { emotionInfo.value = 'Select words, then click an emotion to apply'; emotionWarning.value = false; }, 2000);
        return;
      }
      const baseFontSize = store.style.fontSize || 80;
      saveUndoSnapshot('Apply emotion: ' + emotion.name);
      store.selectedWordIndices.forEach(idx => {
        if (!store.words[idx].style) store.words[idx].style = {};
        store.words[idx].style.highlight_color = emotion.highlight_color;
        store.words[idx].style.normal_color = emotion.normal_color;
        store.words[idx].style.outline_color = emotion.outline_color;
        if (emotion.font_name) store.words[idx].style.font_name = emotion.font_name;
        if (emotion.font_size_mult) store.words[idx].style.font_size = Math.round(baseFontSize * emotion.font_size_mult);
      });
      emotionInfo.value = '✓ Applied "' + emotion.name + '" to ' + store.selectedWordIndices.size + ' word(s)';
      setTimeout(() => { emotionInfo.value = 'Select words, then click an emotion to apply'; }, 2000);
    }

    // Per-word style
    const wordHighlight = ref('#FFD700');
    const wordNormal = ref('#FFFFFF');
    const wordFontSize = ref('');
    const wordOutline = ref('#000000');

    const selectedWordsInfo = computed(() => {
      if (store.selectedWordIndices.size === 0) return '';
      const texts = [...store.selectedWordIndices].slice(0, 5).map(i => store.words[i]?.text || '').join(', ');
      const more = store.selectedWordIndices.size > 5 ? ' +' + (store.selectedWordIndices.size - 5) + ' more' : '';
      return 'Selected: ' + texts + more;
    });

    function applyWordStyle() {
      const hc = wordHighlight.value.replace('#', '');
      const nc = wordNormal.value.replace('#', '');
      const fs = wordFontSize.value ? parseInt(wordFontSize.value) : null;
      const oc = wordOutline.value.replace('#', '');
      saveUndoSnapshot('Apply per-word style');
      store.selectedWordIndices.forEach(idx => {
        if (!store.words[idx].style) store.words[idx].style = {};
        store.words[idx].style.highlight_color = hc;
        store.words[idx].style.normal_color = nc;
        if (fs) store.words[idx].style.font_size = fs;
        store.words[idx].style.outline_color = oc;
      });
    }

    function clearWordStyles() {
      saveUndoSnapshot('Clear word styles');
      store.selectedWordIndices.forEach(idx => { delete store.words[idx].style; });
    }

    return {
      store, currentDynamicPreset, currentStaticPreset,
      dynamicPresetList, staticPresetList, emotionList,
      emotionInfo, emotionWarning,
      applyDynamicPreset, applyStaticPreset, setSubtitleMode, applyEmotion,
      wordHighlight, wordNormal, wordFontSize, wordOutline,
      selectedWordsInfo, applyWordStyle, clearWordStyles,
      regenerateAutoGroups,
    };
  },
  template: `
    <!-- Subtitle Mode -->
    <div class="style-section mode-section">
      <div class="style-section-title">Subtitle Mode</div>
      <div class="mode-toggle-row">
        <button class="mode-toggle-btn" :class="{ active: store.useDynamicMode }" @click="setSubtitleMode('dynamic')">
          <span class="mode-icon">🔤</span>
          <span class="mode-label">Dynamic</span>
          <span class="mode-desc">Per-word highlighting</span>
        </button>
        <button class="mode-toggle-btn" :class="{ active: !store.useDynamicMode }" @click="setSubtitleMode('static')">
          <span class="mode-icon">📝</span>
          <span class="mode-label">Static</span>
          <span class="mode-desc">Sentence at a time</span>
        </button>
      </div>
    </div>

    <!-- Dynamic Presets -->
    <div v-if="store.useDynamicMode" class="style-section preset-section">
      <div class="style-section-title">Dynamic Presets</div>
      <div class="preset-grid">
        <button v-for="p in dynamicPresetList" :key="p.key"
                class="preset-btn" :class="{ active: currentDynamicPreset === p.key }"
                @click="applyDynamicPreset(p.key)">
          <span class="preset-icon" :class="p.iconClass">{{ p.iconText || p.icon }}</span>
          <span class="preset-name">{{ p.name }}</span>
        </button>
      </div>
    </div>

    <!-- Static Presets -->
    <div v-if="!store.useDynamicMode" class="style-section preset-section">
      <div class="style-section-title">Static Presets</div>
      <div class="preset-grid">
        <button v-for="p in staticPresetList" :key="p.key"
                class="preset-btn static-preset" :class="{ active: currentStaticPreset === p.key }"
                @click="applyStaticPreset(p.key)">
          <span class="preset-icon" :class="p.iconClass || ''">{{ p.iconText || p.icon }}</span>
          <span class="preset-name">{{ p.name }}</span>
        </button>
      </div>
    </div>

    <!-- Emotions (dynamic only) -->
    <div v-if="store.useDynamicMode" class="style-section emotion-section">
      <div class="style-section-title">Emotion Styles</div>
      <div class="emotion-grid">
        <button v-for="e in emotionList" :key="e.key" class="emotion-btn"
                :data-emotion="e.key" @click="applyEmotion(e.key)">{{ e.label }}</button>
      </div>
      <div class="emotion-info" :class="{ warning: emotionWarning }">{{ emotionInfo }}</div>
    </div>

    <!-- Font -->
    <div class="style-section">
      <div class="style-section-title">Font</div>
      <div class="style-row">
        <label>Family</label>
        <select v-model="store.style.fontFamily" @change="regenerateAutoGroups">
          <option value="Bangers">Bangers (VTuber)</option>
          <option value="Impact">Impact</option>
          <option value="Arial Black">Arial Black</option>
          <option value="Bebas Neue">Bebas Neue</option>
          <option value="Montserrat">Montserrat</option>
          <option value="Roboto">Roboto</option>
          <option value="Open Sans">Open Sans</option>
          <option value="Oswald">Oswald</option>
          <option value="Anton">Anton</option>
          <option value="Poppins">Poppins</option>
          <option value="Lato">Lato</option>
          <option value="Creepster">Creepster (Horror)</option>
          <option value="Permanent Marker">Permanent Marker</option>
          <option value="Comic Neue">Comic Neue</option>
          <option value="Bungee">Bungee</option>
        </select>
      </div>
      <div class="style-row">
        <label>Size</label>
        <input type="range" min="20" max="200" v-model.number="store.style.fontSize" />
        <input type="number" class="range-val-input" v-model.number="store.style.fontSize" min="20" max="200" />
      </div>
      <div class="style-row">
        <label>Bold</label>
        <input type="checkbox" v-model="store.style.bold" />
        <span style="width:20px"></span>
        <label>Italic</label>
        <input type="checkbox" v-model="store.style.italic" />
      </div>
      <div class="style-row">
        <label>UPPER</label>
        <input type="checkbox" v-model="store.style.uppercase" />
      </div>
    </div>

    <!-- Colors -->
    <div class="style-section">
      <div class="style-section-title">Colors</div>
      <div v-if="store.useDynamicMode" class="style-row">
        <label>Highlight</label>
        <input type="color" v-model="store.style.highlight" />
        <label style="margin-left:0.5rem">Normal</label>
        <input type="color" v-model="store.style.textColor" />
      </div>
      <div v-else class="style-row">
        <label>Text Color</label>
        <input type="color" v-model="store.style.textColor" />
      </div>
      <div class="style-row">
        <label>Outline</label>
        <input type="color" v-model="store.style.outlineColor" />
        <label style="margin-left:0.5rem">Shadow</label>
        <input type="color" v-model="store.style.shadowColor" />
      </div>
    </div>

    <!-- Effects -->
    <div class="style-section">
      <div class="style-section-title">Effects</div>
      <div class="style-row">
        <label>Outline</label>
        <input type="range" min="0" max="12" v-model.number="store.style.outline" />
        <input type="number" class="range-val-input" v-model.number="store.style.outline" min="0" max="12" />
      </div>
      <div class="style-row">
        <label>Shadow</label>
        <input type="range" min="0" max="10" v-model.number="store.style.shadow" />
        <input type="number" class="range-val-input" v-model.number="store.style.shadow" min="0" max="10" />
      </div>
      <div class="style-row">
        <label>Glow</label>
        <input type="range" min="0" max="20" v-model.number="store.style.glow" />
        <input type="number" class="range-val-input" v-model.number="store.style.glow" min="0" max="20" />
      </div>
      <div class="style-row">
        <label>Glow Color</label>
        <input type="color" v-model="store.style.glowColor" />
      </div>
      <div v-if="store.useDynamicMode" class="style-row">
        <label>Scale %</label>
        <input type="range" min="100" max="150" v-model.number="store.style.scale" />
        <input type="number" class="range-val-input" v-model.number="store.style.scale" min="100" max="150" />
      </div>
    </div>

    <!-- Dynamic Animation -->
    <div v-if="store.useDynamicMode" class="style-section">
      <div class="style-section-title">Word Animation</div>
      <div class="style-row">
        <label>Highlight</label>
        <select v-model="store.style.animation">
          <option value="color-only">Color Only</option>
          <option value="scale">Scale</option>
          <option value="bounce">Bounce</option>
          <option value="none">None</option>
        </select>
      </div>
      <div class="style-row">
        <label>Group Anim</label>
        <select v-model="store.style.groupAnimation">
          <option value="none">None</option>
          <option value="fade-in">Fade In</option>
          <option value="slide-up">Slide Up</option>
          <option value="slide-down">Slide Down</option>
          <option value="slide-left">Slide Left</option>
          <option value="slide-right">Slide Right</option>
          <option value="pop-in">Pop In</option>
          <option value="bounce">Bounce / Drop</option>
          <option value="blur-in">Blur In</option>
          <option value="stretch">Stretch</option>
          <option value="zoom-drop">Zoom Drop</option>
          <option value="flip-in">Flip In</option>
          <option value="typewriter">Typewriter</option>
          <option value="cascade">Cascade Pop</option>
        </select>
      </div>
      <div class="style-row">
        <label>Anim Speed</label>
        <input type="range" min="100" max="500" v-model.number="store.style.animSpeed" />
        <input type="number" class="range-val-input" v-model.number="store.style.animSpeed" min="100" max="500" /><span class="range-unit">ms</span>
      </div>
    </div>

    <!-- Static Animation -->
    <div v-if="!store.useDynamicMode" class="style-section">
      <div class="style-section-title">Sentence Animation</div>
      <div class="style-row">
        <label>Entrance</label>
        <select v-model="store.style.sentenceAnimation">
          <option value="none">None</option>
          <option value="fade-in">Fade In</option>
          <option value="slide-up">Slide Up</option>
          <option value="slide-down">Slide Down</option>
          <option value="slide-left">Slide Left</option>
          <option value="slide-right">Slide Right</option>
          <option value="pop-in">Pop In</option>
          <option value="bounce">Bounce / Drop</option>
          <option value="blur-in">Blur In</option>
          <option value="stretch">Stretch</option>
          <option value="zoom-drop">Zoom Drop</option>
          <option value="flip-in">Flip In</option>
          <option value="typewriter">Typewriter</option>
          <option value="cascade">Cascade Pop</option>
        </select>
      </div>
      <div class="style-row">
        <label>Anim Speed</label>
        <input type="range" min="100" max="500" v-model.number="store.style.staticAnimSpeed" />
        <input type="number" class="range-val-input" v-model.number="store.style.staticAnimSpeed" min="100" max="500" /><span class="range-unit">ms</span>
      </div>
    </div>

    <!-- Spacing -->
    <div class="style-section">
      <div class="style-section-title">Spacing</div>
      <div class="style-row">
        <label>Letter Spc</label>
        <input type="range" min="0" max="20" v-model.number="store.style.letterSpacing" />
        <input type="number" class="range-val-input" v-model.number="store.style.letterSpacing" min="0" max="20" />
      </div>
      <div class="style-row">
        <label>Word Gap</label>
        <input type="range" min="0" max="8" v-model.number="store.style.wordGap" />
        <input type="number" class="range-val-input" v-model.number="store.style.wordGap" min="0" max="8" />
      </div>
    </div>

    <!-- Position -->
    <div class="style-section">
      <div class="style-section-title">Position</div>
      <div class="style-row">
        <label>Vertical</label>
        <select v-model="store.style.position">
          <option value="bottom">Bottom</option>
          <option value="center">Center</option>
          <option value="top">Top</option>
        </select>
      </div>
      <div class="style-row">
        <label>Margin V</label>
        <input type="range" min="0" max="200" v-model.number="store.style.marginV" />
        <input type="number" class="range-val-input" v-model.number="store.style.marginV" min="0" max="200" />
      </div>
      <div class="style-row">
        <label>Margin H</label>
        <input type="range" min="0" max="200" v-model.number="store.style.marginH" />
        <input type="number" class="range-val-input" v-model.number="store.style.marginH" min="0" max="200" />
      </div>
    </div>

    <!-- Per-Word Style Panel -->
    <div v-if="store.selectedWordIndices.size > 0" class="word-style-panel">
      <div class="word-style-header">
        <h4>Word Style Override</h4>
        <button class="btn btn-outline btn-sm" @click="clearWordStyles">Clear</button>
      </div>
      <div class="selected-words-info">{{ selectedWordsInfo }}</div>
      <div class="style-row">
        <label>Highlight</label>
        <input type="color" v-model="wordHighlight" />
      </div>
      <div class="style-row">
        <label>Normal</label>
        <input type="color" v-model="wordNormal" />
      </div>
      <div class="style-row">
        <label>Font Size</label>
        <input type="number" v-model="wordFontSize" placeholder="–" />
      </div>
      <div class="style-row">
        <label>Outline</label>
        <input type="color" v-model="wordOutline" />
      </div>
      <div class="style-row">
        <button class="btn btn-primary btn-sm" @click="applyWordStyle" style="width:100%">Apply to Selected</button>
      </div>
    </div>
  `,
};
