import yt_dlp
opts = {
    "skip_download": True,
    "quiet": False,
    "cookiesfrombrowser": ("edge",)
}
with yt_dlp.YoutubeDL(opts) as ydl:
    print("Testing Edge cookies...")
    try:
        ydl.extract_info("https://www.youtube.com/watch?v=BaW_jenozKc", download=False)
        print("Success Edge.")
    except Exception as e:
        print("Edge failed:", e)

opts["cookiesfrombrowser"] = ("firefox",)
with yt_dlp.YoutubeDL(opts) as ydl:
    print("Testing Firefox cookies...")
    try:
        ydl.extract_info("https://www.youtube.com/watch?v=BaW_jenozKc", download=False)
        print("Success Firefox.")
    except Exception as e:
        print("Firefox failed:", e)
