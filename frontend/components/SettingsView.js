import { ref, onMounted, computed } from 'vue';
import store from '../store.js';
import {
  fetchSettings, updateSettings,
  addSettingsModel, removeSettingsModel,
  testElevenlabsKey, testGeminiKey,
} from '../api.js';

export default {
  name: 'SettingsView',
  setup() {
    const loading = ref(true);
    const saving = ref(false);
    const message = ref({ kind: '', text: '' });

    // Editable copies (so masked redacted keys don't get re-saved as the mask)
    const elevenKey = ref('');
    const geminiKey = ref('');
    const elevenKeyDirty = ref(false);
    const geminiKeyDirty = ref(false);

    // New custom model inputs
    const newElevenModel = ref('');
    const newGeminiModel = ref('');

    // Test results per provider
    const elevenTest = ref({ state: 'idle', text: '' });
    const geminiTest = ref({ state: 'idle', text: '' });

    const s = computed(() => store.settings);

    function applyServerSettings(data) {
      store.settings.elevenlabs_api_key = data.elevenlabs_api_key || '';
      store.settings.elevenlabs_api_key_set = !!data.elevenlabs_api_key_set;
      store.settings.elevenlabs_model = data.elevenlabs_model || 'scribe_v1';
      store.settings.elevenlabs_models = data.elevenlabs_models || ['scribe_v1'];

      store.settings.gemini_api_key = data.gemini_api_key || '';
      store.settings.gemini_api_key_set = !!data.gemini_api_key_set;
      store.settings.gemini_model = data.gemini_model || 'gemini-2.0-flash';
      store.settings.gemini_models = data.gemini_models || [];

      store.settings.loaded = true;
      // Mirror to legacy fields used by the rest of the app.
      store.transcriptionModel = store.settings.elevenlabs_model;
    }

    onMounted(async () => {
      try {
        const data = await fetchSettings();
        applyServerSettings(data);
      } catch (e) {
        message.value = { kind: 'error', text: 'Failed to load settings: ' + e.message };
      }
      loading.value = false;
    });

    async function saveAll() {
      saving.value = true;
      message.value = { kind: '', text: '' };
      const patch = {
        elevenlabs_model: store.settings.elevenlabs_model,
        gemini_model: store.settings.gemini_model,
      };
      if (elevenKeyDirty.value) patch.elevenlabs_api_key = elevenKey.value.trim();
      if (geminiKeyDirty.value) patch.gemini_api_key = geminiKey.value.trim();
      try {
        const data = await updateSettings(patch);
        applyServerSettings(data);
        elevenKey.value = '';
        geminiKey.value = '';
        elevenKeyDirty.value = false;
        geminiKeyDirty.value = false;
        message.value = { kind: 'ok', text: 'Saved.' };
      } catch (e) {
        message.value = { kind: 'error', text: e.message };
      }
      saving.value = false;
    }

    async function runElevenTest() {
      elevenTest.value = { state: 'running', text: 'Testing…' };
      try {
        const res = await testElevenlabsKey(
          elevenKeyDirty.value ? elevenKey.value.trim() : '',
          store.settings.elevenlabs_model,
        );
        if (res.ok) {
          elevenTest.value = {
            state: 'ok',
            text: `Key OK · model "${res.model || store.settings.elevenlabs_model}" available${res.subscription ? ' · ' + res.subscription : ''}`,
          };
        } else if (res.reason === 'model') {
          elevenTest.value = {
            state: 'error',
            text: `Key works, but model is the problem → ${res.error || 'model unavailable'}`,
          };
        } else {
          elevenTest.value = {
            state: 'error',
            text: `Key rejected → ${res.error || 'Failed'}`,
          };
        }
      } catch (e) {
        elevenTest.value = { state: 'error', text: e.message };
      }
    }

    async function runGeminiTest() {
      geminiTest.value = { state: 'running', text: 'Testing…' };
      try {
        const res = await testGeminiKey(
          geminiKeyDirty.value ? geminiKey.value.trim() : '',
          store.settings.gemini_model,
        );
        if (res.ok) {
          geminiTest.value = {
            state: 'ok',
            text: `Key OK · model "${res.model}"${res.sample ? ' · "' + res.sample + '"' : ''}`,
          };
        } else if (res.reason === 'model') {
          geminiTest.value = {
            state: 'error',
            text: `Key works, but model is the problem → ${res.error || 'model unavailable'}`,
          };
        } else {
          geminiTest.value = {
            state: 'error',
            text: `Key rejected → ${res.error || 'Failed'}`,
          };
        }
      } catch (e) {
        geminiTest.value = { state: 'error', text: e.message };
      }
    }

    async function addElevenModel() {
      const m = newElevenModel.value.trim();
      if (!m) return;
      try {
        const data = await addSettingsModel('elevenlabs', m);
        applyServerSettings(data);
        store.settings.elevenlabs_model = m;
        await updateSettings({ elevenlabs_model: m });
        newElevenModel.value = '';
      } catch (e) {
        message.value = { kind: 'error', text: e.message };
      }
    }

    async function addGeminiModel() {
      const m = newGeminiModel.value.trim();
      if (!m) return;
      try {
        const data = await addSettingsModel('gemini', m);
        applyServerSettings(data);
        store.settings.gemini_model = m;
        await updateSettings({ gemini_model: m });
        newGeminiModel.value = '';
      } catch (e) {
        message.value = { kind: 'error', text: e.message };
      }
    }

    async function removeElevenModel(model) {
      if (model === store.settings.elevenlabs_model) {
        message.value = { kind: 'error', text: 'Switch to a different active model first.' };
        return;
      }
      if (!confirm('Remove "' + model + '" from the list?')) return;
      try {
        const data = await removeSettingsModel('elevenlabs', model);
        applyServerSettings(data);
      } catch (e) {
        message.value = { kind: 'error', text: e.message };
      }
    }

    async function removeGeminiModel(model) {
      if (model === store.settings.gemini_model) {
        message.value = { kind: 'error', text: 'Switch to a different active model first.' };
        return;
      }
      if (!confirm('Remove "' + model + '" from the list?')) return;
      try {
        const data = await removeSettingsModel('gemini', model);
        applyServerSettings(data);
      } catch (e) {
        message.value = { kind: 'error', text: e.message };
      }
    }

    function onElevenKeyInput() { elevenKeyDirty.value = true; }
    function onGeminiKeyInput() { geminiKeyDirty.value = true; }
    function goHome() {
      const prev = store.previousAppMode || 'home';
      store.appMode = prev;
    }

    return {
      store, s,
      loading, saving, message,
      elevenKey, geminiKey, elevenKeyDirty, geminiKeyDirty,
      newElevenModel, newGeminiModel,
      elevenTest, geminiTest,
      saveAll, runElevenTest, runGeminiTest,
      addElevenModel, addGeminiModel,
      removeElevenModel, removeGeminiModel,
      onElevenKeyInput, onGeminiKeyInput,
      goHome,
    };
  },

  template: `
<div class="settings-view">
  <div class="settings-topbar">
    <button class="btn btn-ghost" @click="goHome">&larr; Back</button>
    <h1 class="settings-heading">⚙️ Settings</h1>
  </div>

  <div v-if="loading" class="settings-loading">Loading…</div>

  <div v-else class="settings-body">

    <div v-if="message.text" class="settings-flash" :class="'settings-flash--' + message.kind">
      {{ message.text }}
    </div>

    <!-- ElevenLabs card -->
    <section class="settings-card">
      <header class="settings-card-head">
        <h2>🎙 ElevenLabs Scribe</h2>
        <span class="settings-status" :class="s.elevenlabs_api_key_set ? 'is-set' : 'is-unset'">
          {{ s.elevenlabs_api_key_set ? 'Key configured' : 'Not configured' }}
        </span>
      </header>

      <div class="settings-row">
        <label class="settings-label">API Key</label>
        <div class="settings-key-row">
          <input
            type="password"
            class="settings-input"
            :placeholder="s.elevenlabs_api_key_set ? s.elevenlabs_api_key : 'sk_...'"
            v-model="elevenKey"
            @input="onElevenKeyInput"
            autocomplete="off"
          />
          <button class="btn btn-outline btn-sm" @click="runElevenTest">Test</button>
        </div>
        <div v-if="elevenTest.state !== 'idle'" class="settings-test-result" :class="'settings-test-result--' + elevenTest.state">
          {{ elevenTest.text }}
        </div>
      </div>

      <div class="settings-row">
        <label class="settings-label">Active model</label>
        <select class="settings-input" v-model="s.elevenlabs_model">
          <option v-for="m in s.elevenlabs_models" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <div class="settings-row">
        <label class="settings-label">Add custom model</label>
        <div class="settings-key-row">
          <input
            type="text"
            class="settings-input"
            placeholder="e.g. scribe_v2"
            v-model="newElevenModel"
            @keydown.enter="addElevenModel"
          />
          <button class="btn btn-primary btn-sm" @click="addElevenModel">+ Add</button>
        </div>
      </div>

      <div v-if="s.elevenlabs_models.length" class="settings-chip-row">
        <span
          v-for="m in s.elevenlabs_models"
          :key="m"
          class="settings-chip"
          :class="{ 'is-active': m === s.elevenlabs_model }"
        >
          {{ m }}
          <button class="settings-chip-x" @click="removeElevenModel(m)" title="Remove">×</button>
        </span>
      </div>
    </section>

    <!-- Gemini card -->
    <section class="settings-card">
      <header class="settings-card-head">
        <h2>✨ Google Gemini</h2>
        <span class="settings-status" :class="s.gemini_api_key_set ? 'is-set' : 'is-unset'">
          {{ s.gemini_api_key_set ? 'Key configured' : 'Not configured' }}
        </span>
      </header>

      <div class="settings-row">
        <label class="settings-label">
          API Key
          <a class="settings-hint" href="https://aistudio.google.com/app/apikey" target="_blank" rel="noopener">Get a free key →</a>
        </label>
        <div class="settings-key-row">
          <input
            type="password"
            class="settings-input"
            :placeholder="s.gemini_api_key_set ? s.gemini_api_key : 'AIza...'"
            v-model="geminiKey"
            @input="onGeminiKeyInput"
            autocomplete="off"
          />
          <button class="btn btn-outline btn-sm" @click="runGeminiTest">Test</button>
        </div>
        <div v-if="geminiTest.state !== 'idle'" class="settings-test-result" :class="'settings-test-result--' + geminiTest.state">
          {{ geminiTest.text }}
        </div>
      </div>

      <div class="settings-row">
        <label class="settings-label">Active model</label>
        <select class="settings-input" v-model="s.gemini_model">
          <option v-for="m in s.gemini_models" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <div class="settings-row">
        <label class="settings-label">Add custom model</label>
        <div class="settings-key-row">
          <input
            type="text"
            class="settings-input"
            placeholder="e.g. gemini-3-flash-preview"
            v-model="newGeminiModel"
            @keydown.enter="addGeminiModel"
          />
          <button class="btn btn-primary btn-sm" @click="addGeminiModel">+ Add</button>
        </div>
      </div>

      <div v-if="s.gemini_models.length" class="settings-chip-row">
        <span
          v-for="m in s.gemini_models"
          :key="m"
          class="settings-chip"
          :class="{ 'is-active': m === s.gemini_model }"
        >
          {{ m }}
          <button class="settings-chip-x" @click="removeGeminiModel(m)" title="Remove">×</button>
        </span>
      </div>
    </section>

    <div class="settings-actions">
      <button class="btn btn-primary" :disabled="saving" @click="saveAll">
        {{ saving ? 'Saving…' : '💾 Save all' }}
      </button>
    </div>

  </div>
</div>
  `,
};
