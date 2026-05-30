import { computed } from 'vue';
import store, {
  saveUndoSnapshot, regenerateAutoGroups,
  getGroupText, setGroupText,
} from '../store.js';

// Premiere-style caption editor: one row per group showing In/Out timecode and
// the editable caption line text. Editing the text overrides the group's
// displayed line (stored as `translation`) without touching the source words.

// Soft line-length budget (chars). Mirrors the AI grouping prompt: aim 15-32,
// hard ceiling ~42. Used only to colour the per-row length badge.
const LEN_MIN = 8;
const LEN_OK = 32;
const LEN_MAX = 42;

export default {
  name: 'CaptionsPanel',
  emits: ['seek'],
  setup(_, { emit }) {
    const groups = computed(() => store.customGroups);

    function ensureGroups() {
      if (store.words.length > 0 && store.customGroups.length === 0) {
        regenerateAutoGroups();
      }
      store.useCustomGroups = true;
    }
    ensureGroups();

    // ── Timecode HH:MM:SS:FF (Premiere style, 30fps display) ──
    function fmtTC(sec) {
      const s = Math.max(0, parseFloat(sec) || 0);
      const h = Math.floor(s / 3600);
      const m = Math.floor((s % 3600) / 60);
      const ss = Math.floor(s % 60);
      const ff = Math.floor((s - Math.floor(s)) * 30);
      const p2 = n => String(n).padStart(2, '0');
      return `${p2(h)}:${p2(m)}:${p2(ss)}:${p2(ff)}`;
    }

    function lineText(g) { return getGroupText(g); }
    function lineLen(g) { return getGroupText(g).length; }

    function lenClass(g) {
      const n = lineLen(g);
      if (n > LEN_MAX) return 'cap-len-over';
      if (n < LEN_MIN) return 'cap-len-short';
      if (n > LEN_OK) return 'cap-len-warn';
      return 'cap-len-ok';
    }

    function onInput(gi, ev) {
      setGroupText(gi, ev.target.value);
    }

    function seekTo(g) {
      emit('seek', g.start);
      store.currentTime = g.start;
    }

    // ── Merge / split passthroughs (reuse same logic as GroupsSidebar) ──
    function mergeUp(gi) {
      if (gi === 0) return;
      saveUndoSnapshot('Merge caption ' + gi + ' + ' + (gi + 1));
      const a = store.customGroups[gi - 1];
      const b = store.customGroups[gi];
      const mergedText = [getGroupText(a), getGroupText(b)].filter(Boolean).join(' ');
      store.customGroups.splice(gi - 1, 2, {
        word_indices: [...a.word_indices, ...b.word_indices],
        start: a.start,
        end: b.end,
        translation: mergedText,
        speaker: a.speaker || b.speaker || null,
      });
    }

    function mergeDown(gi) {
      if (gi >= store.customGroups.length - 1) return;
      mergeUp(gi + 1);
    }

    // Split a caption at the midpoint word boundary (keeps it simple & one-click).
    function splitMid(gi) {
      const g = store.customGroups[gi];
      if (!g || g.word_indices.length < 2) return;
      const mid = Math.ceil(g.word_indices.length / 2);
      saveUndoSnapshot('Split caption ' + (gi + 1));
      const first = g.word_indices.slice(0, mid);
      const second = g.word_indices.slice(mid);
      const firstEnd = store.words[first[first.length - 1]]?.end ?? g.start;
      const secondStart = store.words[second[0]]?.start ?? firstEnd;
      // Splitting drops the manual line override (text no longer matches either
      // half) and falls back to source words for each new line.
      store.customGroups.splice(gi, 1,
        { word_indices: first, start: g.start, end: firstEnd, speaker: g.speaker || null },
        { word_indices: second, start: secondStart, end: g.end, speaker: g.speaker || null },
      );
    }

    function clearOverride(gi) {
      const g = store.customGroups[gi];
      if (!g || !g.translation) return;
      saveUndoSnapshot('Reset caption ' + (gi + 1) + ' to source words');
      g.translation = '';
    }

    function resetAll() {
      saveUndoSnapshot('Re-split all captions');
      regenerateAutoGroups();
      store.useCustomGroups = true;
    }

    function applyGroupingKnobs() {
      saveUndoSnapshot('Re-split captions (rules changed)');
      regenerateAutoGroups();
      store.useCustomGroups = true;
    }

    return {
      store, groups,
      fmtTC, lineText, lineLen, lenClass,
      onInput, seekTo,
      mergeUp, mergeDown, splitMid, clearOverride,
      resetAll, applyGroupingKnobs,
      LEN_MAX,
    };
  },
  template: `
    <div class="captions-panel">
      <!-- Grouping rules -->
      <div class="cap-rules">
        <div class="cap-rule-row">
          <label title="Soft cap on words before a new line starts">Words / line</label>
          <input type="number" min="1" max="14" v-model.number="store.style.wpg"
                 @change="applyGroupingKnobs" />
        </div>
        <div class="cap-rule-row">
          <label title="Start a new line past this many characters (0 = off)">Max chars</label>
          <input type="number" min="0" max="80" v-model.number="store.style.maxCharsPerGroup"
                 @change="applyGroupingKnobs" />
        </div>
        <div class="cap-rule-row">
          <label title="Start a new line on silence longer than this (seconds, 0 = off)">Gap split (s)</label>
          <input type="number" min="0" step="0.1" v-model.number="store.style.groupGapThreshold"
                 @change="applyGroupingKnobs" />
        </div>
        <div class="cap-rule-row">
          <label title="Keep each line on screen at least this long (seconds)">Min on-screen (s)</label>
          <input type="number" min="0" step="0.1" v-model.number="store.style.minGroupDuration" />
        </div>
        <div class="cap-rule-row">
          <label title="Let a line linger this long after the last word, filling silence (seconds)">Hold tail (s)</label>
          <input type="number" min="0" step="0.05" v-model.number="store.style.groupHold" />
        </div>
        <button class="btn btn-outline btn-sm cap-reset" @click="resetAll"
                title="Re-split every line using the rules above">↺ Re-split all</button>
      </div>

      <div class="cap-count">{{ groups.length }} captions · {{ store.words.length }} words</div>

      <!-- Caption rows -->
      <div class="cap-list">
        <div v-for="(g, gi) in groups" :key="gi" class="cap-row">
          <div class="cap-num">{{ gi + 1 }}</div>

          <div class="cap-tc" @click="seekTo(g)" title="Click to seek">
            <div class="cap-tc-in">{{ fmtTC(g.start) }}</div>
            <div class="cap-tc-out">{{ fmtTC(g.end) }}</div>
          </div>

          <div class="cap-body">
            <textarea
              class="cap-text"
              rows="2"
              :value="lineText(g)"
              @input="onInput(gi, $event)"
              :placeholder="'Caption ' + (gi + 1) + ' text…'"></textarea>
            <div class="cap-meta">
              <span class="cap-len" :class="lenClass(g)">{{ lineLen(g) }} ch</span>
              <span v-if="g.translation" class="cap-edited" title="This line was hand-edited">edited</span>
              <span class="cap-actions">
                <button class="cap-act" @click="mergeUp(gi)" :disabled="gi === 0" title="Merge with line above">⤒</button>
                <button class="cap-act" @click="splitMid(gi)" :disabled="g.word_indices.length < 2" title="Split this line in two">⫶</button>
                <button class="cap-act" @click="mergeDown(gi)" :disabled="gi >= groups.length - 1" title="Merge with line below">⤓</button>
                <button class="cap-act" v-if="g.translation" @click="clearOverride(gi)" title="Reset to original words">↺</button>
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  `,
};
