import { computed } from 'vue';
import store, { regenerateAutoGroups } from '../store.js';

export default {
  name: 'GroupsSidebar',
  setup() {
    function setGroupMode(mode) {
      store.useCustomGroups = (mode === 'custom');
      if (store.useCustomGroups && store.customGroups.length === 0) {
        regenerateAutoGroups();
      }
    }

    function updateGroupTiming(groupIdx, field, value) {
      const val = parseFloat(value);
      if (!isNaN(val) && val >= 0) {
        store.customGroups[groupIdx][field] = val;
      }
    }

    function splitGroup(groupIdx) {
      const group = store.customGroups[groupIdx];
      if (group.word_indices.length < 2) return;
      const mid = Math.ceil(group.word_indices.length / 2);
      const firstHalf = group.word_indices.slice(0, mid);
      const secondHalf = group.word_indices.slice(mid);
      const firstEnd = store.words[firstHalf[firstHalf.length - 1]]?.end || group.start;
      const secondStart = store.words[secondHalf[0]]?.start || firstEnd;
      store.customGroups.splice(groupIdx, 1,
        { word_indices: firstHalf, start: group.start, end: firstEnd },
        { word_indices: secondHalf, start: secondStart, end: group.end }
      );
    }

    function mergeWithNext(groupIdx) {
      if (groupIdx >= store.customGroups.length - 1) return;
      const g1 = store.customGroups[groupIdx];
      const g2 = store.customGroups[groupIdx + 1];
      store.customGroups.splice(groupIdx, 2, {
        word_indices: [...g1.word_indices, ...g2.word_indices],
        start: g1.start,
        end: g2.end,
      });
    }

    function groupWords(g) {
      return g.word_indices.map(i => store.words[i]?.text || '').join(' ');
    }

    function onWpgChange() {
      if (!store.useCustomGroups) regenerateAutoGroups();
    }

    return {
      store, setGroupMode, updateGroupTiming,
      splitGroup, mergeWithNext, groupWords,
      onWpgChange, regenerateAutoGroups,
    };
  },
  template: `
    <div class="groups-header">
      <h4>Word Groups</h4>
      <div class="groups-mode-toggle">
        <button :class="{ active: !store.useCustomGroups }" @click="setGroupMode('auto')">Auto</button>
        <button :class="{ active: store.useCustomGroups }" @click="setGroupMode('custom')">Custom</button>
      </div>
    </div>

    <!-- Auto mode -->
    <div v-if="!store.useCustomGroups">
      <div class="style-row">
        <label>Words/group</label>
        <input type="range" min="1" max="10" v-model.number="store.style.wpg" @input="onWpgChange" />
        <span class="range-val">{{ store.style.wpg }}</span>
      </div>
    </div>

    <!-- Custom mode -->
    <div v-else>
      <div style="margin-bottom:0.75rem; display:flex; gap:0.5rem;">
        <button class="btn btn-outline btn-sm" @click="regenerateAutoGroups">Reset to Auto</button>
      </div>
      <div class="group-list">
        <div v-for="(g, gi) in store.customGroups" :key="gi" class="group-item">
          <div class="group-item-header">
            <span class="group-item-num">Group {{ gi + 1 }}</span>
            <div class="group-item-actions">
              <button @click.stop="splitGroup(gi)">Split</button>
              <button @click.stop="mergeWithNext(gi)">Merge→</button>
            </div>
          </div>
          <div class="group-item-words">{{ groupWords(g) }}</div>
          <div class="group-item-timing">
            <label>Start</label>
            <input type="number" step="0.01" :value="g.start.toFixed(2)"
                   @change="updateGroupTiming(gi, 'start', $event.target.value)" />
            <label>End</label>
            <input type="number" step="0.01" :value="g.end.toFixed(2)"
                   @change="updateGroupTiming(gi, 'end', $event.target.value)" />
          </div>
        </div>
      </div>
    </div>
  `,
};
