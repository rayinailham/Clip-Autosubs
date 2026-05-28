"""
Central logging — rich-based, color-tagged, module-aware.

Every backend module imports `get_logger(__name__)` and gets a Logger instance
that prints structured, colorful, timestamped entries via Rich. Designed so the
terminal that runs `python run.py` shows everything happening end-to-end:
transcription, refine, render, FFmpeg, YT clipping, HTTP requests, etc.

Public API:
    get_logger(name)     -> logging.Logger
    print_banner(...)    -> pretty startup banner
    install_uvicorn()    -> route uvicorn loggers through Rich
    log_dict             -> {tag: color} table used to colorize module tags
"""

from __future__ import annotations

import logging
import os
import sys
from typing import Optional

from rich.console import Console
from rich.logging import RichHandler
from rich.panel import Panel
from rich.table import Table
from rich.text import Text
from rich.theme import Theme


# ─── Console ─────────────────────────────────────────────────
# Force UTF-8 stdout on Windows so emoji / box chars don't blow up.
if sys.stdout.encoding and sys.stdout.encoding.lower() != "utf-8":
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
        sys.stderr.reconfigure(encoding="utf-8")  # type: ignore[attr-defined]
    except Exception:
        pass

_THEME = Theme(
    {
        "logging.level.debug": "dim cyan",
        "logging.level.info": "bold cyan",
        "logging.level.warning": "bold yellow",
        "logging.level.error": "bold red",
        "logging.level.critical": "bold white on red",
        "tag.app": "bold magenta",
        "tag.transcribe": "bold green",
        "tag.refine": "bold blue",
        "tag.render": "bold yellow",
        "tag.html": "bold yellow",
        "tag.reframe": "bold magenta",
        "tag.yt": "bold red",
        "tag.trim": "bold cyan",
        "tag.settings": "dim white",
        "tag.http": "bold cyan",
        "tag.uvicorn": "dim cyan",
        "tag.default": "white",
        "ok": "bold green",
        "fail": "bold red",
        "muted": "dim white",
        "url": "underline cyan",
    }
)

console = Console(theme=_THEME, force_terminal=True, log_path=False)

# Map module short name → rich style key. Anything not listed → tag.default.
TAG_STYLES = {
    "app":              "tag.app",
    "transcribe":       "tag.transcribe",
    "refine":           "tag.refine",
    "renderer":         "tag.render",
    "html_renderer":    "tag.html",
    "reframe_renderer": "tag.reframe",
    "yt_clipper":       "tag.yt",
    "trim":             "tag.trim",
    "settings":         "tag.settings",
    "http":             "tag.http",
}


def _short_name(name: str) -> str:
    """Reduce 'backend.transcribe' / '__main__' / 'app' to a single tag word."""
    if not name:
        return "app"
    last = name.rsplit(".", 1)[-1]
    if last in ("__main__", "app"):
        return "app"
    return last


class _TaggedFormatter(logging.Formatter):
    """Adds a colorized [tag] prefix to every record's message."""

    def format(self, record: logging.LogRecord) -> str:
        tag = _short_name(record.name)
        style = TAG_STYLES.get(tag, "tag.default")
        # Rich markup is rendered by RichHandler.
        record.msg = f"[{style}]\\[{tag}][/] {record.getMessage()}"
        record.args = ()  # already interpolated above
        return super().format(record)


_HANDLER: Optional[RichHandler] = None
_CONFIGURED = False


def _build_handler() -> RichHandler:
    global _HANDLER
    if _HANDLER is not None:
        return _HANDLER
    handler = RichHandler(
        console=console,
        show_time=True,
        show_level=True,
        show_path=False,
        markup=True,
        rich_tracebacks=True,
        tracebacks_show_locals=False,
        omit_repeated_times=False,
        log_time_format="[%H:%M:%S]",
    )
    handler.setFormatter(_TaggedFormatter("%(message)s"))
    _HANDLER = handler
    return handler


def _configure_root() -> None:
    global _CONFIGURED
    if _CONFIGURED:
        return
    root = logging.getLogger()
    # Wipe any handlers uvicorn / fastapi may have installed.
    for h in list(root.handlers):
        root.removeHandler(h)
    root.addHandler(_build_handler())
    level_name = os.environ.get("CLIP_LOG_LEVEL", "INFO").upper()
    root.setLevel(getattr(logging, level_name, logging.INFO))
    _CONFIGURED = True


def get_logger(name: str) -> logging.Logger:
    """Return a logger that uses the shared Rich handler."""
    _configure_root()
    return logging.getLogger(name)


def install_uvicorn() -> None:
    """Route uvicorn / fastapi / asyncio loggers through the Rich handler."""
    _configure_root()
    targets = (
        "uvicorn",
        "uvicorn.error",
        "uvicorn.access",
        "fastapi",
        "asyncio",
        "watchfiles",
    )
    handler = _build_handler()
    for n in targets:
        lg = logging.getLogger(n)
        lg.handlers = [handler]
        lg.propagate = False
        # uvicorn.access at INFO is the per-request line — we want it.
        lg.setLevel(logging.INFO)


def print_banner(title: str, subtitle: str, url: str, extras: Optional[dict] = None) -> None:
    """Render a wide startup panel summarising the runtime."""
    _configure_root()
    grid = Table.grid(padding=(0, 2))
    grid.add_column(justify="right", style="muted")
    grid.add_column(style="bold white")
    grid.add_row("URL", f"[url]{url}[/]")
    if extras:
        for k, v in extras.items():
            grid.add_row(k, str(v))

    body = Table.grid(padding=(0, 0))
    body.add_row(Text(subtitle, style="dim cyan"))
    body.add_row("")
    body.add_row(grid)

    panel = Panel(
        body,
        title=f"[bold cyan]{title}[/]",
        border_style="cyan",
        padding=(1, 4),
    )
    console.print(panel)


__all__ = [
    "console",
    "get_logger",
    "install_uvicorn",
    "print_banner",
]
