import os
import json
from google import genai
from google.genai import types

api_key = os.environ.get("GEMINI_API_KEY")
if not api_key:
    # Try reading from store.js if I can parser it, but let's just use empty string or ask user
    pass

def test_gemini():
    # Make a dummy 330 words transcript
    words = []
    text = "God, that term is so specious. You're preaching to the choir, lady. I'm an all animal lover. Yes dear. You've been hearing the word pet. It was lonely there. " * 30
    for i, w in enumerate(text.split()):
        words.append({"start": i*0.5, "end": i*0.5+0.4, "text": w})

    lines = []
    for i, w in enumerate(words):
        lines.append(f"{i}|{w['start']:.2f}|{w['end']:.2f}|{w['text']}")
    transcript_text = "\n".join(lines)
    
    # Just print the exact lines counting
    print(f"Total words: {len(words)}")
