import { ref, computed, onMounted, onBeforeUnmount, watch, nextTick } from 'vue';
import store, { getActiveGroups, getUniqueSpeakers, getSpeakerColor, saveUndoSnapshot, regenerateAutoGroups, undoAction, redoAction, addSplitAtPlayhead, toggleSegment, removeSplitPoint, getSegments } from '../store.js';

export default {
  name: 'Timeline',
  emits: ['seek'],
  setup(_, { emit }) {
    const currentTime = ref(0);
    const duration = ref(0);
    const isDragging = ref(false);   // track-scrub drag
    const hoveredGroup = ref(null);
    let rafId = null;

    // ── Zoom state ────────────────────────────────────────────────
    const zoomLevel = ref(1);        // 1 = fit all, higher = zoomed in
    const scrollLeft = ref(0);       // scroll offset in px
    const MIN_ZOOM = 1;
    const MAX_ZOOM = 60;
    const ZOOM_STEP = 1.25;          // multiplier per wheel tick

    // ── Group drag state ──────────────────────────────────────────
    const groupDrag = ref(null);
    const playheadDrag = ref(false);
    // ── Trim marker drag state ──────────────────────────
    // mode: 'in' | 'out'
    const trimDrag = ref(null);
    // ── Middle-mouse pan state ────────────────────────────────────
    let isPanning = false;
    let panStartX = 0;
    let panStartScroll = 0;

    function getVideo() {
      return document.getElementById('editor-video');
    }

    function getTrackEl() {
      return document.querySelector('.timeline-track');
    }

    function getTrackWrapper() {
      return document.querySelector('.timeline-track-wrapper');
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
        store.currentTime = v.currentTime; // share with store
        if (v.duration && !isNaN(v.duration) && v.duration !== Infinity) {
          duration.value = v.duration;
        }
      }
      rafId = requestAnimationFrame(tick);
    }

    // ── Auto-scroll to keep playhead visible ──────────────────────
    function autoScrollToPlayhead() {
      if (zoomLevel.value <= 1) return;
      const wrapper = getTrackWrapper();
      if (!wrapper) return;
      const wrapperWidth = wrapper.clientWidth;
      const totalWidth = wrapperWidth * zoomLevel.value;
      const playheadX = (currentTime.value / (duration.value || 1)) * totalWidth;
      const viewLeft = wrapper.scrollLeft;
      const viewRight = viewLeft + wrapperWidth;
      const margin = wrapperWidth * 0.15;
      if (playheadX < viewLeft + margin) {
        wrapper.scrollLeft = Math.max(0, playheadX - margin);
      } else if (playheadX > viewRight - margin) {
        wrapper.scrollLeft = playheadX - wrapperWidth + margin;
      }
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

    // ── Track scrub (zoom-aware) ──────────────────────────────────
    function seekFromEvent(e) {
      const trackEl = getTrackEl();
      if (!trackEl) return;
      const rect = trackEl.getBoundingClientRect();
      const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
      emit('seek', (x / rect.width) * (duration.value || 0));
    }

    function onTrackMouseDown(e) {
      // Middle-mouse = pan
      if (e.button === 1) {
        e.preventDefault();
        isPanning = true;
        panStartX = e.clientX;
        const wrapper = getTrackWrapper();
        panStartScroll = wrapper ? wrapper.scrollLeft : 0;
        return;
      }
      isDragging.value = true;
      seekFromEvent(e);
    }

    // ── Zoom via scroll wheel ─────────────────────────────────────
    function onWheelZoom(e) {
      e.preventDefault();
      const wrapper = getTrackWrapper();
      if (!wrapper) return;

      const rect = wrapper.getBoundingClientRect();
      const mouseXInWrapper = e.clientX - rect.left;  // mouse pos relative to wrapper
      const oldScroll = wrapper.scrollLeft;
      const oldZoom = zoomLevel.value;

      // Compute the time under the mouse cursor
      const totalOldWidth = rect.width * oldZoom;
      const mousePosRatio = (oldScroll + mouseXInWrapper) / totalOldWidth;

      // Apply zoom
      if (e.deltaY < 0) {
        zoomLevel.value = Math.min(MAX_ZOOM, oldZoom * ZOOM_STEP);
      } else {
        zoomLevel.value = Math.max(MIN_ZOOM, oldZoom / ZOOM_STEP);
      }

      // Reposition scroll so the time under cursor stays in place
      nextTick(() => {
        const newTotalWidth = rect.width * zoomLevel.value;
        wrapper.scrollLeft = mousePosRatio * newTotalWidth - mouseXInWrapper;
      });
    }

    function zoomIn() {
      zoomLevel.value = Math.min(MAX_ZOOM, zoomLevel.value * ZOOM_STEP);
      nextTick(autoScrollToPlayhead);
    }

    function zoomOut() {
      zoomLevel.value = Math.max(MIN_ZOOM, zoomLevel.value / ZOOM_STEP);
      if (zoomLevel.value <= 1) {
        const wrapper = getTrackWrapper();
        if (wrapper) wrapper.scrollLeft = 0;
      }
    }

    function zoomReset() {
      zoomLevel.value = 1;
      const wrapper = getTrackWrapper();
      if (wrapper) wrapper.scrollLeft = 0;
    }

    function zoomToFit() {
      zoomLevel.value = 1;
      const wrapper = getTrackWrapper();
      if (wrapper) wrapper.scrollLeft = 0;
    }

    function onZoomSlider(e) {
      const val = parseFloat(e.target.value);
      zoomLevel.value = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, val));
      if (zoomLevel.value <= 1) {
        const wrapper = getTrackWrapper();
        if (wrapper) wrapper.scrollLeft = 0;
      } else {
        nextTick(autoScrollToPlayhead);
      }
    }

    const zoomPct = computed(() => Math.round(zoomLevel.value * 100));

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

    // ── Trim marker drag ─────────────────────────────────
    function onTrimMarkerMouseDown(e, mode) {
      e.stopPropagation();
      e.preventDefault();
      const trackEl = getTrackEl();
      if (!trackEl) return;
      trimDrag.value = { mode, trackWidth: trackEl.getBoundingClientRect().width };
    }

    function onWindowMouseMove(e) {
      // Middle-mouse panning
      if (isPanning) {
        const wrapper = getTrackWrapper();
        if (wrapper) {
          wrapper.scrollLeft = panStartScroll - (e.clientX - panStartX);
        }
        return;
      }
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
          const newStart = Math.max(0, Math.min(d.origStart + dt, duration.value - blockDur));
          g.start = parseFloat(newStart.toFixed(2));
          g.end = parseFloat((newStart + blockDur).toFixed(2));
        }
        return;
      }
      if (trimDrag.value) {
        const d = trimDrag.value;
        const trackEl = getTrackEl();
        if (trackEl) {
          const rect = trackEl.getBoundingClientRect();
          const x = Math.max(0, Math.min(e.clientX - rect.left, rect.width));
          const t = parseFloat(((x / rect.width) * duration.value).toFixed(3));
          if (d.mode === 'in') {
            store.trimmer.inPoint = Math.min(t, store.trimmer.outPoint !== null ? store.trimmer.outPoint - 0.05 : t);
          } else {
            store.trimmer.outPoint = Math.max(t, store.trimmer.inPoint !== null ? store.trimmer.inPoint + 0.05 : t);
          }
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
      if (trimDrag.value) {
        trimDrag.value = null;
        return;
      }
      if (isPanning) {
        isPanning = false;
        return;
      }
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

    function formatTimePrecise(t) {
      const m = Math.floor(t / 60);
      const s = (t % 60).toFixed(1);
      return m + ':' + String(s).padStart(4, '0');
    }

    // ── Dynamic tick marks based on zoom level ────────────────────
    const tickMarks = computed(() => {
      if (!duration.value) return [];
      const z = zoomLevel.value;
      // Choose step so ticks are never too dense or too sparse
      let step;
      const visibleDuration = duration.value / z;
      if (visibleDuration <= 5) step = 0.5;
      else if (visibleDuration <= 15) step = 1;
      else if (visibleDuration <= 30) step = 2;
      else if (visibleDuration <= 60) step = 5;
      else if (visibleDuration <= 120) step = 10;
      else if (visibleDuration <= 300) step = 15;
      else if (visibleDuration <= 600) step = 30;
      else step = 60;
      const marks = [];
      for (let t = 0; t <= duration.value; t += step) marks.push(t);
      return marks;
    });

    // Use ms in tick labels when zoomed in enough
    const showMsInTicks = computed(() => {
      const visibleDuration = duration.value / zoomLevel.value;
      return visibleDuration <= 15;
    });

    function groupColor(g) {
      if (g && g.speaker) {
        const c = getSpeakerColor(g.speaker);
        return c.bg;
      }
      return 'rgba(124, 92, 252, 0.30)';
    }
    function groupBorderColor(g) {
      if (g && g.speaker) {
        const c = getSpeakerColor(g.speaker);
        return c.border;
      }
      return 'rgba(124, 92, 252, 0.65)';
    }

    // ── Multi-speaker support ─────────────────────────────
    const uniqueSpeakers = computed(() => getUniqueSpeakers());
    const hasSpeakers = computed(() => uniqueSpeakers.value.length > 1);

    function speakerGroups(speaker) {
      return groups.value.filter(g => g.speaker === speaker);
    }

    function speakerLabel(speaker) {
      return store.speakers[speaker] || speaker.replace('SPEAKER_', 'Speaker ');
    }

    function speakerLabelColor(speaker) {
      return getSpeakerColor(speaker).label;
    }

    // ── Split / Segment helpers ────────────────────────────────────
    const segments = computed(() => getSegments(duration.value));
    const hasSplitPoints = computed(() => store.splitPoints.length > 0);
    const undoCount = computed(() => store.undoStack.length);
    const redoCount = computed(() => store.redoStack.length);
    const undoLabel = computed(() => {
      if (store.undoStack.length === 0) return 'Nothing to undo';
      return 'Undo: ' + store.undoStack[store.undoStack.length - 1].label;
    });
    const redoLabel = computed(() => {
      if (store.redoStack.length === 0) return 'Nothing to redo';
      return 'Redo: ' + store.redoStack[store.redoStack.length - 1].label;
    });


    // ── Trim markers from store ────────────────────────────
    const trimIn  = computed(() => store.trimmer.inPoint);
    const trimOut = computed(() => store.trimmer.outPoint);

    const trimRegionStyle = computed(() => {
      if (trimIn.value === null || trimOut.value === null) return null;
      const left  = pct(trimIn.value);
      const right = 100 - pct(trimOut.value);
      return { left: left + '%', right: right + '%' };
    });

    function handleToggleSegment(index) {
      import('../store.js').then(module => {
        module.toggleSegment(index);
      });
    }

    function handleRemoveSplit(index) {
      import('../store.js').then(module => {
        module.removeSplitPoint(index);
      });
    }

    // Track inner width style for zoomed content
    const trackInnerStyle = computed(() => ({
      width: (zoomLevel.value * 100) + '%',
      position: 'relative',
      height: '100%',
    }));

    return {
      currentTime, duration, groups, isDragging, groupDrag, hoveredGroup, playheadDrag,
      pct, onTrackMouseDown, onGroupHandleMouseDown, onPlayheadMouseDown, togglePlay,
      formatTime, formatTimeNoMs, formatTimePrecise, fmtSec, tickMarks, showMsInTicks,
      groupColor, groupBorderColor,
      zoomLevel, zoomPct, zoomIn, zoomOut, zoomReset, zoomToFit, onWheelZoom, onZoomSlider,
      trackInnerStyle, autoScrollToPlayhead,
      trimIn, trimOut, trimRegionStyle, onTrimMarkerMouseDown, trimDrag,
      // Speaker support
      uniqueSpeakers, hasSpeakers, speakerGroups, speakerLabel, speakerLabelColor,
      // Split / Undo / Redo
      segments, hasSplitPoints, handleToggleSegment, handleRemoveSplit,
      undoAction, redoAction, undoCount, redoCount, undoLabel, redoLabel,
      store,
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

          <div class="timeline-edit-controls">
            <button class="timeline-edit-btn timeline-undo-btn" @click="undoAction" :disabled="undoCount === 0" :title="undoLabel">
              ↩ <span v-if="undoCount > 0" class="edit-count">{{ undoCount }}</span>
            </button>
            <button class="timeline-edit-btn timeline-redo-btn" @click="redoAction" :disabled="redoCount === 0" :title="redoLabel">
              ↪ <span v-if="redoCount > 0" class="edit-count">{{ redoCount }}</span>
            </button>
          </div>

          <div class="timeline-zoom-controls">
            <button class="timeline-zoom-btn" @click="zoomOut" :disabled="zoomLevel <= 1" title="Zoom out (or scroll down)">−</button>
            <input type="range" class="timeline-zoom-slider" min="1" :max="60" step="0.25"
                   :value="zoomLevel"
                   @input="onZoomSlider($event)"
                   title="Drag to zoom" />
            <span class="timeline-zoom-label" @click="zoomReset" title="Click to reset zoom">{{ zoomPct }}%</span>
            <button class="timeline-zoom-btn" @click="zoomIn" :disabled="zoomLevel >= 60" title="Zoom in (or scroll up)">+</button>
            <button v-if="zoomLevel > 1" class="timeline-zoom-btn timeline-zoom-fit" @click="zoomToFit" title="Fit to view">⊟</button>
          </div>
        </div>

        <!-- Scrollable track wrapper -->
        <div class="timeline-track-wrapper"
             @wheel.prevent="onWheelZoom">
          <!-- Scrub track (inner, scaled by zoom) -->
          <div class="timeline-track"
               :style="trackInnerStyle"
               @mousedown="onTrackMouseDown">

            <!-- Background bar -->
            <div class="timeline-bg"></div>

            <!-- Segment blocks (when split points exist) -->
            <template v-if="hasSplitPoints">
              <div v-for="seg in segments" :key="'seg-' + seg.index"
                   class="timeline-segment"
                   :class="{ removed: !seg.active }"
                   :style="{
                     left: pct(seg.start) + '%',
                     width: Math.max(0.2, pct(seg.end) - pct(seg.start)) + '%',
                   }">
                <div class="segment-hitbox" @click.stop="handleToggleSegment(seg.index)"
                     :title="(seg.active ? 'Click to remove' : 'Click to keep') + ' segment ' + (seg.index + 1)">
                  <span class="segment-label">{{ seg.active ? '' : '✖ CUT' }}</span>
                </div>
              </div>
            </template>

            <!-- Split point lines -->
            <div v-for="(sp, si) in store.splitPoints" :key="'sp-' + si"
                 class="timeline-split-line"
                 :style="{ left: pct(sp) + '%' }"
                 @dblclick.stop="handleRemoveSplit(si)"
                 :title="'Split at ' + sp.toFixed(2) + 's — dbl-click to remove'">
              <div class="split-line-head">✂</div>
            </div>


            <!-- Played bar -->
            <div class="timeline-played" :style="{ width: pct(currentTime) + '%' }"></div>

            <!-- Trim region shading -->
            <div v-if="trimRegionStyle"
                 class="timeline-trim-region"
                 :style="trimRegionStyle"></div>

            <!-- Trim In marker -->
            <div v-if="trimIn !== null"
                 class="timeline-trim-marker timeline-trim-in"
                 :class="{ 'is-dragging': trimDrag && trimDrag.mode === 'in' }"
                 :style="{ left: pct(trimIn) + '%' }"
                 @mousedown.stop="onTrimMarkerMouseDown($event, 'in')"
                 title="In point — drag to adjust">
              <div class="trim-marker-head trim-marker-head-in">I</div>
              <div class="trim-marker-label">{{ fmtSec(trimIn) }}s</div>
            </div>

            <!-- Trim Out marker -->
            <div v-if="trimOut !== null"
                 class="timeline-trim-marker timeline-trim-out"
                 :class="{ 'is-dragging': trimDrag && trimDrag.mode === 'out' }"
                 :style="{ left: pct(trimOut) + '%' }"
                 @mousedown.stop="onTrimMarkerMouseDown($event, 'out')"
                 title="Out point — drag to adjust">
              <div class="trim-marker-head trim-marker-head-out">O</div>
              <div class="trim-marker-label">{{ fmtSec(trimOut) }}s</div>
            </div>

            <!-- Hook marker -->

            <!-- Multi-speaker layout -->
            <template v-if="hasSpeakers">
              <div v-for="spk in uniqueSpeakers" :key="'spk-' + spk"
                   class="timeline-speaker-row"
                   :style="{ borderLeftColor: speakerLabelColor(spk) }">
                <div class="timeline-speaker-tag" :style="{ background: speakerLabelColor(spk) }">
                  {{ speakerLabel(spk) }}
                </div>
                <div v-for="(g, i) in groups" :key="i"
                     v-show="g.speaker === spk"
                     class="timeline-group"
                     :class="{ 'is-dragging': groupDrag && groupDrag.gi === i }"
                     :style="{
                       left: pct(g.start) + '%',
                       width: Math.max(0.3, pct(g.end) - pct(g.start)) + '%',
                       background: groupColor(g),
                       borderColor: groupBorderColor(g),
                     }"
                     :title="'#' + (i+1) + ' [' + speakerLabel(spk) + '] ' + g.words.map(w => w.text).join(' ')">
                  <div class="tg-handle tg-handle-start"
                       @mousedown.stop="onGroupHandleMouseDown($event, i, 'start')"></div>
                  <div class="tg-body"
                       @mousedown.stop="onGroupHandleMouseDown($event, i, 'move')">
                    <span class="timeline-group-label">
                      {{ g.words.slice(0, 3).map(w => w.text).join(' ') }}{{ g.words.length > 3 ? '…' : '' }}
                    </span>
                  </div>
                  <div class="tg-handle tg-handle-end"
                       @mousedown.stop="onGroupHandleMouseDown($event, i, 'end')"></div>
                  <div v-if="groupDrag && groupDrag.gi === i" class="timeline-drag-tooltip">
                    {{ fmtSec(g.start) }}s – {{ fmtSec(g.end) }}s
                  </div>
                </div>
              </div>
            </template>

            <!-- Single-track layout (no speakers) -->
            <template v-else>
              <div v-for="(g, i) in groups" :key="i"
                   class="timeline-group"
                   :class="{ 'is-dragging': groupDrag && groupDrag.gi === i }"
                   :style="{
                     left: pct(g.start) + '%',
                     width: Math.max(0.3, pct(g.end) - pct(g.start)) + '%',
                     background: groupColor(g),
                     borderColor: groupBorderColor(g),
                   }"
                   :title="'#' + (i+1) + ' ' + g.words.map(w => w.text).join(' ')">
                <div class="tg-handle tg-handle-start"
                     @mousedown.stop="onGroupHandleMouseDown($event, i, 'start')"
                     title="Drag to adjust start time"></div>
                <div class="tg-body"
                     @mousedown.stop="onGroupHandleMouseDown($event, i, 'move')">
                  <span class="timeline-group-label">
                    {{ g.words.slice(0, 3).map(w => w.text).join(' ') }}{{ g.words.length > 3 ? '…' : '' }}
                  </span>
                </div>
                <div class="tg-handle tg-handle-end"
                     @mousedown.stop="onGroupHandleMouseDown($event, i, 'end')"
                     title="Drag to adjust end time"></div>
                <div v-if="groupDrag && groupDrag.gi === i" class="timeline-drag-tooltip">
                  {{ fmtSec(g.start) }}s – {{ fmtSec(g.end) }}s
                </div>
              </div>
            </template>

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

            <!-- Time ruler (inside the zoomed track) -->
            <div class="timeline-ruler-inner">
              <div v-for="t in tickMarks" :key="t"
                   class="timeline-tick"
                   :style="{ left: pct(t) + '%' }">
                <div class="timeline-tick-mark"></div>
                <span class="timeline-tick-label">{{ showMsInTicks ? formatTimePrecise(t) : formatTimeNoMs(t) }}</span>
              </div>
            </div>
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
