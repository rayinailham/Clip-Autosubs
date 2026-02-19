import { ref, computed, onMounted, onBeforeUnmount } from 'vue';
import store, { getActiveGroups, saveUndoSnapshot, regenerateAutoGroups } from '../store.js';

export default {
  name: 'Timeline',
  emits: ['seek'],
  setup(_, { emit }) {
    const currentTime = ref(0);
    const duration = ref(0);
    const isDragging = ref(false);   // track-scrub drag
    const hoveredGroup = ref(null);
    let rafId = null;

    // ── Group drag state ──────────────────────────────────────────
    // mode: 'start' | 'end' | 'move'
    const groupDrag = ref(null);
    const playheadDrag = ref(false);

    function getVideo() {
      return document.getElementById('editor-video');
    }

    function getTrackEl() {
      return document.querySelector('.timeline-track');
    }

    function togglePlay() {
      const v = getVideo();
      if (v) {
        if (v.paused) v.play();
        else v.pause();
      }
    }

    function tick() {
      const v = getVideo();
      if (v) {
        currentTime.value = v.currentTime;
        if (v.duration && !isNaN(v.duration) && v.duration !== Infinity) {
          duration.value = v.duration;
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    onMounted(() => {
      let attempts = 0;
      const tryInit = () => {
        const v = getVideo();
        if (v) {
          v.addEventListener('loadedmetadata', () => {
            if (v.duration && !isNaN(v.duration)) duration.value = v.duration;
          });
          if (v.duration && !isNaN(v.duration)) duration.value = v.duration;
        }
        if (!duration.value && store.metadata?.duration) {
          duration.value = store.metadata.duration;
        }
        if (!v && attempts++ < 10) setTimeout(tryInit, 300);
      };
      tryInit();
      rafId = requestAnimationFrame(tick);

      window.addEventListener('mousemove', onWindowMouseMove);
      window.addEventListener('mouseup', onWindowMouseUp);
    });

    onBeforeUnmount(() => {
      if (rafId) cancelAnimationFrame(rafId);
      window.removeEventListener('mousemove', onWindowMouseMove);
      window.removeEventListener('mouseup', onWindowMouseUp);
    });

    const groups = computed(() => getActiveGroups());

    function pct(t) {
      return duration.value ? Math.max(0, Math.min(100, (t / duration.value) * 100)) : 0;
    }

    // ── Track scrub ───────────────────────────────────────────────
    function seekFromEvent(e) {
      const trackEl = getTrackEl();
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      emit('seek', (x / rect.width) * (duration.value || 0));
    }

    function onTrackMouseDown(e) {
      isDragging.value = true;
      seekFromEvent(e);
    }

    // ── Group timing drag ─────────────────────────────────────────
    function ensureCustomGroups(gi) {
      if (!store.useCustomGroups) {
        regenerateAutoGroups();
        store.useCustomGroups = true;
      }
      saveUndoSnapshot('Drag timing group ' + (gi + 1));
    }

    function onGroupHandleMouseDown(e, gi, mode) {
      e.stopPropagation();
      e.preventDefault();
      const trackEl = getTrackEl();
      if (!trackEl) return;
      ensureCustomGroups(gi);
      const rect = trackEl.getBoundingClientRect();
      const g = store.customGroups[gi];
      groupDrag.value = {
        mode,
        gi,
        origStart: g.start,
        origEnd: g.end,
        startPx: e.clientX,
        trackWidth: rect.width,
      };
    }

    function onWindowMouseMove(e) {
      if (groupDrag.value) {
        const d = groupDrag.value;
        const dx = e.clientX - d.startPx;
        const dt = (dx / d.trackWidth) * duration.value;
        const g = store.customGroups[d.gi];
        if (!g) return;
        const blockDur = d.origEnd - d.origStart;
        if (d.mode === 'start') {
          g.start = parseFloat(Math.max(0, Math.min(d.origStart + dt, d.origEnd - 0.1)).toFixed(2));
        } else if (d.mode === 'end') {
          g.end = parseFloat(Math.max(d.origStart + 0.1, Math.min(d.origEnd + dt, duration.value)).toFixed(2));
        } else {
          // move: clamp so block stays within [0, duration]
          const newStart = Math.max(0, Math.min(d.origStart + dt, duration.value - blockDur));
          g.start = parseFloat(newStart.toFixed(2));
          g.end = parseFloat((newStart + blockDur).toFixed(2));
        }
        return;
      }
      if (playheadDrag.value) {
        seekFromEvent(e);
        return;
      }
      if (isDragging.value) seekFromEvent(e);
    }

    function onWindowMouseUp() {
      if (groupDrag.value) {
        const d = groupDrag.value;
        const g = store.customGroups[d.gi];
        if (g) emit('seek', g.start);
        groupDrag.value = null;
        return;
      }
      playheadDrag.value = false;
      isDragging.value = false;
    }

    function onPlayheadMouseDown(e) {
      e.stopPropagation();
      e.preventDefault();
      playheadDrag.value = true;
      seekFromEvent(e);
    }

    function fmtSec(t) {
      return parseFloat(t).toFixed(2);
    }

    function formatTime(t) {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      const ms = Math.floor((t % 1) * 1000);
      return m + ':' + String(s).padStart(2, '0') + '.' + String(ms).padStart(3, '0');
    }

    function formatTimeNoMs(t) {
      const m = Math.floor(t / 60);
      const s = Math.floor(t % 60);
      return m + ':' + String(s).padStart(2, '0');
    }

    const tickMarks = computed(() => {
      if (!duration.value) return [];
      let step = 5;
      if (duration.value > 120) step = 15;
      if (duration.value > 300) step = 30;
      if (duration.value > 600) step = 60;
      const marks = [];
      for (let t = 0; t <= duration.value; t += step) marks.push(t);
      return marks;
    });

    // Uniform color for all group blocks
    function groupColor() { return 'rgba(124, 92, 252, 0.30)'; }
    function groupBorderColor() { return 'rgba(124, 92, 252, 0.65)'; }

    return {
      currentTime, duration, groups, isDragging, groupDrag, hoveredGroup, playheadDrag,
      pct, onTrackMouseDown, onGroupHandleMouseDown, onPlayheadMouseDown, togglePlay,
      formatTime, formatTimeNoMs, fmtSec, tickMarks, groupColor, groupBorderColor,
    };
  },
  template: `
    <div class="timeline" :class="{ dragging: isDragging, 'group-dragging': groupDrag, 'playhead-dragging': playheadDrag }">
      <div v-if="!duration" class="timeline-empty">
        <span>⏱ Timeline will appear after video loads</span>
      </div>

      <template v-else>
        <!-- Top controls -->
        <div class="timeline-controls">
          <button class="timeline-play-btn" @click="togglePlay" title="Play / Pause">
            ▶ / ⏸
          </button>
        </div>

        <!-- Scrub track -->
        <div class="timeline-track"
             @mousedown="onTrackMouseDown">

          <!-- Background bar -->
          <div class="timeline-bg"></div>

          <!-- Played bar -->
          <div class="timeline-played" :style="{ width: pct(currentTime) + '%' }"></div>

          <!-- Group blocks -->
          <div v-for="(g, i) in groups" :key="i"
               class="timeline-group"
               :class="{ 'is-dragging': groupDrag && groupDrag.gi === i }"
               :style="{
                 left: pct(g.start) + '%',
                 width: Math.max(0.6, pct(g.end) - pct(g.start)) + '%',
                 background: groupColor(i),
                 borderColor: groupBorderColor(i),
               }"
               :title="'#' + (i+1) + ' ' + g.words.map(w => w.text).join(' ')">

            <!-- Left resize handle -->
            <div class="tg-handle tg-handle-start"
                 @mousedown.stop="onGroupHandleMouseDown($event, i, 'start')"
                 title="Drag to adjust start time"></div>

            <!-- Body — drag to move -->
            <div class="tg-body"
                 @mousedown.stop="onGroupHandleMouseDown($event, i, 'move')">
              <span class="timeline-group-label">
                {{ g.words.slice(0, 3).map(w => w.text).join(' ') }}{{ g.words.length > 3 ? '…' : '' }}
              </span>
            </div>

            <!-- Right resize handle -->
            <div class="tg-handle tg-handle-end"
                 @mousedown.stop="onGroupHandleMouseDown($event, i, 'end')"
                 title="Drag to adjust end time"></div>

            <!-- Timing tooltip while dragging -->
            <div v-if="groupDrag && groupDrag.gi === i" class="timeline-drag-tooltip">
              {{ fmtSec(g.start) }}s – {{ fmtSec(g.end) }}s
            </div>
          </div>

          <!-- Playhead — draggable -->
          <div class="timeline-playhead" 
               :class="{ 'is-dragging': playheadDrag }"
               :style="{ left: pct(currentTime) + '%' }"
               @mousedown="onPlayheadMouseDown">
            <div class="timeline-playhead-head"></div>
            <div v-if="playheadDrag" class="timeline-playhead-tooltip">
              {{ formatTime(currentTime) }}
            </div>
          </div>
        </div>

        <!-- Time ruler -->
        <div class="timeline-ruler">
          <div v-for="t in tickMarks" :key="t"
               class="timeline-tick"
               :style="{ left: pct(t) + '%' }">
            <div class="timeline-tick-mark"></div>
            <span class="timeline-tick-label">{{ formatTimeNoMs(t) }}</span>
          </div>
        </div>

        <!-- Current time display -->
        <div class="timeline-time-display">
          <span class="timeline-current">{{ formatTime(currentTime) }}</span>
          <span class="timeline-sep">/</span>
          <span class="timeline-total">{{ formatTime(duration) }}</span>
          <span class="timeline-groups-count">{{ groups.length }} groups</span>
        </div>
      </template>
    </div>
  `,
};
