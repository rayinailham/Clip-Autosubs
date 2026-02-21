import json
import glob

files = glob.glob('outputs/yt_10_*_transcription.json')
if not files:
    print("No files found!")
else:
    file = files[0]
    with open(file, 'r', encoding='utf-8') as f:
        data = json.load(f)
    print(len(data['words']))
    print(len(data['groups']))
    print(data['groups'][:2])
