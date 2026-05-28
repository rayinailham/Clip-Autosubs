import { ref } from 'vue';
import TranscriptPanel from './TranscriptPanel.js';
import GroupsSidebar from './GroupsSidebar.js';
import TrimPanel from './TrimPanel.js';
import store, { regenerateAutoGroups } from '../store.js';

export default {
  name: 'LeftSidebar',
  components: { TranscriptPanel, GroupsSidebar, TrimPanel },
  emits: ['seek'],
  setup(_, { emit }) {
    const activeTab = ref('transcript');

    function handleSeek(time) {
      emit('seek', time);
    }

    function switchTab(tab) {
      activeTab.value = tab;
      if (tab === 'groups') {
        if (store.words.length > 0 && store.customGroups.length === 0) {
          regenerateAutoGroups();
        }
        store.useCustomGroups = true;
      }
    }

    return { activeTab, handleSeek, switchTab };
  },
  template: `
    <div class="left-sidebar">
      <div class="sidebar-tabs">
        <button class="sidebar-tab" :class="{ active: activeTab === 'transcript' }" @click="switchTab('transcript')">
          ✏️ Transcript
        </button>
        <button class="sidebar-tab" :class="{ active: activeTab === 'groups' }" @click="switchTab('groups')">
          📦 Groups
        </button>
        <button class="sidebar-tab" :class="{ active: activeTab === 'trim' }" @click="switchTab('trim')">
          ✂ Trim
        </button>
      </div>
      <div class="left-sidebar-content">
        <div class="left-tab-pane" v-show="activeTab === 'transcript'">
          <TranscriptPanel @seek="handleSeek" />
        </div>
        <div class="left-tab-pane groups-panel" v-show="activeTab === 'groups'">
          <GroupsSidebar />
        </div>
        <div class="left-tab-pane" v-show="activeTab === 'trim'">
          <TrimPanel @seek="handleSeek" />
        </div>
      </div>
    </div>
  `,
};
