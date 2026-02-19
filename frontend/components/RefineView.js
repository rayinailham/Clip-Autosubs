import { ref, computed, onBeforeUnmount } from 'vue';
import store, { regenerateAutoGroups } from '../store.js';
import { fetchUploads, uploadAndTranscribe, startRefineJob, pollRefineStatus, videoURL } from '../api.js';

export default {
  name: 'RefineView',
  setup() {
    const uploads = ref([]);
    const loading = ref(false);
    const apiKey = ref(store.refine.geminiApiKey || '');
    const selectedFile = ref('');
    const uploading = ref(false);
    const uploadFile = ref(null);
    const step = ref('setup');  // 'setup' | 'processing' | 'done' | 'error'
    const progress = ref({ step: '', message: '' });
    const error = ref('');
    const pollTimer = ref(null);

    const STEP_ORDER = ['init', 'transcribe', 'silence', 'analyze', 'apply', 'done'];
    const STEP_LABELS = {
      init: 'Initializing…',
      transcribe: 'Transcribing with WhisperX',
      silence: 'Cutting silences',
      analyze: 'Analyzing with Gemini AI',
      apply: 'Applying refinements',
      done: 'Complete!',
    };

    const stepIndex = computed(() => {
      const idx = STEP_ORDER.indexOf(progress.value.step);
      return idx >= 0 ? idx : 0;
    });

    const progressPct = computed(() => {
      return Math.round((stepIndex.value / (STEP_ORDER.length - 1)) * 100);
    });

    async function loadUploads() {
      loading.value = true;
      try {
        const data = await fetchUploads();
        uploads.value = (data.files || []).filter(f =>
          f.filename.endsWith('.mp4') || f.filename.endsWith('.mov') || f.filename.endsWith('.webm')
        );
      } catch (e) {
        console.error('Failed to load uploads:', e);
      }
      loading.value = false;
    }
    loadUploads();

    function onFileSelected(e) {
      const file = e.target.files[0];
      if (file) {
        uploadFile.value = file;
        selectedFile.value = '';  // clear dropdown selection
      }
    }

    function onDropFile(e) {
      e.preventDefault();
      const file = e.dataTransfer.files[0];
      if (file) {
        uploadFile.value = file;
        selectedFile.value = '';
      }
    }

    function canStart() {
      return apiKey.value.trim() && (selectedFile.value || uploadFile.value);
    }

    async function startRefine() {
      if (!canStart()) return;

      error.value = '';
      step.value = 'processing';
      progress.value = { step: 'init', message: 'Preparing…' };
      store.refine.geminiApiKey = apiKey.value.trim();

      let filename = selectedFile.value;

      // If a new file was dropped/selected, upload it first
      if (uploadFile.value) {
        progress.value = { step: 'init', message: 'Uploading video…' };
        uploading.value = true;
        try {
          const formData = new FormData();
          formData.append('file', uploadFile.value);
          const res = await fetch('/upload-only', { method: 'POST', body: formData });
          if (!res.ok) {
            const err = await res.json();
            throw new Error(err.detail || 'Upload failed');
          }
          const data = await res.json();
          filename = data.filename;
        } catch (e) {
          error.value = 'Upload failed: ' + e.message;
          step.value = 'error';
          uploading.value = false;
          return;
        }
        uploading.value = false;
      }

      // Start refine job
      try {
        const { job_id } = await startRefineJob({
          video_filename: filename,
          gemini_api_key: apiKey.value.trim(),
        });
        store.refine.jobId = job_id;
        startPolling(job_id);
      } catch (e) {
        error.value = 'Failed to start refine: ' + e.message;
        step.value = 'error';
      }
    }

    function startPolling(jobId) {
      pollTimer.value = setInterval(async () => {
        try {
          const data = await pollRefineStatus(jobId);
          progress.value = {
            step: data.step || data.status,
            message: data.message || '',
          };

          if (data.status === 'done') {
            clearInterval(pollTimer.value);
            pollTimer.value = null;
            step.value = 'done';
            applyResults(data);
          } else if (data.status === 'error') {
            clearInterval(pollTimer.value);
            pollTimer.value = null;
            error.value = data.error || 'Unknown error';
            step.value = 'error';
          }
        } catch (e) {
          // Network error — keep polling
        }
      }, 2000);
    }

    function applyResults(data) {
      // Load refined data into store and switch to editor
      store.words = data.words || [];
      store.videoFilename = data.video_filename || '';
      store.metadata = data.metadata || {};
      store.speakers = data.speakers || {};
      store.hiddenWordIndices = data.hidden_indices || [];
      store.hook = data.hook || null;

      // Apply smart groups
      if (data.groups && data.groups.length > 0) {
        store.customGroups = data.groups.map(g => ({
          word_indices: g.word_indices,
          start: g.start,
          end: g.end,
          speaker: g.speaker || 'SPEAKER_1',
        }));
        store.useCustomGroups = true;
      } else {
        regenerateAutoGroups();
      }

      // Apply dynamic subtitle preset
      store.useDynamicMode = true;
      store.style.animation = 'color-only';
      store.style.groupAnimation = 'pop-in';

      // Reset editor state
      store.selectedWordIndices = new Set();
      store.undoStack = [];
      store.redoStack = [];
      store.splitPoints = [];
      store.removedSegments = [];

      // Navigate to editor
      store.appMode = 'subtitle';
      store.currentView = 'editor';
    }

    function openInEditor() {
      applyResults(store.refine.result);
    }

    function goHome() {
      store.appMode = 'home';
    }

    function reset() {
      step.value = 'setup';
      error.value = '';
      uploadFile.value = null;
      selectedFile.value = '';
      progress.value = { step: '', message: '' };
    }

    onBeforeUnmount(() => {
      if (pollTimer.value) clearInterval(pollTimer.value);
    });

    return {
      uploads, loading, apiKey, selectedFile, uploading, uploadFile, step,
      progress, error, progressPct, stepIndex,
      STEP_ORDER, STEP_LABELS,
      onFileSelected, onDropFile, canStart, startRefine, openInEditor, goHome, reset,
    };
  },
  template: `
    <div class="refine-view">
      <!-- SETUP STEP -->
      <div v-if="step === 'setup'" class="refine-setup">
        <div class="refine-header">
          <button class="btn btn-outline btn-sm" @click="goHome">← Back</button>
          <h1 class="refine-title">✨ Auto-Refine</h1>
          <p class="refine-subtitle">
            Upload a vertical video and let AI do the rest: transcribe, identify speakers,
            smart-group subtitles, cut silences, and find the best hook.
          </p>
        </div>

        <div class="refine-form">
          <!-- API Key -->
          <div class="refine-field">
            <label class="refine-label">🔑 Gemini API Key</label>
            <input type="password" class="refine-input" v-model="apiKey"
                   placeholder="Paste your Google Gemini API key…"
                   autocomplete="off" />
            <span class="refine-hint">
              Get one free at
              <a href="https://aistudio.google.com/apikey" target="_blank" rel="noopener">aistudio.google.com/apikey</a>
            </span>
          </div>

          <!-- Video Selection -->
          <div class="refine-field">
            <label class="refine-label">🎬 Video</label>

            <!-- Upload new -->
            <div class="refine-upload-area"
                 @dragover.prevent
                 @drop="onDropFile"
                 @click="$refs.fileInput.click()">
              <input type="file" ref="fileInput" accept="video/*" @change="onFileSelected" style="display:none" />
              <div v-if="uploadFile" class="refine-upload-selected">
                📎 {{ uploadFile.name }} ({{ (uploadFile.size / 1024 / 1024).toFixed(1) }} MB)
                <button class="btn-clear" @click.stop="uploadFile = null">×</button>
              </div>
              <div v-else class="refine-upload-prompt">
                📁 Drop a video here or click to browse
              </div>
            </div>

            <!-- Or pick existing -->
            <div v-if="uploads.length > 0" class="refine-or">— or pick an existing upload —</div>
            <select v-if="uploads.length > 0" class="refine-select" v-model="selectedFile" @change="uploadFile = null">
              <option value="">Select an uploaded video…</option>
              <option v-for="f in uploads" :key="f.filename" :value="f.filename">
                {{ f.filename }} ({{ f.size_mb }} MB)
              </option>
            </select>
          </div>

          <!-- Start Button -->
          <button class="btn btn-primary btn-lg refine-start-btn"
                  :disabled="!canStart()"
                  @click="startRefine">
            🚀 Start Auto-Refine
          </button>
        </div>
      </div>

      <!-- PROCESSING STEP -->
      <div v-else-if="step === 'processing'" class="refine-processing">
        <h2 class="refine-proc-title">🔄 Refining your video…</h2>
        <p class="refine-proc-sub">This may take a few minutes. Don't close this tab.</p>

        <div class="refine-progress-bar">
          <div class="refine-progress-fill" :style="{ width: progressPct + '%' }"></div>
        </div>
        <div class="refine-progress-label">{{ progressPct }}%</div>

        <div class="refine-steps">
          <div v-for="(s, si) in STEP_ORDER" :key="s"
               class="refine-step"
               :class="{
                 active: progress.step === s,
                 done: stepIndex > si,
                 pending: stepIndex < si
               }">
            <span class="refine-step-icon">
              <template v-if="stepIndex > si">✅</template>
              <template v-else-if="progress.step === s">⏳</template>
              <template v-else>○</template>
            </span>
            <span class="refine-step-label">{{ STEP_LABELS[s] }}</span>
          </div>
        </div>

        <div v-if="progress.message" class="refine-log">{{ progress.message }}</div>
      </div>

      <!-- DONE STEP -->
      <div v-else-if="step === 'done'" class="refine-done">
        <div class="refine-done-icon">🎉</div>
        <h2>Refine Complete!</h2>
        <p>Your video has been transcribed, silence-cut, speaker-identified, and smart-grouped.</p>
        <p class="refine-done-hint">Opening in editor…</p>
      </div>

      <!-- ERROR STEP -->
      <div v-else-if="step === 'error'" class="refine-error">
        <div class="refine-error-icon">⚠️</div>
        <h2>Refine Failed</h2>
        <p class="refine-error-msg">{{ error }}</p>
        <button class="btn btn-primary" @click="reset">← Try Again</button>
      </div>
    </div>
  `,
};
