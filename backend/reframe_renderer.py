"""
VTuber Short Renderer — builds a 9:16 vertical video from a single source clip.

Layout (top-to-bottom):
  ┌───────────────┐
  │  Gameplay     │  ← top 40%  (user-defined crop/zoom)
  ├───────────────┤
  │  Avatar       │  ← bottom 60% (user-defined crop/zoom)
  └───────────────┘

Pan values are percentages (−100 … +100) of the maximum possible pan range
at the current zoom level.  Zoom 1.0 = "cover" fill; higher values zoom in
further, shrinking the visible area.
"""

import subprocess
from pathlib import Path

from renderer import get_video_info


# ──────────────────────────────────────────────────────────────
# Crop maths
# ──────────────────────────────────────────────────────────────

def _compute_crop(
    src_w: int, src_h: int,
    out_w: int, out_h: int,
    zoom: float,
    pan_x_pct: float,  # −100 … +100
    pan_y_pct: float,
) -> tuple[int, int, int, int]:
    """
    Return (crop_x, crop_y, crop_w, crop_h) in source pixels.

    Algorithm
    ---------
    1. "Cover" base crop — find the largest rectangle with aspect
       out_w/out_h that fits entirely within the source frame,
       centred on (src_w/2, src_h/2).
    2. Apply zoom — shrink the crop by 1/zoom (zoom in on the centre).
    3. Apply pan — shift the crop centre by (pan_pct/100) × max_shift,
       where max_shift is the distance from the centre to the edge
       of the source minus half the crop size.
    4. Clamp so the crop stays inside the source.
    """
    zoom = max(1.0, zoom)
    section_aspect = out_w / out_h

    # ── 1. Base "cover" crop at zoom=1 ──────────────────────
    if src_w / src_h >= section_aspect:
        # Source is wider → constrain by source height
        base_ch = float(src_h)
        base_cw = base_ch * section_aspect
    else:
        # Source is taller → constrain by source width
        base_cw = float(src_w)
        base_ch = base_cw / section_aspect

    # ── 2. Zoom ─────────────────────────────────────────────
    crop_w = base_cw / zoom
    crop_h = base_ch / zoom

    # ── 3. Pan ──────────────────────────────────────────────
    # Maximum shift = half-source minus half-crop (edges cannot go outside)
    max_pan_x = (src_w - crop_w) / 2.0
    max_pan_y = (src_h - crop_h) / 2.0

    center_x = src_w / 2.0 + (pan_x_pct / 100.0) * max_pan_x
    center_y = src_h / 2.0 + (pan_y_pct / 100.0) * max_pan_y

    crop_x = center_x - crop_w / 2.0
    crop_y = center_y - crop_h / 2.0

    # ── 4. Clamp ─────────────────────────────────────────────
    crop_x = max(0.0, min(crop_x, src_w - crop_w))
    crop_y = max(0.0, min(crop_y, src_h - crop_h))

    return int(crop_x), int(crop_y), int(crop_w), int(crop_h)


# ──────────────────────────────────────────────────────────────
# Main render function
# ──────────────────────────────────────────────────────────────

def render_vtuber_short(
    video_path: str,
    output_path: str,
    top_zoom: float = 1.0,
    top_pan_x: float = 0.0,
    top_pan_y: float = 0.0,
    bottom_zoom: float = 1.0,
    bottom_pan_x: float = 0.0,
    bottom_pan_y: float = 0.0,
    out_width: int = 1080,
    out_height: int = 1920,
    crf: int = 18,
    preset: str = "medium",
    progress_cb=None,
) -> str:
    """
    Render a vertical VTuber short from a single source video.

    Parameters
    ----------
    video_path   : source video file
    output_path  : destination .mp4
    top_*        : crop/zoom params for gameplay section (top 40%)
    bottom_*     : crop/zoom params for avatar section (bottom 60%)
    out_width/height : final canvas size (default 1080×1920)
    """
    video_path = Path(video_path).resolve()
    output_path = Path(output_path).resolve()
    output_path.parent.mkdir(parents=True, exist_ok=True)

    if not video_path.exists():
        raise FileNotFoundError(f"Video not found: {video_path}")

    # ── Source dimensions ────────────────────────────────────
    info = get_video_info(str(video_path))
    src_w, src_h = info["width"], info["height"]

    # ── Section heights ──────────────────────────────────────
    top_h    = int(out_height * 0.40)   # gameplay  (top  40 %)
    bottom_h = out_height - top_h       # avatar    (bot  60 %)

    if progress_cb:
        progress_cb(f"Source: {src_w}×{src_h}  →  output: {out_width}×{out_height}")

    # ── Crop parameters ──────────────────────────────────────
    tx, ty, tw, th = _compute_crop(
        src_w, src_h, out_width, top_h,
        top_zoom, top_pan_x, top_pan_y,
    )
    bx, by, bw, bh = _compute_crop(
        src_w, src_h, out_width, bottom_h,
        bottom_zoom, bottom_pan_x, bottom_pan_y,
    )

    if progress_cb:
        progress_cb(
            f"Top crop: {tw}×{th} @ ({tx},{ty})  "
            f"Bot crop: {bw}×{bh} @ ({bx},{by})"
        )

    # ── FFmpeg filter graph ──────────────────────────────────
    # Two independent crop+scale chains, then vstack.
    filter_complex = (
        f"[0:v]crop={tw}:{th}:{tx}:{ty},"
        f"scale={out_width}:{top_h}[top];"
        f"[0:v]crop={bw}:{bh}:{bx}:{by},"
        f"scale={out_width}:{bottom_h}[bot];"
        f"[top][bot]vstack=inputs=2[out]"
    )

    cmd = [
        "ffmpeg", "-y",
        "-i", str(video_path),
        "-filter_complex", filter_complex,
        "-map", "[out]",
        "-map", "0:a?",          # optional audio (won't fail if absent)
        "-c:v", "libx264",
        "-crf", str(crf),
        "-preset", preset,
        "-c:a", "aac",
        "-b:a", "192k",
        "-movflags", "+faststart",
        str(output_path),
    ]

    print(f"[reframe] Command:\n  {' '.join(cmd)}")
    if progress_cb:
        progress_cb("Running FFmpeg…")

    result = subprocess.run(cmd, capture_output=True, text=True, timeout=900)

    if result.returncode != 0:
        err = result.stderr[-1000:] if result.stderr else "Unknown error"
        raise RuntimeError(f"FFmpeg reframe failed:\n{err}")

    if not output_path.exists():
        raise RuntimeError("FFmpeg completed but output file was not created")

    size_mb = output_path.stat().st_size / (1024 * 1024)
    msg = f"Done! {output_path.name}  ({size_mb:.1f} MB)"
    print(f"[reframe] {msg}")
    if progress_cb:
        progress_cb(msg)

    return str(output_path)
