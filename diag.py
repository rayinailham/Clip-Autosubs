from youtube_transcript_api import YouTubeTranscriptApi
import yt_dlp

print("--- YouTubeTranscriptApi ---")
print([m for m in dir(YouTubeTranscriptApi) if not m.startswith("_")])

print("\n--- yt-dlp test ---")
try:
    with yt_dlp.YoutubeDL({"cookiesfrombrowser": "edge", "quiet": True}) as ydl:
        # Trigger the browser spec parsing
        from yt_dlp.utils import _parse_browser_specification
        spec = ydl.params.get("cookiesfrombrowser")
        print(f"Testing spec: {spec}")
        try:
            # This is likely what yt-dlp does internally
            if isinstance(spec, str):
                # If they do *spec on a string, it unpacks characters
                print(f"Unpacked string: {list(spec)}")
            _parse_browser_specification(*spec)
            print("Direct call with string succeeded")
        except TypeError as te:
            print(f"Direct call with string failed: {te}")
except Exception as e:
    print(f"yt-dlp setup failed: {e}")

print("\n--- youtube_transcript_api test ---")
try:
    API = YouTubeTranscriptApi()
    print("Instance created")
    # Don't actually call network, just check if method is bound
    print(f"Instance list method: {API.list}")
except Exception as e:
    print(f"API test failed: {e}")
