// ── State ─────────────────────────────────────────
let currentWords = [];
let currentVideoFilename = '';
let currentMetadata = {};
let selectedWordIndices = new Set(); // For word selection
let customGroups = [];  // Custom groups with timing
let useCustomGroups = false;
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
  outlineColor: $('#ctrl-outlinecolor'),
  shadowColor: $('#ctrl-shadowcolor'),
  outline: $('#ctrl-outline'),
  shadow: $('#ctrl-shadow'),
  scale: $('#ctrl-scale'),
  animation: $('#ctrl-animation'),
  position: $('#ctrl-position'),
  marginV: $('#ctrl-marginv'),
  marginH: $('#ctrl-marginh'),
  wpg: $('#ctrl-wpg'),
};

// Range value displays
const setupRangeDisplay = (ctrl, valEl) => {
  ctrl.oninput = () => { valEl.textContent = ctrl.value; };
};
setupRangeDisplay(controls.fontSize, $('#val-fontsize'));
setupRangeDisplay(controls.outline, $('#val-outline'));
setupRangeDisplay(controls.shadow, $('#val-shadow'));
setupRangeDisplay(controls.scale, $('#val-scale'));
setupRangeDisplay(controls.marginV, $('#val-marginv'));
setupRangeDisplay(controls.marginH, $('#val-marginh'));
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
  const textColor = controls.textColor.value;
  const fontSizeASS = parseInt(controls.fontSize.value) || 80;
  const fontFamily = controls.fontFamily.value;
  const scale = parseInt(controls.scale.value) / 100;
  const groups = getActiveGroups();

  // Scale font size proportionally: ASS font_size is relative to video height.
  // Compute the ratio of the displayed video height to actual video height.
  const videoEl = $('#subtitle-box video') || video;
  const displayedHeight = videoEl.clientHeight || videoEl.offsetHeight || 1;
  const actualHeight = videoEl.videoHeight || currentMetadata.height || 1080;
  const scaledFontSize = (fontSizeASS * displayedHeight / actualHeight) + 'px';

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

  // Scale margin_v proportionally so bottom position matches rendered output
  const marginVASS = parseInt(controls.marginV.value) || 60;
  const scaledMarginV = Math.round(marginVASS * displayedHeight / actualHeight);
  if (controls.position.value === 'bottom') {
    subtitlePreview.style.paddingBottom = scaledMarginV + 'px';
  } else if (controls.position.value === 'top') {
    subtitlePreview.style.paddingTop = scaledMarginV + 'px';
  }

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
    font_name: controls.fontFamily.value,
    font_size: parseInt(controls.fontSize.value) || 80,
    bold: controls.bold.checked,
    italic: controls.italic.checked,
    highlight_color: controls.highlight.value.replace('#', ''),
    normal_color: controls.textColor.value.replace('#', ''),
    outline_color: controls.outlineColor.value.replace('#', ''),
    shadow_color: controls.shadowColor.value.replace('#', ''),
    outline_width: parseInt(controls.outline.value) || 4,
    shadow_depth: parseInt(controls.shadow.value) || 2,
    position: controls.position.value,
    margin_v: parseInt(controls.marginV.value) || 60,
    margin_h: parseInt(controls.marginH.value) || 10,
    scale_highlight: parseInt(controls.scale.value) || 115,
    animation: controls.animation.value,
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