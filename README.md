# Smart Produce Guardian: software

A crate-mounted ESP32 logs handling (accelerometer) and environment (temp, humidity, gas) together; this repo is everything that talks to it.

| Layer | Where |
|---|---|
| Firmware (ESP32, SD-buffered, offline fan control) | `firmware/guardian/` (untested on hardware) |
| Backend (Node 22.5+, no dependencies, SQLite) | `lib/guardian.js` |
| Frontend (login + dashboard, served by the backend) | `views/login.html`, `views/dashboard.html` |
| Device stand-in for development | `simulator.js` |
| Tests | `test/api.test.js` (`npm test`) |
| Container | `Dockerfile` |

## Run locally
```
npm start                                   # first run prints a one-time admin password (or set ADMIN_PASSWORD)
node cli.js create-device crate-3        # prints the device key once (profiles: delicate | standard | sturdy)
npm run simulate -- --key pg_xxxx           # fake farm -> market trip
```
Open http://localhost:3000 and sign in as `admin`. More users: `PASSWORD='at least 10 chars' node cli.js create-user alice`.

Env: `PORT`, `DB_PATH` (local file DB), `TURSO_DATABASE_URL` + `TURSO_AUTH_TOKEN` (hosted DB, required on Vercel), `ADMIN_PASSWORD`, `NODE_ENV=production` (Secure cookies), `TELEGRAM_TOKEN` + `TELEGRAM_CHAT_ID` (phone alerts for watch/alert events).

## Security model
- Dashboard + API need a login (scrypt-hashed passwords, 7-day HttpOnly SameSite=Strict session cookie, login rate limit, JSON-only mutations).
- Devices authenticate with their own key (`x-device-key`); only its SHA-256 is stored. The device's identity comes from the key, never from the request body. Keys can be rotated in Settings > Devices.
- Not covered: HTTPS (terminate TLS at your host/proxy), password reset UI, per-user permissions (every user is an admin).

## Device -> server: `POST /api/ingest`
Header `x-device-key`. Send the SD backlog in batches; duplicates (same device + timestamp) are ignored.
```json
{ "trip": "trip-1791115300",
  "readings": [{ "ts": 1791115300000, "temp": 6.1, "hum": 68, "gas": 190, "load": 212.0, "fan": 0 }],
  "events": [
    { "kind": "handling", "ts": 1791115300500, "g": 7.2, "duration_ms": 210, "type": "drop|jolt|impact", "trace": [18,19,70,92,40,20], "load_kg": 212 },
    { "kind": "checkpoint", "ts": 1791115290000, "tag": "load|transit|unload|end" } ] }
```
`ts` = epoch ms. The response carries the current `thresholds`; the firmware stores them. The server derives stage per event (from the latest NFC checkpoint), range-crossing events, fan on/off events and alerts, and drops impacts shorter than `min_ms`.

## Load-aware shock limits
Effective limit = `g_watch|g_alert` x produce-profile scale (delicate 0.6, standard 1, sturdy 1.6) x clamp(`ref_kg`/load, 0.75, 1.25). **These factors are assumptions**, not measured values: calibrate with drop tests per produce type, then edit `PROFILES` / `effectiveShock` in `lib/guardian.js`.

## Deploy
**Vercel** (needs a hosted database, because functions have no persistent disk):
1. `vercel integration add tursocloud/database` (accepts Turso's terms; injects `TURSO_DATABASE_URL` / `TURSO_AUTH_TOKEN`), or create a Turso DB yourself and add both as env vars.
2. `vercel env add ADMIN_PASSWORD production` (first-run admin; ignored once a user exists).
3. `vercel deploy --prod`. Create devices from the dashboard (Settings > Devices) and put the key and the `https://<your-app>.vercel.app/api/ingest` URL in the firmware.

**Docker / Railway / any host with a disk**: `docker build -t guardian . && docker run -p 3000:3000 -v guardian-data:/data -e ADMIN_PASSWORD=... guardian`.

## Known limits
- The MQ135 gas value is a relative index (100 = clean air at boot), not ppm.
- Dashboard is polled every 3 s, not pushed. On Vercel every poll is a function call plus a few DB queries, so leave few tabs open.
- Firmware has never been compiled or run on the real board.
