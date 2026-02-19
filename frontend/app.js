import { createApp } from 'vue';
import store from './store.js';
import AppHeader from './components/AppHeader.js';
import HomeView from './components/HomeView.js';
import UploadView from './components/UploadView.js';
import EditorView from './components/EditorView.js';
import ReframeView from './components/ReframeView.js';
import YtClipperView from './components/YtClipperView.js';

const App = {
  components: { AppHeader, HomeView, UploadView, EditorView, ReframeView, YtClipperView },
  setup() {
    return { store };
  },
  template: `
    <AppHeader />
    <HomeView    v-if="store.appMode === 'home'" />
    <template v-else-if="store.appMode === 'subtitle'">
      <UploadView v-if="store.currentView === 'upload'" />
      <EditorView v-else />
    </template>
    <ReframeView    v-else-if="store.appMode === 'vtuber'" />
    <YtClipperView  v-else-if="store.appMode === 'ytclipper'" />
  `,
};

const app = createApp(App);
app.mount('#app');
