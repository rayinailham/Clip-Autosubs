import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import store from '../store.js';
import {
  ytAnalyze, ytPollAnalyze,
  ytCut, ytPollCut,
} from '../api.js';

// Per-session persistence. Each session gets its own storage slot keyed by id.
function sessionKey(id) { return `ytclipper.session.${id}`; }
function saveSession(id, snap) {
  try { localStorage.setItem(sessionKey(id), JSON.stringify(snap)); } catch (_) {}
}
function loadSession(id) {
  try {
    const raw = localStorage.getItem(sessionKey(id));
    return raw ? JSON.parse(raw) : null;
  } catch (_) { return null; }
}
function clearSession(id) {
  try { localStorage.removeItem(sessionKey(id)); } catch (_) {}
}

// ─── helpers ──────────────────────────────────────────────────
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

function fmtTimecode(s) {
  s = Math.max(0, Math.floor(Number(s) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

function parseTimecode(str) {
  if (str == null) return null;
  const t = String(str).trim();
  if (t === '') return null;
  if (/^\d+(\.\d+)?$/.test(t)) return parseFloat(t);
  const parts = t.split(':');
  if (parts.length > 3) return null;
  let total = 0;
  for (const p of parts) {
    if (!/^\d+(\.\d+)?$/.test(p.trim())) return null;
    total = total * 60 + parseFloat(p.trim());
  }
  return total;
}

export default {
  name: 'YtSession',
  props: {
    id: { type: String, required: true },
    index: { type: Number, default: 0 },
  },
  emits: ['remove', 'meta'],
  setup(props, { emit }) {
    // ── state ────────────────────────────────────────────────
    const url = ref('');
    const criteria = ref('');
    const aiKeyOverride = ref('');
    const showKeyOverride = ref(false);

    const useChatSignal = ref(true);
    const includeSetup = ref(true);

    const analyzeStatus = ref('idle'); // idle | running | done | error
    const analyzeMessage = ref('');
    const analyzeStage = ref('');
    const analyzeElapsed = ref(0);
    const analyzeJobId = ref('');
    const videoTitle = ref('');
    const videoId = ref('');
    const videoDuration = ref(0);
    const proposedClips = ref([]);
    const previewClipId = ref(null);
    const editClipId = ref(null);

    const cutStatus = ref('idle'); // idle | running | done | error
    const cutMessage = ref('');
    const cutProgress = ref(0);
    const cutJobId = ref('');
    const doneClips = ref([]);

    const collapsed = ref(false);

    let analyzePollTimer = null;
    let cutPollTimer = null;

    // ── session persistence ──────────────────
    function fmtElapsed(s) {
      s = Math.max(0, Math.floor(s || 0));
      const m = Math.floor(s / 60);
      const sec = s % 60;
      if (m > 0) return `${m}m ${sec}s`;
      return `${sec}s`;
    }
    const stageLabel = computed(() => {
      switch (analyzeStage.value) {
        case 'queued': return 'Queued';
        case 'extracting': return 'Extracting captions';
        case 'chat': return 'Live chat';
        case 'analyzing': return 'AI analysis';
        case 'done': return 'Done';
        case 'error': return 'Error';
        default: return analyzeStage.value || '';
      }
    });

    function snapshot() {
      return {
        url: url.value,
        criteria: criteria.value,
        useChatSignal: useChatSignal.value,
        includeSetup: includeSetup.value,
        analyzeStatus: analyzeStatus.value,
        analyzeMessage: analyzeMessage.value,
        analyzeStage: analyzeStage.value,
        analyzeElapsed: analyzeElapsed.value,
        analyzeJobId: analyzeJobId.value,
        videoTitle: videoTitle.value,
        videoId: videoId.value,
        videoDuration: videoDuration.value,
        proposedClips: proposedClips.value,
        previewClipId: previewClipId.value,
        cutStatus: cutStatus.value,
        cutMessage: cutMessage.value,
        cutProgress: cutProgress.value,
        cutJobId: cutJobId.value,
        doneClips: doneClips.value,
        collapsed: collapsed.value,
        ts: Date.now(),
      };
    }
    function persist() {
      saveSession(props.id, snapshot());
      // Bubble a lightweight summary so the parent can render a header chip.
      emit('meta', {
        id: props.id,
        title: videoTitle.value || url.value || '',
        analyzeStatus: analyzeStatus.value,
        cutStatus: cutStatus.value,
        cutProgress: cutProgress.value,
      });
    }

    // ── computed ─────────────────────────────────────────────
    const selectedClips = computed(() => proposedClips.value.filter(c => c.selected));
    const selectedTotalDuration = computed(() =>
      selectedClips.value.reduce((sum, c) => sum + (Number(c.duration) || 0), 0)
    );
    const effectiveKey = computed(() => {
      const override = aiKeyOverride.value.trim();
      if (override) return override;
      return store.settings.ai_api_key_set ? '' : '';
    });
    const hasKey = computed(() =>
      aiKeyOverride.value.trim() !== '' || store.settings.ai_api_key_set
    );
    const canAnalyze = computed(() =>
      url.value.trim() &&
      hasKey.value &&
      analyzeStatus.value !== 'running'
    );
    const canCut = computed(() =>
      selectedClips.value.length > 0 &&
      cutStatus.value !== 'running' &&
      analyzeStatus.value === 'done'
    );

    // ── analyze ──────────────────────────────────────────────
    async function startAnalyze() {
      if (!canAnalyze.value) return;
      analyzeStatus.value = 'running';
      analyzeMessage.value = 'Starting analysis...';
      proposedClips.value = [];
      videoTitle.value = '';
      cutStatus.value = 'idle';
      doneClips.value = [];
      persist();

      try {
        const res = await ytAnalyze(url.value.trim(), criteria.value.trim(), effectiveKey.value, {
          useChatSignal: useChatSignal.value,
          includeSetup: includeSetup.value,
        });
        analyzeJobId.value = res.job_id;
        persist();
        _pollAnalyze();
      } catch (e) {
        analyzeStatus.value = 'error';
        analyzeMessage.value = e.message;
        persist();
      }
    }

    function _pollAnalyze() {
      analyzePollTimer = setInterval(async () => {
        try {
          const data = await ytPollAnalyze(analyzeJobId.value);
          analyzeMessage.value = data.message;
          analyzeStage.value = data.status || '';
          if (typeof data.elapsed === 'number') analyzeElapsed.value = data.elapsed;

          if (data.status === 'done') {
            clearInterval(analyzePollTimer);
            analyzeStatus.value = 'done';
            videoTitle.value = data.video_title;
            videoId.value = data.video_id || '';
            videoDuration.value = data.video_duration;
            proposedClips.value = (data.clips || []).map(c => ({
              ...c,
              selected: true,
              _origStart: c.start,
              _origEnd: c.end,
            }));
            persist();
          } else if (data.status === 'error') {
            clearInterval(analyzePollTimer);
            analyzeStatus.value = 'error';
            persist();
          } else {
            persist();
          }
        } catch (e) {
          clearInterval(analyzePollTimer);
          analyzeStatus.value = 'error';
          analyzeMessage.value = e.message;
          persist();
        }
      }, 2000);
    }

    function toggleAll(val) {
      proposedClips.value.forEach(c => (c.selected = val));
      persist();
    }

    // ── cut ──────────────────────────────────────────────────
    async function startCut() {
      if (!canCut.value) return;
      cutStatus.value = 'running';
      cutMessage.value = 'Starting...';
      cutProgress.value = 0;
      doneClips.value = [];
      persist();

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
        persist();
        _pollCut();
      } catch (e) {
        cutStatus.value = 'error';
        cutMessage.value = e.message;
        persist();
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
            persist();
          } else if (data.status === 'error') {
            clearInterval(cutPollTimer);
            cutStatus.value = 'error';
            persist();
          } else {
            persist();
          }
        } catch (e) {
          clearInterval(cutPollTimer);
          cutStatus.value = 'error';
          cutMessage.value = e.message;
          persist();
        }
      }, 2000);
    }

    function clipUrl(filename) {
      return `/uploads/${encodeURIComponent(filename)}`;
    }

    function ytEmbedUrl(clip) {
      if (!videoId.value) return '';
      const start = typeof clip === 'object' && clip ? clip.start : clip;
      const s = Math.max(0, Math.floor(start || 0));
      let u = `https://www.youtube.com/embed/${videoId.value}?start=${s}&autoplay=1&rel=0`;
      if (typeof clip === 'object' && clip && clip.end) {
        const e = Math.ceil(Number(clip.end) || 0);
        if (e > s) u += `&end=${e}`;
      }
      return u;
    }

    function togglePreview(clipId) {
      previewClipId.value = previewClipId.value === clipId ? null : clipId;
      persist();
    }

    function toggleEdit(clipId) {
      editClipId.value = editClipId.value === clipId ? null : clipId;
      persist();
    }

    function _normalizeClip(clip) {
      let start = Math.max(0, Number(clip.start) || 0);
      let end = Number(clip.end) || 0;
      if (videoDuration.value) end = Math.min(end, videoDuration.value);
      if (end <= start) end = start + 1;
      clip.start = Math.round(start * 100) / 100;
      clip.end = Math.round(end * 100) / 100;
      clip.duration = Math.round((clip.end - clip.start) * 100) / 100;
    }

    function setClipTime(clip, edge, raw) {
      const secs = parseTimecode(raw);
      if (secs == null) return;
      clip[edge] = secs;
      _normalizeClip(clip);
      persist();
    }

    function nudgeClip(clip, edge, delta) {
      clip[edge] = (Number(clip[edge]) || 0) + delta;
      _normalizeClip(clip);
      persist();
    }

    function resetClipTime(clip) {
      if (typeof clip._origStart === 'number') clip.start = clip._origStart;
      if (typeof clip._origEnd === 'number') clip.end = clip._origEnd;
      _normalizeClip(clip);
      persist();
    }

    function clipEdited(clip) {
      return (typeof clip._origStart === 'number' && clip.start !== clip._origStart) ||
             (typeof clip._origEnd === 'number' && clip.end !== clip._origEnd);
    }

    function goSubtitleClip(filename) {
      store.yt.prefillFile = filename;
      store.currentView = 'upload';
      store.appMode = 'subtitle';
    }

    function toggleCollapse() {
      collapsed.value = !collapsed.value;
      persist();
    }

    function removeSelf() {
      if (analyzePollTimer) clearInterval(analyzePollTimer);
      if (cutPollTimer) clearInterval(cutPollTimer);
      clearSession(props.id);
      emit('remove', props.id);
    }

    function resetSession() {
      if (analyzePollTimer) clearInterval(analyzePollTimer);
      if (cutPollTimer) clearInterval(cutPollTimer);
      url.value = '';
      criteria.value = '';
      analyzeStatus.value = 'idle';
      analyzeMessage.value = '';
      analyzeStage.value = '';
      analyzeElapsed.value = 0;
      analyzeJobId.value = '';
      videoTitle.value = '';
      videoId.value = '';
      videoDuration.value = 0;
      proposedClips.value = [];
      previewClipId.value = null;
      editClipId.value = null;
      cutStatus.value = 'idle';
      cutMessage.value = '';
      cutProgress.value = 0;
      cutJobId.value = '';
      doneClips.value = [];
      persist();
    }

    // ── restore prior session on mount ────────
    onMounted(() => {
      const s = loadSession(props.id);
      if (!s) { persist(); return; }
      url.value = s.url || '';
      criteria.value = s.criteria || '';
      if (typeof s.useChatSignal === 'boolean') useChatSignal.value = s.useChatSignal;
      if (typeof s.includeSetup === 'boolean') includeSetup.value = s.includeSetup;
      analyzeStatus.value = s.analyzeStatus || 'idle';
      analyzeMessage.value = s.analyzeMessage || '';
      analyzeStage.value = s.analyzeStage || '';
      analyzeElapsed.value = s.analyzeElapsed || 0;
      analyzeJobId.value = s.analyzeJobId || '';
      videoTitle.value = s.videoTitle || '';
      videoId.value = s.videoId || '';
      videoDuration.value = s.videoDuration || 0;
      proposedClips.value = s.proposedClips || [];
      previewClipId.value = s.previewClipId || null;
      cutStatus.value = s.cutStatus || 'idle';
      cutMessage.value = s.cutMessage || '';
      cutProgress.value = s.cutProgress || 0;
      cutJobId.value = s.cutJobId || '';
      doneClips.value = s.doneClips || [];
      if (typeof s.collapsed === 'boolean') collapsed.value = s.collapsed;

      if (analyzeStatus.value === 'running' && analyzeJobId.value) _pollAnalyze();
      if (cutStatus.value === 'running' && cutJobId.value) _pollCut();
      persist();
    });

    onBeforeUnmount(() => {
      if (analyzePollTimer) clearInterval(analyzePollTimer);
      if (cutPollTimer) clearInterval(cutPollTimer);
    });

    return {
      url, criteria,
      aiKeyOverride, showKeyOverride, hasKey,
      useChatSignal, includeSetup,
      store, collapsed,
      analyzeStatus, analyzeMessage, analyzeStage, analyzeElapsed, stageLabel, fmtElapsed,
      videoTitle, videoId, videoDuration, proposedClips, previewClipId, editClipId,
      cutStatus, cutMessage, cutProgress, doneClips,
      selectedClips, selectedTotalDuration, canAnalyze, canCut,
      startAnalyze, startCut,
      toggleAll, fmtSeconds, fmtDuration, fmtTimecode,
      toggleEdit, setClipTime, nudgeClip, resetClipTime, clipEdited,
      goSubtitleClip, clipUrl, ytEmbedUrl, togglePreview,
      toggleCollapse, removeSelf, resetSession,
    };
  },

  template: `
<div class="ytc-session" :class="{ 'ytc-session--collapsed': collapsed }">

  <!-- Session header -->
  <div class="ytc-session-head" @click="toggleCollapse">
    <div class="ytc-session-head-left">
      <span class="ytc-session-caret">{{ collapsed ? '\u25B6' : '\u25BC' }}</span>
      <span class="ytc-session-num">#{{ index + 1 }}</span>
      <span class="ytc-session-title">{{ videoTitle || url || 'New session' }}</span>
    </div>
    <div class="ytc-session-head-right">
      <span
        v-if="analyzeStatus === 'running'"
        class="ytc-session-chip ytc-session-chip--run"
      >\u23F3 {{ stageLabel }} {{ fmtElapsed(analyzeElapsed) }}</span>
      <span
        v-else-if="cutStatus === 'running'"
        class="ytc-session-chip ytc-session-chip--run"
      >\u2702 Cutting {{ cutProgress }}%</span>
      <span
        v-else-if="cutStatus === 'done'"
        class="ytc-session-chip ytc-session-chip--done"
      >\u2705 {{ doneClips.length }} clip(s)</span>
      <span
        v-else-if="analyzeStatus === 'done'"
        class="ytc-session-chip ytc-session-chip--ok"
      >{{ proposedClips.length }} found</span>
      <span
        v-else-if="analyzeStatus === 'error' || cutStatus === 'error'"
        class="ytc-session-chip ytc-session-chip--err"
      >\u274C Error</span>
      <button
        class="btn btn-ghost btn-xs ytc-session-remove"
        type="button"
        @click.stop="removeSelf"
        title="Remove this session"
      >\u2715</button>
    </div>
  </div>

  <div v-show="!collapsed" class="ytc-session-body">

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
          9Router API Key
          <span v-if="store.settings.ai_api_key_set" class="ytc-hint-text">
            &ndash; using saved key from
            <a href="#" @click.prevent="store.appMode = 'settings'">Settings</a>
            &middot; model <code>{{ store.settings.ai_model }}</code>
          </span>
          <span v-else class="ytc-hint-text">
            &ndash; no key saved. Add one in
            <a href="#" @click.prevent="store.appMode = 'settings'">Settings</a>
            or paste a one-off key below.
          </span>
        </label>
        <button
          v-if="store.settings.ai_api_key_set && !showKeyOverride"
          class="btn btn-ghost btn-xs"
          type="button"
          style="align-self:flex-start; margin-bottom:0.4rem;"
          @click="showKeyOverride = true"
        >Use a different key for this run</button>
        <input
          v-if="!store.settings.ai_api_key_set || showKeyOverride"
          v-model="aiKeyOverride"
          type="password"
          class="ytc-input ytc-key-input"
          placeholder="sk-..."
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

      <div class="ytc-field ytc-toggles">
        <label class="ytc-toggle">
          <input
            type="checkbox"
            v-model="useChatSignal"
            :disabled="analyzeStatus === 'running'"
          />
          <span>
            Use live-chat hype signal
            <span class="ytc-hint-text">&ndash; weighs chat laughter & spikes (auto-skipped if no chat replay)</span>
          </span>
        </label>
        <label class="ytc-toggle">
          <input
            type="checkbox"
            v-model="includeSetup"
            :disabled="analyzeStatus === 'running'"
          />
          <span>
            Include story setup (lead-in)
            <span class="ytc-hint-text">&ndash; walks clip start back &le;120s to nearest setup line, never past first spoken line</span>
          </span>
        </label>
      </div>

      <div class="ytc-action-row">
        <button
          class="btn btn-primary ytc-analyze-btn"
          :disabled="!canAnalyze"
          @click="startAnalyze"
        >
          {{ analyzeStatus === 'running' ? '\u23F3 Analyzing...' : '\uD83D\uDD0D Find Clips with AI' }}
        </button>
        <button v-if="analyzeStatus !== 'idle'" class="btn btn-ghost" @click="resetSession">Reset</button>
      </div>

    </div>

    <!-- Analysis progress -->
    <div v-if="analyzeStatus === 'running'" class="ytc-card ytc-status-card ytc-status--running">
      <div class="ytc-progress-head">
        <div class="ytc-spinner"></div>
        <div class="ytc-progress-text">
          <div class="ytc-progress-stage">
            <span class="ytc-stage-label">{{ stageLabel }}</span>
            <span class="ytc-stage-elapsed">{{ fmtElapsed(analyzeElapsed) }}</span>
          </div>
          <p class="ytc-status-msg">{{ analyzeMessage }}</p>
        </div>
      </div>
      <div class="ytc-stages">
        <span class="ytc-stage-pip" :class="{ active: analyzeStage === 'extracting', done: ['chat','analyzing','done'].includes(analyzeStage) }">1. Captions</span>
        <span class="ytc-stage-pip" :class="{ active: analyzeStage === 'chat', done: ['analyzing','done'].includes(analyzeStage), skipped: !useChatSignal }">2. Live chat</span>
        <span class="ytc-stage-pip" :class="{ active: analyzeStage === 'analyzing', done: analyzeStage === 'done' }">3. AI</span>
      </div>
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
          :class="{ 'ytc-clip-item--selected': clip.selected, 'ytc-clip-item--expanded': previewClipId === clip.id }"
        >
          <div class="ytc-clip-row" @click="clip.selected = !clip.selected">
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
              <div v-if="clip.factors && clip.factors.length" class="ytc-factor-chips">
                <span
                  v-for="f in clip.factors"
                  :key="f.key"
                  class="ytc-chip"
                  :class="'ytc-chip--' + f.tone"
                  :title="f.detail"
                >{{ f.label }}</span>
              </div>
            </div>
            <button
              class="btn btn-ghost btn-xs ytc-preview-btn"
              type="button"
              @click.stop="togglePreview(clip.id)"
              :disabled="!videoId"
              :title="videoId ? 'Preview at this timestamp' : 'No video id available'"
            >
              {{ previewClipId === clip.id ? '\u25BC Hide' : '\u25B6 Play' }}
            </button>
            <button
              class="btn btn-ghost btn-xs ytc-edit-btn"
              type="button"
              @click.stop="toggleEdit(clip.id)"
              :title="'Adjust start/end time'"
            >
              {{ editClipId === clip.id ? '\u2715 Close' : '\u270E Edit' }}
            </button>
          </div>

          <div v-if="editClipId === clip.id" class="ytc-clip-edit" @click.stop>
            <div class="ytc-edit-grid">
              <div class="ytc-edit-edge">
                <label class="ytc-edit-label">Start</label>
                <div class="ytc-edit-controls">
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'start', -1)" title="-1s">&minus;1s</button>
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'start', -0.5)" title="-0.5s">&minus;.5</button>
                  <input
                    class="ytc-edit-input"
                    type="text"
                    :value="fmtTimecode(clip.start)"
                    @change="setClipTime(clip, 'start', $event.target.value)"
                    @keyup.enter="setClipTime(clip, 'start', $event.target.value)"
                  />
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'start', 0.5)" title="+0.5s">+.5</button>
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'start', 1)" title="+1s">+1s</button>
                </div>
              </div>
              <div class="ytc-edit-edge">
                <label class="ytc-edit-label">End</label>
                <div class="ytc-edit-controls">
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'end', -1)" title="-1s">&minus;1s</button>
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'end', -0.5)" title="-0.5s">&minus;.5</button>
                  <input
                    class="ytc-edit-input"
                    type="text"
                    :value="fmtTimecode(clip.end)"
                    @change="setClipTime(clip, 'end', $event.target.value)"
                    @keyup.enter="setClipTime(clip, 'end', $event.target.value)"
                  />
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'end', 0.5)" title="+0.5s">+.5</button>
                  <button class="btn btn-ghost btn-xs ytc-nudge" type="button" @click="nudgeClip(clip, 'end', 1)" title="+1s">+1s</button>
                </div>
              </div>
            </div>
            <p class="ytc-edit-hint">Type a timecode (H:MM:SS) or use the nudge buttons. Duration: {{ fmtDuration(clip.duration) }}</p>
            <button
              v-if="clipEdited(clip)"
              class="btn btn-ghost btn-xs ytc-reset-btn"
              type="button"
              @click="resetClipTime(clip)"
              title="Restore AI's original start/end"
            >
              &#x21BA; Reset to original ({{ fmtTimecode(clip._origStart) }} &ndash; {{ fmtTimecode(clip._origEnd) }})
            </button>
          </div>

          <div v-if="previewClipId === clip.id && videoId" class="ytc-clip-preview">
            <div class="ytc-iframe-wrap">
              <iframe
                :src="ytEmbedUrl(clip)"
                frameborder="0"
                allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                allowfullscreen
                loading="lazy"
              ></iframe>
            </div>
          </div>
        </div>
      </div>

      <div class="ytc-cut-bar">
        <div class="ytc-cut-info">
          <span class="ytc-selected-count">{{ selectedClips.length }} / {{ proposedClips.length }} selected</span>
          <span v-if="selectedClips.length" class="ytc-selected-total">
            &middot; total {{ fmtDuration(selectedTotalDuration) }}
          </span>
        </div>
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

          <div class="ytc-done-clip-body">
            <div class="ytc-done-clip-title">{{ clip.title }}</div>
            <div class="ytc-done-clip-time">{{ fmtSeconds(clip.start) }} &ndash; {{ fmtSeconds(clip.end) }}</div>
            <p class="ytc-done-clip-reason">{{ clip.reason }}</p>
          </div>

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

