# Clipping Project — Feature Checklist

This document tracks all existing features during the Vue.js frontend refactor.  
Every feature must be preserved. Mark each with ✅ once confirmed working in the new Vue frontend.

---

## Header
- [x] App title with gradient styling
- [x] GPU status pill (CUDA / CPU indicator)
- [x] FFmpeg status pill (installed / missing)
- [x] Sticky header with blur backdrop

## Upload View
- [x] Hero section with tagline
- [x] Upload card with drag & drop support
- [x] Upload card with file input click (accepts .mp4,.mkv,.avi,.mov,.webm,.mp3,.wav,.flac,.m4a,.ogg)
- [x] File size limit display (up to 500 MB)
- [x] Dragover visual feedback on card
- [x] Transcription progress bar (indeterminate animation)
- [x] Progress text & filename display
- [x] Previously uploaded files list
  - [x] Refresh button
  - [x] File size & transcription status badges
  - [x] "Open" button for transcribed files
  - [x] "Transcribe" button for un-transcribed files
- [x] Transcribe existing file (POST /transcribe-existing)

## Editor View — Video Panel
- [x] Video player with controls
- [x] Subtitle overlay positioned over video
- [x] Real-time subtitle preview synced to video playback
- [x] Subtitle position: bottom / center / top
- [x] Scaled font size relative to video height
- [x] Scaled outline and glow relative to video height
- [x] Margin V/H applied proportionally

## Editor View — Transcript Panel
- [x] Word list rendering with word count
- [x] Word chip click to seek video to that timestamp
- [x] Double-click word chip to inline edit text
- [x] Shift+click for range word selection
- [x] Ctrl/Cmd+click for toggle word selection
- [x] Delete button (×) on word hover
- [x] Visual indicator for words with custom styles (dot badge)
- [x] Visual indicator for merged words (chain icon)
- [x] Currently playing word highlighting (auto-scroll to visible)
- [x] Undo button with stack count
- [x] Undo system (max 50 snapshots, stores words + groups)
- [x] Merge words button (enabled when 2+ adjacent selected)
- [x] Merge modal with editable merged text
- [x] "New File" button to return to upload view
- [x] Footer hint text (click to seek, dbl-click to edit, shift-click range)

## Sidebar — Style Tab
### Subtitle Mode
- [x] Dynamic mode toggle (per-word highlighting)
- [x] Static mode toggle (sentence at a time)
- [x] Mode switch applies default preset (vtuber / classic)
- [x] Show/hide mode-specific controls on toggle

### Dynamic Presets (6 presets)
- [x] VTuber Pop
- [x] Neon
- [x] Anime Bold
- [x] Clean
- [x] Retro
- [x] Idol

### Static Presets (6 presets)
- [x] Classic
- [x] Cinematic
- [x] Minimal
- [x] Neon Glow
- [x] Retro VHS
- [x] Elegant

### Emotion Styles (Dynamic only, 8 emotions)
- [x] Angry, Creepy, Shy, Gloomy, Bright, Energetic, Obnoxious, Romantic
- [x] Apply emotion to selected words (per-word style override)
- [x] Warning if no words selected
- [x] Visual feedback on apply

### Font Controls
- [x] Font family dropdown (15 fonts)
- [x] Font size slider (20–200)
- [x] Bold checkbox
- [x] Italic checkbox
- [x] Uppercase checkbox

### Color Controls
- [x] Highlight color picker (dynamic mode)
- [x] Normal/Text color picker
- [x] Static text color picker (static mode)
- [x] Outline color picker
- [x] Shadow color picker

### Effects Controls
- [x] Outline width slider (0–12)
- [x] Shadow depth slider (0–10)
- [x] Glow strength slider (0–20)
- [x] Glow color picker
- [x] Scale % slider (100–150, dynamic only)

### Animation Controls
- [x] Word highlight animation select (color-only, scale, bounce, none) — dynamic
- [x] Group animation select (none, fade-in, slide-up, slide-down, pop-in, typewriter) — dynamic
- [x] Animation speed slider (100–500ms) — dynamic
- [x] Sentence animation select (none, fade-in, slide-up, slide-down, pop-in, typewriter) — static
- [x] Static animation speed slider (100–500ms) — static

### Spacing Controls
- [x] Letter spacing slider (0–20)
- [x] Word gap slider (0–8)

### Position Controls
- [x] Vertical position select (bottom, center, top)
- [x] Margin V slider (0–200)
- [x] Margin H slider (0–200)

### Per-Word Style Panel
- [x] Shows when words selected
- [x] Highlight color override
- [x] Normal color override
- [x] Font size override
- [x] Outline color override
- [x] Apply to selected button
- [x] Clear word styles button

## Sidebar — Groups Tab
- [x] Auto / Custom mode toggle
- [x] Words per group slider (1–10, auto mode)
- [x] Auto-regenerate groups on WPG change
- [x] Custom group list with:
  - [x] Split group button
  - [x] Merge with next button
  - [x] Editable start/end timing inputs
  - [x] Word text display per group
- [x] "Reset to Auto" button in custom mode

## Rendering
- [x] Render button in bottom bar
- [x] Render overlay modal
  - [x] Progress bar (indeterminate → solid)
  - [x] Status text updates (generating subtitles → rendering → done/error)
  - [x] Poll render status (GET /render-status/{id})
  - [x] Download link on completion
  - [x] Close button
  - [x] Error state display

## API Integration
- [x] GET /status — system check
- [x] POST /transcribe — upload & transcribe new file
- [x] POST /transcribe-existing — transcribe previously uploaded file
- [x] GET /uploads — list previously uploaded files
- [x] GET /outputs/{filename} — load transcription JSON
- [x] GET /video/{filename} — stream video
- [x] POST /render — start render job
- [x] GET /render-status/{id} — poll render progress
- [x] GET /rendered/{filename} — download rendered video

## Styling / UX
- [x] Dark theme with CSS variables
- [x] Gradient accent colors
- [x] Animated upload card border
- [x] Floating upload icon animation
- [x] Responsive layout (≤900px single column)
- [x] Custom scrollbar styling
- [x] Google Fonts loaded (Inter, Bangers, Bebas Neue, Anton, Oswald, Creepster, Permanent Marker, Comic Neue, Bungee, Poppins, Montserrat)
