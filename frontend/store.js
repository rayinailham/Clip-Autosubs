/**
 * Centralised reactive store using Vue.reactive.
 * Imported by all components that need shared state.
 */
import { reactive } from 'vue';

const store = reactive({
  // ── App Mode ─────────────────────────────
  appMode: 'home', // 'home' | 'subtitle' | 'vtuber' | 'ytclipper' | 'settings'
  previousAppMode: 'home', // last non-settings mode, used by Settings back button

  // ── Navigation ──────────────────────────
  currentView: 'upload', // 'upload' | 'editor'

  // ── Settings (loaded from backend on boot) ─────────
  settings: {
    elevenlabs_api_key: '',           // set on save; redacted on load
    elevenlabs_api_key_set: false,    // backend says key exists
    elevenlabs_model: 'scribe_v1',
    elevenlabs_models: ['scribe_v1'],

    ai_api_key: '',
    ai_api_key_set: false,
    ai_base_url: 'http://localhost:20128',
    ai_model: 'kr/claude-sonnet-4.6-thinking',
    ai_models: [
      'kr/claude-sonnet-4.6-thinking',
      'kr/claude-sonnet-4.6',
      'kr/claude-opus-4.8-thinking',
      'kr/claude-haiku-4.5-thinking',
      'kr/auto',
    ],

    loaded: false,
  },

  // ── Transcription data ──────────────────
  // Active transcription model id (mirrors settings.elevenlabs_model).
  transcriptionModel: 'scribe_v1',
  elevenlabsApiKey: '',
  sourceLanguage: '',   // ISO source-language hint ('' = auto-detect, 'ja' = Japanese)
  words: [],
  videoFilename: '',
  metadata: {},

  // ── Selection ───────────────────────────
  selectedWordIndices: new Set(),
  lastClickedIndex: -1,

  // ── Groups ──────────────────────────────
  customGroups: [],
  useCustomGroups: false,

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
    uppercase: false,
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
    maxCharsPerGroup: 0,    // 0 = off; cap rendered chars per group (anti-overflow)
    groupGapThreshold: 0,   // 0 = off; new group on silence >= Ns (auto-group)
    minGroupDuration: 0,    // group shown at least this long (anti-flash), seconds
    groupHold: 0.15,        // extra seconds a group lingers after its last word ends
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
    aiApiKey: '',
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

  // ── Speaker avatar/box overlay config ─────
  // Map speaker_id → { enabled, avatar, label, pos_x, pos_y, bg_color, ... }
  // When `enabled` is true, the subtitle for that speaker is rendered as an
  // avatar + rounded dialog box at the configured position instead of using
  // the global subtitle position.
  speakerConfig: {},
});

export default store;

// ── Speaker color palette ───────────────────

const SPEAKER_PALETTE = [
  { bg: 'rgba(217, 255, 61, 0.22)', border: 'rgba(217, 255, 61, 0.55)', text: '#d9ff3d', label: '#e6ff66' },
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

// ── Speaker reassignment / merge (manual diarization fixes) ──

// Resolve display label for a speaker id (custom label > store.speakers > pretty default).
export function speakerDisplayLabel(spkId) {
  if (!spkId) return '';
  const cfg = store.speakerConfig[spkId];
  if (cfg && cfg.label) return cfg.label;
  return store.speakers[spkId] || spkId.replace('SPEAKER_', 'Speaker ');
}

// Next free SPEAKER_NN id not present in words or speakerConfig.
export function nextSpeakerId() {
  const used = new Set(getUniqueSpeakers());
  Object.keys(store.speakerConfig).forEach(k => used.add(k));
  Object.keys(store.speakers).forEach(k => used.add(k));
  for (let n = 0; n < 1000; n++) {
    const id = 'SPEAKER_' + String(n).padStart(2, '0');
    if (!used.has(id)) return id;
  }
  return 'SPEAKER_' + Date.now();
}

// Reassign a set of word indices to a target speaker id, then resync group speakers.
export function reassignSpeaker(indices, targetSpeaker) {
  const idxList = [...indices].filter(i => store.words[i]);
  if (idxList.length === 0) return;
  saveUndoSnapshot('Reassign ' + idxList.length + ' word(s) → ' + speakerDisplayLabel(targetSpeaker));
  for (const i of idxList) store.words[i].speaker = targetSpeaker;
  syncGroupSpeakers();
}

// Merge every word of `fromSpeaker` into `intoSpeaker`. Drops the orphaned config.
export function mergeSpeakerInto(fromSpeaker, intoSpeaker) {
  if (!fromSpeaker || !intoSpeaker || fromSpeaker === intoSpeaker) return;
  saveUndoSnapshot('Merge ' + speakerDisplayLabel(fromSpeaker) + ' → ' + speakerDisplayLabel(intoSpeaker));
  for (const w of store.words) {
    if (w.speaker === fromSpeaker) w.speaker = intoSpeaker;
  }
  delete store.speakerConfig[fromSpeaker];
  delete store.speakers[fromSpeaker];
  syncGroupSpeakers();
}

// Rewrite each custom group's speaker from its first visible word (after edits).
export function syncGroupSpeakers() {
  if (!store.customGroups || store.customGroups.length === 0) return;
  for (const g of store.customGroups) {
    const first = g.word_indices && g.word_indices.length ? g.word_indices[0] : -1;
    g.speaker = (store.words[first] || {}).speaker || null;
  }
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
  store.selectedWordIndices = new Set();
  // Only auto-regenerate if we don't have any custom groups in the snapshot.
  // Previously this clobbered the just-restored groups every time.
  if (!store.useCustomGroups && store.customGroups.length === 0) {
    regenerateAutoGroups();
  }
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
  const s = store.style;
  const wpg = s.wpg || 4;
  const maxChars = s.maxCharsPerGroup || 0;
  const gapThreshold = s.groupGapThreshold || 0;
  store.customGroups = [];
  let cur = []; // word indices accumulating into current group
  const flush = () => {
    if (cur.length === 0) return;
    store.customGroups.push({
      word_indices: cur.slice(),
      start: store.words[cur[0]].start,
      end: store.words[cur[cur.length - 1]].end,
      speaker: store.words[cur[0]].speaker || null,
    });
    cur = [];
  };
  for (let i = 0; i < store.words.length; i++) {
    const w = store.words[i];
    if (cur.length && gapThreshold > 0) {
      const prev = store.words[cur[cur.length - 1]];
      if ((w.start || 0) - (prev.end || 0) >= gapThreshold) flush();
    }
    if (cur.length) {
      const countAfter = cur.length + 1;
      const overCount = countAfter > wpg;
      let overChars = false;
      if (maxChars > 0) {
        let chars = cur.reduce((a, idx) => a + (store.words[idx].text || '').length, 0);
        chars += (w.text || '').length + (countAfter - 1); // + inter-word spaces
        overChars = chars > maxChars;
      }
      if (overCount || overChars) flush();
    }
    cur.push(i);
  }
  flush();
}

// The caption line shown on screen for a group: explicit translation if set,
// otherwise the group's source words joined. This is the field a text editor binds to.
export function getGroupText(g) {
  if (!g) return '';
  const tr = (g.translation || '').trim();
  if (tr) return tr;
  return (g.word_indices || [])
    .map(i => (store.words[i] || {}).text || '')
    .join(' ')
    .trim();
}

// Overwrite a group's caption text (stored as `translation`, decoupled from words —
// exactly like editing a caption line in Premiere). Empty string clears the override
// so it falls back to the joined source words.
export function setGroupText(gi, text) {
  const g = store.customGroups[gi];
  if (!g) return;
  const next = (text || '').trim();
  if ((g.translation || '') === next) return;
  saveUndoSnapshot('Edit caption ' + (gi + 1) + ' text');
  g.translation = next;
  store.useCustomGroups = true;
}

// Apply linger / anti-flash timing in place. Mirrors backend adjust_group_timing.
// Never extends a group past the next group's start (no overlap).
function applyGroupTiming(groups) {
  const s = store.style;
  const minDur = s.minGroupDuration || 0;
  const hold = s.groupHold != null ? s.groupHold : 0.15;
  if (minDur <= 0 && hold <= 0) return groups;
  for (let i = 0; i < groups.length; i++) {
    const g = groups[i];
    const naturalEnd = g.end;
    let end = naturalEnd;
    if (minDur > 0) end = Math.max(end, g.start + minDur);
    if (hold > 0) end = Math.max(end, naturalEnd + hold);
    if (i + 1 < groups.length) {
      const nextStart = groups[i + 1].start;
      if (nextStart > g.start) end = Math.min(end, nextStart);
    }
    g.end = end;
  }
  return groups;
}

export function getActiveGroups() {
  const hidden = new Set(store.hiddenWordIndices || []);
  if (store.useCustomGroups) {
    const out = [];
    for (const g of store.customGroups) {
      const indices = g.word_indices.filter(i => !hidden.has(i));
      const words = indices.map(i => store.words[i]).filter(Boolean);
      if (words.length === 0) continue;
      out.push({
        words,
        start: g.start,
        end: g.end,
        translation: g.translation || '',
        speaker: g.speaker || (store.words[indices[0]] || {}).speaker || null,
      });
    }
    return applyGroupTiming(out);
  }
  const s = store.style;
  const wpg = s.wpg || 4;
  const maxChars = s.maxCharsPerGroup || 0;
  const gapThreshold = s.groupGapThreshold || 0;
  const groups = [];
  const visibleWords = store.words.filter((_, i) => !hidden.has(i));
  let current = [];
  const flush = () => {
    if (current.length === 0) return;
    groups.push({
      words: current,
      start: current[0].start,
      end: current[current.length - 1].end,
      speaker: current[0].speaker || null,
    });
    current = [];
  };
  for (const w of visibleWords) {
    if (current.length && gapThreshold > 0) {
      const prev = current[current.length - 1];
      if ((w.start || 0) - (prev.end || 0) >= gapThreshold) flush();
    }
    if (current.length) {
      const countAfter = current.length + 1;
      const overCount = countAfter > wpg;
      let overChars = false;
      if (maxChars > 0) {
        let chars = current.reduce((a, c) => a + (c.text || '').length, 0);
        chars += (w.text || '').length + (countAfter - 1);
        overChars = chars > maxChars;
      }
      if (overCount || overChars) flush();
    }
    current.push(w);
  }
  flush();
  return applyGroupTiming(groups);
}

export function getStyleConfig() {
  const s = store.style;
  return {
    words_per_group: s.wpg || 4,
    use_custom_groups: store.useCustomGroups,
    max_chars_per_group: s.maxCharsPerGroup || 0,
    group_gap_threshold: s.groupGapThreshold || 0,
    min_group_duration: s.minGroupDuration || 0,
    group_hold: s.groupHold != null ? s.groupHold : 0.15,
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
