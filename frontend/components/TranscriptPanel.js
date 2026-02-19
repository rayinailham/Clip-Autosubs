import { ref, computed } from 'vue';
import store, { saveUndoSnapshot, undoAction, redoAction, regenerateAutoGroups, getSpeakerColor, getUniqueSpeakers } from '../store.js';
import { transcribeExistingFile } from '../api.js';

export default {
  name: 'TranscriptPanel',
  emits: ['seek'],
  setup(_, { emit }) {
    const showMergeModal = ref(false);
    const mergeText = ref('');
    const mergeContext = ref(null);
    const reTranscribing = ref(false);

    const wordCount = computed(() => store.words.length);
    const undoCount = computed(() => store.undoStack.length);
    const undoDisabled = computed(() => store.undoStack.length === 0);
    const undoTitle = computed(() =>
      store.undoStack.length > 0
        ? 'Undo: ' + store.undoStack[store.undoStack.length - 1].label
        : 'Nothing to undo'
    );

    function canMerge() {
      if (store.selectedWordIndices.size < 2) return false;
      const sorted = [...store.selectedWordIndices].sort((a, b) => a - b);
      for (let i = 1; i < sorted.length; i++) {
        if (sorted[i] !== sorted[i - 1] + 1) return false;
      }
      return true;
    }

    const mergeEnabled = computed(() => canMerge());
    const mergeTitle = computed(() => {
      if (store.selectedWordIndices.size < 2) return 'Select 2+ adjacent words to merge';
      if (!canMerge()) return 'Selected words must be adjacent';
      return 'Merge ' + store.selectedWordIndices.size + ' selected words';
    });

    function handleWordClick(event, index) {
      if (event.shiftKey && store.lastClickedIndex >= 0) {
        const start = Math.min(store.lastClickedIndex, index);
        const end = Math.max(store.lastClickedIndex, index);
        const newSet = new Set(store.selectedWordIndices);
        for (let i = start; i <= end; i++) newSet.add(i);
        store.selectedWordIndices = newSet;
      } else if (event.ctrlKey || event.metaKey) {
        const newSet = new Set(store.selectedWordIndices);
        if (newSet.has(index)) newSet.delete(index); else newSet.add(index);
        store.selectedWordIndices = newSet;
      } else {
        emit('seek', store.words[index].start);
        store.selectedWordIndices = new Set([index]);
      }
      store.lastClickedIndex = index;
    }

    function editWord(index) {
      // Create inline input via DOM (same as original)
      const chip = document.querySelector('.word-chip[data-index="' + index + '"]');
      if (!chip) return;
      const word = store.words[index];
      const input = document.createElement('input');
      input.type = 'text';
      input.value = word.text;
      input.className = 'word-edit-input';
      const finish = () => {
        const newText = input.value.trim();
        if (newText && newText !== word.text) {
          saveUndoSnapshot('Edit word "' + word.text + '" → "' + newText + '"');
          store.words[index].text = newText;
        }
      };
      input.addEventListener('blur', finish);
      input.addEventListener('keydown', e => {
        if (e.key === 'Enter') { e.preventDefault(); finish(); }
        if (e.key === 'Escape') { /* just blur */ input.blur(); }
      });
      chip.innerHTML = '';
      chip.appendChild(input);
      input.focus();
      input.select();
    }

    function deleteWord(index) {
      saveUndoSnapshot('Delete word "' + store.words[index].text + '"');
      store.words.splice(index, 1);
      store.selectedWordIndices = new Set();
      regenerateAutoGroups();
    }

    function openMergeModal() {
      if (!canMerge()) return;
      const sorted = [...store.selectedWordIndices].sort((a, b) => a - b);
      const wordsToMerge = sorted.map(i => store.words[i]);
      mergeText.value = wordsToMerge.map(w => w.text).join(' ');
      mergeContext.value = { indices: sorted, wordsToMerge };
      showMergeModal.value = true;
    }

    function confirmMerge() {
      const ctx = mergeContext.value;
      if (!ctx || !mergeText.value.trim()) return;
      saveUndoSnapshot('Merge words: ' + ctx.wordsToMerge.map(w => w.text).join(' + '));
      const firstIdx = ctx.indices[0];
      const mergedWord = {
        text: mergeText.value.trim(),
        start: ctx.wordsToMerge[0].start,
        end: ctx.wordsToMerge[ctx.wordsToMerge.length - 1].end,
        _merged: true,
      };
      store.words.splice(firstIdx, ctx.indices.length, mergedWord);
      store.selectedWordIndices = new Set();
      regenerateAutoGroups();
      closeMergeModal();
    }

    function closeMergeModal() {
      showMergeModal.value = false;
      mergeContext.value = null;
    }

    function newTranscription() {
      store.currentView = 'upload';
      store.transcribing = false;
      store.words = [];
      store.customGroups = [];
      store.selectedWordIndices = new Set();
    }

    async function reTranscribe() {
      if (!store.videoFilename) return;
      if (!confirm('Re-transcribe "' + store.videoFilename + '"?\\nThis will replace all current words and edits.')) return;
      reTranscribing.value = true;
      try {
        const result = await transcribeExistingFile(store.videoFilename);
        store.words = result.words || [];
        store.metadata = result.metadata || {};
        store.customGroups = [];
        store.selectedWordIndices = new Set();
        store.useCustomGroups = false;
        store.undoStack = [];
        store.redoStack = [];
        regenerateAutoGroups();
      } catch (err) {
        alert('Re-transcription failed: ' + err.message);
      }
      reTranscribing.value = false;
    }

    function isSelected(i) { return store.selectedWordIndices.has(i); }
    function hasStyle(w) { return w.style && Object.keys(w.style).length > 0; }
    function isHidden(i) { return store.hiddenWordIndices && store.hiddenWordIndices.includes(i); }

    // Speaker support
    const hasSpeakers = computed(() => getUniqueSpeakers().length > 1);

    function isSpeakerStart(i) {
      if (!hasSpeakers.value) return false;
      const w = store.words[i];
      if (!w || !w.speaker) return false;
      if (i === 0) return true;
      return store.words[i - 1].speaker !== w.speaker;
    }

    function speakerLabel(w) {
      if (!w.speaker) return '';
      return store.speakers[w.speaker] || w.speaker.replace('SPEAKER_', 'Speaker ');
    }

    function wordSpeakerStyle(w) {
      if (!hasSpeakers.value || !w.speaker) return {};
      const c = getSpeakerColor(w.speaker);
      return { borderLeftColor: c.border, borderLeftWidth: '3px', borderLeftStyle: 'solid' };
    }

    function speakerBadgeStyle(w) {
      if (!w.speaker) return {};
      const c = getSpeakerColor(w.speaker);
      return { background: c.label, color: '#fff' };
    }

    return {
      store, wordCount, undoCount, undoDisabled, undoTitle,
      mergeEnabled, mergeTitle,
      handleWordClick, editWord, deleteWord,
      undoAction, openMergeModal, confirmMerge, closeMergeModal,
      newTranscription, reTranscribe, reTranscribing, isSelected, hasStyle, isHidden,
      showMergeModal, mergeText, mergeContext,
      hasSpeakers, isSpeakerStart, speakerLabel, wordSpeakerStyle, speakerBadgeStyle,
    };
  },
  template: `
    <div class="transcript-panel">
      <div class="transcript-header">
        <h3>📝 Transcript</h3>
        <span class="transcript-meta">{{ wordCount }} words</span>
      </div>
      <div class="transcript-toolbar">
        <button class="toolbar-btn undo-btn" @click="undoAction" :disabled="undoDisabled" :title="undoTitle">
          ↩ Undo <span v-if="undoCount > 0" class="undo-count">{{ undoCount }}</span>
        </button>
        <div class="toolbar-separator"></div>
        <button class="toolbar-btn merge-btn" @click="openMergeModal" :disabled="!mergeEnabled" :title="mergeTitle">
          ⛓ Merge Words
        </button>
      </div>
      <div class="word-list" id="word-list">
        <template v-for="(w, i) in store.words" :key="i">
          <div v-if="isSpeakerStart(i)" class="speaker-divider">
            <span class="speaker-badge" :style="speakerBadgeStyle(w)">{{ speakerLabel(w) }}</span>
          </div>
          <span class="word-chip"
                :class="{ selected: isSelected(i), 'has-style': hasStyle(w), merged: w._merged, 'word-hidden': isHidden(i) }"
                :style="wordSpeakerStyle(w)"
                :data-index="i"
                :title="w.start.toFixed(2) + 's – ' + w.end.toFixed(2) + 's' + (w.speaker ? ' [' + speakerLabel(w) + ']' : '') + (isHidden(i) ? ' (hidden - overlap)' : '')"
                @dblclick="editWord(i)"
                @click="handleWordClick($event, i)">
            {{ w.text }}
            <button class="delete-btn" @click.stop="deleteWord(i)">×</button>
          </span>
        </template>
      </div>
      <div class="transcript-footer">
        <button class="btn btn-outline btn-sm" @click="newTranscription">⬆ New File</button>
        <button class="btn btn-outline btn-sm btn-retranscribe" @click="reTranscribe" :disabled="reTranscribing" :title="'Re-transcribe ' + store.videoFilename">
          {{ reTranscribing ? '⏳ Transcribing…' : '🔄 Re-Transcribe' }}
        </button>
        <span style="flex:1"></span>
        <span style="font-size:0.7rem; color:var(--text-dim);">Click to seek • Dbl-click to edit • Shift+click to select range</span>
      </div>

      <!-- Merge Modal -->
      <div v-if="showMergeModal" class="merge-edit-overlay" @click.self="closeMergeModal">
        <div class="merge-edit-modal">
          <h4>⛓ Merge Words</h4>
          <div class="merge-preview" v-if="mergeContext">Merging: {{ mergeContext.wordsToMerge.map(w => w.text).join(' + ') }}</div>
          <input type="text" v-model="mergeText" placeholder="Enter merged text…"
                 @keydown.enter.prevent="confirmMerge" @keydown.escape="closeMergeModal" ref="mergeInput" />
          <div class="merge-actions">
            <button class="btn btn-outline btn-sm" @click="closeMergeModal">Cancel</button>
            <button class="btn btn-primary btn-sm" @click="confirmMerge">Merge</button>
          </div>
        </div>
      </div>
    </div>
  `,
};
