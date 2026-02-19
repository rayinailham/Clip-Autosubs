import { ref, computed, onUnmounted } from 'vue';
import store from '../store.js';
import { uploadVideoOnly, startReframeJob, pollReframeStatus } from '../api.js';

export default {
  name: 'ReframeView',
  setup() {
    // ── Upload step ─────────────────────────────────────────
    const uploading = ref(false);
    const dragover = ref(false);

    async function handleFile(file) {
      if (!file) return;
      uploading.value = true;
      try {
        const result = await uploadVideoOnly(file);
        store.reframe.videoFilename = result.filename;
        store.reframe.step = 'editor';
      } catch (err) {
        alert('Upload error: ' + err.message);
      }
      uploading.value = false;
    }

    function onFileChange(e) { handleFile(e.target.files[0]); }
    function onDrop(e) {
      e.preventDefault(); dragover.value = false;
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    }
    function onDragover(e) { e.preventDefault(); dragover.value = true; }
    function onDragleave() { dragover.value = false; }

    // ── Video preview sync ──────────────────────────────────
    const videoTop = ref(null);
    const videoBot = ref(null);
    const playing = ref(false);

    function syncBot() {
      if (videoBot.value && videoTop.value) {
        const diff = Math.abs(videoBot.value.currentTime - videoTop.value.currentTime);
        if (diff > 0.1) videoBot.value.currentTime = videoTop.value.currentTime;
      }
    }

    function togglePlay() {
      const vt = videoTop.value;
      const vb = videoBot.value;
      if (!vt) return;
      if (vt.paused) {
        vt.play(); if (vb) vb.play();
        playing.value = true;
      } else {
        vt.pause(); if (vb) vb.pause();
        playing.value = false;
      }
    }

    // ── CSS transform helper ────────────────────────────────
    // Pan is implemented by shifting the transform-origin (the zoom focal point)
    // rather than translating the element. This ensures the video never leaves
    // its container bounds, so no black bars are ever visible.
    //
    // At scale(z), the maximum safe origin offset from 50% is:
    //   maxOff = 50 * (1 - 1/z)   (beyond this you'd see outside the source)
    // We map panX/panY (−100…+100) linearly into [−maxOff … +maxOff].
    function sectionStyle(section) {
      const { zoom, panX, panY } = store.reframe[section];
      const z = Math.max(1, zoom);
      // max origin shift (%) that won't expose black at this zoom level
      const maxOff = 50 * (1 - 1 / z);
      const ox = 50 + (panX / 100) * maxOff;
      const oy = 50 + (panY / 100) * maxOff;
      return {
        transform: `scale(${z})`,
        transformOrigin: `${ox}% ${oy}%`,
        objectFit: 'cover',
        width: '100%',
        height: '100%',
        position: 'absolute',
        inset: '0',
      };
    }

    // ── Render ──────────────────────────────────────────────
    const rr = computed(() => store.reframe.render);
    let pollInterval = null;

    async function startRender() {
      const rf = store.reframe;
      if (!rf.videoFilename) { alert('No video loaded.'); return; }

      const r = rf.render;
      r.active = true;
      r.status = 'Starting…';
      r.done = false;
      r.error = false;
      r.downloadUrl = '';
      r.downloadLabel = '';

      try {
        const payload = {
          video_filename: rf.videoFilename,
          top_zoom:  rf.top.zoom,
          top_pan_x: rf.top.panX,
          top_pan_y: rf.top.panY,
          bottom_zoom:  rf.bottom.zoom,
          bottom_pan_x: rf.bottom.panX,
          bottom_pan_y: rf.bottom.panY,
        };
        const { job_id } = await startReframeJob(payload);
        r.jobId = job_id;
        startPolling(job_id);
      } catch (err) {
        r.active = false;
        r.error = true;
        r.status = err.message;
      }
    }

    function startPolling(jobId) {
      if (pollInterval) clearInterval(pollInterval);
      pollInterval = setInterval(async () => {
        try {
          const data = await pollReframeStatus(jobId);
          const r = store.reframe.render;
          if (data.status === 'processing') {
            r.status = data.log || 'Rendering layout…';
          } else if (data.status === 'done') {
            clearInterval(pollInterval);
            r.done = true;
            r.status = `Done — ${data.size_mb} MB`;
            r.downloadUrl = data.url;
            r.downloadLabel = `📥 Download (${data.size_mb} MB)`;
          } else if (data.status === 'error') {
            clearInterval(pollInterval);
            r.error = true;
            r.status = data.error || 'Unknown error';
          }
        } catch { /* keep polling on network hiccup */ }
      }, 2000);
    }

    function closeRender() {
      if (pollInterval) clearInterval(pollInterval);
      store.reframe.render.active = false;
    }

    function goHome() {
      if (pollInterval) clearInterval(pollInterval);
      store.appMode = 'home';
    }

    onUnmounted(() => { if (pollInterval) clearInterval(pollInterval); });

    const videoSrc = computed(() =>
      store.reframe.videoFilename
        ? '/video/' + encodeURIComponent(store.reframe.videoFilename)
        : ''
    );

    return {
      store, uploading, dragover,
      onFileChange, onDrop, onDragover, onDragleave,
      videoTop, videoBot, playing, syncBot, togglePlay,
      sectionStyle, startRender, closeRender, goHome,
      rr, videoSrc,
    };
  },

  template: `
    <div class="reframe-view">

      <!-- ── Upload step ── -->
      <div v-if="store.reframe.step === 'upload'" class="reframe-upload-wrap">
        <button class="btn btn-ghost back-btn" @click="goHome">← Back</button>
        <div class="upload-hero">
          <h2>VTuber Short — Upload Clip</h2>
          <p>Upload the clip you want to reframe. You'll pan &amp; zoom each section next.</p>
        </div>
        <div class="upload-card-wrap">
          <div class="upload-card"
               :class="{ dragover, disabled: uploading }"
               @dragover="onDragover"
               @dragleave="onDragleave"
               @drop="onDrop">
            <input type="file" @change="onFileChange"
                   accept=".mp4,.mkv,.avi,.mov,.webm" />
            <span class="upload-icon">🎬</span>
            <h2>Drop a video file</h2>
            <p>MP4, MKV, AVI, MOV, WEBM — up to 500 MB</p>
          </div>
        </div>
        <div class="transcribe-progress" :class="{ active: uploading }">
          <div class="progress-box">
            <div class="progress-label">
              <span>Uploading…</span>
            </div>
            <div class="progress-track"><div class="progress-fill"></div></div>
          </div>
        </div>
      </div>

      <!-- ── Editor step ── -->
      <div v-else class="reframe-editor">

        <!-- Left panel: Gameplay (top) -->
        <div class="reframe-panel">
          <div class="reframe-panel-header">
            <span class="reframe-panel-badge reframe-panel-badge--top">TOP 40%</span>
            <h3>Gameplay</h3>
          </div>

          <label class="ctrl-label">
            Zoom
            <span class="ctrl-value">{{ store.reframe.top.zoom.toFixed(2) }}×</span>
          </label>
          <input class="ctrl-range" type="range" min="1" max="5" step="0.01"
                 :value="store.reframe.top.zoom"
                 @input="store.reframe.top.zoom = +$event.target.value" />

          <label class="ctrl-label">
            Pan X
            <span class="ctrl-value">{{ store.reframe.top.panX > 0 ? '+' : '' }}{{ store.reframe.top.panX }}%</span>
          </label>
          <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                 :value="store.reframe.top.panX"
                 @input="store.reframe.top.panX = +$event.target.value" />

          <label class="ctrl-label">
            Pan Y
            <span class="ctrl-value">{{ store.reframe.top.panY > 0 ? '+' : '' }}{{ store.reframe.top.panY }}%</span>
          </label>
          <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                 :value="store.reframe.top.panY"
                 @input="store.reframe.top.panY = +$event.target.value" />

          <button class="btn btn-outline btn-sm" style="margin-top:.5rem"
                  @click="store.reframe.top = { zoom:1, panX:0, panY:0 }">Reset</button>

          <!-- Divider -->
          <div class="reframe-divider"></div>

          <div class="reframe-panel-header">
            <span class="reframe-panel-badge reframe-panel-badge--bottom">BOTTOM 60%</span>
            <h3>Avatar</h3>
          </div>

          <label class="ctrl-label">
            Zoom
            <span class="ctrl-value">{{ store.reframe.bottom.zoom.toFixed(2) }}×</span>
          </label>
          <input class="ctrl-range" type="range" min="1" max="5" step="0.01"
                 :value="store.reframe.bottom.zoom"
                 @input="store.reframe.bottom.zoom = +$event.target.value" />

          <label class="ctrl-label">
            Pan X
            <span class="ctrl-value">{{ store.reframe.bottom.panX > 0 ? '+' : '' }}{{ store.reframe.bottom.panX }}%</span>
          </label>
          <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                 :value="store.reframe.bottom.panX"
                 @input="store.reframe.bottom.panX = +$event.target.value" />

          <label class="ctrl-label">
            Pan Y
            <span class="ctrl-value">{{ store.reframe.bottom.panY > 0 ? '+' : '' }}{{ store.reframe.bottom.panY }}%</span>
          </label>
          <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                 :value="store.reframe.bottom.panY"
                 @input="store.reframe.bottom.panY = +$event.target.value" />

          <button class="btn btn-outline btn-sm" style="margin-top:.5rem"
                  @click="store.reframe.bottom = { zoom:1, panX:0, panY:0 }">Reset</button>
        </div>

        <!-- Center: 9:16 Preview -->
        <div class="reframe-center">
          <button class="btn btn-ghost back-btn" @click="goHome">← Back</button>
          <p class="reframe-hint">Live preview — what you see is what will be exported</p>

          <div class="reframe-canvas-wrap">
            <div class="reframe-canvas">

              <!-- Top section: Gameplay (40%) -->
              <div class="reframe-section reframe-section--top">
                <video :src="videoSrc" ref="videoTop"
                       :style="sectionStyle('top')"
                       @timeupdate="syncBot"
                       preload="metadata" playsinline muted loop />
                <div class="reframe-section-label">Gameplay</div>
              </div>

              <!-- Subtitle zone indicator -->
              <div class="reframe-sub-zone">
                <span class="reframe-sub-label">Subtitle area</span>
              </div>

              <!-- Bottom section: Avatar (60%) -->
              <div class="reframe-section reframe-section--bottom">
                <video :src="videoSrc" ref="videoBot"
                       :style="sectionStyle('bottom')"
                       preload="metadata" playsinline muted loop />
                <div class="reframe-section-label reframe-section-label--bottom">Avatar</div>
              </div>

            </div>
          </div>

          <!-- Playback controls -->
          <div class="reframe-controls">
            <button class="btn btn-outline" @click="togglePlay">
              {{ playing ? '⏸ Pause' : '▶ Play' }}
            </button>
          </div>
        </div>

        <!-- Right panel: Render -->
        <div class="reframe-panel reframe-panel--right">
          <h3 style="margin-bottom:1rem">Export</h3>
          <p class="reframe-export-info">Output: <b>1080 × 1920</b> (9:16 vertical)</p>
          <p class="reframe-export-info">Top: <b>40%</b> gameplay · Bottom: <b>60%</b> avatar</p>

          <button class="btn btn-primary reframe-render-btn"
                  :disabled="rr.active"
                  @click="startRender">
            🎬 Render Short
          </button>

          <!-- Render progress -->
          <div v-if="rr.active" class="reframe-render-status">
            <div class="progress-track" style="margin:.75rem 0">
              <div class="progress-fill"
                   :style="{ width: rr.done ? '100%' : '40%',
                             animation: rr.done ? 'none' : 'indeterminate 1.5s infinite ease-in-out',
                             background: rr.error ? 'var(--error)' : '' }"></div>
            </div>
            <p class="render-status-text">{{ rr.status }}</p>

            <div v-if="rr.done" style="margin-top:1rem; display:flex; flex-direction:column; gap:.5rem">
              <a :href="rr.downloadUrl" class="btn btn-success" download>{{ rr.downloadLabel }}</a>
              <button class="btn btn-outline btn-sm" @click="closeRender">Close</button>
            </div>
            <div v-if="rr.error" style="margin-top:1rem">
              <button class="btn btn-outline btn-sm" @click="closeRender">Close</button>
            </div>
          </div>

          <div class="reframe-divider"></div>
          <p class="reframe-export-info" style="color:var(--text-dim); font-size:.75rem">
            Tip: Drag the sliders to adjust which part of the source video fills each
            section. Zoom in to hide black bars.
          </p>
        </div>

      </div>
    </div>
  `,
};
