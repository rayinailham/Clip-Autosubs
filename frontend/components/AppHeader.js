import { ref, onMounted } from 'vue';
import store from '../store.js';
import { fetchStatus } from '../api.js';

export default {
  name: 'AppHeader',
  setup() {
    onMounted(async () => {
      try {
        const data = await fetchStatus();
        if (data.gpu?.cuda_available) {
          store.gpu.available = true;
          store.gpu.name = data.gpu.gpu_name || 'CUDA Ready';
        } else {
          store.gpu.name = 'CPU Only';
        }
        if (data.ffmpeg?.ffmpeg) {
          store.ffmpeg.available = true;
        }
      } catch {
        store.gpu.name = 'Offline';
      }
    });

    return { store };
  },
  template: `
    <header>
      <h1>Clipping Project</h1>
      <div class="status-pills">
        <div class="pill">
          <span class="dot" :class="{ ok: store.gpu.available }"></span>
          <span>{{ store.gpu.name }}</span>
        </div>
        <div class="pill">
          <span class="dot" :class="{ ok: store.ffmpeg.available }"></span>
          <span>{{ store.ffmpeg.available ? 'FFmpeg ✓' : 'FFmpeg missing' }}</span>
        </div>
      </div>
    </header>
  `,
};
