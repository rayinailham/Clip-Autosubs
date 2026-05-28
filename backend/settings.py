"""
Settings — persistent config for API keys + model lists.

Stored at  <project_root>/config/settings.json  (ignored by git via .gitignore).
Intentionally plaintext — local-only single-user app.
"""

import json
from pathlib import Path
from typing import Optional

import requests


BASE_DIR = Path(__file__).resolve().parent.parent
CONFIG_DIR = BASE_DIR / "config"
SETTINGS_PATH = CONFIG_DIR / "settings.json"


DEFAULTS = {
    "elevenlabs_api_key": "",
    "elevenlabs_model": "scribe_v1",
    "elevenlabs_models": ["scribe_v1"],

    "gemini_api_key": "",
    "gemini_model": "gemini-2.0-flash",
    "gemini_models": [
        "gemini-2.0-flash",
        "gemini-2.5-flash",
        "gemini-2.5-pro",
        "gemini-3-flash-preview",
    ],
}


def _ensure_dir() -> None:
    CONFIG_DIR.mkdir(parents=True, exist_ok=True)


def load_settings() -> dict:
    """Return the current settings, merged on top of DEFAULTS."""
    _ensure_dir()
    if not SETTINGS_PATH.exists():
        return dict(DEFAULTS)
    try:
        with open(SETTINGS_PATH, "r", encoding="utf-8") as f:
            data = json.load(f) or {}
    except (json.JSONDecodeError, OSError):
        return dict(DEFAULTS)

    out = dict(DEFAULTS)
    out.update(data)

    # Make sure model lists always include the active model.
    for active_key, list_key in (
        ("elevenlabs_model", "elevenlabs_models"),
        ("gemini_model", "gemini_models"),
    ):
        active = out.get(active_key)
        models = list(out.get(list_key) or [])
        if active and active not in models:
            models.insert(0, active)
        out[list_key] = models
    return out


def save_settings(patch: dict) -> dict:
    """Merge `patch` into the existing settings and persist. Returns merged dict."""
    _ensure_dir()
    current = load_settings()

    # Whitelist keys to avoid arbitrary writes.
    allowed = set(DEFAULTS.keys())
    for k, v in patch.items():
        if k in allowed:
            current[k] = v

    # Auto-add active model into the list if missing.
    for active_key, list_key in (
        ("elevenlabs_model", "elevenlabs_models"),
        ("gemini_model", "gemini_models"),
    ):
        active = current.get(active_key)
        models = list(current.get(list_key) or [])
        if active and active not in models:
            models.insert(0, active)
        current[list_key] = models

    with open(SETTINGS_PATH, "w", encoding="utf-8") as f:
        json.dump(current, f, indent=2)
    return current


def add_model(provider: str, model: str) -> dict:
    """Add a custom model to the provider's list. provider in {elevenlabs, gemini}."""
    if not model or not model.strip():
        raise ValueError("Model name cannot be empty.")
    model = model.strip()
    list_key = f"{provider}_models"
    if list_key not in DEFAULTS:
        raise ValueError(f"Unknown provider: {provider}")

    current = load_settings()
    models = list(current.get(list_key) or [])
    if model not in models:
        models.append(model)
    current[list_key] = models
    return save_settings({list_key: models})


def remove_model(provider: str, model: str) -> dict:
    """Remove a model from the provider's list (cannot remove if it's the active one)."""
    list_key = f"{provider}_models"
    active_key = f"{provider}_model"
    if list_key not in DEFAULTS:
        raise ValueError(f"Unknown provider: {provider}")

    current = load_settings()
    if current.get(active_key) == model:
        raise ValueError("Cannot remove the active model — switch first.")

    models = [m for m in (current.get(list_key) or []) if m != model]
    current[list_key] = models
    return save_settings({list_key: models})


# ─── Key tests ───────────────────────────────────────────────────────────


def test_elevenlabs_key(api_key: str) -> dict:
    """Hit the ElevenLabs /user endpoint to confirm the key works."""
    if not api_key or not api_key.strip():
        return {"ok": False, "error": "API key is empty."}
    try:
        res = requests.get(
            "https://api.elevenlabs.io/v1/user",
            headers={"xi-api-key": api_key.strip()},
            timeout=15,
        )
    except requests.RequestException as e:
        return {"ok": False, "error": f"Network error: {e}"}

    if res.status_code == 200:
        try:
            data = res.json()
        except ValueError:
            data = {}
        return {
            "ok": True,
            "user": data.get("first_name") or data.get("xi_api_key", ""),
            "subscription": (data.get("subscription") or {}).get("tier", ""),
        }
    if res.status_code in (401, 403):
        return {"ok": False, "error": "Key rejected (401/403). Check the key value."}
    return {"ok": False, "error": f"HTTP {res.status_code}: {res.text[:200]}"}


def test_gemini_key(api_key: str, model: Optional[str] = None) -> dict:
    """Verify a Gemini key by calling the lightweight generate endpoint."""
    if not api_key or not api_key.strip():
        return {"ok": False, "error": "API key is empty."}

    model = (model or "gemini-2.0-flash").strip()
    api_key = api_key.strip()
    url = (
        "https://generativelanguage.googleapis.com/v1beta/models/"
        f"{model}:generateContent?key={api_key}"
    )
    body = {
        "contents": [{"parts": [{"text": "ping"}]}],
        "generationConfig": {"maxOutputTokens": 4, "temperature": 0},
    }
    try:
        res = requests.post(url, json=body, timeout=20)
    except requests.RequestException as e:
        return {"ok": False, "error": f"Network error: {e}"}

    if res.status_code == 200:
        try:
            data = res.json()
            txt = (
                (data.get("candidates") or [{}])[0]
                .get("content", {})
                .get("parts", [{}])[0]
                .get("text", "")
            )
        except (ValueError, IndexError, AttributeError):
            txt = ""
        return {"ok": True, "model": model, "sample": txt.strip()[:50]}
    if res.status_code in (400, 401, 403):
        return {
            "ok": False,
            "error": f"Key/model rejected (HTTP {res.status_code}). {res.text[:200]}",
        }
    return {"ok": False, "error": f"HTTP {res.status_code}: {res.text[:200]}"}
