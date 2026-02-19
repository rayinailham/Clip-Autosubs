import { ref } from 'vue';
import store from '../store.js';
import VideoPanel from './VideoPanel.js';
import LeftSidebar from './LeftSidebar.js';
import EditorSidebar from './EditorSidebar.js';
import Timeline from './Timeline.js';
import RenderOverlay from './RenderOverlay.js';

export default {
  name: 'EditorView',
  components: { VideoPanel, LeftSidebar, EditorSidebar, Timeline, RenderOverlay },
  setup() {
    const videoPanelRef = ref(null);
    const renderOverlayRef = ref(null);

    function handleSeek(time) {
      if (videoPanelRef.value) videoPanelRef.value.seekTo(time);
    }

    function handleRender() {
      if (renderOverlayRef.value) renderOverlayRef.value.startRender();
    }

    return { store, videoPanelRef, renderOverlayRef, handleSeek, handleRender };
  },
  template: `
    <div id="editor-view" class="view active">
      <LeftSidebar @seek="handleSeek" />
      <div class="center-area">
        <VideoPanel ref="videoPanelRef" />
        <Timeline @seek="handleSeek" />
      </div>
      <EditorSidebar @render="handleRender" />
      <RenderOverlay ref="renderOverlayRef" />
    </div>
  `,
};
