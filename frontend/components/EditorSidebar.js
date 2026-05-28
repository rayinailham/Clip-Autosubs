import { ref } from 'vue';
import store, { getSegments } from '../store.js';
import { exportSrt } from '../api.js';
import StyleSidebar from './StyleSidebar.js';
import SpeakersSidebar from './SpeakersSidebar.js';

export default {
  name: 'EditorSidebar',
  components: { StyleSidebar, SpeakersSidebar },
  emits: ['render'],
  setup(_, { emit }) {
    const srtBusy = ref(false);
    const srtMsg = ref('');
    const activeTab = ref('style'); // 'style' | 'speakers'

    function handleRender() { emit('render'); }

    async function handleExportSrt() {
      if (!store.words.length || !store.videoFilename) {
        srtMsg.value = '⚠️ No transcription loaded';
        setTimeout(() => { srtMsg.value = ''; }, 2500);
        return;
      }
      srtBusy.value = true;
      srtMsg.value = 'Building SRT…';
      try {
        const payload = {
          video_filename: store.videoFilename,
          words: store.words,
          words_per_group: store.style.wpg || 4,
          use_custom_groups: store.useCustomGroups,
          uppercase: !!store.style.uppercase,
        };
        if (store.useCustomGroups && store.customGroups.length > 0) {
          payload.word_groups = store.customGroups;
        }
        // Apply timeline cuts so SRT timing matches the cut video the user
        // will edit in Premiere.
        if (store.splitPoints.length > 0 && store.removedSegments.length > 0) {
          const v = document.getElementById('editor-video');
          const dur = v ? v.duration : (store.metadata?.duration || 0);
          if (dur > 0) {
            const segs = getSegments(dur);
            const activeSegs = segs.filter(s => s.active).map(s => [s.start, s.end]);
            if (activeSegs.length > 0 && activeSegs.length < segs.length) {
              payload.active_segments = activeSegs;
            }
          }
        }
        const res = await exportSrt(payload);
        // Trigger download in a new tab
        const a = document.createElement('a');
        a.href = res.url;
        a.download = res.filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        srtMsg.value = '✓ ' + res.filename;
      } catch (err) {
        srtMsg.value = '✗ ' + (err.message || 'Export failed');
      } finally {
        srtBusy.value = false;
        setTimeout(() => { srtMsg.value = ''; }, 3500);
      }
    }

    return { store, handleRender, handleExportSrt, srtBusy, srtMsg, activeTab };
  },
  template: `
    <div class="sidebar right-sidebar">
      <div class="sidebar-header sidebar-tabs">
        <button class="sidebar-tab" :class="{ active: activeTab === 'style' }" @click="activeTab = 'style'">🎨 Style</button>
        <button class="sidebar-tab" :class="{ active: activeTab === 'speakers' }" @click="activeTab = 'speakers'">🗣 Speakers</button>
      </div>
      <div class="sidebar-content">
        <StyleSidebar v-show="activeTab === 'style'" />
        <SpeakersSidebar v-show="activeTab === 'speakers'" />
      </div>
      <div class="sidebar-footer">
        <button class="btn btn-outline btn-sm"
                style="width:100%; margin-bottom:0.5rem;"
                :disabled="srtBusy"
                @click="handleExportSrt"
                title="Export plain SRT for Premiere Pro (timing + text only — style inside Premiere)">
          {{ srtBusy ? '…' : '📄 Export SRT (Premiere)' }}
        </button>
        <div v-if="srtMsg"
             style="font-size:0.75rem; text-align:center; opacity:0.8; margin-bottom:0.5rem;">
          {{ srtMsg }}
        </div>
        <button class="btn btn-primary btn-render" @click="handleRender">🎬 Render Video</button>
      </div>
    </div>
  `,
};
