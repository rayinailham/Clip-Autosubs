import yt_dlp
import sys
from pathlib import Path

def refresh_cookies():
    # We'll try common browsers on Windows
    browsers = ["edge", "chrome", "brave", "firefox"]
    output_path = Path("cookies.txt")
    
    print("--- YouTube Cookie Refresher ---")
    print("This will attempt to extract fresh cookies from your browser and save them to cookies.txt")
    
    success = False
    for browser in browsers:
        print(f"Trying to extract from {browser}...")
        try:
            # yt-dlp's internal cookie jar is a MozillaCookieJar subclass that can save to file
            ydl_opts = {
                "cookiesfrombrowser": (browser,),
                "quiet": True,
                "no_warnings": True,
            }
            
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # To trigger the extraction, we need to access the cookiejar
                # yt-dlp extracts them during initialization if cookiesfrombrowser is set
                jar = ydl.cookiejar
                
                # Check if we got any youtube cookies
                found_yt = any("youtube.com" in c.domain for c in jar)
                
                if found_yt:
                    jar.save(str(output_path), ignore_discard=True, ignore_expires=True)
                    print(f"SUCCESS! Fresh cookies from {browser} saved to {output_path.resolve()}")
                    success = True
                    break
                else:
                    print(f"No YouTube session found in {browser}.")
                    
        except Exception as e:
            err = str(e)
            if "locked" in err.lower() or "in use" in err.lower():
                print(f"  [Notice] {browser} database is locked (it's likely open). Please close the browser and try again.")
            else:
                print(f"  [Error] {browser}: {err}")
    
    if not success:
        print("\nCould not automatically refresh cookies.")
        print("Please make sure you are logged into YouTube in your browser, close the browser, and try again.")
        print("Alternatively, use the 'Get cookies.txt LOCALLY' browser extension to manually update the file.")
    else:
        print("\nDone! You can now run your project again.")

if __name__ == "__main__":
    refresh_cookies()
