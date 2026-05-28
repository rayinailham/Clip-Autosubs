import { ref, computed } from 'vue';
import store, { getUniqueSpeakers, getSpeakerColor } from '../store.js';
import { uploadAvatar, avatarURL } from '../api.js';

/**
 * Default per-speaker config. Mirrors the backend SpeakerEntry pydantic model.
 */
function defaultSpeakerEntry() {
  return {
    enabled: false,
    avatar: '',         // filename inside uploads/avatars/
    label: '',
    pos_x: 15,          // top-left default for second speaker
    pos_y: 15,
    bg_color: '#FFFFFF',
    bg_alpha: 0.92,
    text_color: '#111111',
    border_color: '#000000',
    border_width: 0,
    box_scale: 1.0,
    avatar_size: 120,
  };
}

function ensureEntry(spkId) {
  if (!store.speakerConfig[spkId]) {
    store.speakerConfig[spkId] = defaultSpeakerEntry();
  }
  return store.speakerConfig[spkId];
}

const POSITION_PRESETS = [
  { key: 'tl', label: 'Top Left',     x: 15, y: 15 },
  { key: 'tc', label: 'Top Center',   x: 50, y: 15 },
  { key: 'tr', label: 'Top Right',    x: 85, y: 15 },
  { key: 'ml', label: 'Mid Left',     x: 15, y: 50 },
  { key: 'mc', label: 'Center',       x: 50, y: 50 },
  { key: 'mr', label: 'Mid Right',    x: 85, y: 50 },
  { key: 'bl', label: 'Bot Left',     x: 15, y: 85 },
  { key: 'bc', label: 'Bot Center',   x: 50, y: 85 },
  { key: 'br', label: 'Bot Right',    x: 85, y: 85 },
];

export default {
  name: 'SpeakersSidebar',
  setup() {
    const uploadingFor = ref('');
    const uploadMsg = ref('');

    const uniqueSpeakers = computed(() => getUniqueSpeakers());
    const hasSpeakers = computed(() => uniqueSpeakers.value.length > 0);

    function speakerColorPill(spkId) {
      const c = getSpeakerColor(spkId);
      return { background: c.bg, borderColor: c.border, color: c.text };
    }

    function defaultLabel(spkId) {
      return store.speakers[spkId] || spkId.replace('SPEAKER_', 'Speaker ');
    }

    function entry(spkId) {
      return ensureEntry(spkId);
    }

    function applyPreset(spkId, preset) {
      const e = ensureEntry(spkId);
      e.pos_x = preset.x;
      e.pos_y = preset.y;
    }

    async function onAvatarFile(spkId, evt) {
      const file = evt.target.files && evt.target.files[0];
      if (!file) return;
      uploadingFor.value = spkId;
      uploadMsg.value = 'Uploading…';
      try {
        const res = await uploadAvatar(file);
        const e = ensureEntry(spkId);
        e.avatar = res.filename;
        e.enabled = true;
        uploadMsg.value = '✓ Saved ' + res.filename;
      } catch (err) {
        uploadMsg.value = '✗ ' + (err.message || 'upload failed');
      } finally {
        uploadingFor.value = '';
        // Clear file input so the same file can be re-picked.
        evt.target.value = '';
        setTimeout(() => { uploadMsg.value = ''; }, 2500);
      }
    }

    function clearAvatar(spkId) {
      const e = ensureEntry(spkId);
      e.avatar = '';
    }

    function avatarSrc(spkId) {
      const e = store.speakerConfig[spkId];
      return e && e.avatar ? avatarURL(e.avatar) : '';
    }

    function applyToAll(field, fromSpkId) {
      const src = ensureEntry(fromSpkId);
      uniqueSpeakers.value.forEach(id => {
        if (id === fromSpkId) return;
        const e = ensureEntry(id);
        e[field] = src[field];
      });
    }

    return {
      store, uniqueSpeakers, hasSpeakers,
      POSITION_PRESETS, speakerColorPill, defaultLabel,
      entry, applyPreset, onAvatarFile, clearAvatar, avatarSrc,
      uploadingFor, uploadMsg, applyToAll,
    };
  },
  template: `
    <div class="speakers-tab">
      <div v-if="!hasSpeakers" class="speakers-empty">
        <p>No speakers detected on this transcription.</p>
        <p class="hint">Re-transcribe with diarization enabled, then return here to assign avatars and dialog-box positions per speaker.</p>
      </div>

      <div v-for="spkId in uniqueSpeakers" :key="spkId" class="speaker-card">
        <div class="speaker-card-header">
          <span class="speaker-id-pill" :style="speakerColorPill(spkId)">{{ defaultLabel(spkId) }}</span>
        </div>

        <div class="speaker-role-row">
          <label class="speaker-role-opt" :class="{ active: !entry(spkId).enabled }">
            <input type="radio" :name="'role-' + spkId" :checked="!entry(spkId).enabled" @change="entry(spkId).enabled = false" />
            <span class="role-label">Main</span>
            <span class="role-desc">Default subtitle (bottom center)</span>
          </label>
          <label class="speaker-role-opt" :class="{ active: entry(spkId).enabled }">
            <input type="radio" :name="'role-' + spkId" :checked="entry(spkId).enabled" @change="entry(spkId).enabled = true" />
            <span class="role-label">Sub</span>
            <span class="role-desc">Avatar + dialog box</span>
          </label>
        </div>

        <div v-if="entry(spkId).enabled">
        <div class="speaker-row">
          <label>Label</label>
          <input type="text"
                 :value="entry(spkId).label || defaultLabel(spkId)"
                 @input="entry(spkId).label = $event.target.value"
                 placeholder="Speaker name" />
        </div>

        <div class="speaker-avatar-row">
          <div class="speaker-avatar-preview" :class="{ empty: !avatarSrc(spkId) }">
            <img v-if="avatarSrc(spkId)" :src="avatarSrc(spkId)" alt="avatar" />
            <span v-else>No image</span>
          </div>
          <div class="speaker-avatar-actions">
            <label class="btn btn-outline btn-sm avatar-upload-btn">
              {{ uploadingFor === spkId ? 'Uploading…' : (avatarSrc(spkId) ? 'Replace' : 'Upload Image') }}
              <input type="file"
                     accept=".png,.jpg,.jpeg,.webp,.gif"
                     :disabled="uploadingFor === spkId"
                     @change="onAvatarFile(spkId, $event)" />
            </label>
            <button v-if="avatarSrc(spkId)" class="btn btn-outline btn-sm" @click="clearAvatar(spkId)">Remove</button>
          </div>
        </div>
        <div v-if="uploadingFor === spkId || (uploadMsg && uploadingFor === '')" class="upload-msg">{{ uploadMsg }}</div>

        <div class="speaker-section-title">Position</div>
        <div class="speaker-preset-grid">
          <button v-for="p in POSITION_PRESETS" :key="p.key"
                  class="speaker-preset-btn"
                  :class="{ active: entry(spkId).pos_x === p.x && entry(spkId).pos_y === p.y }"
                  @click="applyPreset(spkId, p)">{{ p.label }}</button>
        </div>
        <div class="speaker-row">
          <label>X %</label>
          <input type="range" min="0" max="100" v-model.number="entry(spkId).pos_x" />
          <input type="number" min="0" max="100" class="range-val-input" v-model.number="entry(spkId).pos_x" />
        </div>
        <div class="speaker-row">
          <label>Y %</label>
          <input type="range" min="0" max="100" v-model.number="entry(spkId).pos_y" />
          <input type="number" min="0" max="100" class="range-val-input" v-model.number="entry(spkId).pos_y" />
        </div>

        <div class="speaker-section-title">Box</div>
        <div class="speaker-row">
          <label>BG Color</label>
          <input type="color" v-model="entry(spkId).bg_color" />
          <label style="margin-left:0.5rem">Alpha</label>
          <input type="range" min="0" max="1" step="0.02" v-model.number="entry(spkId).bg_alpha" />
        </div>
        <div class="speaker-row">
          <label>Text</label>
          <input type="color" v-model="entry(spkId).text_color" />
          <label style="margin-left:0.5rem">Border</label>
          <input type="color" v-model="entry(spkId).border_color" />
        </div>
        <div class="speaker-row">
          <label>Border W</label>
          <input type="range" min="0" max="10" v-model.number="entry(spkId).border_width" />
          <input type="number" min="0" max="10" class="range-val-input" v-model.number="entry(spkId).border_width" />
        </div>
        <div class="speaker-row">
          <label>Box Scale</label>
          <input type="range" min="0.5" max="2" step="0.05" v-model.number="entry(spkId).box_scale" />
          <input type="number" min="0.5" max="2" step="0.05" class="range-val-input" v-model.number="entry(spkId).box_scale" />
        </div>
        <div class="speaker-row">
          <label>Avatar Size</label>
          <input type="range" min="60" max="240" v-model.number="entry(spkId).avatar_size" />
          <input type="number" min="60" max="240" class="range-val-input" v-model.number="entry(spkId).avatar_size" />
        </div>

        <div class="speaker-row apply-all-row">
          <button class="btn btn-outline btn-sm" @click="applyToAll('box_scale', spkId)" title="Copy box scale to other speakers">Copy Box Scale →</button>
          <button class="btn btn-outline btn-sm" @click="applyToAll('avatar_size', spkId)" title="Copy avatar size to other speakers">Copy Avatar Size →</button>
        </div>
        </div><!-- /v-if sub config -->
      </div>
    </div>
  `,
};
