"""
Entrypoint: Run the web server.
Usage: python run.py
"""

import subprocess
import sys
from pathlib import Path

BACKEND_DIR = Path(__file__).resolve().parent / "backend"


def main():
    print("=" * 50)
    print("  Clipping Project — Phase 1")
    print("  http://localhost:8000")
    print("=" * 50)
    try:
        subprocess.run(
            [
                sys.executable, "-m", "uvicorn",
                "app:app",
                "--host", "0.0.0.0",
                "--port", "8000",
                "--reload",
                "--log-level", "warning",
            ],
            cwd=str(BACKEND_DIR),
        )
    except KeyboardInterrupt:
        print("\nServer stopped.")
        sys.exit(0)


if __name__ == "__main__":
    main()
