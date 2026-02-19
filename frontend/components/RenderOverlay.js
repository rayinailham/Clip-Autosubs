import { ref } from 'vue';
import store, { getStyleConfig } from '../store.js';
import { startRenderJob, pollRenderStatus } from '../api.js';

export default {
  name: 'RenderOverlay',
  setup() {
    const r = store.render;
    let pollInterval = null;

    async function startRender() {
      if (!store.words.length || !store.videoFilename) {
        alert('No transcription loaded.');
        return;
      }

      r.active = true;
      r.title = 'Rendering…';
      r.status = 'Starting…';
      r.indeterminate = true;
      r.progress = 30;
      r.done = false;
      r.error = false;
      r.downloadUrl = '';

      try {
        const payload = {
          video_filename: store.videoFilename,
          words: store.words,
          style: getStyleConfig(),
        };
        if (store.useCustomGroups && store.customGroups.length > 0) {
          payload.word_groups = store.customGroups;
        }
        const { render_id } = await startRenderJob(payload);
        startPolling(render_id);
      } catch (err) {
        alert('Render error: ' + err.message);
        closeOverlay();
      }
    }

    function startPolling(renderId) {
      pollInterval = setInterval(async () => {
        try {
          const data = await pollRenderStatus(renderId);
          if (data.status === 'generating_subtitles') {
            r.status = 'Generating subtitle file…';
          } else if (data.status === 'rendering') {
            r.status = 'Burning subtitles into video…';
          } else if (data.status === 'done') {
            clearInterval(pollInterval);
            r.title = 'Render Complete!';
            r.status = 'File: ' + data.filename + ' (' + data.size_mb + ' MB)';
            r.indeterminate = false;
            r.progress = 100;
            r.done = true;
            r.downloadUrl = data.url;
            r.downloadLabel = '📥 Download (' + data.size_mb + ' MB)';
          } else if (data.status === 'error') {
            clearInterval(pollInterval);
            r.title = 'Render Failed';
            r.status = data.error || 'Unknown error';
            r.indeterminate = false;
            r.progress = 100;
            r.error = true;
          }
        } catch {
          // network error, keep polling
        }
      }, 2000);
    }

    function closeOverlay() {
      if (pollInterval) clearInterval(pollInterval);
      r.active = false;
    }

    return { store, r: store.render, startRender, closeOverlay };
  },
  template: `
    <!-- Render button (placed in bottom bar) -->
    <!-- This component manages the overlay only; the trigger button is in EditorView -->

    <div class="render-overlay" :class="{ active: r.active }">
      <div class="render-modal">
        <h3>{{ r.title }}</h3>
        <div class="progress-track" style="margin-top: 1rem;">
          <div class="progress-fill"
               :style="{
                 width: r.indeterminate ? '30%' : r.progress + '%',
                 animation: r.indeterminate ? 'indeterminate 1.5s infinite ease-in-out' : 'none',
                 background: r.error ? 'var(--error)' : ''
               }"></div>
        </div>
        <div class="render-status">{{ r.status }}</div>
        <div v-if="r.done" class="download-area">
          <a :href="r.downloadUrl" class="btn btn-success" download>{{ r.downloadLabel }}</a>
          <br/><br/>
          <button class="btn btn-outline" @click="closeOverlay">Close</button>
        </div>
        <div v-if="r.error" class="download-area">
          <button class="btn btn-outline" @click="closeOverlay">Close</button>
        </div>
      </div>
    </div>
  `,
};
