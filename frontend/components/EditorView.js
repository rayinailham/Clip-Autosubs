import { ref, onMounted, onBeforeUnmount } from 'vue';
import store, { undoAction, redoAction, addSplitAtPlayhead } from '../store.js';
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

    // ── Global keyboard shortcuts ───────────────────
    function onKeyDown(e) {
      // Skip if user is typing in an input/textarea
      const tag = e.target.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || e.target.isContentEditable) return;

      // Ctrl+Z / Cmd+Z = Undo
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key === 'z') {
        e.preventDefault();
        undoAction();
        return;
      }
      // Ctrl+Y / Cmd+Shift+Z = Redo
      if ((e.ctrlKey || e.metaKey) && e.key === 'y') {
        e.preventDefault();
        redoAction();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key === 'z') {
        e.preventDefault();
        redoAction();
        return;
      }
      // S = Split / Cut at playhead
      if (e.key === 's' || e.key === 'S') {
        if (e.ctrlKey || e.metaKey) return; // Don't intercept Ctrl+S
        e.preventDefault();
        addSplitAtPlayhead();
        return;
      }
      // Space = Play/Pause
      if (e.key === ' ') {
        e.preventDefault();
        const v = document.getElementById('editor-video');
        if (v) { if (v.paused) v.play(); else v.pause(); }
        return;
      }
    }

    onMounted(() => {
      window.addEventListener('keydown', onKeyDown);
    });

    onBeforeUnmount(() => {
      window.removeEventListener('keydown', onKeyDown);
    });

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
