import { ref } from 'vue';
import store from '../store.js';
import StyleSidebar from './StyleSidebar.js';
import GroupsSidebar from './GroupsSidebar.js';

export default {
  name: 'EditorSidebar',
  components: { StyleSidebar, GroupsSidebar },
  setup() {
    const activeTab = ref('style'); // 'style' | 'groups'

    function switchTab(tab) { activeTab.value = tab; }

    return { activeTab, switchTab };
  },
  template: `
    <div class="sidebar">
      <div class="sidebar-tabs">
        <button class="sidebar-tab" :class="{ active: activeTab === 'style' }" @click="switchTab('style')">🎨 Style</button>
        <button class="sidebar-tab" :class="{ active: activeTab === 'groups' }" @click="switchTab('groups')">📦 Groups</button>
      </div>
      <div class="sidebar-content">
        <div v-show="activeTab === 'style'" class="tab-panel active">
          <StyleSidebar />
        </div>
        <div v-show="activeTab === 'groups'" class="tab-panel active">
          <GroupsSidebar />
        </div>
      </div>
    </div>
  `,
};
