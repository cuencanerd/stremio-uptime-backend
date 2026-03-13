# Stremio Uptime Monitor — Backend

Checks 5 Stremio addon manifest endpoints every 30 seconds and stores 48 hours of hourly history.

## API Endpoints

- `GET /api/status` — full status + 48h history for all addons
- `GET /api/health` — health check

## Deploy to Railway

1. Push this folder to a GitHub repo
2. Connect repo to Railway
3. Railway auto-detects Node.js and runs `npm start`
4. Copy the Railway public URL and paste it into the frontend config
