import { ref, onMounted } from 'vue';
import store, { regenerateAutoGroups, resetSpeakerColors } from '../store.js';
import { fetchUploads, uploadAndTranscribe, transcribeExistingFile, loadTranscriptionJSON, videoURL, deleteUpload } from '../api.js';

export default {
  name: 'UploadView',
  setup() {
    const uploads = ref([]);
    const uploadsLoading = ref(true);
    const dragover = ref(false);
    const showDiarize = ref(false);

    // Diarization settings (persist via store)
    if (!store.diarization) {
      store.diarization = {
        hfToken: '',
        maxSpeakers: null,
      };
    }

    function getDiarizeOpts() {
      const opts = { transcription_model: store.transcriptionModel };
      const token = (store.diarization.hfToken || '').trim();
      if (token) opts.hf_token = token;
      const maxSp = store.diarization.maxSpeakers;
      if (maxSp && maxSp > 0) opts.max_speakers = maxSp;
      return opts;
    }

    function populateSpeakers(result) {
      // Reset color assignments for new transcription
      resetSpeakerColors();
      // Auto-populate store.speakers from word data
      const speakerSet = new Set();
      for (const w of (result.words || [])) {
        if (w.speaker) speakerSet.add(w.speaker);
      }
      if (speakerSet.size > 0) {
        const speakers = {};
        const sorted = [...speakerSet].sort();
        const labels = ['Speaker 1', 'Speaker 2', 'Speaker 3', 'Speaker 4', 'Speaker 5'];
        sorted.forEach((spk, i) => {
          speakers[spk] = labels[i] || `Speaker ${i + 1}`;
        });
        store.speakers = speakers;
        console.log(`[diarization] Detected ${sorted.length} speakers:`, sorted);
      } else {
        store.speakers = {};
      }
    }

    async function loadPreviousUploads() {
      uploadsLoading.value = true;
      try {
        const data = await fetchUploads();
        uploads.value = data.files || [];
      } catch {
        uploads.value = [];
      }
      uploadsLoading.value = false;
    }

    function openEditor() {
      regenerateAutoGroups();
      store.currentView = 'editor';
    }

    async function handleFile(file) {
      if (!file) return;
      store.transcribing = true;
      store.progressText = 'Uploading & transcribing…';
      store.progressFile = file.name;
      try {
        const result = await uploadAndTranscribe(file, getDiarizeOpts());
        store.words = result.words || [];
        store.metadata = result.metadata || {};
        store.videoFilename = file.name;
        populateSpeakers(result);
        openEditor();
      } catch (err) {
        alert('Error: ' + err.message);
      }
      store.transcribing = false;
    }

    function onFileChange(e) {
      const file = e.target.files[0];
      handleFile(file);
    }

    function onDrop(e) {
      e.preventDefault();
      dragover.value = false;
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    }

    function onDragover(e) {
      e.preventDefault();
      dragover.value = true;
    }

    function onDragleave() {
      dragover.value = false;
    }

    async function loadExisting(encodedVideo, encodedJson) {
      try {
        const result = await loadTranscriptionJSON(encodedJson);
        store.words = result.words || [];
        store.metadata = result.metadata || {};
        store.videoFilename = decodeURIComponent(encodedVideo);
        populateSpeakers(result);
        openEditor();
      } catch (e) {
        alert('Failed to load transcription: ' + e.message);
      }
    }

    async function transcribeExisting(encodedFilename) {
      const filename = decodeURIComponent(encodedFilename);
      store.transcribing = true;
      store.progressText = 'Transcribing…';
      store.progressFile = filename;
      try {
        const result = await transcribeExistingFile(filename, getDiarizeOpts());
        store.words = result.words || [];
        store.metadata = result.metadata || {};
        store.videoFilename = filename;
        populateSpeakers(result);
        openEditor();
      } catch (err) {
        alert('Error: ' + err.message);
      }
      store.transcribing = false;
      loadPreviousUploads();
    }

    onMounted(async () => {
      await loadPreviousUploads();
      // Auto-transcribe a clip that came from the YouTube Clip Finder
      if (store.yt && store.yt.prefillFile) {
        const filename = store.yt.prefillFile;
        store.yt.prefillFile = '';
        await transcribeExisting(encodeURIComponent(filename));
      }
    });

    async function deleteFile(filename) {
      if (!confirm(`Delete "${filename}"?\nThis will also remove its transcription if one exists.`)) return;
      try {
        await deleteUpload(filename);
        await loadPreviousUploads();
      } catch (err) {
        alert('Delete failed: ' + err.message);
      }
    }

    return {
      store, uploads, uploadsLoading, dragover, showDiarize,
      onFileChange, onDrop, onDragover, onDragleave,
      loadExisting, transcribeExisting, loadPreviousUploads,
      deleteFile, videoURL,
    };
  },
  template: `
    <div id="upload-view" class="view active">
      <button class="btn btn-ghost back-btn" style="margin:1rem 1.5rem" @click="store.appMode = 'home'">← Back</button>
      <!-- Hero -->
      <div class="upload-hero">
        <h2>Subtitle your clips in seconds</h2>
        <p>Drop a video or audio file to auto-transcribe and style dynamic subtitles</p>
      </div>

      <!-- Upload Card -->
      <div class="upload-card-wrap">
        <div class="upload-card"
             :class="{ dragover: dragover, disabled: store.transcribing }"
             @dragover="onDragover"
             @dragleave="onDragleave"
             @drop="onDrop">
          <input type="file" @change="onFileChange"
                 accept=".mp4,.mkv,.avi,.mov,.webm,.mp3,.wav,.flac,.m4a,.ogg" />
          <span class="upload-icon">🎬</span>
          <h2>Drop a video or audio file</h2>
          <p>MP4, MKV, AVI, MOV, WEBM, MP3, WAV — up to 500 MB</p>
        </div>
      </div>

      <!-- Transcription Options -->
      <div class="transcription-options" style="max-width: 560px; width: 100%; margin-top: 1rem;">
        <div style="margin-bottom: 0.8rem; background: var(--surface); padding: 0.75rem 1rem; border: 1px solid var(--border); border-radius: var(--radius-sm);">
          <label style="font-size: 0.8rem; color: var(--text); display: flex; align-items: center; justify-content: space-between;">
            <span>🧠 Transcription Model</span>
            <select v-model="store.transcriptionModel" style="padding: 4px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); cursor: pointer; max-width: 60%;">
              <option value="large-v2">WhisperX (English / Auto-Translate)</option>
              <option value="flyfront/anime-whisper-faster">Anime-Whisper (Japanese-focused translation)</option>
            </select>
          </label>
        </div>
        <button class="btn btn-ghost btn-sm" @click="showDiarize = !showDiarize"
                style="font-size: 0.78rem; display: flex; align-items: center; gap: 0.4rem; color: var(--text-dim);">
          <span style="font-size: 0.6rem;">{{ showDiarize ? '▼' : '▶' }}</span>
          🎤 Speaker Diarization
          <span v-if="store.diarization.hfToken" style="color: var(--success); font-size: 0.65rem;">● Active</span>
        </button>
        <div v-if="showDiarize" class="diarize-panel"
             style="background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-sm);
                    padding: 0.75rem 1rem; margin-top: 0.35rem;">
          <p style="font-size: 0.72rem; color: var(--text-dim); margin-bottom: 0.5rem; line-height: 1.45;">
            Enable speaker detection by providing a
            <a href="https://huggingface.co/settings/tokens" target="_blank"
               style="color: var(--accent2);">HuggingFace token</a>
            with access to
            <a href="https://huggingface.co/pyannote/speaker-diarization-3.1" target="_blank"
               style="color: var(--accent2);">pyannote/speaker-diarization-3.1</a>.
          </p>
          <div style="display: flex; gap: 0.5rem; align-items: center;">
            <input type="password" v-model="store.diarization.hfToken"
                   placeholder="hf_xxxxxxxxxx…"
                   style="flex: 1; padding: 6px 10px; background: var(--surface2); border: 1px solid var(--border);
                          border-radius: 5px; color: var(--text); font-size: 0.8rem; outline: none;
                          font-family: monospace;" />
            <label style="font-size: 0.72rem; color: var(--text-dim); white-space: nowrap;">
              Max speakers
              <input type="number" v-model.number="store.diarization.maxSpeakers"
                     min="2" max="10" placeholder="auto"
                     style="width: 50px; padding: 5px 6px; margin-left: 4px; background: var(--surface2);
                            border: 1px solid var(--border); border-radius: 5px; color: var(--text);
                            font-size: 0.8rem; text-align: center; outline: none;" />
            </label>
          </div>
        </div>
      </div>

      <!-- Progress -->
      <div class="transcribe-progress" :class="{ active: store.transcribing }">
        <div class="progress-box">
          <div class="progress-label">
            <span>{{ store.progressText }}</span>
            <span>{{ store.progressFile }}</span>
          </div>
          <div class="progress-track">
            <div class="progress-fill"></div>
          </div>
        </div>
      </div>

      <!-- Previous Uploads -->
      <div class="previous-uploads">
        <div class="prev-uploads-header">
          <h3>Previously Uploaded</h3>
          <button class="btn btn-outline btn-sm" @click="loadPreviousUploads">↻ Refresh</button>
        </div>
        <div class="uploads-list">
          <div v-if="uploadsLoading" class="uploads-loading">Loading…</div>
          <div v-else-if="uploads.length === 0" class="uploads-empty">No previous uploads found.</div>
          <div v-else v-for="f in uploads" :key="f.filename" class="upload-item">
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
              <div class="upload-item-name" :title="f.filename">{{ f.filename }}</div>
              <div class="upload-item-meta">
                {{ f.size_mb }} MB
                <span v-if="f.has_transcription" class="upload-badge transcribed">✓ Transcribed</span>
                <span v-else class="upload-badge">Not transcribed</span>
              </div>
              <div class="upload-item-action">
                <button v-if="f.has_transcription" class="btn btn-primary btn-sm"
                        @click="loadExisting(encodeURIComponent(f.filename), encodeURIComponent(f.transcription_file))">
                  Open ▶
                </button>
                <button v-else class="btn btn-outline btn-sm"
                        @click="transcribeExisting(encodeURIComponent(f.filename))">
                  Transcribe
                </button>
                <button class="btn btn-ghost btn-sm btn-delete" :title="'Delete ' + f.filename"
                        @click.stop="deleteFile(f.filename)">
                  🗑
                </button>
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
