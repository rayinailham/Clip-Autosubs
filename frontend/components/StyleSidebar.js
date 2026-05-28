import { ref, computed } from 'vue';
import store, { regenerateAutoGroups, saveUndoSnapshot } from '../store.js';
import { STATIC_PRESETS } from '../presets/staticPresets.js';

export default {
  name: 'StyleSidebar',
  setup() {
    const currentStaticPreset = ref('natural');

    const staticPresetList = [
      { key: 'natural',    icon: '✨', name: 'Natural' },
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

    function applyStaticPreset(key) {
      const p = STATIC_PRESETS[key]; if (!p) return;
      saveUndoSnapshot('Apply preset: ' + p.name);
      currentStaticPreset.value = key;
      Object.assign(store.style, {
        fontFamily: p.fontFamily, fontSize: p.fontSize, bold: p.bold, italic: p.italic,
        uppercase: p.uppercase, textColor: p.textColor,
        outlineColor: p.outlineColor, shadowColor: p.shadowColor, outline: p.outline,
        shadow: p.shadow, glow: p.glow, glowColor: p.glowColor,
        sentenceAnimation: p.sentenceAnimation, staticAnimSpeed: p.animSpeed, animIntensity: p.animIntensity || 100,
      });
      if (!store.useCustomGroups) regenerateAutoGroups();
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

    function onPositionPreset() {
      const presets = { bottom: 85, center: 50, top: 15 };
      store.style.posY = presets[store.style.position] || 85;
      store.style.posX = 50;  // Reset to center X
    }

    return {
      store, currentStaticPreset,
      staticPresetList,
      applyStaticPreset,
      wordHighlight, wordNormal, wordFontSize, wordOutline,
      selectedWordsInfo, applyWordStyle, clearWordStyles,
      regenerateAutoGroups, onPositionPreset,
    };
  },
  template: `
    <!-- Static Presets -->
    <div class="style-section preset-section">
      <div class="style-section-title">Style Presets</div>
      <div class="preset-grid">
        <button v-for="p in staticPresetList" :key="p.key"
                class="preset-btn static-preset" :class="{ active: currentStaticPreset === p.key }"
                @click="applyStaticPreset(p.key)">
          <span class="preset-icon" :class="p.iconClass || ''">{{ p.iconText || p.icon }}</span>
          <span class="preset-name">{{ p.name }}</span>
        </button>
      </div>
    </div>

    <!-- Font -->
    <div class="style-section">
      <div class="style-section-title">Font</div>
      <div class="style-row">
        <label>Family</label>
        <select v-model="store.style.fontFamily" @change="regenerateAutoGroups">
          <option value="Bangers">Bangers</option>
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
      <div class="style-row">
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
    </div>

    <!-- Static Animation -->
    <div class="style-section">
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
      <div class="style-row">
        <label>Effects Amt</label>
        <input type="range" min="0" max="250" v-model.number="store.style.animIntensity" />
        <input type="number" class="range-val-input" v-model.number="store.style.animIntensity" min="0" max="250" /><span class="range-unit">%</span>
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
        <label>Preset</label>
        <select v-model="store.style.position" @change="onPositionPreset">
          <option value="bottom">Bottom</option>
          <option value="center">Center</option>
          <option value="top">Top</option>
        </select>
      </div>
      <div class="style-row">
        <label>X</label>
        <input type="range" min="0" max="100" v-model.number="store.style.posX" />
        <input type="number" class="range-val-input" v-model.number="store.style.posX" min="0" max="100" />
      </div>
      <div class="style-row">
        <label>Y</label>
        <input type="range" min="0" max="100" v-model.number="store.style.posY" />
        <input type="number" class="range-val-input" v-model.number="store.style.posY" min="0" max="100" />
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
