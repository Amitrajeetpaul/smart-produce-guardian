# Smart Produce Guardian: Blueprint

How the whole system fits together, and how a new box goes from parts on a desk to a crate on a truck.

Status at the time of writing: the software (backend, dashboard, tests, Vercel deployment) is built and tested with a simulator. The **firmware and the physical box have never been built or run**; everything about them below follows the spec and is untested.

---

## 1. The idea

Produce arrives damaged for two different reasons: rough **handling** (drops, jolts) and bad **environment** (heat, humidity, spoilage gas). No cheap tool tracks both, so the cause gets guessed. One small box inside each crate records both on a single timeline, tags each event with the **stage** of the journey it happened in, and lets the owner see the whole trip afterwards (and alerts them during it).

---

## 2. The whole system on one page

```
 IN THE CRATE                                   THE INTERNET                      YOU
┌──────────────────────────┐
│ MPU6050  accelerometer   │──┐
│ DHT22    temp + humidity │  │
│ MQ135    gas index       │  │   ┌─────────┐   HTTPS POST        ┌───────────────────┐   ┌────────────┐
│ HX711    load cell (kg)  │──┼──▶│  ESP32  │──/api/ingest───────▶│ Vercel function   │──▶│ Turso (DB) │
│ RC522    NFC checkpoints │  │   │ (brain) │  + device key       │ lib/guardian.js   │   └────────────┘
│ DS3231   clock           │──┘   └────┬────┘◀── "OK" + current   └─────────▲─────────┘
└──────────────────────────┘           │         thresholds                  │ polls every 3 s
        │                         ┌────▼────┐                       ┌────────┴────────┐
        └──── fan (relay) ◀───────│ SD card │                       │ Dashboard (web) │  phone / laptop
              runs locally        │ buffer  │                       └─────────────────┘
                                  └─────────┘
```

Three rules that explain most of the design:

1. **The box pushes; nothing connects in to it.** It works behind any Wi-Fi or hotspot.
2. **SD card first, network second.** Every reading is written to the SD card, then shipped. Losing Wi-Fi in a truck loses nothing.
3. **The fan is decided on the box**, not by the server, so the box protects the produce even when offline.

---

## 3. What each part does

### 3.1 Box (ESP32 firmware) — `firmware/guardian/`
| Job | How |
|---|---|
| Handling detection | Samples the accelerometer at ~200 Hz. A candidate hit starts above 1.5 g deviation from resting; it logs peak g, duration and a short trace. Hits shorter than `min_ms` are dropped (Iteration 2: vibration is not an impact). |
| Environment | Every 2 s: temperature, humidity, gas index, load (kg). |
| Fan | Turns on when any reading passes its "watch" line, off with hysteresis (0.5 °C, 2 % RH, 30 index) so the relay does not chatter. Uses the thresholds from the last successful sync. |
| Stage | NFC tag taps log a `checkpoint` (load / transit / unload / end). |
| Buffering | Appends every record to `/pending.ndj` on the SD card, with a cursor file marking what the server has confirmed. |
| Sync | Every 10 s, if Wi-Fi is up: send the backlog (≤ 6 KB per batch), advance the cursor only on HTTP 200, store the thresholds from the reply. |

The gas value is a **relative index** (100 = clean air measured at power-on), not ppm.

### 3.2 Backend — `lib/guardian.js` (logic), `cli.js` (local server + CLI), `api/index.js` (Vercel entry)
- **Ingest** (`POST /api/ingest`): authenticates the device by its key, then in one transaction stores readings and events, and derives:
  - the **stage** of each event (from the latest checkpoint before it),
  - **range events** ("temperature above watch line", "back in range after N s"),
  - **fan on/off events**,
  - the **severity** of each hit (see 6),
  - **alerts** (Telegram, if configured) for fresh watch/alert events.
- **Read side**: `/api/state`, `/api/events/:id`, `/api/trips`, `/api/devices`, `/api/thresholds`.
- **Auth**: password login with a session cookie for people; per-device keys for boxes.
- **Storage**: libSQL: a local file in development, Turso when deployed.

### 3.3 Dashboard — `views/dashboard.html`, `views/login.html`
Phone-first single page: **Home** (status, tiles, latest hit), **Timeline** (all events, filter by type, trip picker), **Event detail** (severity meter, trace graph), **Settings** (thresholds, devices, sign out). It polls the server every 3 s and never talks to the box.

### 3.4 Simulator — `simulator.js`
Pretends to be a box: scripted farm → transit → market trip, same messages, same SD-style buffering. Lets you see everything working with no hardware.

---

## 4. The message between box and server

`POST /api/ingest` with header `x-device-key: pg_…`
```json
{ "trip": "trip-1791115300",
  "readings": [{ "ts": 1791115300000, "temp": 6.1, "hum": 68, "gas": 190, "load": 212.0, "fan": 0 }],
  "events": [
    { "kind": "handling", "ts": 1791115300500, "g": 7.2, "duration_ms": 210, "type": "drop", "trace": [18,19,70,92,40,20], "load_kg": 212 },
    { "kind": "checkpoint", "ts": 1791115290000, "tag": "load" } ] }
```
- `ts` is epoch milliseconds from the box's clock. `tag` is `load`, `transit`, `unload` or `end`.
- The reply carries the current thresholds; the box saves them.
- Re-sending the same data is harmless (duplicates are ignored per device + timestamp).
- The device's identity comes from the key, never from the body.

---

## 5. Adding a new box, start to finish

### Step 1: Register it (dashboard, 2 min)
Settings → Devices → type a name (e.g. `crate-4`) → Add → **copy the key (shown once)** → choose the produce type. "New key" replaces a lost key and kills the old one.

### Step 2: Build the unit
Parts: ESP32 dev board, MPU6050, DS3231, DHT22, MQ135, HX711 + load cell, RC522, SD module + card, 5 V fan + relay, Li-ion battery + charger module, enclosure. Pin map: `firmware/guardian/config.h`.

Wiring gotchas:
- MPU6050 and DS3231 both default to I²C address 0x68. **Tie the MPU6050 AD0 pin to 3.3 V** (the firmware uses 0x69).
- MQ135 output reaches 5 V: use a **voltage divider**, and an **ADC1 pin (34)**; ADC2 stops working while Wi-Fi is on.
- The relay board may be active-low; invert the `digitalWrite` if the fan runs backwards.
- Mount the board **rigidly, centred at the base of the crate** (Iteration 4: placement changes readings).

### Step 3: Flash the firmware
1. Arduino IDE, board "ESP32 Dev Module", install the libraries listed at the top of `guardian.ino`.
2. Edit `config.h`: `WIFI_SSID` / `WIFI_PASS` (a phone hotspot is fine), `SERVER_URL` = `https://smart-produce-guardian.vercel.app/api/ingest`, `DEVICE_KEY` = the key from step 1.
3. Upload. The same firmware goes on every box; only `DEVICE_KEY` differs.

### Step 4: Calibrate (once per unit)
- **Load cell:** power on with the crate **empty** (it zeroes at boot), put a known weight on, adjust `LOAD_SCALE` until kg match.
- **Gas baseline:** power on in **clean air**. The first 30 s warm the MQ135, then "clean air" becomes index 100.

### Step 5: Tag the checkpoints (once for the whole fleet)
Tap each NFC tag on the reader, read its UID from the serial monitor ("unknown tag AA:BB:CC:DD"), put four UIDs in the `TAGS` list in `config.h`, stick the tags at: loading bay, truck, market dock, drop-off. All boxes share the same tags.

### Step 6: Acceptance test
| Do this | Expect |
|---|---|
| Power on | Serial shows "trip …"; device shows "seen Ns ago" in Settings → Devices |
| Tap a tag | A `Checkpoint: …` event on the Timeline |
| Drop the box a few cm | A handling event with a g value and duration |
| Blow warm air on the DHT22 / MQ135 | An environment event, fan switches on, then "back in range" |
| Turn Wi-Fi off 1 min, back on | Backlog appears with no gaps |

### Step 7: Every trip
Switching the box on starts a new trip id. Tap **load** at the farm, **transit** when the truck leaves, **unload** at the market, **end** at drop-off. Review afterwards on the Timeline: each event shows its stage.

---

## 6. Load-aware shock sensitivity

The same knock should count differently for berries and potatoes.

```
effective limit = base limit (g_watch / g_alert)
                × produce scale   (Delicate 0.6, Standard 1.0, Sturdy 1.6)
                × clamp(ref_kg / load_kg, 0.75, 1.25)
```
Defaults: `g_watch` 3 g, `g_alert` 6 g, `ref_kg` 200 kg. Example: a 4 g hit on a delicate 200 kg crate has limits 1.8 / 3.6 g → **Severe**; on sturdy produce limits are 4.8 / 9.6 g → **Minor**.

**These factors are assumptions, not measurements.** Calibrate with drop tests per produce type, then edit `PROFILES` and `effectiveShock` in `lib/guardian.js`.

---

## 7. Headline status

The big status on Home is the worst of: temperature, humidity, gas (current reading vs thresholds) and any watch/alert impact in the last 10 minutes of the trip. The Timeline shows every event; "Worst so far" shows the trip's peak.

---

## 8. Seeing it with no hardware (at home)

Add a device in the dashboard, copy its key, then:
```
npm run simulate -- --url https://smart-produce-guardian.vercel.app --key pg_YOUR_KEY --tick 1000
```
A full trip takes ~2 minutes at `--tick 1000` (about 5 minutes at the default 2500 ms). Watch Home and Timeline update: stage changes, temperature and gas climbing, the fan switching on, jolts and drops, the status turning Alert. To stay off the live database, run `npm start` and use `--url http://localhost:3000` (or whichever `PORT` you set) with a key from `node cli.js create-device demo-crate`.

---

## 9. Run, test, deploy

| Task | Command |
|---|---|
| Run locally | `npm start` (first run prints a one-time `admin` password, or set `ADMIN_PASSWORD`) |
| Create device from terminal | `node cli.js create-device crate-3 [delicate\|standard\|sturdy]` |
| Create / reset a user | `PASSWORD='10+ chars' node cli.js create-user alice` |
| Tests (10, spawn a real server on a throwaway DB) | `npm test` |
| Deploy to Vercel | `vercel deploy --prod` (needs `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_PASSWORD` set in the project) |
| Docker / Railway | `Dockerfile` (stores the DB in `/data`) |

Environment variables: `PORT`, `DB_PATH` (local file DB), `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `ADMIN_PASSWORD`, `NODE_ENV`, `TELEGRAM_TOKEN`, `TELEGRAM_CHAT_ID`.

Vercel notes: functions have no persistent disk, hence Turso. Do not name root files `app.js` / `server.js` / `index.js`: Vercel treats them as the entry point. `vercel.json` sets `"framework": null` and rewrites every path to `api/index.js`.

---

## 10. Security model

- Dashboard and API need a login: scrypt-hashed passwords, 7-day HttpOnly SameSite=Strict cookie, Secure when on HTTPS, login rate limit (10 tries / 10 min per IP, stored in the DB), JSON-only mutations.
- Boxes authenticate with their own key; only its SHA-256 is stored. Keys can be rotated.
- Security headers and a strict CSP are set on every response.
- Not covered: per-user permissions (everyone is an admin), a password-change screen, password reset, device deletion.

---

## 11. Known limits and open decisions

| Item | State |
|---|---|
| Firmware | Written, **never compiled or run on hardware** |
| HTTPS on the box | Currently skips certificate checking (`setInsecure()`); pin the real CA before real use |
| Gas reading | Relative index, not ppm; needs warm-up and clean-air boot |
| Load cell | Zeroes at power-on; a mid-trip reboot of a loaded box gives wrong weights |
| Thresholds | One global set for all boxes; only the produce type is per box |
| Load-aware factors | Assumed, need drop-test calibration |
| Dashboard updates | Polled every 3 s, not pushed (each open tab costs function calls on Vercel) |
| Telegram alerts | Implemented, never tested with a real bot token |
| Device management | No delete or rename |
| Lab report | Still describes an LCD + buzzer design that the final spec dropped |

---

## 12. File map

```
BLUEPRINT.md              this document
README.md                 quick start
lib/guardian.js           backend logic: ingest, rules, auth, API
cli.js                    local server + create-user / create-device
api/index.js              Vercel entry point
views/dashboard.html      the app (all screens)
views/login.html          sign-in page
simulator.js              fake box for development
test/api.test.js          automated tests
firmware/guardian/        ESP32 firmware + config.h + wiring notes
vercel.json  Dockerfile   deployment config
produce-guardian-project-report.md-2.pdf   original project spec
Smart-Food-Handling-…docx                  lab report (Weeks 1–14)
```
