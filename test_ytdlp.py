import yt_dlp
from yt_dlp.utils import download_range_func
opts = {
    'quiet': False, 
    'download_ranges': download_range_func(None, [(5, 15)]), 
    'force_keyframes_at_cuts': True
}
with yt_dlp.YoutubeDL(opts) as ydl:
    ydl.download(['https://www.youtube.com/watch?v=jNQXAC9IVRw'])
