import store from '../store.js';
import StyleSidebar from './StyleSidebar.js';

export default {
  name: 'EditorSidebar',
  components: { StyleSidebar },
  emits: ['render'],
  setup(_, { emit }) {
    function handleRender() { emit('render'); }
    return { store, handleRender };
  },
  template: `
    <div class="sidebar right-sidebar">
      <div class="sidebar-header">
        <span class="sidebar-header-title">🎨 Style</span>
      </div>
      <div class="sidebar-content">
        <StyleSidebar />
      </div>
      <div class="sidebar-footer">
        <button class="btn btn-primary btn-render" @click="handleRender">🎬 Render Video</button>
      </div>
    </div>
  `,
};
