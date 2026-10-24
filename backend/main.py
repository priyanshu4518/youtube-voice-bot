"""Entry point. Run: uvicorn main:app --reload --port 8000

The code lives in the app/ package; see OPTIMIZATIONS.md for the architecture."""
from app import create_app

app = create_app()
