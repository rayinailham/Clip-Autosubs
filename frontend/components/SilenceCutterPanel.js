/**
 * SilenceCutterPanel — UI for the Cut Silence feature.
 *
 * Reads word timestamps already in the store, lets the user tune two
 * parameters, then fires POST /cut-silence and polls until done.
 * Downloads the result via a link to GET /rendered/<filename>.
 */
import { computed } from 'vue';
import store from '../store.js';
import { startCutSilenceJob, pollCutSilenceStatus } from '../api.js';
import { saveUndoSnapshot, regenerateAutoGroups } from '../store.js';

// ── Remap word timestamps to new silence-cut timeline ────────────────────────
function remapTime(t, segments) {
  let offset = 0;
  for (const [s, e] of segments) {
    if (t <= e) {
      if (t >= s) return offset + (t - s);
      return offset; // t was in a silent gap — clamp to segment start
    }
    offset += e - s;
  }
  return offset; // after last segment
}

function remapWords(words, segments) {
  return words.map(w => ({
    ...w,
    start: parseFloat(remapTime(w.start, segments).toFixed(4)),
    end:   parseFloat(remapTime(w.end,   segments).toFixed(4)),
  }));
}

function applyToEditor(filename, segments) {
  saveUndoSnapshot('Cut silence');
  if (segments && segments.length > 0) {
    store.words = remapWords(store.words, segments);
    // Update custom group timings to match remapped word timestamps
    if (store.useCustomGroups && store.customGroups.length > 0) {
      for (const g of store.customGroups) {
        const wordsInGroup = g.word_indices.map(i => store.words[i]).filter(Boolean);
        if (wordsInGroup.length > 0) {
          g.start = wordsInGroup[0].start;
          g.end = wordsInGroup[wordsInGroup.length - 1].end;
        }
      }
    } else {
      // Regenerate auto groups with new timestamps
      regenerateAutoGroups();
    }
  }
  // Reset split points — they reference old timestamps and are now invalid
  store.splitPoints = [];
  store.removedSegments = [];
  store.videoFilename = filename;
}

let _pollTimer = null;

function stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export default {
  name: 'SilenceCutterPanel',

  setup() {
    const sc = computed(() => store.silenceCutter);

    const hasWords = computed(() => store.words.length > 0);

    // ── Start job ──────────────────────────────────────────────────────────
    async function startCut() {
      if (!hasWords.value) return;
      stopPoll();

      const s = store.silenceCutter;
      s.active    = true;
      s.status    = 'queued';
      s.log       = 'Queuing job…';
      s.error     = '';
      s.downloadUrl   = '';
      s.downloadLabel = '';
      s.stats     = null;

      try {
        const { job_id } = await startCutSilenceJob({
          video_filename: store.videoFilename,
          words: store.words,
          min_silence_ms: s.minSilenceMs,
          padding_ms: s.paddingMs,
        });

        s.jobId  = job_id;
        s.log    = 'Job started — polling…';

        _pollTimer = setInterval(async () => {
          try {
            const data = await pollCutSilenceStatus(job_id);
            s.status = data.status;
            s.log    = data.log || data.status;

            if (data.status === 'done') {
              stopPoll();
              s.active        = false;
              s.downloadUrl   = data.url;
              s.downloadLabel = data.filename;
              s.stats         = {
                kept:     data.kept_duration_s,
                removed:  data.removed_duration_s,
                original: data.original_duration_s,
                ratio:    data.compression_ratio,
                segments: data.segments_kept,
                sizeMb:   data.size_mb,
              };
              // Apply the cut video as the active editor video
              if (data.filename) applyToEditor(data.filename, data.segments);
            } else if (data.status === 'error') {
              stopPoll();
              s.active = false;
              s.error  = data.error || 'Unknown error';
            }
          } catch (e) {
            stopPoll();
            s.active = false;
            s.error  = `Polling failed: ${e.message}`;
          }
        }, 1500);

      } catch (e) {
        s.active = false;
        s.status = 'error';
        s.error  = e.message;
      }
    }

    function reset() {
      stopPoll();
      const s = store.silenceCutter;
      s.active = false; s.status = ''; s.log = '';
      s.error = ''; s.downloadUrl = ''; s.downloadLabel = ''; s.stats = null;
    }

    // Helpers
    function fmt(secs) {
      if (secs == null) return '—';
      const m = Math.floor(secs / 60);
      const s = (secs % 60).toFixed(1);
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    return { sc, hasWords, startCut, reset, fmt };
  },

  template: `
    <div class="silence-cutter-panel">

      <!-- ── Header ── -->
      <div class="sc-header">
        <span class="sc-icon">✂️</span>
        <div>
          <div class="sc-title">Cut Silence</div>
          <div class="sc-subtitle">Remove silent gaps using word timestamps</div>
        </div>
      </div>

      <!-- ── No words warning ── -->
      <div v-if="!hasWords" class="sc-warning">
        ⚠ Transcribe a video first to enable silence cutting.
      </div>

      <template v-else>

        <!-- ── Controls ── -->
        <div class="sc-section">
          <label class="sc-label">
            Min silence to cut
            <span class="sc-value">{{ sc.minSilenceMs }} ms</span>
          </label>
          <input
            type="range" min="100" max="2000" step="50"
            v-model.number="sc.minSilenceMs"
            :disabled="sc.active"
            class="sc-range"
          />
          <div class="sc-range-hints"><span>100 ms</span><span>2 s</span></div>
        </div>

        <div class="sc-section">
          <label class="sc-label">
            Padding around speech
            <span class="sc-value">{{ sc.paddingMs }} ms</span>
          </label>
          <input
            type="range" min="0" max="500" step="25"
            v-model.number="sc.paddingMs"
            :disabled="sc.active"
            class="sc-range"
          />
          <div class="sc-range-hints"><span>0 ms</span><span>500 ms</span></div>
        </div>

        <!-- ── Action button ── -->
        <button
          class="btn btn-primary sc-btn"
          @click="startCut"
          :disabled="sc.active"
        >
          <span v-if="sc.active" class="sc-spinner"></span>
          {{ sc.active ? 'Cutting…' : '✂️ Cut Silence' }}
        </button>

        <!-- ── Progress ── -->
        <div v-if="sc.active || sc.status === 'queued' || sc.status === 'processing'" class="sc-progress">
          <div class="sc-progress-bar">
            <div class="sc-progress-fill sc-indeterminate"></div>
          </div>
          <p class="sc-log-text">{{ sc.log }}</p>
        </div>

        <!-- ── Error ── -->
        <div v-if="sc.error" class="sc-error">
          <strong>Error:</strong> {{ sc.error }}
          <button class="sc-reset-btn" @click="reset">Try again</button>
        </div>

        <!-- ── Done ── -->
        <div v-if="sc.status === 'done' && sc.downloadUrl" class="sc-done">
          <div class="sc-done-header">✅ Silence removed!</div>

          <!-- Stats table -->
          <div v-if="sc.stats" class="sc-stats">
            <div class="sc-stat">
              <span class="sc-stat-label">Original</span>
              <span class="sc-stat-value">{{ fmt(sc.stats.original) }}</span>
            </div>
            <div class="sc-stat">
              <span class="sc-stat-label">Kept</span>
              <span class="sc-stat-value">{{ fmt(sc.stats.kept) }}</span>
            </div>
            <div class="sc-stat">
              <span class="sc-stat-label">Removed</span>
              <span class="sc-stat-value sc-removed">{{ fmt(sc.stats.removed) }}</span>
            </div>
            <div class="sc-stat">
              <span class="sc-stat-label">Segments</span>
              <span class="sc-stat-value">{{ sc.stats.segments }}</span>
            </div>
            <div class="sc-stat">
              <span class="sc-stat-label">Output size</span>
              <span class="sc-stat-value">{{ sc.stats.sizeMb }} MB</span>
            </div>
          </div>

          <a :href="sc.downloadUrl" :download="sc.downloadLabel" class="btn btn-primary sc-download-btn">
            ⬇ Download
          </a>
          <button class="sc-reset-btn" @click="reset">Cut another</button>
        </div>

      </template>
    </div>
  `,
};
