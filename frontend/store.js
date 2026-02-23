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
  transcriptionModel: 'large-v2', // 'large-v2' (whisperx) or 'flyfront/anime-whisper-faster' (anime) or 'scribe_v2' (elevenlabs)
  elevenlabsApiKey: '',
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

  // ── Undo / Redo ─────────────────────────
  undoStack: [],
  redoStack: [],
  MAX_UNDO: 1000,

  // ── Playhead (shared) ───────────────────
  currentTime: 0,

  // ── Split / Segments ────────────────────
  splitPoints: [],        // sorted timestamps where cuts were made
  removedSegments: [],    // indices of segments to exclude

  // ── Style controls (bound to UI) ───────
  style: {
    fontFamily: 'Montserrat',
    fontSize: 78,
    bold: true,
    italic: false,
    uppercase: true,
    highlight: '#FFD700',
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outline: 4,
    shadow: 2,
    glow: 10,
    glowColor: '#FFFFFF',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'pop-in',
    animSpeed: 300,
    animIntensity: 100,
    sentenceAnimation: 'fade-in',
    staticAnimSpeed: 300,
    position: 'bottom',
    marginV: 60,
    marginH: 10,
    posX: 50,        // 0-100% horizontal position (50 = center)
    posY: 85,        // 0-100% vertical position (85 = near bottom)
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
    // Split-screen ratio: top section percentage (20-80)
    splitRatio: 40,
    // Single-section zoom/pan (used by 'zoomed' mode)
    single: { zoom: 1.0, panX: 0, panY: 0 },
    // Split-screen sections
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

  // ── Refine Automation ─────────────────────
  refine: {
    geminiApiKey: '',
    status: '',        // '' | 'queued' | 'processing' | 'done' | 'error'
    step: '',          // 'init' | 'transcribe' | 'silence' | 'analyze' | 'apply' | 'done'
    message: '',
    jobId: '',
    error: '',
    result: null,      // full result from backend when done
  },

  // ── Diarization settings ───────────────────────
  diarization: {
    hfToken: '',
    maxSpeakers: null,
  },

  // ── Speaker data ──────────────────────────
  speakers: {},          // e.g. { SPEAKER_1: 'Host', SPEAKER_2: 'Guest' }
  hiddenWordIndices: [], // word indices to hide (overlapping speech)
});

export default store;

// ── Speaker color palette ───────────────────

const SPEAKER_PALETTE = [
  { bg: 'rgba(124, 92, 252, 0.30)', border: 'rgba(124, 92, 252, 0.65)', text: '#7C5CFC', label: '#b4a0ff' },
  { bg: 'rgba(76, 175, 80, 0.30)',  border: 'rgba(76, 175, 80, 0.65)',  text: '#4CAF50', label: '#81C784' },
  { bg: 'rgba(255, 152, 0, 0.30)',  border: 'rgba(255, 152, 0, 0.65)',  text: '#FF9800', label: '#FFB74D' },
  { bg: 'rgba(233, 30, 99, 0.30)',  border: 'rgba(233, 30, 99, 0.65)',  text: '#E91E63', label: '#F06292' },
  { bg: 'rgba(0, 188, 212, 0.30)',  border: 'rgba(0, 188, 212, 0.65)',  text: '#00BCD4', label: '#4DD0E1' },
];

// Legacy compat: map old keys too
export const SPEAKER_COLORS = {
  SPEAKER_1: SPEAKER_PALETTE[0],
  SPEAKER_2: SPEAKER_PALETTE[1],
  SPEAKER_3: SPEAKER_PALETTE[2],
  SPEAKER_4: SPEAKER_PALETTE[3],
};

// Dynamic color assignment by index for any speaker ID format
const _speakerColorCache = {};
export function getSpeakerColor(speaker) {
  if (_speakerColorCache[speaker]) return _speakerColorCache[speaker];
  // Try legacy map first
  if (SPEAKER_COLORS[speaker]) {
    _speakerColorCache[speaker] = SPEAKER_COLORS[speaker];
    return SPEAKER_COLORS[speaker];
  }
  // Assign by order of appearance
  const idx = Object.keys(_speakerColorCache).length;
  const color = SPEAKER_PALETTE[idx % SPEAKER_PALETTE.length];
  _speakerColorCache[speaker] = color;
  return color;
}

// Reset color cache when speakers change (call on new transcription load)
export function resetSpeakerColors() {
  Object.keys(_speakerColorCache).forEach(k => delete _speakerColorCache[k]);
}

export function getUniqueSpeakers() {
  const speakerSet = new Set();
  for (const w of store.words) {
    if (w.speaker) speakerSet.add(w.speaker);
  }
  return [...speakerSet].sort();
}

// ── Helper actions ─────────────────────────

function captureState(label) {
  return {
    label,
    words: JSON.parse(JSON.stringify(store.words)),
    groups: JSON.parse(JSON.stringify(store.customGroups)),
    style: JSON.parse(JSON.stringify(store.style)),
    videoFilename: store.videoFilename,
    splitPoints: [...store.splitPoints],
    removedSegments: [...store.removedSegments],
    useCustomGroups: store.useCustomGroups,
    useDynamicMode: store.useDynamicMode,
  };
}

function restoreSnapshot(snapshot) {
  store.words = snapshot.words;
  store.customGroups = snapshot.groups;
  Object.assign(store.style, snapshot.style);
  store.videoFilename = snapshot.videoFilename;
  store.splitPoints = snapshot.splitPoints;
  store.removedSegments = snapshot.removedSegments;
  store.useCustomGroups = snapshot.useCustomGroups;
  store.useDynamicMode = snapshot.useDynamicMode;
  store.selectedWordIndices = new Set();
  regenerateAutoGroups();
}

export function saveUndoSnapshot(label) {
  store.undoStack.push(captureState(label));
  if (store.undoStack.length > store.MAX_UNDO) store.undoStack.shift();
  // New action clears redo history
  store.redoStack = [];
}

export function undoAction() {
  if (store.undoStack.length === 0) return;
  // Push current state to redo stack
  store.redoStack.push(captureState('Redo'));
  restoreSnapshot(store.undoStack.pop());
}

export function redoAction() {
  if (store.redoStack.length === 0) return;
  // Push current state to undo stack (without clearing redo)
  store.undoStack.push(captureState('Undo'));
  restoreSnapshot(store.redoStack.pop());
}

// ── Split / Segments ───────────────────────

export function addSplitAtPlayhead() {
  const t = parseFloat(store.currentTime.toFixed(3));
  if (t <= 0) return;
  // Don't add duplicate (within 0.05s tolerance)
  if (store.splitPoints.some(p => Math.abs(p - t) < 0.05)) return;
  saveUndoSnapshot('Split at ' + t.toFixed(2) + 's');
  store.splitPoints.push(t);
  store.splitPoints.sort((a, b) => a - b);
}

export function removeSplitPoint(index) {
  saveUndoSnapshot('Remove split point');
  store.splitPoints.splice(index, 1);
  store.removedSegments = []; // Reset removed segments since indices shift
}

export function toggleSegment(segmentIndex) {
  const idx = store.removedSegments.indexOf(segmentIndex);
  if (idx >= 0) {
    store.removedSegments.splice(idx, 1);
  } else {
    store.removedSegments.push(segmentIndex);
  }
}

export function getSegments(duration) {
  if (!duration) return [];
  const points = [0, ...store.splitPoints.filter(p => p < duration), duration];
  const segments = [];
  for (let i = 0; i < points.length - 1; i++) {
    segments.push({
      start: points[i],
      end: points[i + 1],
      active: !store.removedSegments.includes(i),
      index: i,
    });
  }
  return segments;
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
      words: g.word_indices.map(i => store.words[i]).filter(Boolean),
      start: g.start,
      end: g.end,
      speaker: g.speaker || (store.words[g.word_indices[0]] || {}).speaker || null,
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
      speaker: chunk[0].speaker || null,
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
    pos_x: s.posX != null ? s.posX : 50,
    pos_y: s.posY != null ? s.posY : 85,
    letter_spacing: s.letterSpacing || 0,
    word_gap: s.wordGap || 0,
    scale_highlight: s.scale || 100,
    animation: s.animation,
    group_animation: s.groupAnimation,
    anim_speed: s.animSpeed || 200,
    anim_intensity: s.animIntensity != null ? s.animIntensity : 100,
    sentence_animation: s.sentenceAnimation || 'fade-in',
    static_anim_speed: s.staticAnimSpeed || 300,
    uppercase: s.uppercase,
  };
}
