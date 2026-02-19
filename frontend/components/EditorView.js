import { ref } from 'vue';
import store from '../store.js';
import VideoPanel from './VideoPanel.js';
import TranscriptPanel from './TranscriptPanel.js';
import EditorSidebar from './EditorSidebar.js';
import RenderOverlay from './RenderOverlay.js';

export default {
  name: 'EditorView',
  components: { VideoPanel, TranscriptPanel, EditorSidebar, RenderOverlay },
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
      <div class="main-area">
        <VideoPanel ref="videoPanelRef" />
        <TranscriptPanel @seek="handleSeek" />
      </div>
      <EditorSidebar />
      <div class="bottom-bar">
        <button class="btn btn-primary" @click="handleRender">🎬 Render Video</button>
      </div>
      <RenderOverlay ref="renderOverlayRef" />
    </div>
  `,
};
