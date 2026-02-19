import { ref, computed } from 'vue';
import store from '../store.js';
import {
  ytAnalyze, ytPollAnalyze,
  ytCut, ytPollCut,
} from '../api.js';

// â”€â”€â”€ helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function fmtSeconds(s) {
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = Math.floor(s % 60);
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function fmtDuration(secs) {
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}

export default {
  name: 'YtClipperView',
  setup() {
    // â”€â”€ state â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const url = ref('');
    const criteria = ref('');
    const geminiKey = ref('');

    const analyzeStatus = ref('idle'); // idle | running | done | error
    const analyzeMessage = ref('');
    const analyzeJobId = ref('');
    const videoTitle = ref('');
    const videoDuration = ref(0);
    const proposedClips = ref([]);

    const cutStatus = ref('idle'); // idle | running | done | error
    const cutMessage = ref('');
    const cutProgress = ref(0);
    const cutJobId = ref('');
    const doneClips = ref([]);

    let analyzePollTimer = null;
    let cutPollTimer = null;

    // â”€â”€ computed â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const selectedClips = computed(() => proposedClips.value.filter(c => c.selected));
    const canAnalyze = computed(() =>
      url.value.trim() &&
      geminiKey.value.trim() &&
      analyzeStatus.value !== 'running'
    );
    const canCut = computed(() =>
      selectedClips.value.length > 0 &&
      cutStatus.value !== 'running' &&
      analyzeStatus.value === 'done'
    );

    // â”€â”€ analyze â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function startAnalyze() {
      if (!canAnalyze.value) return;
      analyzeStatus.value = 'running';
      analyzeMessage.value = 'Starting analysis...';
      proposedClips.value = [];
      videoTitle.value = '';
      cutStatus.value = 'idle';
      doneClips.value = [];

      try {
        const res = await ytAnalyze(url.value.trim(), criteria.value.trim(), geminiKey.value.trim());
        analyzeJobId.value = res.job_id;
        _pollAnalyze();
      } catch (e) {
        analyzeStatus.value = 'error';
        analyzeMessage.value = e.message;
      }
    }

    function _pollAnalyze() {
      analyzePollTimer = setInterval(async () => {
        try {
          const data = await ytPollAnalyze(analyzeJobId.value);
          analyzeMessage.value = data.message;

          if (data.status === 'done') {
            clearInterval(analyzePollTimer);
            analyzeStatus.value = 'done';
            videoTitle.value = data.video_title;
            videoDuration.value = data.video_duration;
            proposedClips.value = (data.clips || []).map(c => ({ ...c, selected: true }));
          } else if (data.status === 'error') {
            clearInterval(analyzePollTimer);
            analyzeStatus.value = 'error';
          }
        } catch (e) {
          clearInterval(analyzePollTimer);
          analyzeStatus.value = 'error';
          analyzeMessage.value = e.message;
        }
      }, 2000);
    }

    function toggleAll(val) {
      proposedClips.value.forEach(c => (c.selected = val));
    }

    // â”€â”€ cut â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    async function startCut() {
      if (!canCut.value) return;
      cutStatus.value = 'running';
      cutMessage.value = 'Starting...';
      cutProgress.value = 0;
      doneClips.value = [];

      const clipsPayload = selectedClips.value.map(c => ({
        id: c.id,
        title: c.title,
        start: c.start,
        end: c.end,
        reason: c.reason,
      }));

      try {
        const res = await ytCut(url.value.trim(), clipsPayload);
        cutJobId.value = res.job_id;
        _pollCut();
      } catch (e) {
        cutStatus.value = 'error';
        cutMessage.value = e.message;
      }
    }

    function _pollCut() {
      cutPollTimer = setInterval(async () => {
        try {
          const data = await ytPollCut(cutJobId.value);
          cutMessage.value = data.message;
          cutProgress.value = data.progress || 0;

          if (data.status === 'done') {
            clearInterval(cutPollTimer);
            cutStatus.value = 'done';
            doneClips.value = data.clips || [];
          } else if (data.status === 'error') {
            clearInterval(cutPollTimer);
            cutStatus.value = 'error';
          }
        } catch (e) {
          clearInterval(cutPollTimer);
          cutStatus.value = 'error';
          cutMessage.value = e.message;
        }
      }, 2000);
    }

    function clipUrl(filename) {
      return `/uploads/${encodeURIComponent(filename)}`;
    }

    function goSubtitleClip(filename) {
      store.yt.prefillFile = filename;
      store.currentView = 'upload';
      store.appMode = 'subtitle';
    }

    function goHome() {
      store.appMode = 'home';
    }

    function reset() {
      if (analyzePollTimer) clearInterval(analyzePollTimer);
      if (cutPollTimer) clearInterval(cutPollTimer);
      url.value = '';
      criteria.value = '';
      analyzeStatus.value = 'idle';
      analyzeMessage.value = '';
      proposedClips.value = [];
      cutStatus.value = 'idle';
      cutMessage.value = '';
      doneClips.value = [];
    }

    return {
      url, criteria, geminiKey,
      analyzeStatus, analyzeMessage, videoTitle, videoDuration, proposedClips,
      cutStatus, cutMessage, cutProgress, doneClips,
      selectedClips, canAnalyze, canCut,
      startAnalyze, startCut,
      toggleAll, fmtSeconds, fmtDuration,
      goHome, goSubtitleClip, clipUrl, reset,
    };
  },

  template: `
<div class="ytc-root">

  <!-- Header bar -->
  <div class="ytc-topbar">
    <button class="btn btn-ghost ytc-back" @click="goHome">&larr; Back</button>
    <h1 class="ytc-heading">&#x1F3AC; YouTube Clip Finder</h1>
  </div>

  <div class="ytc-body">

    <!-- Input section -->
    <div class="ytc-card ytc-input-card">

      <div class="ytc-field">
        <label class="ytc-label">YouTube URL</label>
        <input
          v-model="url"
          class="ytc-input"
          placeholder="https://www.youtube.com/watch?v=..."
          :disabled="analyzeStatus === 'running'"
          @keydown.enter="startAnalyze"
        />
      </div>

      <div class="ytc-field">
        <label class="ytc-label">
          Gemini API Key
          <span class="ytc-hint-text">
            &ndash; not stored anywhere, only used for this request &middot;
            <a href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Get a free key</a>
          </span>
        </label>
        <input
          v-model="geminiKey"
          type="password"
          class="ytc-input ytc-key-input"
          placeholder="AIza..."
          :disabled="analyzeStatus === 'running'"
          autocomplete="off"
        />
      </div>

      <div class="ytc-field">
        <label class="ytc-label">
          What kind of clips do you want?
          <span class="ytc-hint-text">(optional &ndash; leave blank to find all clippable moments)</span>
        </label>
        <textarea
          v-model="criteria"
          class="ytc-textarea"
          rows="3"
          placeholder="e.g. funny moments, key insights, emotional moments, top 5 highlights..."
          :disabled="analyzeStatus === 'running'"
        />
      </div>

      <div class="ytc-action-row">
        <button
          class="btn btn-primary ytc-analyze-btn"
          :disabled="!canAnalyze"
          @click="startAnalyze"
        >
          {{ analyzeStatus === 'running' ? '\u23F3 Analyzing...' : '\uD83D\uDD0D Find Clips with Gemini' }}
        </button>
        <button v-if="analyzeStatus !== 'idle'" class="btn btn-ghost" @click="reset">Reset</button>
      </div>

    </div>

    <!-- Analysis progress -->
    <div v-if="analyzeStatus === 'running'" class="ytc-card ytc-status-card ytc-status--running">
      <div class="ytc-spinner"></div>
      <p class="ytc-status-msg">{{ analyzeMessage }}</p>
    </div>
    <div v-if="analyzeStatus === 'error'" class="ytc-card ytc-status-card ytc-status--error">
      <p>&#x274C; {{ analyzeMessage }}</p>
    </div>

    <!-- Proposed clips -->
    <div v-if="analyzeStatus === 'done' && proposedClips.length" class="ytc-card ytc-clips-card">
      <div class="ytc-clips-header">
        <div>
          <h2 class="ytc-clips-title">{{ videoTitle }}</h2>
          <p class="ytc-clips-sub">
            {{ proposedClips.length }} clip(s) found &middot; video duration {{ fmtDuration(videoDuration) }}
          </p>
        </div>
        <div class="ytc-select-all">
          <button class="btn btn-ghost btn-xs" @click="toggleAll(true)">Select all</button>
          <button class="btn btn-ghost btn-xs" @click="toggleAll(false)">Deselect all</button>
        </div>
      </div>

      <div class="ytc-clips-list">
        <div
          v-for="clip in proposedClips"
          :key="clip.id"
          class="ytc-clip-item"
          :class="{ 'ytc-clip-item--selected': clip.selected }"
          @click="clip.selected = !clip.selected"
        >
          <div class="ytc-clip-check">
            <input type="checkbox" :checked="clip.selected" @click.stop="clip.selected = !clip.selected" />
          </div>
          <div class="ytc-clip-body">
            <div class="ytc-clip-top">
              <span class="ytc-clip-title">{{ clip.title }}</span>
              <span class="ytc-clip-time">
                {{ fmtSeconds(clip.start) }} &ndash; {{ fmtSeconds(clip.end) }}
                <span class="ytc-clip-dur">({{ fmtDuration(clip.duration) }})</span>
              </span>
            </div>
            <p class="ytc-clip-reason">{{ clip.reason }}</p>
          </div>
        </div>
      </div>

      <div class="ytc-cut-bar">
        <span class="ytc-selected-count">{{ selectedClips.length }} / {{ proposedClips.length }} selected</span>
        <button
          class="btn btn-accent ytc-cut-btn"
          :disabled="!canCut"
          @click="startCut"
        >
          {{ cutStatus === 'running' ? '\u23F3 Processing...' : '\u2702 Download & Cut Selected' }}
        </button>
      </div>
    </div>

    <!-- Cut progress -->
    <div v-if="cutStatus === 'running'" class="ytc-card ytc-status-card ytc-status--running">
      <div class="ytc-progress-bar">
        <div class="ytc-progress-fill" :style="{ width: cutProgress + '%' }"></div>
      </div>
      <p class="ytc-status-msg">{{ cutMessage }}</p>
    </div>
    <div v-if="cutStatus === 'error'" class="ytc-card ytc-status-card ytc-status--error">
      <p>&#x274C; {{ cutMessage }}</p>
    </div>

    <!-- Done clips -->
    <div v-if="cutStatus === 'done' && doneClips.length" class="ytc-card ytc-done-card">
      <h2 class="ytc-done-title">&#x1F389; {{ doneClips.length }} clip(s) ready in uploads!</h2>
      <div class="ytc-done-grid">
        <div v-for="clip in doneClips" :key="clip.id" class="ytc-done-clip-card">

          <!-- Video preview -->
          <div class="ytc-done-video-wrap">
            <video
              class="ytc-done-video"
              :src="clipUrl(clip.filename) + '#t=2'"
              preload="metadata"
              muted
              playsinline
              @mouseenter="e => e.target.play()"
              @mouseleave="e => { e.target.pause(); e.target.currentTime = 2; }"
            ></video>
            <span class="ytc-done-badge">{{ fmtDuration(clip.duration) }}</span>
          </div>

          <!-- Info -->
          <div class="ytc-done-clip-body">
            <div class="ytc-done-clip-title">{{ clip.title }}</div>
            <div class="ytc-done-clip-time">{{ fmtSeconds(clip.start) }} &ndash; {{ fmtSeconds(clip.end) }}</div>
            <p class="ytc-done-clip-reason">{{ clip.reason }}</p>
          </div>

          <!-- CTA -->
          <div class="ytc-done-clip-cta">
            <button class="btn btn-primary btn-sm ytc-done-cta-btn" @click="goSubtitleClip(clip.filename)">
              &#x1F4AC; Auto-subtitle &rarr;
            </button>
          </div>

        </div>
      </div>
    </div>

  </div>
</div>
  `,
};

