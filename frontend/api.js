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

export async function uploadAndTranscribe(file) {
  const formData = new FormData();
  formData.append('file', file);
  const res = await fetch('/transcribe', { method: 'POST', body: formData });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Transcription failed');
  }
  return res.json();
}

export async function transcribeExistingFile(filename) {
  const res = await fetch('/transcribe-existing', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ filename }),
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

export async function startCutSilenceJob(payload) {
  const res = await fetch('/cut-silence', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  if (!res.ok) {
    const err = await res.json();
    throw new Error(err.detail || 'Cut silence request failed');
  }
  return res.json();
}

export async function pollCutSilenceStatus(jobId) {
  const res = await fetch('/cut-silence-status/' + jobId);
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

export async function ytAnalyze(url, criteria, geminiApiKey) {
  const res = await fetch('/yt-clip/analyze', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url, criteria, gemini_api_key: geminiApiKey }),
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

