import { ref, computed, onMounted } from 'vue';
import store from '../store.js';
import YtSession from './YtSession.js';

// Parent manages a list of session ids. Each YtSession child owns its own
// jobs, polling and storage slot, so N streams run fully independently.
const LIST_KEY = 'ytclipper.sessions.v2';
const LEGACY_KEY = 'ytclipper.session.v1';

function genId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function loadIds() {
  try {
    const raw = localStorage.getItem(LIST_KEY);
    const arr = raw ? JSON.parse(raw) : null;
    if (Array.isArray(arr) && arr.length) return arr;
  } catch (_) {}
  return null;
}

function saveIds(ids) {
  try { localStorage.setItem(LIST_KEY, JSON.stringify(ids)); } catch (_) {}
}

// One-time migration: lift the old single-session blob into a v2 session slot.
function migrateLegacy() {
  try {
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (!legacy) return null;
    const id = genId();
    localStorage.setItem(`ytclipper.session.${id}`, legacy);
    localStorage.removeItem(LEGACY_KEY);
    return id;
  } catch (_) { return null; }
}

export default {
  name: 'YtClipperView',
  components: { YtSession },
  setup() {
    const sessionIds = ref([]);
    const metaById = ref({}); // id -> { title, analyzeStatus, cutStatus, cutProgress }

    function persistIds() { saveIds(sessionIds.value); }

    function addSession() {
      const id = genId();
      sessionIds.value.push(id);
      persistIds();
    }

    function removeSession(id) {
      sessionIds.value = sessionIds.value.filter(s => s !== id);
      delete metaById.value[id];
      persistIds();
      if (!sessionIds.value.length) addSession(); // always keep at least one
    }

    function onMeta(meta) {
      metaById.value = { ...metaById.value, [meta.id]: meta };
    }

    const runningCount = computed(() =>
      Object.values(metaById.value).filter(
        m => m.analyzeStatus === 'running' || m.cutStatus === 'running'
      ).length
    );

    function goHome() {
      store.appMode = 'home';
    }

    onMounted(() => {
      const ids = loadIds();
      if (ids) {
        sessionIds.value = ids;
      } else {
        const migrated = migrateLegacy();
        sessionIds.value = migrated ? [migrated] : [genId()];
        persistIds();
      }
    });

    return {
      sessionIds, metaById, runningCount,
      addSession, removeSession, onMeta, goHome,
    };
  },

  template: `
<div class="ytc-root">

  <!-- Header bar -->
  <div class="ytc-topbar">
    <button class="btn btn-ghost ytc-back" @click="goHome">&larr; Back</button>
    <h1 class="ytc-heading">&#x1F3AC; YouTube Clip Finder</h1>
    <div class="ytc-topbar-right">
      <span v-if="runningCount" class="ytc-running-badge">
        &#x23F3; {{ runningCount }} running
      </span>
      <span class="ytc-session-count">{{ sessionIds.length }} session(s)</span>
    </div>
  </div>

  <div class="ytc-body">

    <YtSession
      v-for="(id, i) in sessionIds"
      :key="id"
      :id="id"
      :index="i"
      @remove="removeSession"
      @meta="onMeta"
    />

    <div class="ytc-add-row">
      <button class="btn btn-primary ytc-add-session-btn" @click="addSession">
        &#x2795; Add another stream
      </button>
      <p class="ytc-add-hint">
        Each session runs independently &mdash; analyze and cut multiple streams at the same time.
      </p>
    </div>

  </div>
</div>
  `,
};
