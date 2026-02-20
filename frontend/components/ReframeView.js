import { ref, computed, onMounted, onUnmounted } from 'vue';
import store from '../store.js';
import { uploadVideoOnly, startReframeJob, pollReframeStatus, fetchUploads, videoURL } from '../api.js';

export default {
  name: 'ReframeView',
  setup() {
    // ── Upload step ─────────────────────────────────────────
    const uploading = ref(false);
    const dragover = ref(false);
    const uploads = ref([]);
    const uploadsLoading = ref(false);
    const sortMode = ref('newest');

    const processedUploads = computed(() => {
      let list = [...uploads.value];
      if (sortMode.value === 'newest') list.sort((a,b) => (b.created_at || 0) - (a.created_at || 0));
      if (sortMode.value === 'oldest') list.sort((a,b) => (a.created_at || 0) - (b.created_at || 0));
      if (sortMode.value === 'size') list.sort((a,b) => b.size_mb - a.size_mb);
      if (sortMode.value === 'name') list.sort((a,b) => a.filename.localeCompare(b.filename));

      // Group by folder
      const groups = {};
      list.forEach(f => {
        const fn = f.folder || 'Root Uploads';
        if (!groups[fn]) groups[fn] = [];
        groups[fn].push(f);
      });
      return groups;
    });

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

    function useExistingUpload(filename) {
      store.reframe.videoFilename = filename;
      store.reframe.step = 'editor';
    }

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
    // Pan is implemented via object-position (which controls the visible
    // portion of a cover-cropped video) combined with matching transform-origin
    // for additional zoom.
    //
    // panX/panY (−100 … +100) map linearly to object-position (0% … 100%).
    //   panX = −100 ⇒ show left edge,  panX = +100 ⇒ show right edge
    //   panY = −100 ⇒ show top edge,   panY = +100 ⇒ show bottom edge
    //
    // transform-origin is set to the same percentages so that scale(z)
    // zooms into the same point the user panned to.
    function sectionStyle(section) {
      const { zoom, panX, panY } = store.reframe[section];
      const z = Math.max(1, zoom);
      // Map pan (−100…+100) → object-position (0%…100%)
      const opX = 50 + (panX / 100) * 50;
      const opY = 50 + (panY / 100) * 50;
      return {
        transform: z > 1 ? `scale(${z})` : 'none',
        transformOrigin: `${opX}% ${opY}%`,
        objectFit: 'cover',
        objectPosition: `${opX}% ${opY}%`,
        width: '100%',
        height: '100%',
        position: 'absolute',
        inset: '0',
      };
    }

    // ── Mode selection ───────────────────────────────────────
    const MODE_LABELS = {
      zoomed:   'Zoomed',
      blur_bg:  'Blurred Background',
      black_bg: 'Black Background',
      vtuber:   'Split-screen',
    };

    function setMode(mode) {
      store.reframe.shortsMode = mode;
      store.reframe.step = 'upload';
    }

    function goBack() {
      if (store.reframe.step === 'editor') {
        store.reframe.step = 'upload';
      } else if (store.reframe.step === 'upload') {
        store.reframe.step = 'mode';
      } else {
        goHome();
      }
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
        const mode = rf.shortsMode || 'vtuber';
        const payload = {
          video_filename: rf.videoFilename,
          shorts_mode: mode,
          // Split-screen params
          split_ratio:  rf.splitRatio,
          top_zoom:     rf.top.zoom,
          top_pan_x:    rf.top.panX,
          top_pan_y:    rf.top.panY,
          bottom_zoom:  rf.bottom.zoom,
          bottom_pan_x: rf.bottom.panX,
          bottom_pan_y: rf.bottom.panY,
          // Single-section params (zoomed mode)
          single_zoom:  rf.single.zoom,
          single_pan_x: rf.single.panX,
          single_pan_y: rf.single.panY,
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
            r.filename = data.filename;
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

    function goToRefine() {
      if (!store.reframe.render.filename) return;
      if (pollInterval) clearInterval(pollInterval);
      store.refine.videoFilename = store.reframe.render.filename;
      store.refine.step = 'setup';
      store.appMode = 'refine';
    }

    onMounted(() => loadPreviousUploads());
    onUnmounted(() => { if (pollInterval) clearInterval(pollInterval); });

    const videoSrc = computed(() =>
      store.reframe.videoFilename
        ? '/video/' + encodeURIComponent(store.reframe.videoFilename)
        : ''
    );

    // ── Computed split heights for preview ─────────────────────
    const topPct = computed(() => store.reframe.splitRatio || 40);
    const botPct = computed(() => 100 - topPct.value);

    return {
      store, uploading, dragover, MODE_LABELS,
      uploads, uploadsLoading, loadPreviousUploads, useExistingUpload, videoURL,
      onFileChange, onDrop, onDragover, onDragleave,
      videoTop, videoBot, playing, syncBot, togglePlay,
      sectionStyle, startRender, closeRender, goHome, goToRefine, setMode, goBack,
      rr, videoSrc, topPct, botPct, sortMode, processedUploads,
    };
  },

  template: `
    <div class="reframe-view">

      <!-- ── Mode picker step ── -->
      <div v-if="store.reframe.step === 'mode'" class="shorts-mode-pick">
        <button class="btn btn-ghost back-btn" @click="goHome">← Back</button>
        <div class="upload-hero">
          <h2>Shorts Creator — Choose a Style</h2>
          <p>Pick how you want your horizontal video converted to vertical 9:16.</p>
        </div>
        <div class="shorts-mode-cards">

          <div class="shorts-mode-card" @click="setMode('zoomed')">
            <div class="shorts-mode-icon">&#x1F50D;</div>
            <h3>Zoomed</h3>
            <p>Crop &amp; zoom into the action to fill the frame. Pan to pick the perfect spot.</p>
          </div>

          <div class="shorts-mode-card" @click="setMode('blur_bg')">
            <div class="shorts-mode-icon">&#x1F32B;&#xFE0F;</div>
            <h3>Blurred Background</h3>
            <p>The same video (blurred) fills the background with the original overlaid in the center.</p>
          </div>

          <div class="shorts-mode-card" @click="setMode('black_bg')">
            <div class="shorts-mode-icon">&#x2B1B;</div>
            <h3>Black Background</h3>
            <p>Your video centered with solid black padding. Clean cinematic look.</p>
          </div>

          <div class="shorts-mode-card" @click="setMode('vtuber')">
            <div class="shorts-mode-icon">&#x1F3AD;</div>
            <h3>Split-screen</h3>
            <p>Split layout — adjustable top/bottom ratio with full pan &amp; zoom control for each section.</p>
          </div>

        </div>
      </div>

      <!-- ── Upload step ── -->
      <div v-else-if="store.reframe.step === 'upload'" class="reframe-upload-wrap">
        <button class="btn btn-ghost back-btn" @click="goBack">← Back</button>
        <div class="upload-hero">
          <h2>Shorts Creator — Upload Clip</h2>
          <p>Style: <b>{{ MODE_LABELS[store.reframe.shortsMode] }}</b>. Upload the video you want to convert.</p>
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

        <!-- Previously Uploaded -->
        <div class="previous-uploads" style="margin-top:2rem">
          <div class="prev-uploads-header" style="display:flex; justify-content:space-between; align-items:center;">
            <h3>File Manager (Uploads)</h3>
            <div style="display:flex; gap:0.5rem; align-items:center;">
              <select v-model="sortMode" style="padding: 4px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); cursor: pointer; font-size: 0.8rem;">
                <option value="newest">Latest</option>
                <option value="oldest">Oldest</option>
                <option value="size">Largest size</option>
                <option value="name">A-Z</option>
              </select>
              <button class="btn btn-outline btn-sm" @click="loadPreviousUploads">↻ Refresh</button>
            </div>
          </div>
          <div class="uploads-list" style="margin-top:0.5rem;">
            <div v-if="uploadsLoading" class="uploads-loading">Loading…</div>
            <div v-else-if="uploads.length === 0" class="uploads-empty">No previous uploads found.</div>
            <template v-else v-for="(files, folder) in processedUploads" :key="folder">
              <div style="background:var(--surface2); padding:0.5rem 1rem; border-radius:var(--radius-sm); font-weight:bold; color:var(--text); margin-top:1rem; border:1px solid var(--border);">
                📁 {{ folder }} <span style="font-weight:normal; color:var(--text-dim); font-size:0.8rem; margin-left:0.5rem;">({{ files.length }} items)</span>
              </div>
              <div v-for="f in files" :key="f.filename" class="upload-item">
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
                <div class="upload-item-name" :title="f.name || f.filename">{{ f.name || f.filename }}</div>
                <div class="upload-item-meta">{{ f.size_mb }} MB</div>
                <div class="upload-item-action">
                  <button class="btn btn-primary btn-sm" @click="useExistingUpload(f.filename)">Use ▶</button>
                </div>
              </div>
            </div>
            </template>
          </div>
        </div>
      </div>

      <!-- ── Editor step ── -->
      <div v-else class="reframe-editor">

        <!-- ─── Left panel: controls (mode-aware) ─── -->
        <div class="reframe-panel">

          <!-- ZOOMED: single zoom/pan -->
          <template v-if="store.reframe.shortsMode === 'zoomed'">
            <div class="reframe-panel-header">
              <span class="reframe-panel-badge reframe-panel-badge--top">FRAME</span>
              <h3>Zoom &amp; Pan</h3>
            </div>

            <label class="ctrl-label">Zoom
              <span class="ctrl-value">{{ store.reframe.single.zoom.toFixed(2) }}×</span>
            </label>
            <input class="ctrl-range" type="range" min="1" max="5" step="0.01"
                   :value="store.reframe.single.zoom"
                   @input="store.reframe.single.zoom = +$event.target.value" />

            <label class="ctrl-label">Pan X
              <span class="ctrl-value">{{ store.reframe.single.panX > 0 ? '+' : '' }}{{ store.reframe.single.panX }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                   :value="store.reframe.single.panX"
                   @input="store.reframe.single.panX = +$event.target.value" />

            <label class="ctrl-label">Pan Y
              <span class="ctrl-value">{{ store.reframe.single.panY > 0 ? '+' : '' }}{{ store.reframe.single.panY }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                   :value="store.reframe.single.panY"
                   @input="store.reframe.single.panY = +$event.target.value" />

            <button class="btn btn-outline btn-sm" style="margin-top:.5rem"
                    @click="store.reframe.single = { zoom:1, panX:0, panY:0 }">Reset</button>
          </template>

          <!-- BLUR BG: info only -->
          <template v-else-if="store.reframe.shortsMode === 'blur_bg'">
            <div class="reframe-panel-header">
              <span class="reframe-panel-badge" style="background:var(--accent2)">AUTO</span>
              <h3>Blurred Background</h3>
            </div>
            <p class="reframe-export-info" style="margin-top:.75rem">
              The background is automatically generated by blurring and scaling
              the source video to fill 9:16.<br><br>
              The original video is overlaid, centered and letterboxed on top.
            </p>
          </template>

          <!-- BLACK BG: info only -->
          <template v-else-if="store.reframe.shortsMode === 'black_bg'">
            <div class="reframe-panel-header">
              <span class="reframe-panel-badge" style="background:#333">AUTO</span>
              <h3>Black Background</h3>
            </div>
            <p class="reframe-export-info" style="margin-top:.75rem">
              The video is scaled to fit inside 9:16 with solid black bars
              filling the remaining space. No adjustments needed — just export.
            </p>
          </template>

          <!-- SPLIT-SCREEN: dual top/bottom -->
          <template v-else>
            <!-- Split Ratio slider -->
            <div class="reframe-panel-header">
              <span class="reframe-panel-badge" style="background:rgba(255,215,0,0.2);color:#FFD700;border:1px solid rgba(255,215,0,0.4)">RATIO</span>
              <h3>Split Ratio</h3>
            </div>
            <label class="ctrl-label">Top
              <span class="ctrl-value">{{ topPct }}% / {{ botPct }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="20" max="80" step="1"
                   :value="store.reframe.splitRatio"
                   @input="store.reframe.splitRatio = +$event.target.value" />

            <div class="reframe-divider"></div>

            <div class="reframe-panel-header">
              <span class="reframe-panel-badge reframe-panel-badge--top">TOP {{ topPct }}%</span>
              <h3>Top Section</h3>
            </div>

            <label class="ctrl-label">Zoom
              <span class="ctrl-value">{{ store.reframe.top.zoom.toFixed(2) }}×</span>
            </label>
            <input class="ctrl-range" type="range" min="1" max="5" step="0.01"
                   :value="store.reframe.top.zoom"
                   @input="store.reframe.top.zoom = +$event.target.value" />

            <label class="ctrl-label">Pan X
              <span class="ctrl-value">{{ store.reframe.top.panX > 0 ? '+' : '' }}{{ store.reframe.top.panX }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                   :value="store.reframe.top.panX"
                   @input="store.reframe.top.panX = +$event.target.value" />

            <label class="ctrl-label">Pan Y
              <span class="ctrl-value">{{ store.reframe.top.panY > 0 ? '+' : '' }}{{ store.reframe.top.panY }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                   :value="store.reframe.top.panY"
                   @input="store.reframe.top.panY = +$event.target.value" />

            <button class="btn btn-outline btn-sm" style="margin-top:.5rem"
                    @click="store.reframe.top = { zoom:1, panX:0, panY:0 }">Reset</button>

            <div class="reframe-divider"></div>

            <div class="reframe-panel-header">
              <span class="reframe-panel-badge reframe-panel-badge--bottom">BOTTOM {{ botPct }}%</span>
              <h3>Bottom Section</h3>
            </div>

            <label class="ctrl-label">Zoom
              <span class="ctrl-value">{{ store.reframe.bottom.zoom.toFixed(2) }}×</span>
            </label>
            <input class="ctrl-range" type="range" min="1" max="5" step="0.01"
                   :value="store.reframe.bottom.zoom"
                   @input="store.reframe.bottom.zoom = +$event.target.value" />

            <label class="ctrl-label">Pan X
              <span class="ctrl-value">{{ store.reframe.bottom.panX > 0 ? '+' : '' }}{{ store.reframe.bottom.panX }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                   :value="store.reframe.bottom.panX"
                   @input="store.reframe.bottom.panX = +$event.target.value" />

            <label class="ctrl-label">Pan Y
              <span class="ctrl-value">{{ store.reframe.bottom.panY > 0 ? '+' : '' }}{{ store.reframe.bottom.panY }}%</span>
            </label>
            <input class="ctrl-range" type="range" min="-100" max="100" step="1"
                   :value="store.reframe.bottom.panY"
                   @input="store.reframe.bottom.panY = +$event.target.value" />

            <button class="btn btn-outline btn-sm" style="margin-top:.5rem"
                    @click="store.reframe.bottom = { zoom:1, panX:0, panY:0 }">Reset</button>
          </template>
        </div>

        <!-- Center: 9:16 Preview (mode-aware) -->
        <div class="reframe-center">
          <button class="btn btn-ghost back-btn" @click="goBack">← Back</button>
          <p class="reframe-hint">Live preview — what you see is what will be exported</p>

          <div class="reframe-canvas-wrap">

            <!-- ZOOMED preview -->
            <div v-if="store.reframe.shortsMode === 'zoomed'" class="reframe-canvas" style="background:#000; overflow:hidden; position:relative;">
              <video :src="videoSrc" ref="videoTop"
                     :style="sectionStyle('single')"
                     preload="metadata" playsinline loop />
            </div>

            <!-- BLUR BG preview -->
            <div v-else-if="store.reframe.shortsMode === 'blur_bg'" class="reframe-canvas" style="overflow:hidden; position:relative;">
              <video :src="videoSrc" ref="videoTop"
                     style="position:absolute;inset:0;width:100%;height:100%;object-fit:cover;filter:blur(20px) brightness(0.6);"
                     preload="metadata" playsinline muted loop />
              <video :src="videoSrc" ref="videoBot"
                     style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;"
                     preload="metadata" playsinline loop />
            </div>

            <!-- BLACK BG preview -->
            <div v-else-if="store.reframe.shortsMode === 'black_bg'" class="reframe-canvas" style="background:#000; overflow:hidden; position:relative;">
              <video :src="videoSrc" ref="videoTop"
                     style="position:absolute;inset:0;width:100%;height:100%;object-fit:contain;"
                     preload="metadata" playsinline loop />
            </div>

            <!-- SPLIT-SCREEN preview -->
            <div v-else class="reframe-canvas">
              <div class="reframe-section" :style="{ height: topPct + '%' }">
                <video :src="videoSrc" ref="videoTop"
                       :style="sectionStyle('top')"
                       @timeupdate="syncBot"
                       preload="metadata" playsinline loop />
                <div class="reframe-section-label">Top</div>
              </div>
              <div class="reframe-sub-zone" :style="{ top: topPct + '%' }">
                <span class="reframe-sub-label">Subtitle area</span>
              </div>
              <div class="reframe-section" :style="{ height: botPct + '%' }">
                <video :src="videoSrc" ref="videoBot"
                       :style="sectionStyle('bottom')"
                       preload="metadata" playsinline muted loop />
                <div class="reframe-section-label reframe-section-label--bottom">Bottom</div>
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
          <p class="reframe-export-info">Mode: <b>{{ MODE_LABELS[store.reframe.shortsMode] }}</b></p>

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
              <button class="btn btn-primary" style="background:var(--accent); border-color:var(--accent); color:#000" @click="goToRefine">✨ Auto-Refine this video</button>
              <button class="btn btn-outline btn-sm" @click="closeRender">Close</button>
            </div>
            <div v-if="rr.error" style="margin-top:1rem">
              <button class="btn btn-outline btn-sm" @click="closeRender">Close</button>
            </div>
          </div>

          <div class="reframe-divider"></div>
          <p class="reframe-export-info" style="color:var(--text-dim); font-size:.75rem">
            Tip: Use the sliders on the left to frame the shot. Zoom in to fill
            the canvas edge-to-edge.
          </p>
        </div>

      </div>
    </div>
  `,
};
