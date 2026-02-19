/**
 * TrimPanel — Manually trim a video between two time points.
 *
 * In / Out points can be set by typing or by clicking "Set to current time".
 * Submits POST /trim, polls until done, then swaps the active video + remaps
 * word timestamps so subtitles stay aligned.
 */
import { computed } from 'vue';
import store from '../store.js';
import { startTrimJob, pollTrimStatus } from '../api.js';

// ── Remap words to the trimmed timeline ─────────────────────────────────────
function remapWordsToTrim(words, inPoint, outPoint) {
  return words
    .filter(w => w.end > inPoint && w.start < outPoint)   // only keep overlapping words
    .map(w => ({
      ...w,
      start: parseFloat(Math.max(0, w.start - inPoint).toFixed(4)),
      end:   parseFloat(Math.min(outPoint - inPoint, w.end - inPoint).toFixed(4)),
    }));
}

let _pollTimer = null;
function stopPoll() {
  if (_pollTimer) { clearInterval(_pollTimer); _pollTimer = null; }
}

export default {
  name: 'TrimPanel',
  emits: ['seek'],

  setup(_, { emit }) {
    const tr = computed(() => store.trimmer);

    const hasDuration = computed(() => {
      const v = document.getElementById('editor-video');
      return !!(v && v.duration && !isNaN(v.duration));
    });

    function getCurrentTime() {
      const v = document.getElementById('editor-video');
      return v ? parseFloat(v.currentTime.toFixed(3)) : 0;
    }

    function getDuration() {
      const v = document.getElementById('editor-video');
      return v && v.duration ? v.duration : 0;
    }

    // ── Set In / Out from current playhead ──────────────────────
    function setIn() {
      const t = getCurrentTime();
      store.trimmer.inPoint = t;
      if (store.trimmer.outPoint !== null && store.trimmer.outPoint <= t) {
        store.trimmer.outPoint = null;
      }
    }

    function setOut() {
      const t = getCurrentTime();
      store.trimmer.outPoint = t;
      if (store.trimmer.inPoint !== null && store.trimmer.inPoint >= t) {
        store.trimmer.inPoint = null;
      }
    }

    function clearPoints() {
      store.trimmer.inPoint = null;
      store.trimmer.outPoint = null;
    }

    // ── Validated number input ───────────────────────────────────
    function onInInput(e) {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v >= 0) store.trimmer.inPoint = parseFloat(v.toFixed(3));
    }

    function onOutInput(e) {
      const v = parseFloat(e.target.value);
      if (!isNaN(v) && v >= 0) store.trimmer.outPoint = parseFloat(v.toFixed(3));
    }

    // Seek video when user clicks a time chip
    function seekTo(t) {
      emit('seek', t);
    }

    const selectionDuration = computed(() => {
      const { inPoint, outPoint } = store.trimmer;
      if (inPoint === null || outPoint === null) return null;
      return outPoint - inPoint;
    });

    const canCut = computed(() => {
      const { inPoint, outPoint } = store.trimmer;
      if (inPoint === null || outPoint === null) return false;
      return outPoint > inPoint && !!store.videoFilename;
    });

    // ── Start trim job ───────────────────────────────────────────
    async function startTrim() {
      if (!canCut.value) return;
      stopPoll();

      const t = store.trimmer;
      t.active = true;
      t.status = 'queued';
      t.log    = 'Queuing job…';
      t.error  = '';
      t.downloadUrl   = '';
      t.downloadLabel = '';

      try {
        const { job_id } = await startTrimJob({
          video_filename: store.videoFilename,
          trim_start: t.inPoint,
          trim_end:   t.outPoint,
        });

        t.jobId = job_id;
        t.log   = 'Job started — polling…';

        _pollTimer = setInterval(async () => {
          try {
            const data = await pollTrimStatus(job_id);
            t.status = data.status;
            t.log    = data.log || data.status;

            if (data.status === 'done') {
              stopPoll();
              t.active        = false;
              t.downloadUrl   = data.url;
              t.downloadLabel = data.filename;
              t.durationS     = data.duration_s;
              t.sizeMb        = data.size_mb;

              // Remap word timestamps to the trimmed video
              const inPt = data.trim_start;
              const outPt = data.trim_end;
              if (store.words.length > 0) {
                store.words = remapWordsToTrim(store.words, inPt, outPt);
              }
              // Swap active video
              store.videoFilename = data.filename;
              // Clear in/out points now that trim is applied
              t.inPoint  = null;
              t.outPoint = null;

            } else if (data.status === 'error') {
              stopPoll();
              t.active = false;
              t.error  = data.error || 'Unknown error';
            }
          } catch (e) {
            stopPoll();
            t.active = false;
            t.error  = `Polling failed: ${e.message}`;
          }
        }, 1200);

      } catch (e) {
        t.active = false;
        t.status = 'error';
        t.error  = e.message;
      }
    }

    function reset() {
      stopPoll();
      const t = store.trimmer;
      t.active = false; t.status = ''; t.log = '';
      t.error = ''; t.downloadUrl = ''; t.downloadLabel = '';
      t.durationS = 0; t.sizeMb = 0;
    }

    function fmt(secs) {
      if (secs == null) return '—';
      const m = Math.floor(secs / 60);
      const s = (secs % 60).toFixed(3);
      return m > 0 ? `${m}m ${s}s` : `${s}s`;
    }

    function fmtShort(secs) {
      if (secs == null) return '—';
      const m = Math.floor(secs / 60);
      const s = String(Math.floor(secs % 60)).padStart(2, '0');
      const ms = String(Math.floor((secs % 1) * 1000)).padStart(3, '0');
      return `${m}:${s}.${ms}`;
    }

    const hasVideo = computed(() => !!store.videoFilename);

    return {
      tr, canCut, selectionDuration, hasVideo,
      setIn, setOut, clearPoints, onInInput, onOutInput, seekTo,
      startTrim, reset, fmt, fmtShort,
    };
  },

  template: `
    <div class="trim-panel">

      <!-- Header -->
      <div class="sc-header">
        <span class="sc-icon">✂</span>
        <div>
          <div class="sc-title">Manual Trim</div>
          <div class="sc-subtitle">Set In / Out points, then cut</div>
        </div>
      </div>

      <div v-if="!hasVideo && !tr.downloadUrl" class="sc-warning">
        ⚠ Open a video in the editor first.
      </div>

      <template v-else>
        <!-- In Point -->
        <div class="trim-point-row">
          <div class="trim-point-label">
            <span class="trim-badge trim-badge-in">IN</span>
          </div>
          <input
            type="number"
            step="0.001" min="0"
            class="trim-time-input"
            :value="tr.inPoint ?? ''"
            placeholder="0.000"
            :disabled="tr.active"
            @change="onInInput"
          />
          <button class="trim-set-btn" :disabled="tr.active" @click="setIn" title="Set to current playhead">
            ◆ Now
          </button>
          <button v-if="tr.inPoint !== null" class="trim-seek-btn" @click="seekTo(tr.inPoint)" title="Seek to In point">
            ↩
          </button>
        </div>

        <!-- Out Point -->
        <div class="trim-point-row">
          <div class="trim-point-label">
            <span class="trim-badge trim-badge-out">OUT</span>
          </div>
          <input
            type="number"
            step="0.001" min="0"
            class="trim-time-input"
            :value="tr.outPoint ?? ''"
            placeholder="end"
            :disabled="tr.active"
            @change="onOutInput"
          />
          <button class="trim-set-btn" :disabled="tr.active" @click="setOut" title="Set to current playhead">
            ◆ Now
          </button>
          <button v-if="tr.outPoint !== null" class="trim-seek-btn" @click="seekTo(tr.outPoint)" title="Seek to Out point">
            ↩
          </button>
        </div>

        <!-- Selection summary -->
        <div v-if="selectionDuration !== null" class="trim-summary">
          <span class="trim-summary-label">Selection</span>
          <span class="trim-summary-value">{{ fmtShort(tr.inPoint) }} → {{ fmtShort(tr.outPoint) }}</span>
          <span class="trim-summary-dur">{{ fmt(selectionDuration) }}</span>
        </div>

        <div v-if="tr.inPoint !== null && tr.outPoint !== null && tr.outPoint <= tr.inPoint" class="sc-warning" style="margin-top:0.5rem">
          ⚠ Out point must be after In point.
        </div>

        <!-- Clear + Cut buttons -->
        <div class="trim-actions">
          <button class="btn btn-outline trim-clear-btn" :disabled="tr.active" @click="clearPoints">
            Clear
          </button>
          <button
            class="btn btn-primary sc-btn trim-cut-btn"
            :disabled="!canCut || tr.active"
            @click="startTrim"
          >
            <span v-if="tr.active" class="sc-spinner"></span>
            {{ tr.active ? 'Trimming…' : '✂ Cut Clip' }}
          </button>
        </div>

        <!-- Progress -->
        <div v-if="tr.active" class="sc-progress">
          <div class="sc-progress-bar">
            <div class="sc-progress-fill sc-indeterminate"></div>
          </div>
          <p class="sc-log-text">{{ tr.log }}</p>
        </div>

        <!-- Error -->
        <div v-if="tr.error" class="sc-error">
          <strong>Error:</strong> {{ tr.error }}
          <button class="sc-reset-btn" @click="reset">Try again</button>
        </div>

        <!-- Done -->
        <div v-if="tr.status === 'done' && tr.downloadUrl" class="sc-done">
          <div class="sc-done-header">✅ Clip ready!</div>
          <div class="sc-stats">
            <div class="sc-stat">
              <span class="sc-stat-label">Duration</span>
              <span class="sc-stat-value">{{ fmt(tr.durationS) }}</span>
            </div>
            <div class="sc-stat">
              <span class="sc-stat-label">File size</span>
              <span class="sc-stat-value">{{ tr.sizeMb }} MB</span>
            </div>
          </div>
          <a :href="tr.downloadUrl" :download="tr.downloadLabel" class="btn btn-primary sc-download-btn">
            ⬇ Download
          </a>
          <button class="sc-reset-btn" @click="reset">Trim another</button>
        </div>
      </template>
    </div>
  `,
};
