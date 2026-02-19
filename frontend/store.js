/**
 * Centralised reactive store using Vue.reactive.
 * Imported by all components that need shared state.
 */
import { reactive } from 'vue';

const store = reactive({
  // ── App Mode ─────────────────────────────
  appMode: 'home', // 'home' | 'subtitle' | 'vtuber' | 'ytclipper'

  // ── Navigation ──────────────────────────
  currentView: 'upload', // 'upload' | 'editor'

  // ── Transcription data ──────────────────
  words: [],
  videoFilename: '',
  metadata: {},

  // ── Selection ───────────────────────────
  selectedWordIndices: new Set(),
  lastClickedIndex: -1,

  // ── Groups ──────────────────────────────
  customGroups: [],
  useCustomGroups: false,

  // ── Mode ────────────────────────────────
  useDynamicMode: true,

  // ── Undo ────────────────────────────────
  undoStack: [],
  MAX_UNDO: 50,

  // ── Style controls (bound to UI) ───────
  style: {
    fontFamily: 'Bangers',
    fontSize: 85,
    bold: true,
    italic: false,
    uppercase: true,
    highlight: '#FFD700',
    textColor: '#FFFFFF',
    outlineColor: '#FF1493',
    shadowColor: '#000000',
    outline: 5,
    shadow: 3,
    glow: 8,
    glowColor: '#FFD700',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'pop-in',
    animSpeed: 200,
    sentenceAnimation: 'fade-in',
    staticAnimSpeed: 300,
    position: 'bottom',
    marginV: 60,
    marginH: 10,
    letterSpacing: 0,
    wordGap: 0,
    wpg: 4,
  },

  // ── Status ──────────────────────────────
  gpu: { available: false, name: 'Checking GPU…' },
  ffmpeg: { available: false },

  // ── Render ──────────────────────────────
  render: {
    active: false,
    title: 'Rendering…',
    status: 'Starting…',
    progress: 30,
    indeterminate: true,
    done: false,
    error: false,
    downloadUrl: '',
    downloadLabel: '',
  },

  // ── Upload progress ─────────────────────
  transcribing: false,
  progressText: 'Transcribing…',
  progressFile: '',
  // ── Trimmer ──────────────────────────────────
  trimmer: {
    inPoint: null,   // seconds | null = not set
    outPoint: null,  // seconds | null = not set
    active: false,
    log: '',
    status: '',      // '' | 'queued' | 'processing' | 'done' | 'error'
    error: '',
    jobId: '',
    downloadUrl: '',
    downloadLabel: '',
    durationS: 0,
    sizeMb: 0,
  },

  // ── Silence cutter ────────────────────────
  silenceCutter: {
    minSilenceMs: 500,
    paddingMs: 100,
    active: false,
    log: '',
    status: '',   // '' | 'queued' | 'processing' | 'done' | 'error'
    error: '',
    jobId: '',
    downloadUrl: '',
    downloadLabel: '',
    stats: null,  // stats object returned by backend when done
  },

  // ── Shorts Creator / VTuber Reframe ────
  reframe: {
    videoFilename: '',
    step: 'mode',    // 'mode' | 'upload' | 'editor'
    // Shorts mode: 'vtuber' | 'zoomed' | 'blur_bg' | 'black_bg'
    shortsMode: 'vtuber',
    // Single-section zoom/pan (used by 'zoomed' mode)
    single: { zoom: 1.0, panX: 0, panY: 0 },
    // VTuber split-screen sections
    top: { zoom: 1.0, panX: 0, panY: 0 },
    bottom: { zoom: 1.0, panX: 0, panY: 0 },
    render: {
      active: false,
      status: '',
      jobId: '',
      done: false,
      error: false,
      downloadUrl: '',
      downloadLabel: '',
    },
  },

  // ── YouTube Clipper ───────────────────────
  yt: {
    prefillFile: '', // filename to auto-load in upload view after clipping
  },
});

export default store;

// ── Helper actions ─────────────────────────

export function saveUndoSnapshot(label) {
  store.undoStack.push({
    label,
    words: JSON.parse(JSON.stringify(store.words)),
    groups: JSON.parse(JSON.stringify(store.customGroups)),
  });
  if (store.undoStack.length > store.MAX_UNDO) store.undoStack.shift();
}

export function undoAction() {
  if (store.undoStack.length === 0) return;
  const snapshot = store.undoStack.pop();
  store.words = snapshot.words;
  store.customGroups = snapshot.groups;
  store.selectedWordIndices = new Set();
  regenerateAutoGroups();
}

export function regenerateAutoGroups() {
  const wpg = store.style.wpg || 4;
  store.customGroups = [];
  for (let i = 0; i < store.words.length; i += wpg) {
    const chunk = store.words.slice(i, i + wpg);
    if (chunk.length === 0) continue;
    store.customGroups.push({
      word_indices: Array.from({ length: chunk.length }, (_, j) => i + j),
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
    });
  }
}

export function getActiveGroups() {
  if (store.useCustomGroups) {
    return store.customGroups.map(g => ({
      words: g.word_indices.map(i => store.words[i]),
      start: g.start,
      end: g.end,
    }));
  }
  const wpg = store.style.wpg || 4;
  const groups = [];
  for (let i = 0; i < store.words.length; i += wpg) {
    const chunk = store.words.slice(i, i + wpg);
    if (chunk.length === 0) continue;
    groups.push({
      words: chunk,
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
    });
  }
  return groups;
}

export function getStyleConfig() {
  const s = store.style;
  return {
    words_per_group: s.wpg || 4,
    use_custom_groups: store.useCustomGroups,
    dynamic_mode: store.useDynamicMode,
    font_name: s.fontFamily,
    font_size: s.fontSize || 80,
    bold: s.bold,
    italic: s.italic,
    highlight_color: s.highlight.replace('#', ''),
    normal_color: s.textColor.replace('#', ''),
    outline_color: s.outlineColor.replace('#', ''),
    shadow_color: s.shadowColor.replace('#', ''),
    outline_width: s.outline || 4,
    shadow_depth: s.shadow || 2,
    glow_strength: s.glow || 0,
    glow_color: s.glowColor.replace('#', ''),
    position: s.position,
    margin_v: s.marginV || 60,
    margin_h: s.marginH || 10,
    letter_spacing: s.letterSpacing || 0,
    word_gap: s.wordGap || 0,
    scale_highlight: s.scale || 100,
    animation: s.animation,
    group_animation: s.groupAnimation,
    anim_speed: s.animSpeed || 200,
    sentence_animation: s.sentenceAnimation || 'fade-in',
    static_anim_speed: s.staticAnimSpeed || 300,
    uppercase: s.uppercase,
  };
}
