import store, { saveUndoSnapshot, regenerateAutoGroups } from '../store.js';

export default {
  name: 'GroupsSidebar',
  setup() {
    // Always keep custom groups in sync — regenerate whenever wpg changes
    function onWpgChange() {
      regenerateAutoGroups();
      store.useCustomGroups = true;
    }

    function resetToAuto() {
      regenerateAutoGroups();
      store.useCustomGroups = true;
    }

    // ── Timing ───────────────────────────────────
    function setTiming(gi, field, value) {
      const val = parseFloat(value);
      if (!isNaN(val) && val >= 0) store.customGroups[gi][field] = val;
    }

    function nudgeTiming(gi, field, delta) {
      const val = parseFloat((store.customGroups[gi][field] + delta).toFixed(2));
      if (val >= 0) store.customGroups[gi][field] = val;
    }

    // ── Split at a specific word boundary ────────
    // splitBefore(gi, wi): splits group gi so that word at position wi (within the group)
    // becomes the first word of the new second group.
    function splitBefore(gi, wi) {
      const g = store.customGroups[gi];
      if (wi <= 0 || wi >= g.word_indices.length) return;
      saveUndoSnapshot('Split group ' + (gi + 1) + ' before "' + (store.words[g.word_indices[wi]]?.text || '') + '"');
      const first = g.word_indices.slice(0, wi);
      const second = g.word_indices.slice(wi);
      const firstEnd = store.words[first[first.length - 1]]?.end ?? g.start;
      const secondStart = store.words[second[0]]?.start ?? firstEnd;
      store.customGroups.splice(gi, 1,
        { word_indices: first, start: g.start, end: firstEnd },
        { word_indices: second, start: secondStart, end: g.end },
      );
    }

    // ── Merge with adjacent group ─────────────────
    function mergeWithPrev(gi) {
      if (gi === 0) return;
      saveUndoSnapshot('Merge group ' + gi + ' + ' + (gi + 1));
      const g1 = store.customGroups[gi - 1];
      const g2 = store.customGroups[gi];
      store.customGroups.splice(gi - 1, 2, {
        word_indices: [...g1.word_indices, ...g2.word_indices],
        start: g1.start,
        end: g2.end,
      });
    }

    function mergeWithNext(gi) {
      if (gi >= store.customGroups.length - 1) return;
      saveUndoSnapshot('Merge group ' + (gi + 1) + ' + ' + (gi + 2));
      const g1 = store.customGroups[gi];
      const g2 = store.customGroups[gi + 1];
      store.customGroups.splice(gi, 2, {
        word_indices: [...g1.word_indices, ...g2.word_indices],
        start: g1.start,
        end: g2.end,
      });
    }

    // ── Move first word of this group → end of prev group ──
    function moveFirstToPrev(gi) {
      if (gi === 0) return;
      const g = store.customGroups[gi];
      if (g.word_indices.length < 2) return; // don't empty the group
      saveUndoSnapshot('Move "' + (store.words[g.word_indices[0]]?.text || '') + '" to group ' + gi);
      const moved = g.word_indices[0];
      const prev = store.customGroups[gi - 1];
      const newPrevEnd = store.words[moved]?.end ?? prev.end;
      const newCurStart = store.words[g.word_indices[1]]?.start ?? g.start;
      store.customGroups[gi - 1] = { ...prev, word_indices: [...prev.word_indices, moved], end: newPrevEnd };
      store.customGroups[gi] = { ...g, word_indices: g.word_indices.slice(1), start: newCurStart };
    }

    // ── Move last word of this group → start of next group ──
    function moveLastToNext(gi) {
      if (gi >= store.customGroups.length - 1) return;
      const g = store.customGroups[gi];
      if (g.word_indices.length < 2) return;
      saveUndoSnapshot('Move "' + (store.words[g.word_indices[g.word_indices.length - 1]]?.text || '') + '" to group ' + (gi + 2));
      const moved = g.word_indices[g.word_indices.length - 1];
      const next = store.customGroups[gi + 1];
      const newCurEnd = store.words[g.word_indices[g.word_indices.length - 2]]?.end ?? g.end;
      const newNextStart = store.words[moved]?.start ?? next.start;
      store.customGroups[gi] = { ...g, word_indices: g.word_indices.slice(0, -1), end: newCurEnd };
      store.customGroups[gi + 1] = { ...next, word_indices: [moved, ...next.word_indices], start: newNextStart };
    }

    function wordText(wi) { return store.words[wi]?.text ?? '?'; }

    function fmtTime(t) { return parseFloat(t).toFixed(2); }

    return {
      store,
      onWpgChange, resetToAuto,
      setTiming, nudgeTiming,
      splitBefore,
      mergeWithPrev, mergeWithNext,
      moveFirstToPrev, moveLastToNext,
      wordText, fmtTime,
    };
  },
  template: `
    <!-- Top controls -->
    <div class="groups-topbar">
      <div class="groups-wpg-row">
        <label class="groups-wpg-label">Words / group</label>
        <input type="range" min="1" max="12" v-model.number="store.style.wpg" @input="onWpgChange" class="groups-wpg-slider" />
        <input type="number" class="range-val-input" v-model.number="store.style.wpg" min="1" max="12" @change="onWpgChange" />
      </div>
      <button class="btn btn-outline btn-sm" @click="resetToAuto" title="Re-split all groups evenly by Words/group">↺ Reset</button>
    </div>

    <div class="group-count-line">{{ store.customGroups.length }} groups · {{ store.words.length }} words</div>

    <!-- Group list -->
    <div class="group-list">
      <div v-for="(g, gi) in store.customGroups" :key="gi" class="group-item">

        <!-- Header row -->
        <div class="group-item-header">
          <span class="group-item-num">#{{ gi + 1 }}</span>

          <!-- Adjacent-group merge buttons -->
          <div class="group-merge-row">
            <button class="gib gib-merge" :disabled="gi === 0"
                    @click="mergeWithPrev(gi)" title="Merge with group above">↑</button>
            <button class="gib gib-merge" :disabled="gi >= store.customGroups.length - 1"
                    @click="mergeWithNext(gi)" title="Merge with group below">↓</button>
          </div>
        </div>

        <!-- Word chips with split-before dividers -->
        <div class="group-words-row">
          <!-- Move-first-to-prev arrow -->
          <button v-if="gi > 0 && g.word_indices.length > 1"
                  class="word-move-btn word-move-prev"
                  @click="moveFirstToPrev(gi)"
                  :title="'Move \\''+wordText(g.word_indices[0])+'\\' to group ' + gi">‹</button>

          <div class="group-word-chips">
            <template v-for="(wi, pos) in g.word_indices" :key="wi">
              <!-- Split-before divider (before every word except the first) -->
              <button v-if="pos > 0"
                      class="split-divider"
                      @click="splitBefore(gi, pos)"
                      title="Split here">
                <span class="split-line"></span>
                <span class="split-icon">✂</span>
                <span class="split-line"></span>
              </button>
              <span class="group-word-chip">{{ wordText(wi) }}</span>
            </template>
          </div>

          <!-- Move-last-to-next arrow -->
          <button v-if="gi < store.customGroups.length - 1 && g.word_indices.length > 1"
                  class="word-move-btn word-move-next"
                  @click="moveLastToNext(gi)"
                  :title="'Move \\''+wordText(g.word_indices[g.word_indices.length-1])+'\\' to group ' + (gi+2)">›</button>
        </div>

        <!-- Timing row -->
        <div class="group-timing-row">
          <div class="group-timing-field">
            <button class="timing-nudge" @click="nudgeTiming(gi,'start',-0.1)">−</button>
            <label>In</label>
            <input type="number" step="0.01" min="0"
                   :value="fmtTime(g.start)"
                   @change="setTiming(gi, 'start', $event.target.value)" />
            <button class="timing-nudge" @click="nudgeTiming(gi,'start',0.1)">+</button>
          </div>
          <div class="group-timing-field">
            <button class="timing-nudge" @click="nudgeTiming(gi,'end',-0.1)">−</button>
            <label>Out</label>
            <input type="number" step="0.01" min="0"
                   :value="fmtTime(g.end)"
                   @change="setTiming(gi, 'end', $event.target.value)" />
            <button class="timing-nudge" @click="nudgeTiming(gi,'end',0.1)">+</button>
          </div>
        </div>

      </div>
    </div>
  `,
};
