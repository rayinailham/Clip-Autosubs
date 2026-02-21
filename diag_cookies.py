import yt_dlp
from pathlib import Path
import os

def test_cookies():
    # Attempt to find cookies.txt
    cookie_file = Path("cookies.txt")
    if not cookie_file.exists():
        # Try parent or backend if running from within backend
        cookie_file = Path("../cookies.txt")
    
    if not cookie_file.exists():
        print(f"ERROR: cookies.txt not found! Current dir: {os.getcwd()}")
        return

    print(f"Using cookie file: {cookie_file.resolve()}")
    
    # Test URL (a common one)
    url = "https://www.youtube.com/watch?v=p_aKZ7mQ2W8"
    
    ydl_opts = {
        "cookiefile": str(cookie_file),
        "quiet": False,
        "no_warnings": False,
        # Try to extract info only
        "skip_download": True,
    }
    
    print(f"Attempting to extract info for {url} using cookies...")
    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=False)
            print("\nSUCCESS: Cookies are working and recognized by YouTube.")
            print(f"Video Title: {info.get('title')}")
            print(f"Uploader: {info.get('uploader')}")
    except Exception as e:
        print("\nFAILURE: Could not authenticate with cookies.")
        error_msg = str(e)
        print(f"Error details: {error_msg}")
        
        if "429" in error_msg:
            print("\nCAUSE: Rate Limited (HTTP 429).")
            print("Your IP address is flagged, or the cookies are being ignored/invalid for this request.")
        elif "Sign in" in error_msg or "confirm you're not a bot" in error_msg:
            print("\nCAUSE: Cookies are invalid or expired.")
            print("Action: Refresh your cookies.txt using the 'Get cookies.txt LOCALLY' extension while logged into YouTube.")

if __name__ == "__main__":
    test_cookies()
