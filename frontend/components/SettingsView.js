import { ref, onMounted, computed } from 'vue';
import store from '../store.js';
import {
  fetchSettings, updateSettings,
  addSettingsModel, removeSettingsModel,
  testElevenlabsKey, testAiKey,
} from '../api.js';

export default {
  name: 'SettingsView',
  setup() {
    const loading = ref(true);
    const saving = ref(false);
    const message = ref({ kind: '', text: '' });

    // Editable copies (so masked redacted keys don't get re-saved as the mask)
    const elevenKey = ref('');
    const aiKey = ref('');
    const elevenKeyDirty = ref(false);
    const aiKeyDirty = ref(false);

    // New custom model inputs
    const newElevenModel = ref('');
    const newAiModel = ref('');

    // Test results per provider
    const elevenTest = ref({ state: 'idle', text: '' });
    const aiTest = ref({ state: 'idle', text: '' });

    const s = computed(() => store.settings);

    function applyServerSettings(data) {
      store.settings.elevenlabs_api_key = data.elevenlabs_api_key || '';
      store.settings.elevenlabs_api_key_set = !!data.elevenlabs_api_key_set;
      store.settings.elevenlabs_model = data.elevenlabs_model || 'scribe_v1';
      store.settings.elevenlabs_models = data.elevenlabs_models || ['scribe_v1'];

      store.settings.ai_api_key = data.ai_api_key || '';
      store.settings.ai_api_key_set = !!data.ai_api_key_set;
      store.settings.ai_base_url = data.ai_base_url || 'http://localhost:20128';
      store.settings.ai_model = data.ai_model || 'kr/claude-sonnet-4.6-thinking';
      store.settings.ai_models = data.ai_models || [];

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
        ai_model: store.settings.ai_model,
      };
      if (elevenKeyDirty.value) patch.elevenlabs_api_key = elevenKey.value.trim();
      if (aiKeyDirty.value) patch.ai_api_key = aiKey.value.trim();
      try {
        const data = await updateSettings(patch);
        applyServerSettings(data);
        elevenKey.value = '';
        aiKey.value = '';
        elevenKeyDirty.value = false;
        aiKeyDirty.value = false;
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

    async function runAiTest() {
      aiTest.value = { state: 'running', text: 'Testing…' };
      try {
        const res = await testAiKey(
          aiKeyDirty.value ? aiKey.value.trim() : '',
          store.settings.ai_model,
        );
        if (res.ok) {
          aiTest.value = {
            state: 'ok',
            text: `Key OK · model "${res.model}"${res.sample ? ' · "' + res.sample + '"' : ''}`,
          };
        } else if (res.reason === 'model') {
          aiTest.value = {
            state: 'error',
            text: `Key works, but model is the problem → ${res.error || 'model unavailable'}`,
          };
        } else {
          aiTest.value = {
            state: 'error',
            text: `Key rejected → ${res.error || 'Failed'}`,
          };
        }
      } catch (e) {
        aiTest.value = { state: 'error', text: e.message };
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

    async function addAiModel() {
      const m = newAiModel.value.trim();
      if (!m) return;
      try {
        const data = await addSettingsModel('ai', m);
        applyServerSettings(data);
        store.settings.ai_model = m;
        await updateSettings({ ai_model: m });
        newAiModel.value = '';
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

    async function removeAiModel(model) {
      if (model === store.settings.ai_model) {
        message.value = { kind: 'error', text: 'Switch to a different active model first.' };
        return;
      }
      if (!confirm('Remove "' + model + '" from the list?')) return;
      try {
        const data = await removeSettingsModel('ai', model);
        applyServerSettings(data);
      } catch (e) {
        message.value = { kind: 'error', text: e.message };
      }
    }

    function onElevenKeyInput() { elevenKeyDirty.value = true; }
    function onAiKeyInput() { aiKeyDirty.value = true; }
    function goHome() {
      const prev = store.previousAppMode || 'home';
      store.appMode = prev;
    }

    return {
      store, s,
      loading, saving, message,
      elevenKey, aiKey, elevenKeyDirty, aiKeyDirty,
      newElevenModel, newAiModel,
      elevenTest, aiTest,
      saveAll, runElevenTest, runAiTest,
      addElevenModel, addAiModel,
      removeElevenModel, removeAiModel,
      onElevenKeyInput, onAiKeyInput,
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

    <!-- 9Router (Kiro) card -->
    <section class="settings-card">
      <header class="settings-card-head">
        <h2>✨ 9Router (Kiro)</h2>
        <span class="settings-status" :class="s.ai_api_key_set ? 'is-set' : 'is-unset'">
          {{ s.ai_api_key_set ? 'Key configured' : 'Not configured' }}
        </span>
      </header>

      <div class="settings-row">
        <label class="settings-label">
          API Key
          <span class="settings-hint">Base URL: <code>{{ s.ai_base_url }}</code></span>
        </label>
        <div class="settings-key-row">
          <input
            type="password"
            class="settings-input"
            :placeholder="s.ai_api_key_set ? s.ai_api_key : 'sk-...'"
            v-model="aiKey"
            @input="onAiKeyInput"
            autocomplete="off"
          />
          <button class="btn btn-outline btn-sm" @click="runAiTest">Test</button>
        </div>
        <div v-if="aiTest.state !== 'idle'" class="settings-test-result" :class="'settings-test-result--' + aiTest.state">
          {{ aiTest.text }}
        </div>
      </div>

      <div class="settings-row">
        <label class="settings-label">Active model</label>
        <select class="settings-input" v-model="s.ai_model">
          <option v-for="m in s.ai_models" :key="m" :value="m">{{ m }}</option>
        </select>
      </div>

      <div class="settings-row">
        <label class="settings-label">Add custom model</label>
        <div class="settings-key-row">
          <input
            type="text"
            class="settings-input"
            placeholder="e.g. kr/claude-opus-4.8-thinking"
            v-model="newAiModel"
            @keydown.enter="addAiModel"
          />
          <button class="btn btn-primary btn-sm" @click="addAiModel">+ Add</button>
        </div>
      </div>

      <div v-if="s.ai_models.length" class="settings-chip-row">
        <span
          v-for="m in s.ai_models"
          :key="m"
          class="settings-chip"
          :class="{ 'is-active': m === s.ai_model }"
        >
          {{ m }}
          <button class="settings-chip-x" @click="removeAiModel(m)" title="Remove">×</button>
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
