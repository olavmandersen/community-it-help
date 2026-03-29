# TecIT local backend

This site now supports a simple self-hosted backend for the request forms.

## Stack
- Node.js
- Express
- SQLite (`better-sqlite3`)

## Files
- `server.js` — backend + static file server
- `data/tecit.db` — SQLite database (created automatically)
- `package.json` — dependencies and start script

## Endpoints
- `GET /api/health`
- `POST /api/help-request`
- `POST /api/delete-request`

## Run locally
```bash
cd /home/clawdog/.openclaw/workspace/community-it-help
npm install
npm start
```

Then open:
- `http://localhost:3000`

## Notes
- Requests are stored in SQLite under `data/tecit.db`
- This replaces the old Supabase-based form flow
- If you later want notifications, that can be added on top (email, Discord webhook, etc.)
