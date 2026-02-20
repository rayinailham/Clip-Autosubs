import { ref, computed, onBeforeUnmount } from 'vue';
import store, { regenerateAutoGroups } from '../store.js';
import { fetchUploads, uploadAndTranscribe, startRefineJob, pollRefineStatus, videoURL } from '../api.js';

export default {
  name: 'RefineView',
  setup() {
    const uploads = ref([]);
    const loading = ref(false);
    const apiKey = ref(store.refine.geminiApiKey || '');
    const selectedFile = ref(store.refine.videoFilename || '');
    const dragover = ref(false);
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
        let fetched = (data.files || []).filter(f =>
          f.filename.endsWith('.mp4') || f.filename.endsWith('.mov') || f.filename.endsWith('.webm')
        );
        if (store.refine.videoFilename && !fetched.find(f => f.filename === store.refine.videoFilename)) {
          fetched.unshift({ filename: store.refine.videoFilename, size_mb: 'Rendered' });
        }
        uploads.value = fetched;
        if (store.refine.videoFilename) {
          selectedFile.value = store.refine.videoFilename;
          store.refine.videoFilename = '';
        }
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

      // Apply wasted indices (boring parts) -> create cut segments
      if (data.wasted_indices && data.wasted_indices.length > 0) {
        let segments = [];
        let cur = null;
        let sorted = [...data.wasted_indices].sort((a,b) => a - b);
        for (let i of sorted) {
          let w = store.words[i];
          if (!w) continue;
          if (!cur) {
             cur = { start: w.start, end: w.end };
          } else if (w.start <= cur.end + 1.0) { // allow 1 sec gap to keep them continuous
             cur.end = Math.max(cur.end, w.end);
          } else {
             segments.push(cur);
             cur = { start: w.start, end: w.end };
          }
        }
        if (cur) segments.push(cur);

        let splits = new Set();
        segments.forEach(seg => {
          if (seg.start > 0.1) splits.add(parseFloat(seg.start.toFixed(3)));
          splits.add(parseFloat(seg.end.toFixed(3)));
        });
        store.splitPoints = Array.from(splits).sort((a, b) => a - b);

        const videoDur = (store.words[store.words.length - 1]?.end || 0) + 5;
        const points = [0, ...store.splitPoints, videoDur];
        for (let i = 0; i < points.length - 1; i++) {
          const mid = (points[i] + points[i+1]) / 2;
          const isWasted = segments.some(seg => mid >= seg.start && mid <= seg.end);
          if (isWasted) {
            store.removedSegments.push(i);
          }
        }
      }

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
      STEP_ORDER, STEP_LABELS, dragover, videoURL, loadUploads,
      onFileSelected, onDropFile, canStart, startRefine, openInEditor, goHome, reset,
    };
  },
  template: `
    <div id="upload-view" class="view active">
      <button class="btn btn-ghost back-btn" style="margin:1rem 1.5rem" @click="goHome">← Back</button>

      <!-- SETUP STEP -->
      <template v-if="step === 'setup'">
        <!-- Hero -->
        <div class="upload-hero">
          <h2 style="background: linear-gradient(135deg, #f7b733 0%, #fc4a1a 100%); -webkit-background-clip: text; color: transparent;">✨ Auto-Refine</h2>
          <p>Upload a vertical video and let AI do the rest: transcribe, identify speakers, smart-group, cut silences, and find hooks.</p>
        </div>

        <!-- Upload Card -->
        <div class="upload-card-wrap" style="background: linear-gradient(135deg, rgba(247,183,51,0.5), rgba(252,74,26,0.3), rgba(247,183,51,0.5));">
          <div class="upload-card"
               :class="{ dragover: dragover, disabled: uploading }"
               @dragover.prevent="dragover = true"
               @dragleave="dragover = false"
               @drop.prevent="e => { dragover = false; onDropFile(e); }">
            <input type="file" @change="onFileSelected" accept="video/*" title="" />
            <span class="upload-icon" style="filter: drop-shadow(0 0 16px rgba(247,183,51,0.5));">✨</span>
            <div v-if="uploadFile">
              <h2>{{ uploadFile.name }}</h2>
              <p>{{ (uploadFile.size / 1024 / 1024).toFixed(1) }} MB selected</p>
            </div>
            <div v-else>
              <h2>Drop a vertical video</h2>
              <p>MP4, MOV, WEBM — up to 500 MB</p>
            </div>
          </div>
        </div>

        <!-- Gemini API Key -->
        <div class="diarize-options" style="max-width: 560px; width: 100%; margin-top: 1rem;">
          <div style="background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm); padding: 0.75rem 1rem;">
            <div style="display: flex; align-items: center; justify-content: space-between; margin-bottom: 0.5rem;">
              <span style="font-size: 0.78rem; font-weight: 600; color: var(--text-dim);">🔑 Gemini API Key</span>
              <a href="https://aistudio.google.com/apikey" target="_blank" style="color: #f7b733; font-size: 0.72rem; text-decoration: none;">Get one free</a>
            </div>
            <input type="password" v-model="apiKey"
                   placeholder="Paste your Google Gemini API key…"
                   style="width: 100%; padding: 8px 10px; background: var(--surface2); border: 1px solid var(--border); border-radius: 5px; color: var(--text); font-size: 0.8rem; outline: none; font-family: monospace;" />
          </div>
        </div>

        <!-- Start Button -->
        <div style="max-width: 560px; width: 100%; margin-top: 1.5rem;">
          <button class="btn btn-primary" style="width: 100%; padding: 12px; font-size: 1rem; background: linear-gradient(135deg, #f7b733, #fc4a1a); border: none; color: white; display: flex; justify-content: center; align-items: center; cursor: pointer; transition: opacity 0.2s;"
                  :disabled="!canStart()"
                  :style="{ opacity: canStart() ? 1 : 0.5 }"
                  @click="startRefine">
            <span style="margin-right: 8px; font-size: 1.2rem;">🚀</span> Start Auto-Refine
          </button>
        </div>

        <!-- Previous Uploads -->
        <div class="previous-uploads">
          <div class="prev-uploads-header">
            <h3>Previously Uploaded</h3>
            <button class="btn btn-outline btn-sm" @click="loadUploads">↻ Refresh</button>
          </div>
          <div class="uploads-list">
            <div v-if="loading" class="uploads-loading">Loading…</div>
            <div v-else-if="uploads.length === 0" class="uploads-empty">No previous uploads found.</div>
            <div v-else v-for="f in uploads" :key="f.filename" class="upload-item" 
                 @click="selectedFile = f.filename; uploadFile = null" 
                 :style="selectedFile === f.filename ? 'border-color: #f7b733; box-shadow: 0 4px 20px rgba(247, 183, 51, 0.4); transform: translateY(-4px);' : ''" 
                 style="cursor: pointer; position: relative;">
              <div class="upload-item-thumb">
                <video
                  :src="videoURL(f.filename)"
                  preload="metadata"
                  muted
                  playsinline
                  class="upload-item-video"
                  @loadedmetadata="e => { e.target.currentTime = 1 }"
                  @mouseenter="e => { e.target.currentTime = 0; e.target.play(); }"
                  @mouseleave="e => { e.target.pause(); e.target.currentTime = 1; }"
                ></video>
              </div>
              <div class="upload-item-body">
                <div class="upload-item-name" :title="f.filename" :style="selectedFile === f.filename ? 'color: #f7b733;' : ''">{{ f.filename }}</div>
                <div class="upload-item-meta">
                  {{ f.size_mb }}{{ f.size_mb === 'Rendered' ? '' : ' MB' }}
                  <span v-if="selectedFile === f.filename" style="margin-left: auto; color: #f7b733; font-weight: bold; background: rgba(247,183,51,0.1); padding: 2px 6px; border-radius: 4px;">Selected</span>
                </div>
              </div>
            </div>
          </div>
        </div>
      </template>

      <!-- PROCESSING STEP -->
      <div v-else-if="step === 'processing'" class="refine-processing" style="margin: 4rem auto; max-width: 560px; width: 100%;">
        <div class="upload-hero">
          <h2 style="font-size: 1.5rem; margin-bottom: 0.5rem; background: linear-gradient(135deg, #f7b733, #fc4a1a); -webkit-background-clip: text; color: transparent;">🔄 Refining your video…</h2>
          <p>This may take a few minutes. Don't close this tab.</p>
        </div>

        <div class="refine-progress-bar" style="height: 10px; background: rgba(255,255,255,0.05); border-radius: 5px; overflow: hidden; margin: 2rem 0 1rem;">
          <div class="refine-progress-fill" :style="{ width: progressPct + '%', background: 'linear-gradient(90deg, #f7b733, #fc4a1a)', height: '100%', transition: 'width 0.4s ease' }"></div>
        </div>
        <div class="refine-progress-label" style="text-align: center; color: var(--text-dim); margin-bottom: 2rem; font-weight: 600;">{{ progressPct }}%</div>

        <div class="refine-steps" style="display: flex; flex-direction: column; gap: 1rem; background: var(--surface); padding: 1.5rem; border-radius: var(--radius); border: 1px solid rgba(255,255,255,0.05); text-align: left;">
          <div v-for="(s, si) in STEP_ORDER" :key="s"
               class="refine-step"
               style="display: flex; align-items: center; gap: 12px; font-size: 0.9rem;"
               :style="stepIndex > si ? 'color: #4caf50;' : (progress.step === s ? 'color: #f7b733; font-weight: 600;' : 'color: var(--text-dim);')">
            <span class="refine-step-icon" style="flex-shrink: 0; width: 24px; text-align: center;">
              <template v-if="stepIndex > si">✅</template>
              <template v-else-if="progress.step === s">⏳</template>
              <template v-else>○</template>
            </span>
            <span class="refine-step-label">{{ STEP_LABELS[s] }}</span>
          </div>
        </div>

        <div v-if="progress.message" class="refine-log" style="margin-top: 1.5rem; font-size: 0.8rem; color: var(--text-dim); font-family: monospace; background: rgba(0,0,0,0.2); padding: 0.5rem; border-radius: 4px;">{{ progress.message }}</div>
      </div>

      <!-- DONE STEP -->
      <div v-else-if="step === 'done'" class="refine-done" style="margin: 4rem auto; text-align: center; max-width: 500px;">
        <div class="refine-done-icon" style="font-size: 4rem; margin-bottom: 1rem;">🎉</div>
        <h2 style="font-size: 1.8rem; margin-bottom: 1rem; color: #4caf50;">Refine Complete!</h2>
        <p style="color: var(--text-dim); line-height: 1.6; margin-bottom: 2rem;">Your video has been transcribed, silence-cut, speaker-identified, and smart-grouped.</p>
        <p class="refine-done-hint" style="color: #f7b733; font-weight: 600;">Opening in editor…</p>
      </div>

      <!-- ERROR STEP -->
      <div v-else-if="step === 'error'" class="refine-error" style="margin: 4rem auto; text-align: center; max-width: 500px;">
        <div class="refine-error-icon" style="font-size: 4rem; margin-bottom: 1rem;">⚠️</div>
        <h2 style="font-size: 1.8rem; margin-bottom: 1rem; color: #f44336;">Refine Failed</h2>
        <p class="refine-error-msg" style="background: rgba(244,67,54,0.1); border: 1px solid rgba(244,67,54,0.2); padding: 1rem; border-radius: var(--radius); color: #ffcccc; margin-bottom: 2rem;">{{ error }}</p>
        <button class="btn btn-primary" style="background: var(--surface2); color: var(--text);" @click="reset">← Try Again</button>
      </div>
    </div>
  `,
};
