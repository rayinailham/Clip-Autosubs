import { ref, onMounted } from 'vue';
import store, { regenerateAutoGroups } from '../store.js';
import { fetchUploads, uploadAndTranscribe, transcribeExistingFile, loadTranscriptionJSON, videoURL } from '../api.js';

export default {
  name: 'UploadView',
  setup() {
    const uploads = ref([]);
    const uploadsLoading = ref(true);
    const dragover = ref(false);

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
        const result = await uploadAndTranscribe(file);
        store.words = result.words || [];
        store.metadata = result.metadata || {};
        store.videoFilename = file.name;
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
        const result = await transcribeExistingFile(filename);
        store.words = result.words || [];
        store.metadata = result.metadata || {};
        store.videoFilename = filename;
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

    return {
      store, uploads, uploadsLoading, dragover,
      onFileChange, onDrop, onDragover, onDragleave,
      loadExisting, transcribeExisting, loadPreviousUploads,
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
            <div class="upload-item-icon">🎬</div>
            <div class="upload-item-info">
              <div class="upload-item-name" :title="f.filename">{{ f.filename }}</div>
              <div class="upload-item-meta">
                {{ f.size_mb }} MB
                <span v-if="f.has_transcription" class="upload-badge transcribed">✓ Transcribed</span>
                <span v-else class="upload-badge">Not transcribed</span>
              </div>
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
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
