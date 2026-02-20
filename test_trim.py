import os
import time
from backend.app import _do_trim, TrimRequest
import backend.app

# Setup dummy job tracker and paths
backend.app.trim_jobs = {"test_job": {}}

# Create test video if missing
test_video = "test_video.mp4"
if not os.path.exists(test_video) or not os.path.exists(os.path.join("uploads", test_video)):
    import subprocess
    os.makedirs("uploads", exist_ok=True)
    subprocess.run([
        "ffmpeg", "-y", "-f", "lavfi", "-i", "testsrc=duration=10:size=640x360:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=1000:duration=10",
        "-c:v", "libx264", "-c:a", "aac", os.path.join("uploads", test_video)
    ], check=True)

req = TrimRequest(
    video_filename=test_video,
    trim_start=2.0,
    trim_end=5.5
)

print("Starting trim test...")
start = time.time()
_do_trim("test_job", req)
print(f"Trim finished in {time.time() - start:.2f}s")
print("Job status:", backend.app.trim_jobs["test_job"])
