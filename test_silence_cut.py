import time
from backend.silence_cutter import cut_video_segments
import subprocess
import os

# Create a 10-second test video
test_video = "test_video.mp4"
if not os.path.exists(test_video):
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=duration=60:size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=60",
        "-c:v", "libx264", "-c:a", "aac", test_video
    ], check=True)

# Generate 250 small segments (e.g. 0.1s each)
segments = []
t = 0.0
while t < 50.0:
    segments.append((t, t + 0.1))
    t += 0.2

print(f"Testing with {len(segments)} segments...")

start = time.time()
cut_video_segments(test_video, segments, "test_output.mp4")
print(f"Finished in {time.time() - start:.2f} seconds.")
