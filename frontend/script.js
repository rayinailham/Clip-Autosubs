// ── State ─────────────────────────────────────────
let currentWords = [];
let currentVideoFilename = '';
let currentMetadata = {};
let selectedWordIndices = new Set(); // For word selection
let customGroups = [];  // Custom groups with timing
let useCustomGroups = false;
let useDynamicMode = true;  // true = per-word highlighting, false = static sentence
let undoStack = [];  // Stack of undo snapshots
const MAX_UNDO = 50;

// ── DOM refs ──────────────────────────────────────
const $  = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

const uploadView      = $('#upload-view');
const editorView      = $('#editor-view');
const uploadCard      = $('#upload-card');
const fileInput       = $('#file-input');
const transcribeBar   = $('#transcribe-progress');
const progressText    = $('#progress-text');
const progressFile    = $('#progress-file');
const video           = $('#editor-video');
const subtitlePreview = $('#subtitle-preview');
const wordListEl      = $('#word-list');
const wordCountEl     = $('#word-count');
const renderOverlay   = $('#render-overlay');

// ── Style Controls ────────────────────────────────
const controls = {
  fontFamily: $('#ctrl-fontfamily'),
  fontSize: $('#ctrl-fontsize'),
  bold: $('#ctrl-bold'),
  italic: $('#ctrl-italic'),
  uppercase: $('#ctrl-uppercase'),
  highlight: $('#ctrl-highlight'),
  textColor: $('#ctrl-textcolor'),
  textColorStatic: $('#ctrl-textcolor-static'),
  outlineColor: $('#ctrl-outlinecolor'),
  shadowColor: $('#ctrl-shadowcolor'),
  outline: $('#ctrl-outline'),
  shadow: $('#ctrl-shadow'),
  glow: $('#ctrl-glow'),
  glowColor: $('#ctrl-glowcolor'),
  scale: $('#ctrl-scale'),
  animation: $('#ctrl-animation'),
  groupAnimation: $('#ctrl-groupanimation'),
  animSpeed: $('#ctrl-animspeed'),
  sentenceAnimation: $('#ctrl-sentenceanimation'),
  staticAnimSpeed: $('#ctrl-staticanimspeed'),
  position: $('#ctrl-position'),
  marginV: $('#ctrl-marginv'),
  marginH: $('#ctrl-marginh'),
  letterSpacing: $('#ctrl-letterspacing'),
  wordGap: $('#ctrl-wordgap'),
  wpg: $('#ctrl-wpg'),
};

// ── Style Presets for Dynamic Mode ────────────────
const DYNAMIC_PRESETS = {
  vtuber: {
    name: 'VTuber Pop',
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
  },
  neon: {
    name: 'Neon',
    fontFamily: 'Bebas Neue',
    fontSize: 80,
    bold: true,
    italic: false,
    uppercase: true,
    highlight: '#00FFFF',
    textColor: '#FF00FF',
    outlineColor: '#000000',
    shadowColor: '#00FFFF',
    outline: 2,
    shadow: 0,
    glow: 15,
    glowColor: '#00FFFF',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'fade-in',
    animSpeed: 300,
  },
  anime: {
    name: 'Anime Bold',
    fontFamily: 'Anton',
    fontSize: 90,
    bold: true,
    italic: true,
    uppercase: true,
    highlight: '#FF4444',
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#FF4444',
    outline: 6,
    shadow: 4,
    glow: 5,
    glowColor: '#FF4444',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'slide-up',
    animSpeed: 150,
  },
  clean: {
    name: 'Clean',
    fontFamily: 'Montserrat',
    fontSize: 70,
    bold: true,
    italic: false,
    uppercase: false,
    highlight: '#FFD700',
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outline: 3,
    shadow: 2,
    glow: 0,
    glowColor: '#FFFFFF',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'fade-in',
    animSpeed: 250,
  },
  retro: {
    name: 'Retro',
    fontFamily: 'Bungee',
    fontSize: 75,
    bold: true,
    italic: false,
    uppercase: true,
    highlight: '#FFD700',
    textColor: '#FF6B6B',
    outlineColor: '#2D0A4E',
    shadowColor: '#2D0A4E',
    outline: 4,
    shadow: 5,
    glow: 0,
    glowColor: '#FF6B6B',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'typewriter',
    animSpeed: 100,
  },
  idol: {
    name: 'Idol',
    fontFamily: 'Poppins',
    fontSize: 75,
    bold: true,
    italic: false,
    uppercase: false,
    highlight: '#FFB7DD',
    textColor: '#FFFFFF',
    outlineColor: '#FF69B4',
    shadowColor: '#FFB7DD',
    outline: 3,
    shadow: 2,
    glow: 12,
    glowColor: '#FFB7DD',
    scale: 100,
    animation: 'color-only',
    groupAnimation: 'pop-in',
    animSpeed: 180,
  },
};

// ── Style Presets for Static Mode ─────────────────
const STATIC_PRESETS = {
  classic: {
    name: 'Classic',
    fontFamily: 'Arial Black',
    fontSize: 70,
    bold: true,
    italic: false,
    uppercase: true,
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outline: 4,
    shadow: 2,
    glow: 0,
    glowColor: '#FFFFFF',
    sentenceAnimation: 'fade-in',
    animSpeed: 300,
  },
  cinematic: {
    name: 'Cinematic',
    fontFamily: 'Bebas Neue',
    fontSize: 65,
    bold: true,
    italic: false,
    uppercase: true,
    textColor: '#FFFFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outline: 2,
    shadow: 3,
    glow: 0,
    glowColor: '#FFFFFF',
    sentenceAnimation: 'fade-in',
    animSpeed: 400,
  },
  minimal: {
    name: 'Minimal',
    fontFamily: 'Montserrat',
    fontSize: 60,
    bold: true,
    italic: false,
    uppercase: false,
    textColor: '#FFFFFF',
    outlineColor: '#333333',
    shadowColor: '#000000',
    outline: 2,
    shadow: 1,
    glow: 0,
    glowColor: '#FFFFFF',
    sentenceAnimation: 'none',
    animSpeed: 200,
  },
  neonStatic: {
    name: 'Neon Glow',
    fontFamily: 'Bebas Neue',
    fontSize: 75,
    bold: true,
    italic: false,
    uppercase: true,
    textColor: '#00FFFF',
    outlineColor: '#000000',
    shadowColor: '#000000',
    outline: 2,
    shadow: 0,
    glow: 15,
    glowColor: '#00FFFF',
    sentenceAnimation: 'fade-in',
    animSpeed: 350,
  },
  retrostatic: {
    name: 'Retro VHS',
    fontFamily: 'Bungee',
    fontSize: 70,
    bold: true,
    italic: false,
    uppercase: true,
    textColor: '#FF6B6B',
    outlineColor: '#2D0A4E',
    shadowColor: '#2D0A4E',
    outline: 4,
    shadow: 5,
    glow: 0,
    glowColor: '#FF6B6B',
    sentenceAnimation: 'slide-up',
    animSpeed: 250,
  },
  elegant: {
    name: 'Elegant',
    fontFamily: 'Poppins',
    fontSize: 65,
    bold: true,
    italic: true,
    uppercase: false,
    textColor: '#FFEFD5',
    outlineColor: '#2C1810',
    shadowColor: '#1A0F0A',
    outline: 3,
    shadow: 2,
    glow: 5,
    glowColor: '#FFD700',
    sentenceAnimation: 'fade-in',
    animSpeed: 400,
  },
};

// Legacy alias for compatibility
const STYLE_PRESETS = DYNAMIC_PRESETS;

// ── Emotion Presets (for per-word styling) ────────
const EMOTION_PRESETS = {
  angry: {
    name: 'Angry',
    highlight_color: 'FF0000',
    normal_color: 'CC0000',
    outline_color: '000000',
    font_size_mult: 1.2,
    shake: true,
  },
  creepy: {
    name: 'Creepy',
    highlight_color: '00FF00',
    normal_color: '006600',
    outline_color: '000000',
    font_name: 'Creepster',
    font_size_mult: 1.1,
  },
  shy: {
    name: 'Shy',
    highlight_color: 'FFB6C1',
    normal_color: 'FFC0CB',
    outline_color: 'FF69B4',
    font_size_mult: 0.9,
  },
  gloomy: {
    name: 'Gloomy',
    highlight_color: '6B7B8C',
    normal_color: '4A5568',
    outline_color: '1A202C',
    font_size_mult: 0.95,
  },
  bright: {
    name: 'Bright',
    highlight_color: 'FFFF00',
    normal_color: 'FFF700',
    outline_color: 'FF8C00',
    font_size_mult: 1.15,
  },
  energetic: {
    name: 'Energetic',
    highlight_color: 'FF6600',
    normal_color: 'FFAA00',
    outline_color: 'FF0000',
    font_size_mult: 1.25,
  },
  obnoxious: {
    name: 'Obnoxious',
    highlight_color: 'FF00FF',
    normal_color: '00FFFF',
    outline_color: 'FFFF00',
    font_size_mult: 1.3,
    rainbow: true,
  },
  romantic: {
    name: 'Romantic',
    highlight_color: 'FF1493',
    normal_color: 'FF69B4',
    outline_color: 'C71585',
    font_size_mult: 1.05,
  },
};

let currentPreset = 'vtuber';

// Range value displays
const setupRangeDisplay = (ctrl, valEl) => {
  if (!ctrl || !valEl) return;
  ctrl.oninput = () => { valEl.textContent = ctrl.value; };
};
setupRangeDisplay(controls.fontSize, $('#val-fontsize'));
setupRangeDisplay(controls.outline, $('#val-outline'));
setupRangeDisplay(controls.shadow, $('#val-shadow'));
setupRangeDisplay(controls.glow, $('#val-glow'));
setupRangeDisplay(controls.scale, $('#val-scale'));
setupRangeDisplay(controls.animSpeed, $('#val-animspeed'));
setupRangeDisplay(controls.staticAnimSpeed, $('#val-staticanimspeed'));
setupRangeDisplay(controls.marginV, $('#val-marginv'));
setupRangeDisplay(controls.marginH, $('#val-marginh'));
setupRangeDisplay(controls.letterSpacing, $('#val-letterspacing'));
setupRangeDisplay(controls.wordGap, $('#val-wordgap'));
setupRangeDisplay(controls.wpg, $('#val-wpg'));

// Update preview on control change
const updatePreviewOnChange = () => {
  subtitlePreview.className = 'subtitle-overlay pos-' + controls.position.value;
  subtitlePreview.style.fontFamily = controls.fontFamily.value + ', Impact, sans-serif';
  if (!useCustomGroups) {
    regenerateAutoGroups();
  }
};

controls.position.onchange = updatePreviewOnChange;
controls.fontFamily.onchange = updatePreviewOnChange;
controls.wpg.oninput = () => {
  $('#val-wpg').textContent = controls.wpg.value;
  if (!useCustomGroups) {
    regenerateAutoGroups();
  }
};

// Sync static text color with dynamic text color control
if (controls.textColorStatic) {
  controls.textColorStatic.oninput = () => {
    controls.textColor.value = controls.textColorStatic.value;
  };
}

// ── Preset Application ────────────────────────────
function applyDynamicPreset(presetName) {
  const preset = DYNAMIC_PRESETS[presetName];
  if (!preset) return;

  currentPreset = presetName;

  // Update UI buttons
  $$('#dynamic-presets-section .preset-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = $(`#dynamic-presets-section .preset-btn[data-preset="${presetName}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // Apply preset values to controls
  controls.fontFamily.value = preset.fontFamily;
  controls.fontSize.value = preset.fontSize;
  $('#val-fontsize').textContent = preset.fontSize;
  controls.bold.checked = preset.bold;
  controls.italic.checked = preset.italic;
  controls.uppercase.checked = preset.uppercase;
  controls.highlight.value = preset.highlight;
  controls.textColor.value = preset.textColor;
  controls.outlineColor.value = preset.outlineColor;
  controls.shadowColor.value = preset.shadowColor;
  controls.outline.value = preset.outline;
  $('#val-outline').textContent = preset.outline;
  controls.shadow.value = preset.shadow;
  $('#val-shadow').textContent = preset.shadow;
  controls.glow.value = preset.glow;
  $('#val-glow').textContent = preset.glow;
  controls.glowColor.value = preset.glowColor;
  controls.scale.value = preset.scale;
  $('#val-scale').textContent = preset.scale;
  controls.animation.value = preset.animation;
  controls.groupAnimation.value = preset.groupAnimation;
  controls.animSpeed.value = preset.animSpeed;
  $('#val-animspeed').textContent = preset.animSpeed;

  updatePreviewOnChange();
}

function applyStaticPreset(presetName) {
  const preset = STATIC_PRESETS[presetName];
  if (!preset) return;

  currentPreset = presetName;

  // Update UI buttons
  $$('#static-presets-section .preset-btn').forEach(btn => btn.classList.remove('active'));
  const activeBtn = $(`#static-presets-section .preset-btn[data-preset="${presetName}"]`);
  if (activeBtn) activeBtn.classList.add('active');

  // Apply preset values to controls
  controls.fontFamily.value = preset.fontFamily;
  controls.fontSize.value = preset.fontSize;
  $('#val-fontsize').textContent = preset.fontSize;
  controls.bold.checked = preset.bold;
  controls.italic.checked = preset.italic;
  controls.uppercase.checked = preset.uppercase;
  controls.textColor.value = preset.textColor;
  if (controls.textColorStatic) {
    controls.textColorStatic.value = preset.textColor;
  }
  controls.outlineColor.value = preset.outlineColor;
  controls.shadowColor.value = preset.shadowColor;
  controls.outline.value = preset.outline;
  $('#val-outline').textContent = preset.outline;
  controls.shadow.value = preset.shadow;
  $('#val-shadow').textContent = preset.shadow;
  controls.glow.value = preset.glow;
  $('#val-glow').textContent = preset.glow;
  controls.glowColor.value = preset.glowColor;
  
  // Static-specific controls
  if (controls.sentenceAnimation) {
    controls.sentenceAnimation.value = preset.sentenceAnimation;
  }
  if (controls.staticAnimSpeed) {
    controls.staticAnimSpeed.value = preset.animSpeed;
    const speedVal = $('#val-staticanimspeed');
    if (speedVal) speedVal.textContent = preset.animSpeed;
  }

  updatePreviewOnChange();
}

// Legacy function for backward compatibility
function applyPreset(presetName) {
  if (useDynamicMode) {
    applyDynamicPreset(presetName);
  } else {
    applyStaticPreset(presetName);
  }
}

function applyEmotion(emotionName) {
  const emotion = EMOTION_PRESETS[emotionName];
  if (!emotion) return;

  if (selectedWordIndices.size === 0) {
    // Show hint
    const info = $('#emotion-info');
    info.textContent = '⚠️ Select words first, then apply emotion';
    info.classList.add('warning');
    setTimeout(() => {
      info.textContent = 'Select words, then click an emotion to apply';
      info.classList.remove('warning');
    }, 2000);
    return;
  }

  // Calculate base font size for scaling
  const baseFontSize = parseInt(controls.fontSize.value) || 80;

  // Apply emotion to selected words
  selectedWordIndices.forEach(idx => {
    if (!currentWords[idx].style) currentWords[idx].style = {};
    currentWords[idx].style.highlight_color = emotion.highlight_color;
    currentWords[idx].style.normal_color = emotion.normal_color;
    currentWords[idx].style.outline_color = emotion.outline_color;
    if (emotion.font_name) {
      currentWords[idx].style.font_name = emotion.font_name;
    }
    if (emotion.font_size_mult) {
      currentWords[idx].style.font_size = Math.round(baseFontSize * emotion.font_size_mult);
    }
  });

  renderTranscript();
  
  // Visual feedback
  const info = $('#emotion-info');
  info.textContent = `✓ Applied "${emotion.name}" to ${selectedWordIndices.size} word(s)`;
  setTimeout(() => {
    info.textContent = 'Select words, then click an emotion to apply';
  }, 2000);
}

// ── Subtitle Mode Toggle ──────────────────────────
function setSubtitleMode(mode) {
  useDynamicMode = (mode === 'dynamic');
  
  // Update toggle buttons
  $('#mode-dynamic').classList.toggle('active', useDynamicMode);
  $('#mode-static').classList.toggle('active', !useDynamicMode);
  
  // Show/hide dynamic-only elements
  $$('.dynamic-only').forEach(el => {
    el.style.display = useDynamicMode ? '' : 'none';
  });
  
  // Show/hide static-only elements
  $$('.static-only').forEach(el => {
    el.style.display = useDynamicMode ? 'none' : '';
  });
  
  // Sync text color between static and dynamic controls
  if (!useDynamicMode) {
    // When switching to static, sync the static color control with the normal text color
    if (controls.textColorStatic) {
      controls.textColorStatic.value = controls.textColor.value;
    }
  } else {
    // When switching to dynamic, sync back
    if (controls.textColorStatic) {
      controls.textColor.value = controls.textColorStatic.value;
    }
  }
  
  // Apply appropriate default preset when switching modes
  if (useDynamicMode) {
    applyDynamicPreset('vtuber');
  } else {
    applyStaticPreset('classic');
  }
}

// ── Tab Switching ─────────────────────────────────
function switchTab(tabName) {
  $$('.sidebar-tab').forEach(t => t.classList.remove('active'));
  $$('.tab-panel').forEach(p => p.classList.remove('active'));
  $(`.sidebar-tab[data-tab="${tabName}"]`).classList.add('active');
  $(`#tab-${tabName}`).classList.add('active');
}

// ── View switching ────────────────────────────────
function showView(viewId) {
  $$('.view').forEach(v => v.classList.remove('active'));
  $('#' + viewId).classList.add('active');
}

function newTranscription() {
  showView('upload-view');
  transcribeBar.classList.remove('active');
  uploadCard.classList.remove('disabled');
  fileInput.value = '';
  currentWords = [];
  customGroups = [];
  selectedWordIndices.clear();
  loadPreviousUploads();
}

// ── Status check ──────────────────────────────────
async function checkStatus() {
  try {
    const res = await fetch('/status');
    const data = await res.json();
    if (data.gpu?.cuda_available) {
      $('#gpu-dot').classList.add('ok');
      $('#gpu-label').textContent = data.gpu.gpu_name || 'CUDA Ready';
    } else {
      $('#gpu-label').textContent = 'CPU Only';
    }
    if (data.ffmpeg?.ffmpeg) {
      $('#ffmpeg-dot').classList.add('ok');
      $('#ffmpeg-label').textContent = 'FFmpeg ✓';
    } else {
      $('#ffmpeg-label').textContent = 'FFmpeg missing';
    }
  } catch (e) {
    $('#gpu-label').textContent = 'Offline';
  }
}
checkStatus();
loadPreviousUploads();

// ── Previous Uploads ──────────────────────────────
async function loadPreviousUploads() {
  const container = $('#uploads-list');
  if (!container) return;
  container.innerHTML = '<div class="uploads-loading">Loading…</div>';
  try {
    const res = await fetch('/uploads');
    const data = await res.json();
    const files = data.files || [];

    if (files.length === 0) {
      container.innerHTML = '<div class="uploads-empty">No previous uploads found.</div>';
      return;
    }

    container.innerHTML = files.map(f => {
      const safeName = f.filename.replace(/"/g, '&quot;');
      const safeJson = f.transcription_file ? f.transcription_file.replace(/"/g, '&quot;') : '';
      const badge = f.has_transcription
        ? '<span class="upload-badge transcribed">✓ Transcribed</span>'
        : '<span class="upload-badge">Not transcribed</span>';
      const action = f.has_transcription
        ? `<button class="btn btn-primary btn-sm" onclick="loadExistingTranscription('${encodeURIComponent(f.filename)}','${encodeURIComponent(f.transcription_file)}')">Open ▶</button>`
        : `<button class="btn btn-outline btn-sm" onclick="transcribeExisting('${encodeURIComponent(f.filename)}')">Transcribe</button>`;
      return `
        <div class="upload-item">
          <div class="upload-item-icon">🎬</div>
          <div class="upload-item-info">
            <div class="upload-item-name" title="${safeName}">${safeName}</div>
            <div class="upload-item-meta">${f.size_mb} MB ${badge}</div>
          </div>
          <div class="upload-item-action">${action}</div>
        </div>`;
    }).join('');
  } catch (e) {
    container.innerHTML = '<div class="uploads-empty">Could not load uploads.</div>';
  }
}

async function loadExistingTranscription(encodedVideo, encodedJson) {
  try {
    const res = await fetch('/outputs/' + encodedJson);
    if (!res.ok) throw new Error('Transcription file not found');
    const result = await res.json();
    currentWords = result.words || [];
    currentMetadata = result.metadata || {};
    currentVideoFilename = decodeURIComponent(encodedVideo);
    openEditor();
  } catch (e) {
    alert('Failed to load transcription: ' + e.message);
  }
}

async function transcribeExisting(encodedFilename) {
  const filename = decodeURIComponent(encodedFilename);
  uploadCard.classList.add('disabled');
  transcribeBar.classList.add('active');
  progressText.textContent = 'Transcribing…';
  progressFile.textContent = filename;
  try {
    const res = await fetch('/transcribe-existing', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ filename }),
    });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Transcription failed');
    }
    const result = await res.json();
    currentWords = result.words || [];
    currentMetadata = result.metadata || {};
    currentVideoFilename = filename;
    openEditor();
  } catch (err) {
    alert('Error: ' + err.message);
    uploadCard.classList.remove('disabled');
    transcribeBar.classList.remove('active');
    loadPreviousUploads();
  }
}

// ── Upload & Transcribe ───────────────────────────
uploadCard.addEventListener('dragover', e => {
  e.preventDefault();
  uploadCard.classList.add('dragover');
});
uploadCard.addEventListener('dragleave', () => {
  uploadCard.classList.remove('dragover');
});
uploadCard.addEventListener('drop', e => {
  e.preventDefault();
  uploadCard.classList.remove('dragover');
  if (e.dataTransfer.files.length) {
    fileInput.files = e.dataTransfer.files;
    handleFileSelected();
  }
});
fileInput.addEventListener('change', handleFileSelected);

async function handleFileSelected() {
  const file = fileInput.files[0];
  if (!file) return;

  uploadCard.classList.add('disabled');
  transcribeBar.classList.add('active');
  progressText.textContent = 'Uploading & transcribing…';
  progressFile.textContent = file.name;

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch('/transcribe', { method: 'POST', body: formData });
    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Transcription failed');
    }
    const result = await res.json();
    currentWords = result.words || [];
    currentMetadata = result.metadata || {};
    currentVideoFilename = file.name;
    openEditor();
  } catch (err) {
    alert('Error: ' + err.message);
    uploadCard.classList.remove('disabled');
    transcribeBar.classList.remove('active');
  }
}

// ── Editor ────────────────────────────────────────
function openEditor() {
  video.src = '/video/' + encodeURIComponent(currentVideoFilename);
  video.load();
  selectedWordIndices.clear();
  regenerateAutoGroups();
  renderTranscript();
  showView('editor-view');
  video.addEventListener('timeupdate', onTimeUpdate);
  
  // Apply default preset based on current mode
  if (useDynamicMode) {
    applyDynamicPreset('vtuber');
  } else {
    applyStaticPreset('classic');
  }
}

// ── Transcript rendering ──────────────────────────
function renderTranscript() {
  wordCountEl.textContent = currentWords.length + ' words';

  wordListEl.innerHTML = currentWords.map((w, i) => {
    const hasStyle = w.style && Object.keys(w.style).length > 0;
    const selected = selectedWordIndices.has(i);
    const isMerged = w._merged ? 'merged' : '';
    return `
      <span class="word-chip ${selected ? 'selected' : ''} ${hasStyle ? 'has-style' : ''} ${isMerged}"
            data-index="${i}"
            title="${w.start.toFixed(2)}s – ${w.end.toFixed(2)}s"
            ondblclick="editWord(${i})"
            onclick="handleWordClick(event, ${i})">
        ${w.text}
        <button class="delete-btn" onclick="event.stopPropagation(); deleteWord(${i})">×</button>
      </span>
    `;
  }).join('');
  
  updateWordStylePanel();
  updateMergeButton();
  updateUndoButton();
}

let lastClickedIndex = -1;

function handleWordClick(event, index) {
  if (event.shiftKey && lastClickedIndex >= 0) {
    // Range selection
    const start = Math.min(lastClickedIndex, index);
    const end = Math.max(lastClickedIndex, index);
    for (let i = start; i <= end; i++) {
      selectedWordIndices.add(i);
    }
  } else if (event.ctrlKey || event.metaKey) {
    // Toggle selection
    if (selectedWordIndices.has(index)) {
      selectedWordIndices.delete(index);
    } else {
      selectedWordIndices.add(index);
    }
  } else {
    // Seek + select only this word
    seekToWord(index);
    selectedWordIndices.clear();
    selectedWordIndices.add(index);
  }
  lastClickedIndex = index;
  renderTranscript();
}

function seekToWord(index) {
  if (index >= 0 && index < currentWords.length) {
    video.currentTime = currentWords[index].start;
  }
}

function editWord(index) {
  const chip = $(`.word-chip[data-index="${index}"]`);
  if (!chip) return;
  const word = currentWords[index];

  const input = document.createElement('input');
  input.type = 'text';
  input.value = word.text;
  input.className = 'word-edit-input';

  const finish = () => {
    const newText = input.value.trim();
    if (newText && newText !== word.text) {
      saveUndoSnapshot('Edit word "' + word.text + '" → "' + newText + '"');
      currentWords[index].text = newText;
    }
    renderTranscript();
    renderGroups();
  };

  input.addEventListener('blur', finish);
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); finish(); }
    if (e.key === 'Escape') { renderTranscript(); renderGroups(); }
  });

  chip.innerHTML = '';
  chip.appendChild(input);
  input.focus();
  input.select();
}

function deleteWord(index) {
  saveUndoSnapshot('Delete word "' + currentWords[index].text + '"');
  currentWords.splice(index, 1);
  selectedWordIndices.clear();
  regenerateAutoGroups();
  renderTranscript();
  renderGroups();
}

// ── Undo System ───────────────────────────────────
function saveUndoSnapshot(actionLabel) {
  undoStack.push({
    label: actionLabel,
    words: JSON.parse(JSON.stringify(currentWords)),
    groups: JSON.parse(JSON.stringify(customGroups)),
  });
  if (undoStack.length > MAX_UNDO) undoStack.shift();
  updateUndoButton();
}

function undoAction() {
  if (undoStack.length === 0) return;
  const snapshot = undoStack.pop();
  currentWords = snapshot.words;
  customGroups = snapshot.groups;
  selectedWordIndices.clear();
  regenerateAutoGroups();
  renderTranscript();
  renderGroups();
  updateUndoButton();
}

function updateUndoButton() {
  const btn = $('#undo-btn');
  const countEl = $('#undo-count');
  if (undoStack.length > 0) {
    btn.disabled = false;
    btn.title = 'Undo: ' + undoStack[undoStack.length - 1].label;
    countEl.textContent = undoStack.length;
    countEl.style.display = 'inline';
  } else {
    btn.disabled = true;
    btn.title = 'Nothing to undo';
    countEl.style.display = 'none';
  }
}

// ── Merge Words ───────────────────────────────────
function canMergeSelected() {
  if (selectedWordIndices.size < 2) return false;
  const sorted = [...selectedWordIndices].sort((a, b) => a - b);
  // Check if indices are consecutive
  for (let i = 1; i < sorted.length; i++) {
    if (sorted[i] !== sorted[i - 1] + 1) return false;
  }
  return true;
}

function updateMergeButton() {
  const btn = $('#merge-btn');
  if (canMergeSelected()) {
    btn.disabled = false;
    btn.title = 'Merge ' + selectedWordIndices.size + ' selected words';
  } else {
    btn.disabled = true;
    if (selectedWordIndices.size < 2) {
      btn.title = 'Select 2+ adjacent words to merge';
    } else {
      btn.title = 'Selected words must be adjacent';
    }
  }
}

function mergeSelectedWords() {
  if (!canMergeSelected()) return;
  
  const sorted = [...selectedWordIndices].sort((a, b) => a - b);
  const wordsToMerge = sorted.map(i => currentWords[i]);
  const mergedText = wordsToMerge.map(w => w.text).join(' ');
  
  // Show modal to let user edit the merged text
  showMergeEditModal(mergedText, sorted, wordsToMerge);
}

function showMergeEditModal(defaultText, indices, wordsToMerge) {
  const originalTexts = wordsToMerge.map(w => w.text).join(' + ');
  
  const overlay = document.createElement('div');
  overlay.className = 'merge-edit-overlay';
  overlay.innerHTML = `
    <div class="merge-edit-modal">
      <h4>⛓ Merge Words</h4>
      <div class="merge-preview">Merging: ${originalTexts}</div>
      <input type="text" id="merge-text-input" value="${defaultText}" placeholder="Enter merged text…" />
      <div class="merge-actions">
        <button class="btn btn-outline btn-sm" onclick="closeMergeModal()">Cancel</button>
        <button class="btn btn-primary btn-sm" onclick="confirmMerge()">Merge</button>
      </div>
    </div>
  `;
  
  document.body.appendChild(overlay);
  
  // Store merge context
  window._mergeContext = { indices, wordsToMerge, overlay };
  
  const input = document.getElementById('merge-text-input');
  input.focus();
  input.select();
  input.addEventListener('keydown', e => {
    if (e.key === 'Enter') { e.preventDefault(); confirmMerge(); }
    if (e.key === 'Escape') closeMergeModal();
  });
}

function confirmMerge() {
  const ctx = window._mergeContext;
  if (!ctx) return;
  
  const input = document.getElementById('merge-text-input');
  const newText = input.value.trim();
  if (!newText) return;
  
  saveUndoSnapshot('Merge words: ' + ctx.wordsToMerge.map(w => w.text).join(' + '));
  
  const firstIdx = ctx.indices[0];
  const lastIdx = ctx.indices[ctx.indices.length - 1];
  
  // Create merged word with timing spanning all merged words
  const mergedWord = {
    text: newText,
    start: ctx.wordsToMerge[0].start,
    end: ctx.wordsToMerge[ctx.wordsToMerge.length - 1].end,
    _merged: true,  // Flag for visual indicator
  };
  
  // Replace the range with the single merged word
  currentWords.splice(firstIdx, ctx.indices.length, mergedWord);
  
  selectedWordIndices.clear();
  regenerateAutoGroups();
  renderTranscript();
  renderGroups();
  
  closeMergeModal();
}

function closeMergeModal() {
  const ctx = window._mergeContext;
  if (ctx && ctx.overlay) {
    ctx.overlay.remove();
  }
  window._mergeContext = null;
}

// ── Word Style Panel ──────────────────────────────
function updateWordStylePanel() {
  const panel = $('#word-style-panel');
  const info = $('#selected-words-info');
  
  if (selectedWordIndices.size === 0) {
    panel.classList.add('hidden');
  } else {
    panel.classList.remove('hidden');
    const texts = [...selectedWordIndices].slice(0, 5).map(i => currentWords[i]?.text || '').join(', ');
    const more = selectedWordIndices.size > 5 ? ` +${selectedWordIndices.size - 5} more` : '';
    info.textContent = `Selected: ${texts}${more}`;
  }
}

function applyWordStyle() {
  const highlightColor = $('#word-highlight').value.replace('#', '');
  const normalColor = $('#word-normal').value.replace('#', '');
  const fontSize = $('#word-fontsize').value ? parseInt($('#word-fontsize').value) : null;
  const outlineColor = $('#word-outline').value.replace('#', '');
  
  selectedWordIndices.forEach(idx => {
    if (!currentWords[idx].style) currentWords[idx].style = {};
    currentWords[idx].style.highlight_color = highlightColor;
    currentWords[idx].style.normal_color = normalColor;
    if (fontSize) currentWords[idx].style.font_size = fontSize;
    currentWords[idx].style.outline_color = outlineColor;
  });
  
  renderTranscript();
}

function clearWordStyles() {
  selectedWordIndices.forEach(idx => {
    delete currentWords[idx].style;
  });
  renderTranscript();
}

// ── Groups ────────────────────────────────────────
function setGroupMode(mode) {
  useCustomGroups = (mode === 'custom');
  $('#mode-auto').classList.toggle('active', !useCustomGroups);
  $('#mode-custom').classList.toggle('active', useCustomGroups);
  $('#auto-group-controls').style.display = useCustomGroups ? 'none' : 'block';
  $('#custom-group-controls').style.display = useCustomGroups ? 'block' : 'none';
  
  if (useCustomGroups && customGroups.length === 0) {
    regenerateAutoGroups();
  }
  renderGroups();
}

function regenerateAutoGroups() {
  const wpg = parseInt(controls.wpg.value) || 4;
  customGroups = [];
  for (let i = 0; i < currentWords.length; i += wpg) {
    const chunk = currentWords.slice(i, i + wpg);
    if (chunk.length === 0) continue;
    customGroups.push({
      word_indices: Array.from({ length: chunk.length }, (_, j) => i + j),
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
    });
  }
  renderGroups();
  renderTranscript();
}

function autoGenerateGroups() {
  regenerateAutoGroups();
}

function renderGroups() {
  const container = $('#group-list');
  container.innerHTML = customGroups.map((g, gi) => {
    const words = g.word_indices.map(i => currentWords[i]?.text || '').join(' ');
    return `
      <div class="group-item" data-group="${gi}">
        <div class="group-item-header">
          <span class="group-item-num">Group ${gi + 1}</span>
          <div class="group-item-actions">
            <button onclick="event.stopPropagation(); splitGroup(${gi})">Split</button>
            <button onclick="event.stopPropagation(); mergeWithNext(${gi})">Merge→</button>
          </div>
        </div>
        <div class="group-item-words">${words}</div>
        <div class="group-item-timing">
          <label>Start</label>
          <input type="number" step="0.01" value="${g.start.toFixed(2)}" onchange="updateGroupTiming(${gi}, 'start', this.value)" />
          <label>End</label>
          <input type="number" step="0.01" value="${g.end.toFixed(2)}" onchange="updateGroupTiming(${gi}, 'end', this.value)" />
        </div>
      </div>
    `;
  }).join('');
}

function updateGroupTiming(groupIdx, field, value) {
  const val = parseFloat(value);
  if (!isNaN(val) && val >= 0) {
    customGroups[groupIdx][field] = val;
  }
}

function splitGroup(groupIdx) {
  const group = customGroups[groupIdx];
  if (group.word_indices.length < 2) return;
  
  const mid = Math.ceil(group.word_indices.length / 2);
  const firstHalf = group.word_indices.slice(0, mid);
  const secondHalf = group.word_indices.slice(mid);
  
  const firstEnd = currentWords[firstHalf[firstHalf.length - 1]]?.end || group.start;
  const secondStart = currentWords[secondHalf[0]]?.start || firstEnd;
  
  customGroups.splice(groupIdx, 1, 
    { word_indices: firstHalf, start: group.start, end: firstEnd },
    { word_indices: secondHalf, start: secondStart, end: group.end }
  );
  renderGroups();
  renderTranscript();
}

function mergeWithNext(groupIdx) {
  if (groupIdx >= customGroups.length - 1) return;
  
  const g1 = customGroups[groupIdx];
  const g2 = customGroups[groupIdx + 1];
  
  customGroups.splice(groupIdx, 2, {
    word_indices: [...g1.word_indices, ...g2.word_indices],
    start: g1.start,
    end: g2.end,
  });
  renderGroups();
  renderTranscript();
}

// ── Subtitle preview sync ─────────────────────────
function getActiveGroups() {
  if (useCustomGroups) {
    return customGroups.map(g => ({
      words: g.word_indices.map(i => currentWords[i]),
      start: g.start,
      end: g.end,
    }));
  }
  const wpg = parseInt(controls.wpg.value) || 4;
  const groups = [];
  for (let i = 0; i < currentWords.length; i += wpg) {
    const chunk = currentWords.slice(i, i + wpg);
    if (chunk.length === 0) continue;
    groups.push({
      words: chunk,
      start: chunk[0].start,
      end: chunk[chunk.length - 1].end,
    });
  }
  return groups;
}

function onTimeUpdate() {
  const t = video.currentTime;
  const upper = controls.uppercase.checked;
  const highlightColor = controls.highlight.value;
  // Use static text color control in static mode, fallback to normal textColor
  const textColor = useDynamicMode 
    ? controls.textColor.value 
    : (controls.textColorStatic?.value || controls.textColor.value);
  const fontSizeASS = parseInt(controls.fontSize.value) || 80;
  const fontFamily = controls.fontFamily.value;
  const scale = parseInt(controls.scale.value) / 100;
  const glowStrength = parseInt(controls.glow.value) || 0;
  const glowColor = controls.glowColor.value;
  const outlineColor = controls.outlineColor.value;
  const outlineWidth = parseInt(controls.outline.value) || 4;
  const groups = getActiveGroups();

  // Scale font size proportionally: ASS font_size is relative to video height.
  // Compute the ratio of the displayed video height to actual video height.
  const videoEl = $('#subtitle-box video') || video;
  const displayedHeight = videoEl.clientHeight || videoEl.offsetHeight || 1;
  const actualHeight = videoEl.videoHeight || currentMetadata.height || 1080;
  const scaledFontSize = (fontSizeASS * displayedHeight / actualHeight) + 'px';

  // Calculate glow text-shadow
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
    if (t >= g.start && t <= g.end + 0.15) {
      activeGroup = g;
      break;
    }
  }

  if (!activeGroup) {
    subtitlePreview.innerHTML = '';
    $$('.word-chip.playing').forEach(el => el.classList.remove('playing'));
    return;
  }

  // Find active word
  let activeIdx = -1;
  for (let i = 0; i < activeGroup.words.length; i++) {
    if (t >= activeGroup.words[i].start && t <= activeGroup.words[i].end) {
      activeIdx = i;
      break;
    }
  }
  if (activeIdx === -1) {
    for (let i = activeGroup.words.length - 1; i >= 0; i--) {
      if (t >= activeGroup.words[i].start) {
        activeIdx = i;
        break;
      }
    }
  }

  // Render overlay
  subtitlePreview.style.fontSize = scaledFontSize;
  subtitlePreview.style.fontFamily = fontFamily + ', Impact, sans-serif';
  subtitlePreview.style.letterSpacing = (parseInt(controls.letterSpacing.value) || 0) + 'px';
  subtitlePreview.style.wordSpacing = (parseInt(controls.wordGap.value) || 0) * 4 + 'px';
  subtitlePreview.style.textShadow = textShadow;

  // Scale margin_v proportionally so bottom position matches rendered output
  const marginVASS = parseInt(controls.marginV.value) || 60;
  const scaledMarginV = Math.round(marginVASS * displayedHeight / actualHeight);
  if (controls.position.value === 'bottom') {
    subtitlePreview.style.paddingBottom = scaledMarginV + 'px';
  } else if (controls.position.value === 'top') {
    subtitlePreview.style.paddingTop = scaledMarginV + 'px';
  }

  // Static mode: show whole sentence in normal color
  if (!useDynamicMode) {
    const sentence = activeGroup.words.map(w => upper ? w.text.toUpperCase() : w.text).join(' ');
    subtitlePreview.innerHTML = `<span class="subtitle-word" style="color:${textColor};">${sentence}</span>`;
    $$('.word-chip.playing').forEach(el => el.classList.remove('playing'));
    return;
  }

  // Dynamic mode: per-word highlighting
  subtitlePreview.innerHTML = activeGroup.words.map((w, i) => {
    const text = upper ? w.text.toUpperCase() : w.text;
    const isActive = i === activeIdx;
    
    // Check for per-word style
    const wordStyle = w.style || {};
    let color = isActive 
      ? (wordStyle.highlight_color ? '#' + wordStyle.highlight_color : highlightColor)
      : (wordStyle.normal_color ? '#' + wordStyle.normal_color : textColor);
    
    const scaleVal = isActive ? `scale(${scale})` : 'scale(1)';
    const fs = wordStyle.font_size ? `font-size:${Math.round(wordStyle.font_size * displayedHeight / actualHeight)}px;` : '';
    
    return `<span class="subtitle-word" style="color:${color}; transform:${scaleVal}; ${fs}">${text}</span>`;
  }).join(' ');

  // Highlight in transcript
  $$('.word-chip.playing').forEach(el => el.classList.remove('playing'));
  if (activeIdx >= 0) {
    const globalIdx = currentWords.indexOf(activeGroup.words[activeIdx]);
    const chip = $(`.word-chip[data-index="${globalIdx}"]`);
    if (chip) {
      chip.classList.add('playing');
      const wordList = document.getElementById('word-list');
      const chipTop = chip.offsetTop - wordList.offsetTop;
      const chipBottom = chipTop + chip.offsetHeight;
      const scrollTop = wordList.scrollTop;
      const scrollBottom = scrollTop + wordList.clientHeight;
      if (chipTop < scrollTop) {
        wordList.scrollTop = chipTop;
      } else if (chipBottom > scrollBottom) {
        wordList.scrollTop = chipBottom - wordList.clientHeight;
      }
    }
  }
}

// ── Render ────────────────────────────────────────
function getStyleConfig() {
  return {
    words_per_group: parseInt(controls.wpg.value) || 4,
    use_custom_groups: useCustomGroups,
    dynamic_mode: useDynamicMode,
    font_name: controls.fontFamily.value,
    font_size: parseInt(controls.fontSize.value) || 80,
    bold: controls.bold.checked,
    italic: controls.italic.checked,
    highlight_color: controls.highlight.value.replace('#', ''),
    normal_color: useDynamicMode 
      ? controls.textColor.value.replace('#', '')
      : (controls.textColorStatic?.value || controls.textColor.value).replace('#', ''),
    outline_color: controls.outlineColor.value.replace('#', ''),
    shadow_color: controls.shadowColor.value.replace('#', ''),
    outline_width: parseInt(controls.outline.value) || 4,
    shadow_depth: parseInt(controls.shadow.value) || 2,
    glow_strength: parseInt(controls.glow.value) || 0,
    glow_color: controls.glowColor.value.replace('#', ''),
    position: controls.position.value,
    margin_v: parseInt(controls.marginV.value) || 60,
    margin_h: parseInt(controls.marginH.value) || 10,
    letter_spacing: parseInt(controls.letterSpacing.value) || 0,
    word_gap: parseInt(controls.wordGap.value) || 0,
    scale_highlight: parseInt(controls.scale.value) || 100,
    // Dynamic mode animation
    animation: controls.animation.value,
    group_animation: controls.groupAnimation.value,
    anim_speed: parseInt(controls.animSpeed.value) || 200,
    // Static mode animation
    sentence_animation: controls.sentenceAnimation?.value || 'fade-in',
    static_anim_speed: parseInt(controls.staticAnimSpeed?.value) || 300,
    uppercase: controls.uppercase.checked,
  };
}

async function startRender() {
  if (!currentWords.length || !currentVideoFilename) {
    alert('No transcription loaded.');
    return;
  }

  renderOverlay.classList.add('active');
  $('#render-title').textContent = 'Rendering…';
  $('#render-status-text').textContent = 'Starting…';
  $('#render-progress-fill').style.animation = 'indeterminate 1.5s infinite ease-in-out';
  $('#render-progress-fill').style.width = '30%';
  $('#download-area').style.display = 'none';
  $('#render-btn').disabled = true;

  try {
    const payload = {
      video_filename: currentVideoFilename,
      words: currentWords,
      style: getStyleConfig(),
    };
    
    if (useCustomGroups && customGroups.length > 0) {
      payload.word_groups = customGroups;
    }

    const res = await fetch('/render', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.detail || 'Render request failed');
    }

    const { render_id } = await res.json();
    pollRenderStatus(render_id);
  } catch (err) {
    alert('Render error: ' + err.message);
    closeRenderOverlay();
  }
}

function pollRenderStatus(renderId) {
  const interval = setInterval(async () => {
    try {
      const res = await fetch('/render-status/' + renderId);
      const data = await res.json();

      if (data.status === 'generating_subtitles') {
        $('#render-status-text').textContent = 'Generating subtitle file…';
      } else if (data.status === 'rendering') {
        $('#render-status-text').textContent = 'Burning subtitles into video…';
      } else if (data.status === 'done') {
        clearInterval(interval);
        $('#render-title').textContent = 'Render Complete!';
        $('#render-status-text').textContent = `File: ${data.filename} (${data.size_mb} MB)`;
        $('#render-progress-fill').style.animation = 'none';
        $('#render-progress-fill').style.width = '100%';

        const link = $('#download-link');
        link.href = data.url;
        link.textContent = '📥 Download (' + data.size_mb + ' MB)';
        $('#download-area').style.display = 'block';
        $('#render-btn').disabled = false;
      } else if (data.status === 'error') {
        clearInterval(interval);
        $('#render-title').textContent = 'Render Failed';
        $('#render-status-text').textContent = data.error || 'Unknown error';
        $('#render-progress-fill').style.animation = 'none';
        $('#render-progress-fill').style.width = '100%';
        $('#render-progress-fill').style.background = 'var(--error)';
        $('#download-area').innerHTML = '<button class="btn btn-outline" onclick="closeRenderOverlay()">Close</button>';
        $('#download-area').style.display = 'block';
        $('#render-btn').disabled = false;
      }
    } catch (e) {
      // network error, keep polling
    }
  }, 2000);
}

function closeRenderOverlay() {
  renderOverlay.classList.remove('active');
  $('#render-btn').disabled = false;
}