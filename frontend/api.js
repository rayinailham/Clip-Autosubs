/**
 * API service — centralises all fetch calls to the backend.
 */

export async function fetchStatus() {
  const res = await fetch('/status');
  return res.json();
}

export async function fetchUploads() {
  const res = await fetch('/uploads');
  return res.json();
}

export async function loadTranscriptionJSON(encodedJson) {
  const res = await fetch('/outputs/' + encodedJson);
  if (!res.ok) throw new Error('Transcription file not found');
  return res.json();
}

export async function uploadAndTranscribe(file, diarizeOpts = {}) {
  const formData = new FormData();
  formData.append('file', file);
  if (diarizeOpts.transcription_model) formData.append('transcription_model', diarizeOpts.transcription_model);
  if (diarizeOpts.elevenlabs_api_key) formData.append('elevenlabs_api_key', diarizeOpts.elevenlabs_api_key);
  if (diarizeOpts.diarize) formData.append('diarize', 'true');
  if (diarizeOpts.num_speakers != null) formData.append('num_speakers', String(diarizeOpts.num_speakers));
  // Legacy aliases — backend maps these to num_speakers if present.
  if (diarizeOpts.hf_token) formData.append('hf_token', diarizeOpts.hf_token);
  if (diarizeOpts.min_speakers != null) formData.append('min_speakers', String(diarizeOpts.min_speakers));
  if (diarizeOpts.max_speakers != null) formData.append('max_speakers', String(diarizeOpts.max_speakers));
  const res = await fetch('/transcribe', { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Transcription failed');
  }
  return res.json();
}

export async function transcribeExistingFile(filename, diarizeOpts = {}) {
  const body = { filename };
  if (diarizeOpts.transcription_model) body.transcription_model = diarizeOpts.transcription_model;
  if (diarizeOpts.elevenlabs_api_key) body.elevenlabs_api_key = diarizeOpts.elevenlabs_api_key;
  if (diarizeOpts.diarize) body.diarize = true;
  if (diarizeOpts.num_speakers != null) body.num_speakers = diarizeOpts.num_speakers;
  if (diarizeOpts.hf_token) body.hf_token = diarizeOpts.hf_token;
  if (diarizeOpts.min_speakers != null) body.min_speakers = diarizeOpts.min_speakers;
  if (diarizeOpts.max_speakers != null) body.max_speakers = diarizeOpts.max_speakers;
  const res = await fetch('/transcribe-existing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Transcription failed');
  }
  return res.json();
}

export async function startRenderJob(payload) {
  const res = await fetch('/render', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Render request failed');
  }
  return res.json();
}

export async function pollRenderStatus(renderId) {
  const res = await fetch('/render-status/' + renderId);
  return res.json();
}

export async function deleteUpload(filename) {
  const res = await fetch('/uploads/' + encodeURIComponent(filename), { method: 'DELETE' });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Delete failed');
  }
  return res.json();
}

export function videoURL(filename) {
  return '/video/' + encodeURIComponent(filename);
}

// ── VTuber Reframe ──────────────────────────────────────────

export async function uploadVideoOnly(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/upload-only', { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Upload failed');
  }
  return res.json();
}

export async function startReframeJob(payload) {
  const res = await fetch('/render-reframe', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Reframe render request failed');
  }
  return res.json();
}

export async function pollReframeStatus(jobId) {
  const res = await fetch('/reframe-status/' + jobId);
  return res.json();
}

// ── YouTube Clip Finder ──────────────────────────────────────

export async function ytAnalyze(url, criteria, geminiApiKey, opts = {}) {
  const {
    useChatSignal = true,
    includeSetup = true,
  } = opts;
  const res = await fetch('/yt-clip/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      url,
      criteria,
      gemini_api_key: geminiApiKey,
      use_chat_signal: useChatSignal,
      include_setup: includeSetup,
    }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Analyze request failed');
  }
  return res.json();
}

export async function ytPollAnalyze(jobId) {
  const res = await fetch('/yt-clip/analyze-status/' + jobId);
  return res.json();
}

export async function ytCut(url, clips) {
  const res = await fetch('/yt-clip/cut', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, clips }),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Cut request failed');
  }
  return res.json();
}

export async function ytPollCut(jobId) {
  const res = await fetch('/yt-clip/cut-status/' + jobId);
  return res.json();
}

// ── Manual Trim ────────────────────────────────────────────

export async function startTrimJob(payload) {
  const res = await fetch('/trim', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Trim request failed');
  }
  return res.json();
}

export async function pollTrimStatus(jobId) {
  const res = await fetch('/trim-status/' + jobId);
  return res.json();
}

// ── Refine Automation ──────────────────────────────────────

export async function startRefineJob(payload) {
  const res = await fetch('/refine', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Refine request failed');
  }
  return res.json();
}

export async function pollRefineStatus(jobId) {
  const res = await fetch('/refine-status/' + jobId);
  return res.json();
}

// ── Settings ──────────────────────────────────────────────

export async function fetchSettings() {
  const res = await fetch('/settings');
  if (!res.ok) throw new Error('Failed to load settings');
  return res.json();
}

export async function updateSettings(patch) {
  const res = await fetch('/settings', {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to save settings');
  }
  return res.json();
}

export async function addSettingsModel(provider, model) {
  const res = await fetch('/settings/models/add', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to add model');
  }
  return res.json();
}

export async function removeSettingsModel(provider, model) {
  const res = await fetch('/settings/models/remove', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ provider, model }),
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({}));
    throw new Error(err.detail || 'Failed to remove model');
  }
  return res.json();
}

export async function testElevenlabsKey(apiKey) {
  const res = await fetch('/settings/test/elevenlabs', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey || '' }),
  });
  return res.json();
}

export async function testGeminiKey(apiKey, model) {
  const res = await fetch('/settings/test/gemini', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: apiKey || '', model: model || null }),
  });
  return res.json();
}
