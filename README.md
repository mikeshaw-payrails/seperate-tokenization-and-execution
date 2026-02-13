# Payrails Card Tokenization Demo

Minimal Flask app that serves a Payrails card element for tokenization and sends the token to a backend that triggers a workflow execution.

## Prerequisites
- Python 3.10+
- Poetry
- Node.js (for frontend build)

## Setup
1. Copy `.env.example` to `.env` and fill in your Payrails values.
2. Install Python deps:
   ```bash
   poetry install
   ```
3. Install frontend deps:
   ```bash
   npm install
   ```
4. Build frontend assets:
   ```bash
   npm run build
   ```

## Run
```bash
poetry run python app.py
```
Then open `http://localhost:5000`.

## Notes
- The Payrails client init and execution endpoints are called server-side.
- The backend fetches and caches OAuth tokens internally for Payrails API calls and will error if OAuth envs are missing.
- Update `PAYRAILS_INIT_EXTRA_JSON` and `PAYRAILS_EXECUTION_EXTRA_JSON` to add any required fields.
