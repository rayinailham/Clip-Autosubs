import { createApp } from 'vue';
import store from './store.js';
import AppHeader from './components/AppHeader.js';
import UploadView from './components/UploadView.js';
import EditorView from './components/EditorView.js';

const App = {
  components: { AppHeader, UploadView, EditorView },
  setup() {
    return { store };
  },
  template: `
    <AppHeader />
    <UploadView v-if="store.currentView === 'upload'" />
    <EditorView v-else />
  `,
};

const app = createApp(App);
app.mount('#app');
