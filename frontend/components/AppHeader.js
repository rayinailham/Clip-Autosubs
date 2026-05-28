import { ref, onMounted } from 'vue';
import store from '../store.js';
import { fetchStatus, fetchSettings } from '../api.js';

export default {
  name: 'AppHeader',
  setup() {
    onMounted(async () => {
      try {
        const data = await fetchStatus();
        if (data.ffmpeg?.ffmpeg) {
          store.ffmpeg.available = true;
        }
        // Surface ElevenLabs status as the “gpu” pill (legacy slot).
        if (data.elevenlabs?.configured) {
          store.gpu.available = true;
          store.gpu.name = 'ElevenLabs ✓';
        } else {
          store.gpu.available = false;
          store.gpu.name = 'ElevenLabs key missing';
        }
      } catch {
        store.gpu.name = 'Offline';
      }

      // Pull settings into the store.
      try {
        const s = await fetchSettings();
        store.settings.elevenlabs_api_key = s.elevenlabs_api_key || '';
        store.settings.elevenlabs_api_key_set = !!s.elevenlabs_api_key_set;
        store.settings.elevenlabs_model = s.elevenlabs_model || 'scribe_v1';
        store.settings.elevenlabs_models = s.elevenlabs_models || ['scribe_v1'];
        store.settings.gemini_api_key = s.gemini_api_key || '';
        store.settings.gemini_api_key_set = !!s.gemini_api_key_set;
        store.settings.gemini_model = s.gemini_model || 'gemini-2.0-flash';
        store.settings.gemini_models = s.gemini_models || [];
        store.settings.loaded = true;
        store.transcriptionModel = store.settings.elevenlabs_model;
      } catch {
        // ignore — Settings page will retry.
      }
    });

    function openSettings() {
      if (store.appMode !== 'settings') {
        store.previousAppMode = store.appMode;
      }
      store.appMode = 'settings';
    }

    return { store, openSettings };
  },
  template: `
    <header>
      <h1 style="cursor:pointer" @click="store.appMode = 'home'">Clipping Project</h1>
      <div class="status-pills">
        <div class="pill">
          <span class="dot" :class="{ ok: store.gpu.available }"></span>
          <span>{{ store.gpu.name }}</span>
        </div>
        <div class="pill">
          <span class="dot" :class="{ ok: store.ffmpeg.available }"></span>
          <span>{{ store.ffmpeg.available ? 'FFmpeg ✓' : 'FFmpeg missing' }}</span>
        </div>
        <button class="header-settings-btn" @click="openSettings" title="Settings">⚙ Settings</button>
      </div>
    </header>
  `,
};
