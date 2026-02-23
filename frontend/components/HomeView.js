import store from '../store.js';

export default {
  name: 'HomeView',
  setup() {
    function goSubtitle() {
      store.currentView = 'upload';
      store.appMode = 'subtitle';
    }

    function goVtuber() {
      store.reframe.step = 'mode';
      store.appMode = 'vtuber';
    }

    function goYtClipper() {
      store.appMode = 'ytclipper';
    }

    function goRefine() {
      store.appMode = 'refine';
    }

    return { goSubtitle, goVtuber, goYtClipper, goRefine };
  },
  template: `
    <div class="home-view">
      <div class="home-hero">
        <h1 class="home-title">What do you want to make?</h1>
        <p class="home-sub">Pick a workflow to get started</p>
      </div>

      <div class="home-cards">

        <!-- Auto-Refine card (featured) -->
        <div class="home-card home-card--refine" @click="goRefine">
          <div class="home-card-icon">✨</div>
          <h2 class="home-card-title">Auto-Refine</h2>
          <p class="home-card-desc">
            Drop a vertical video and let AI handle everything: transcribe,
            identify speakers, remove silences and smart-group your subtitles — all in one click.
          </p>
          <div class="home-card-tags">
            <span class="tag">Speaker ID</span>
            <span class="tag">Smart groups</span>
            <span class="tag">Silence cut</span>
            <span class="tag">Gemini AI</span>
          </div>
          <button class="btn btn-refine home-card-btn">Get Started →</button>
        </div>

        <!-- Subtitle Clips card -->
        <div class="home-card" @click="goSubtitle">
          <div class="home-card-icon">💬</div>
          <h2 class="home-card-title">Subtitle Clips</h2>
          <p class="home-card-desc">
            Upload a video or audio file and get animated, styled subtitles
            burned in automatically. Perfect for TikTok, Reels, and YouTube Shorts.
          </p>
          <div class="home-card-tags">
            <span class="tag">Auto-transcribe</span>
            <span class="tag">Dynamic karaoke</span>
            <span class="tag">Custom fonts</span>
          </div>
          <button class="btn btn-primary home-card-btn">Get Started →</button>
        </div>

        <!-- Shorts Creator card -->
        <div class="home-card home-card--vtuber" @click="goVtuber">
          <div class="home-card-icon">🎥</div>
          <h2 class="home-card-title">Shorts Creator</h2>
          <p class="home-card-desc">
            Convert any horizontal video into a 9:16 vertical short. Choose
            from four styles: zoomed-in, blurred background, black bars, or
            the split-screen layout with custom pan &amp; zoom.
          </p>
          <div class="home-card-tags">
            <span class="tag">9:16 vertical</span>
            <span class="tag">Blur / Zoom / Black</span>
            <span class="tag">Split-screen</span>
          </div>
          <button class="btn btn-accent home-card-btn">Get Started →</button>
        </div>

        <!-- YouTube Clip Finder card -->
        <div class="home-card home-card--ytclipper" @click="goYtClipper">
          <div class="home-card-icon">🎬</div>
          <h2 class="home-card-title">YouTube Clip Finder</h2>
          <p class="home-card-desc">
            Paste a YouTube link, describe what you're looking for, and let
            Gemini AI find the best moments. Clips get cut and sent straight
            to the subtitle workflow.
          </p>
          <div class="home-card-tags">
            <span class="tag">yt-dlp</span>
            <span class="tag">Gemini AI</span>
            <span class="tag">Auto-clip</span>
          </div>
          <button class="btn btn-yt home-card-btn">Get Started →</button>
        </div>

      </div>
    </div>
  `,
};
