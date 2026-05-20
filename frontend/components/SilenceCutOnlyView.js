import { ref, onMounted } from 'vue';
import store from '../store.js';
import { uploadAndTranscribe, startCutSilenceJob, pollCutSilenceStatus, videoURL } from '../api.js';

export default {
  name: 'SilenceCutOnlyView',
  setup() {
    const dragover = ref(false);
    
    const step = ref('upload'); // 'upload', 'processing', 'done'
    const progressText = ref('');
    const progressFile = ref('');
    const cutVideo = ref(null);
    const stats = ref(null);

    // Settings
    const minSilenceMs = ref(500);
    const paddingMs = ref(100);
    
    async function handleFile(file) {
      if (!file) return;
      
      step.value = 'processing';
      progressFile.value = file.name;
      
      try {
        progressText.value = '1/2 Uploading & Transcribing audio...';
        
        // Use auto model by default, or the one from store
        const transcribeResult = await uploadAndTranscribe(file, {
          transcription_model: store.transcriptionModel || 'large-v2'
        });
        
        const words = transcribeResult.words || [];
        
        if (words.length === 0) {
           throw new Error("No speech detected or transcription failed.");
        }
        
        progressText.value = '2/2 Cutting silences...';
        
        const cutReq = {
          video_filename: transcribeResult.metadata?.filename || file.name,
          words: words,
          min_silence_ms: minSilenceMs.value,
          padding_ms: paddingMs.value
        };
        
        const cutInit = await startCutSilenceJob(cutReq);
        const jobId = cutInit.job_id;
        
        // Poll for completion
        while (true) {
           await new Promise(r => setTimeout(r, 1000));
           const status = await pollCutSilenceStatus(jobId);
           if (status.status === 'error') {
             throw new Error(status.error);
           }
           if (status.status === 'done') {
             cutVideo.value = status.url;
             stats.value = status;
             break;
           }
        }
        
        step.value = 'done';
        
      } catch (err) {
        alert('Error: ' + err.message);
        step.value = 'upload';
      }
    }

    function onFileChange(e) {
      const file = e.target.files[0];
      handleFile(file);
    }

    function onDrop(e) {
      e.preventDefault();
      dragover.value = false;
      if (e.dataTransfer.files.length) handleFile(e.dataTransfer.files[0]);
    }

    function onDragover(e) {
      e.preventDefault();
      dragover.value = true;
    }

    function onDragleave() {
      dragover.value = false;
    }

    function reset() {
       step.value = 'upload';
       cutVideo.value = null;
       stats.value = null;
    }

    return {
      store, dragover, step, progressText, progressFile, cutVideo, stats,
      minSilenceMs, paddingMs,
      onFileChange, onDrop, onDragover, onDragleave, reset, videoURL
    };
  },
  template: `
    <div id="silence-cutter-only-view" class="view active">
      <button class="btn btn-ghost back-btn" style="margin:1rem 1.5rem" @click="store.appMode = 'home'">← Back</button>
      
      <!-- Upload Step -->
      <template v-if="step === 'upload'">
          <div class="upload-hero">
            <h2>Fast Silence Remover</h2>
            <p>Drop a video to automatically remove silent gaps. No subtitles generated.</p>
          </div>
          
          <div class="transcription-options" style="max-width: 560px; width: 100%; margin: 0 auto 1.5rem auto;">
             <div style="background: var(--surface); padding: 1rem; border: 1px solid var(--border); border-radius: var(--radius-sm); display: flex; flex-direction: column; gap: 1rem;">
               <label style="color: var(--text); display: flex; align-items: center; justify-content: space-between;">
                 <span>Maximum Silence Duration (ms) <br/><small style="color: var(--text-dim)">Gaps longer than this are removed</small></span>
                 <input type="number" v-model.number="minSilenceMs" min="100" max="3000" step="50" style="padding: 4px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); width: 80px;" />
               </label>
               
               <label style="color: var(--text); display: flex; align-items: center; justify-content: space-between;">
                 <span>Padding (ms) <br/><small style="color: var(--text-dim)">Extra time kept before/after speech</small></span>
                 <input type="number" v-model.number="paddingMs" min="0" max="1000" step="10" style="padding: 4px 8px; border-radius: 4px; background: var(--surface2); border: 1px solid var(--border); color: var(--text); width: 80px;" />
               </label>
             </div>
          </div>
          
          <div class="upload-card-wrap" style="max-width: 560px; margin: 0 auto;">
            <div class="upload-card" :class="{ dragover: dragover }"
                 @dragover="onDragover" @dragleave="onDragleave" @drop="onDrop">
              <input type="file" @change="onFileChange" accept=".mp4,.mkv,.avi,.mov,.webm" />
              <span class="upload-icon">✂️</span>
              <h2>Drop a video file to cut</h2>
              <p>MP4, MKV, AVI, MOV, WEBM</p>
            </div>
          </div>
      </template>
      
      <!-- Processing Step -->
      <template v-else-if="step === 'processing'">
          <div class="upload-hero">
            <h2>Processing your video...</h2>
            <p>This may take a minute depending on duration.</p>
          </div>
          <div class="transcribe-progress active">
            <div class="progress-box">
              <div class="progress-label">
                <span>{{ progressText }}</span>
                <span>{{ progressFile }}</span>
              </div>
              <div class="progress-track" style="margin-top: 10px;">
                <div class="progress-fill" style="width: 100%; animation: pulse 2s infinite linear;"></div>
              </div>
            </div>
          </div>
      </template>
      
      <!-- Done Step -->
      <template v-else-if="step === 'done'">
          <div class="upload-hero">
            <h2>Success!</h2>
            <p>Your video is ready.</p>
          </div>
          
          <div style="max-width: 800px; margin: 2rem auto; display: flex; flex-direction: column; gap: 1rem;">
             <video :src="cutVideo" controls style="width: 100%; border-radius: var(--radius-sm); border: 1px solid var(--border); background: #000;"></video>
             
             <div v-if="stats" style="background: var(--surface2); padding: 1rem; border-radius: var(--radius-sm); border: 1px solid var(--border); display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem; text-align: center;">
                 <div>
                     <strong style="font-size: 1.2rem; color: var(--accent);">{{ stats.kept_duration_s }}s</strong>
                     <div style="font-size: 0.8rem; color: var(--text-dim)">New Duration</div>
                 </div>
                 <div>
                     <strong style="font-size: 1.2rem; color: var(--accent);">-{{ stats.removed_duration_s }}s</strong>
                     <div style="font-size: 0.8rem; color: var(--text-dim)">Silence Removed</div>
                 </div>
                 <div>
                     <strong style="font-size: 1.2rem; color: var(--accent);">{{ stats.size_mb }} MB</strong>
                     <div style="font-size: 0.8rem; color: var(--text-dim)">File Size</div>
                 </div>
             </div>
             
             <div style="display: flex; gap: 1rem; margin-top: 1rem;">
                <a :href="cutVideo" target="_blank" download class="btn btn-primary" style="flex: 1; text-align: center; text-decoration: none;">⬇️ Download Video</a>
                <button class="btn btn-outline" style="flex: 1;" @click="reset">Cut Another Video</button>
             </div>
          </div>
      </template>
      
    </div>
  `,
};
