"""
9Router client — OpenAI-compatible chat gateway.

Replaces the old google-genai dependency. Talks to a local/remote 9Router
instance via POST {base_url}/v1/chat/completions and returns text / parsed JSON.

Default model: kr/claude-sonnet-4.6-thinking (Claude Sonnet 4.6 + Thinking via Kiro).
"""

import json
import os
import random
import re
import time
from typing import Callable, Optional

import requests

from logger import get_logger

log = get_logger("nine_router")


# Base URL + key may come from env, settings, or per-request overrides.
DEFAULT_BASE_URL = (os.environ.get("NINEROUTER_URL") or "http://localhost:20128").rstrip("/")
DEFAULT_API_KEY = os.environ.get("NINEROUTER_KEY", "")
# Non-thinking by default: thinking models emit reasoning inside `content`
# (wrapped in <thinking>), which both burns the token budget and gets stripped
# before the JSON arrives — producing empty/truncated output for big transcripts.
DEFAULT_MODEL = "kr/claude-sonnet-4.6"

# Tried in order when the primary model returns a transient/unavailable error.
# Non-thinking variants first so JSON generation never loses budget to reasoning.
_FALLBACK_MODELS = [
    "kr/claude-sonnet-4.6",
    "kr/claude-haiku-4.5",
    "kr/auto",
]


class NineRouterError(RuntimeError):
    """Error from the 9Router gateway. Carries the HTTP status code when known."""

    def __init__(self, message: str, status_code: Optional[int] = None):
        super().__init__(message)
        self.status_code = status_code
        self.empty_content = False


def _base_url(base_url: Optional[str]) -> str:
    return (base_url or DEFAULT_BASE_URL).rstrip("/")


def _is_transient(status_code: Optional[int], msg: str = "") -> bool:
    """True for 5xx / overloaded / rate-limit errors that warrant retry."""
    if isinstance(status_code, int) and status_code in (429, 500, 502, 503, 504):
        return True
    m = msg.lower()
    return any(
        s in m
        for s in ("503", "unavailable", "overloaded", "deadline", "rate limit", "429", "timed out")
    )


def chat_completion(
    messages: list[dict],
    api_key: str,
    model: str = DEFAULT_MODEL,
    base_url: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: Optional[int] = None,
    json_mode: bool = False,
    timeout: int = 300,
) -> str:
    """
    Single POST to /v1/chat/completions. Returns the assistant message text.
    Raises NineRouterError on non-200 or malformed responses.
    """
    url = f"{_base_url(base_url)}/v1/chat/completions"
    headers = {"Content-Type": "application/json"}
    key = (api_key or DEFAULT_API_KEY).strip()
    if key:
        headers["Authorization"] = f"Bearer {key}"

    body: dict = {
        "model": model,
        "messages": messages,
        "temperature": temperature,
        "stream": False,
    }
    if max_tokens:
        body["max_tokens"] = max_tokens
    if json_mode:
        body["response_format"] = {"type": "json_object"}

    try:
        res = requests.post(url, headers=headers, json=body, timeout=timeout)
    except requests.RequestException as e:
        raise NineRouterError(f"Network error contacting 9Router: {e}") from e

    if res.status_code != 200:
        raise NineRouterError(
            f"HTTP {res.status_code}: {res.text[:400]}", status_code=res.status_code
        )

    try:
        data = res.json()
    except ValueError as e:
        raise NineRouterError(f"9Router returned non-JSON body: {res.text[:300]}") from e

    choices = data.get("choices") or []
    if not choices:
        raise NineRouterError(f"9Router returned no choices: {json.dumps(data)[:300]}")

    content = (choices[0].get("message") or {}).get("content") or ""
    # Some providers return content as a list of parts.
    if isinstance(content, list):
        content = "".join(
            part.get("text", "") for part in content if isinstance(part, dict)
        )

    # Thinking models can burn the entire token budget on hidden reasoning and
    # return empty/whitespace content with finish_reason=length. Treat that as a
    # retryable/fallback-worthy error instead of silently returning "".
    if not content.strip():
        finish = choices[0].get("finish_reason") or "unknown"
        err = NineRouterError(
            f"9Router model '{model}' returned empty content (finish_reason={finish}); "
            f"likely exhausted token budget on reasoning."
        )
        err.empty_content = True
        raise err

    return content


def generate_text(
    messages: list[dict],
    api_key: str,
    model: str = DEFAULT_MODEL,
    base_url: Optional[str] = None,
    temperature: float = 0.3,
    max_tokens: Optional[int] = None,
    json_mode: bool = False,
    progress_cb: Optional[Callable[[str, str], None]] = None,
    max_attempts: int = 5,
    fallback: bool = True,
) -> str:
    """
    chat_completion with exponential backoff on transient errors and fallback
    across _FALLBACK_MODELS when a model stays unavailable.
    """
    model_chain = [model]
    if fallback:
        model_chain += [m for m in _FALLBACK_MODELS if m != model]

    last_err: Optional[Exception] = None
    for m_idx, m in enumerate(model_chain):
        attempts = max_attempts if m_idx == 0 else 2
        for attempt in range(1, attempts + 1):
            try:
                return chat_completion(
                    messages,
                    api_key,
                    model=m,
                    base_url=base_url,
                    temperature=temperature,
                    max_tokens=max_tokens,
                    json_mode=json_mode,
                )
            except NineRouterError as err:
                last_err = err
                empty = getattr(err, "empty_content", False)
                if not empty and not _is_transient(err.status_code, str(err)):
                    raise
                # Empty content won't recover by retrying the SAME model — break
                # out to the fallback chain immediately (next model is non-thinking).
                if empty:
                    if progress_cb:
                        progress_cb("analyze", f"9Router {m} returned empty output — switching model…")
                    log.warning("9Router %s returned empty content — falling through to fallback.", m)
                    break
                backoff = min(2 ** attempt, 32) + random.uniform(0, 1.5)
                if progress_cb:
                    progress_cb(
                        "analyze",
                        f"9Router {m} transient error (attempt {attempt}/{attempts}); retrying in {backoff:.1f}s…",
                    )
                log.warning(
                    "9Router %s transient error attempt %d/%d: %s — retry in %.1fs",
                    m, attempt, attempts, err, backoff,
                )
                time.sleep(backoff)

        if m_idx + 1 < len(model_chain):
            next_m = model_chain[m_idx + 1]
            if progress_cb:
                progress_cb("analyze", f"9Router {m} unavailable — falling back to {next_m}…")
            log.warning("9Router %s unavailable after %d attempts — falling back to %s", m, attempts, next_m)

    raise NineRouterError(
        f"9Router unavailable across all fallback models ({', '.join(model_chain)}). "
        f"Last error: {last_err}"
    )


def _strip_fences(raw: str) -> str:
    raw = raw.strip()
    # Strip reasoning/thinking blocks emitted by *-thinking models. These appear
    # before the JSON and confuse the slicer because they mention keys like
    # 'clips' in prose. Remove them first.
    raw = re.sub(r"<(thinking|think|reasoning)>.*?</\1>", "", raw, flags=re.DOTALL | re.IGNORECASE)
    # Drop an unclosed leading thinking block (model truncated mid-reasoning).
    raw = re.sub(r"^\s*<(thinking|think|reasoning)>.*", "", raw, flags=re.DOTALL | re.IGNORECASE)
    raw = raw.strip()
    raw = re.sub(r"^```(?:json)?\s*", "", raw, flags=re.MULTILINE)
    raw = re.sub(r"\s*```$", "", raw, flags=re.MULTILINE)
    return raw.strip()


def _slice_json(raw: str) -> str:
    """Best-effort: slice from first { or [ to the matching last } or ]."""
    starts = [i for i in (raw.find("{"), raw.find("[")) if i != -1]
    if not starts:
        return raw
    start = min(starts)
    ends = [i for i in (raw.rfind("}"), raw.rfind("]")) if i != -1]
    if not ends:
        return raw
    end = max(ends)
    if end <= start:
        return raw
    return raw[start : end + 1]


def _salvage_truncated(raw: str):
    """
    Recover a TRUNCATED JSON array/object (model hit max_tokens mid-output).
    Walks the array tracking string/escape state, keeps every fully-closed
    element, then closes the array (and `{...}` wrapper) so the complete items
    survive. Handles both bare `[...]` and `{"clips":[...]}` shapes.
    Returns parsed value or None.
    """
    s = raw.strip()
    arr_start = s.find("[")
    if arr_start == -1:
        return None
    wrapper = s[0] == "{"

    depth = 0
    in_str = False
    escape = False
    last_elem_end = None  # index (exclusive) just after the last complete element

    for i in range(arr_start, len(s)):
        ch = s[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch in "[{":
            depth += 1
        elif ch in "]}":
            depth -= 1
            # depth == 1 right after a "}" → an array element just closed cleanly.
            if depth == 1 and ch == "}":
                last_elem_end = i + 1

    if last_elem_end is None:
        return None

    candidate = s[:last_elem_end] + ("]}" if wrapper else "]")
    try:
        return json.loads(candidate)
    except json.JSONDecodeError:
        return None


def generate_json(
    system_prompt: str,
    user_prompt: str,
    api_key: str,
    model: str = DEFAULT_MODEL,
    base_url: Optional[str] = None,
    temperature: float = 0.2,
    max_tokens: Optional[int] = None,
    progress_cb: Optional[Callable[[str, str], None]] = None,
):
    """
    Run a system+user prompt and parse the response as JSON.

    Tries response_format=json_object first; if the model/gateway rejects that
    with a 400 it retries in plain mode and relies on prompt instructions plus
    fence-stripping / JSON slicing to recover the payload.
    """
    messages = [
        {"role": "system", "content": system_prompt},
        {"role": "user", "content": user_prompt},
    ]

    try:
        raw = generate_text(
            messages, api_key, model=model, base_url=base_url,
            temperature=temperature, max_tokens=max_tokens,
            json_mode=True, progress_cb=progress_cb,
        )
    except NineRouterError as err:
        if err.status_code == 400:
            raw = generate_text(
                messages, api_key, model=model, base_url=base_url,
                temperature=temperature, max_tokens=max_tokens,
                json_mode=False, progress_cb=progress_cb,
            )
        else:
            raise

    cleaned = _strip_fences(raw)
    try:
        return json.loads(cleaned)
    except json.JSONDecodeError:
        pass

    sliced = _slice_json(cleaned)
    try:
        return json.loads(sliced)
    except json.JSONDecodeError:
        pass

    # Last resort: the model likely hit max_tokens mid-output. Salvage every
    # fully-closed element from the truncated array.
    salvaged = _salvage_truncated(cleaned)
    if salvaged is not None:
        if progress_cb:
            progress_cb("analyze", "AI response was truncated — recovered complete items.")
        log.warning("9Router response truncated; salvaged %s complete element(s).",
                    len(salvaged.get("clips", salvaged)) if isinstance(salvaged, (dict, list)) else "?")
        return salvaged

    raise NineRouterError(
        f"9Router returned invalid JSON: truncated/unparseable.\nRaw response:\n{cleaned[:1500]}"
    )


def test_key(api_key: str, model: Optional[str] = None, base_url: Optional[str] = None) -> dict:
    """Lightweight ping to confirm the gateway + key + model work."""
    model = (model or DEFAULT_MODEL).strip()
    try:
        txt = chat_completion(
            [{"role": "user", "content": "ping"}],
            api_key,
            model=model,
            base_url=base_url,
            temperature=0,
            max_tokens=8,
        )
        return {"ok": True, "model": model, "sample": txt.strip()[:50]}
    except NineRouterError as e:
        code = e.status_code
        if code in (400, 401, 403):
            return {"ok": False, "error": f"Key/model rejected (HTTP {code}). {e}"}
        return {"ok": False, "error": str(e)}
