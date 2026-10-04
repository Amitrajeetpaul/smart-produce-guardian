// Smart Produce Guardian: request handler + domain logic.
// Runs unchanged as a local Node server (server.js) or a Vercel function (api/index.js).
// Storage: libSQL (SQLite dialect). Local file by default; set TURSO_DATABASE_URL (+ TURSO_AUTH_TOKEN) for a hosted DB.
"use strict";
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { createClient } = require("@libsql/client");

const ON_VERCEL = !!process.env.VERCEL;
const PROD = process.env.NODE_ENV === "production" || ON_VERCEL;
const SESSION_DAYS = 7;
const TG_TOKEN = process.env.TELEGRAM_TOKEN || "";
const TG_CHAT = process.env.TELEGRAM_CHAT_ID || "";
const MAX_BODY = 1 << 20;

// ---- database ----
let DB_LABEL;
function makeClient() {
  const url = process.env.TURSO_DATABASE_URL;
  if (url) { DB_LABEL = url.replace(/\/\/.*@/, "//"); return createClient({ url, authToken: process.env.TURSO_AUTH_TOKEN }); }
  if (ON_VERCEL) throw new Error("TURSO_DATABASE_URL is not set: Vercel has no persistent disk, so a hosted database is required");
  const file = process.env.DB_PATH || path.join(__dirname, "..", "data", "guardian.db");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  DB_LABEL = file;
  return createClient({ url: "file:" + file });
}
const client = makeClient();
const wrap = (ex) => {                                                // same tiny API over the client or a transaction
  const all = async (sql, args = []) => {
    const r = await ex.execute({ sql, args });
    return r.rows.map((row) => Object.fromEntries(r.columns.map((c, i) => [c, row[i]])));
  };
  return {
    all,
    get: async (sql, args) => (await all(sql, args))[0],
    run: async (sql, args = []) => ({ changes: (await ex.execute({ sql, args })).rowsAffected }),
  };
};
const db = wrap(client);

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS readings(
    id INTEGER PRIMARY KEY, device TEXT NOT NULL, trip TEXT NOT NULL, ts INTEGER NOT NULL,
    temp REAL, hum REAL, gas REAL, load REAL, fan INTEGER NOT NULL DEFAULT 0, UNIQUE(device, ts));
  CREATE INDEX IF NOT EXISTS readings_trip ON readings(device, trip, ts);
  CREATE TABLE IF NOT EXISTS events(
    id INTEGER PRIMARY KEY, device TEXT NOT NULL, trip TEXT NOT NULL, ts INTEGER NOT NULL,
    kind TEXT NOT NULL, level TEXT NOT NULL, title TEXT NOT NULL, metric TEXT, value REAL, unit TEXT,
    duration_ms INTEGER, stage TEXT, sev_g REAL, note TEXT, trace TEXT, tag TEXT, g_watch_eff REAL, g_alert_eff REAL,
    UNIQUE(device, ts, kind, title));
  CREATE INDEX IF NOT EXISTS events_trip ON events(device, trip, ts DESC);
  CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value REAL NOT NULL);
  CREATE TABLE IF NOT EXISTS users(username TEXT PRIMARY KEY, pw TEXT NOT NULL, created INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, username TEXT NOT NULL, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS devices(
    name TEXT PRIMARY KEY, key_hash TEXT NOT NULL UNIQUE, produce TEXT NOT NULL DEFAULT 'standard',
    created INTEGER NOT NULL, last_seen INTEGER);
  CREATE TABLE IF NOT EXISTS attempts(ip TEXT PRIMARY KEY, n INTEGER NOT NULL, reset INTEGER NOT NULL);
`;
let ready;
function init() {                                                     // once per process (= once per cold start on Vercel)
  return (ready ||= (async () => {
    if (!process.env.TURSO_DATABASE_URL) await client.execute("PRAGMA journal_mode = WAL");
    await client.executeMultiple(SCHEMA);
    for (const col of ["g_watch_eff REAL", "g_alert_eff REAL"]) {     // migration for DBs created before load-aware thresholds
      try { await client.execute(`ALTER TABLE events ADD COLUMN ${col}`); } catch { /* already there */ }
    }
    if (!(await db.get("SELECT 1 AS x FROM users LIMIT 1"))) {        // first run: make an admin so the dashboard is reachable
      if (process.env.ADMIN_PASSWORD) { await createUser("admin", process.env.ADMIN_PASSWORD); console.log("created user admin (password from ADMIN_PASSWORD)"); }
      else if (ON_VERCEL) console.error("No users exist and ADMIN_PASSWORD is not set: nobody can sign in. Set it and redeploy.");
      else { const pw = crypto.randomBytes(9).toString("base64url"); await createUser("admin", pw); console.log(`created user admin, one-time password: ${pw}`); }
    }
  })().catch((e) => { ready = null; throw e; }));
}

class HttpError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

// ---- thresholds (editable from the dashboard, pulled by the device on every sync) ----
const DEFAULTS = {
  temp_watch: 8, temp_alert: 11, hum_watch: 90, hum_alert: 95, gas_watch: 300, gas_alert: 450,
  g_watch: 3, g_alert: 6, min_ms: 50, ref_kg: 200,
};
const LIMITS = { temp: [-20, 60], hum: [0, 100], gas: [0, 5000], g: [0.1, 16], min_ms: [1, 1000], ref_kg: [1, 5000] };
async function getThresholds(d = db) {
  const out = { ...DEFAULTS };
  for (const r of await d.all("SELECT key, value FROM settings")) if (r.key in out) out[r.key] = r.value;
  return out;
}
async function validateThresholds(patch) {
  const t = { ...(await getThresholds()) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) throw new HttpError(400, `unknown setting ${k}`);
    if (typeof v !== "number" || !Number.isFinite(v)) throw new HttpError(400, `${k} must be a number`);
    t[k] = v;
  }
  for (const m of ["temp", "hum", "gas", "g"]) {
    const [lo, hi] = LIMITS[m];
    for (const k of [`${m}_watch`, `${m}_alert`]) if (t[k] < lo || t[k] > hi) throw new HttpError(400, `${k} out of range ${lo}..${hi}`);
    if (t[`${m}_watch`] >= t[`${m}_alert`]) throw new HttpError(400, `${m}_watch must be below ${m}_alert`);
  }
  for (const k of ["min_ms", "ref_kg"]) if (t[k] < LIMITS[k][0] || t[k] > LIMITS[k][1]) throw new HttpError(400, `${k} out of range`);
  return t;
}

// ---- domain helpers ----
const RANK = { good: 0, watch: 1, alert: 2 };
const lvl = (v, watch, alert) => (v == null ? "good" : v > alert ? "alert" : v > watch ? "watch" : "good");
const worse = (a, b) => (RANK[a] >= RANK[b] ? a : b);
const STAGES = { load: "Loading", transit: "In transit", unload: "Unloading", end: "Delivered" };
const METRICS = {
  temp: { name: "Temperature", unit: "°C" },
  hum: { name: "Humidity", unit: "% RH" },
  gas: { name: "Spoilage gas index", unit: "" },
};
// Load-aware shock sensitivity. Both numbers are ASSUMPTIONS to calibrate with drop tests: delicate produce bruises at
// lower g; a heavier crate stacks more pressure on the bottom layers, so it is treated as more sensitive.
const PROFILES = {
  delicate: { label: "Delicate (berries, tomatoes, grapes)", scale: 0.6 },
  standard: { label: "Standard (apples, citrus)", scale: 1 },
  sturdy: { label: "Sturdy (potatoes, onions, roots)", scale: 1.6 },
};
function effectiveShock(t, produce, loadKg) {
  const prof = PROFILES[produce] || PROFILES.standard;
  const loadF = loadKg > 0 ? Math.min(1.25, Math.max(0.75, t.ref_kg / loadKg)) : 1;
  const f = prof.scale * loadF;
  return { factor: f, g_watch: +(t.g_watch * f).toFixed(2), g_alert: +(t.g_alert * f).toFixed(2) };
}
const SEV_WORD = { good: "Minor", watch: "Moderate", alert: "Severe" };

function levelsOf(r, t) {
  return { temp: lvl(r.temp, t.temp_watch, t.temp_alert), hum: lvl(r.hum, t.hum_watch, t.hum_alert), gas: lvl(r.gas, t.gas_watch, t.gas_alert) };
}
async function stageAt(d, device, trip, ts) {
  const c = await d.get("SELECT tag FROM events WHERE device=? AND trip=? AND kind='checkpoint' AND ts<=? ORDER BY ts DESC LIMIT 1", [device, trip, ts]);
  return c ? STAGES[c.tag] : "Unassigned";
}
function num(v, name, { min = -Infinity, max = Infinity, optional = false } = {}) {
  if (v == null && optional) return null;
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) throw new HttpError(400, `bad ${name}`);
  return v;
}
function str(v, name, max = 64) {
  if (typeof v !== "string" || !v || v.length > max || !/^[\w .:@+\-]+$/.test(v)) throw new HttpError(400, `bad ${name}`);
  return v;
}

async function addEvent(d, e, alerts) {
  const r = await d.run(`INSERT OR IGNORE INTO events
    (device,trip,ts,kind,level,title,metric,value,unit,duration_ms,stage,sev_g,note,trace,tag,g_watch_eff,g_alert_eff)
    VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [e.device, e.trip, e.ts, e.kind, e.level, e.title, e.metric ?? null, e.value ?? null, e.unit ?? null, e.duration_ms ?? null,
      e.stage, e.sev_g ?? null, e.note ?? null, e.trace ? JSON.stringify(e.trace) : null, e.tag ?? null, e.g_watch_eff ?? null, e.g_alert_eff ?? null]);
  if (r.changes && e.level !== "good" && Date.now() - e.ts < 5 * 60e3) alerts.push(e);   // only alert on fresh events
  return r.changes;
}

async function ingest(body, dev) {
  const device = dev.name;                                            // identity comes from the device key, never the body
  const trip = str(body.trip ?? "default", "trip");
  const readings = Array.isArray(body.readings) ? body.readings : [];
  const events = Array.isArray(body.events) ? body.events : [];
  if (readings.length > 2000 || events.length > 2000) throw new HttpError(413, "batch too large");
  const t = await getThresholds();
  const alerts = [];
  let nr = 0, ne = 0;

  const tx = await client.transaction("write");
  const d = wrap(tx);
  try {
    // checkpoints first so stage attribution sees them
    for (const e of events.filter((e) => e && e.kind === "checkpoint").sort((a, b) => a.ts - b.ts)) {
      const ts = num(e.ts, "ts", { min: 1e12 });
      if (!(e.tag in STAGES)) throw new HttpError(400, "bad checkpoint tag");
      ne += await addEvent(d, { device, trip, ts, kind: "checkpoint", level: "good", title: `Checkpoint: ${STAGES[e.tag]}`, tag: e.tag,
        stage: STAGES[e.tag], note: `NFC checkpoint scanned. Events from here on are attributed to “${STAGES[e.tag]}”.` }, alerts);
    }
    for (const e of events.filter((e) => e && e.kind === "handling").sort((a, b) => a.ts - b.ts)) {
      const ts = num(e.ts, "ts", { min: 1e12 });
      const g = num(e.g, "g", { min: 0, max: 200 });
      const dur = num(e.duration_ms, "duration_ms", { min: 0, max: 60000 });
      if (dur < t.min_ms) continue;                                   // brief vibration spike, not an impact (Iteration 2)
      const lastLoad = await d.get("SELECT load FROM readings WHERE device=? AND trip=? AND ts<=? AND load IS NOT NULL ORDER BY ts DESC LIMIT 1", [device, trip, ts]);
      const loadKg = e.load_kg != null ? num(e.load_kg, "load_kg", { min: 0, max: 5000 }) : lastLoad ? lastLoad.load : null;
      const eff = effectiveShock(t, dev.produce, loadKg);
      const level = lvl(g, eff.g_watch, eff.g_alert);
      const title = { drop: "Drop detected", jolt: "Jolt detected" }[e.type] || "Impact detected";
      const trace = Array.isArray(e.trace) ? e.trace.slice(0, 200).filter(Number.isFinite) : null;
      const stage = await stageAt(d, device, trip, ts);
      ne += await addEvent(d, { device, trip, ts, kind: "handling", level, title, sev_g: g, duration_ms: dur, stage, trace,
        g_watch_eff: eff.g_watch, g_alert_eff: eff.g_alert,
        note: `Peak ${g.toFixed(1)} g for ${dur} ms (${SEV_WORD[level].toLowerCase()}). ` +
          `Limits for ${(PROFILES[dev.produce] || PROFILES.standard).label.split(" (")[0].toLowerCase()} produce` +
          (loadKg ? ` at ${loadKg.toFixed(1)} kg` : "") + `: watch > ${eff.g_watch} g, alert > ${eff.g_alert} g.` }, alerts);
    }
    for (const r of readings.slice().sort((a, b) => a.ts - b.ts)) {
      const ts = num(r.ts, "ts", { min: 1e12 });
      const row = {
        temp: num(r.temp, "temp", { min: -40, max: 100, optional: true }),
        hum: num(r.hum, "hum", { min: 0, max: 100, optional: true }),
        gas: num(r.gas, "gas", { min: 0, max: 100000, optional: true }),
        load: num(r.load, "load", { min: 0, max: 5000, optional: true }),
        fan: r.fan ? 1 : 0,
      };
      const prev = await d.get("SELECT * FROM readings WHERE device=? AND trip=? AND ts<? ORDER BY ts DESC LIMIT 1", [device, trip, ts]);
      const added = (await d.run("INSERT OR IGNORE INTO readings(device,trip,ts,temp,hum,gas,load,fan) VALUES (?,?,?,?,?,?,?,?)",
        [device, trip, ts, row.temp, row.hum, row.gas, row.load, row.fan])).changes;
      if (!added) continue;
      nr++;
      const stage = await stageAt(d, device, trip, ts);
      const cur = levelsOf(row, t), was = prev ? levelsOf(prev, t) : { temp: "good", hum: "good", gas: "good" };
      for (const m of Object.keys(METRICS)) {
        if (cur[m] === was[m]) continue;
        const { name, unit } = METRICS[m];
        const val = row[m], fmt = `${val}${unit ? " " + unit : ""}`;
        if (cur[m] !== "good") {
          ne += await addEvent(d, { device, trip, ts, kind: "env", level: cur[m], title: `${name} ${cur[m] === "alert" ? "past alert line" : "above watch line"}`,
            metric: m, value: val, unit, stage, note: `${name} reached ${fmt} (watch > ${t[m + "_watch"]}, alert > ${t[m + "_alert"]}).` }, alerts);
        } else {
          const open = await d.get("SELECT ts FROM events WHERE device=? AND trip=? AND kind='env' AND metric=? AND level!='good' AND ts<? ORDER BY ts DESC LIMIT 1", [device, trip, m, ts]);
          const dur = open ? ts - open.ts : null;
          ne += await addEvent(d, { device, trip, ts, kind: "env", level: "good", title: `${name} back in range`, metric: m, value: val, unit, stage,
            duration_ms: dur, note: `${name} returned to ${fmt}` + (dur ? ` after ${Math.round(dur / 1000)} s out of range.` : ".") }, alerts);
        }
      }
      if (prev && prev.fan !== row.fan) {
        ne += await addEvent(d, { device, trip, ts, kind: "fan", level: "good", title: row.fan ? "Ventilation fan ON" : "Ventilation fan OFF", stage,
          note: row.fan ? "Fan switched on automatically because a reading left its safe range." : "Fan switched off automatically; conditions are back to normal." }, alerts);
      }
    }
    await d.run("UPDATE devices SET last_seen=? WHERE name=?", [Date.now(), device]);
    await tx.commit();
  } catch (err) {
    try { await tx.rollback(); } catch { /* already closed */ }
    throw err;
  } finally {
    tx.close();
  }
  await sendAlerts(alerts);                                           // awaited: a serverless function may be frozen right after responding
  return { ok: true, readings: nr, events: ne, thresholds: t, produce: dev.produce,
    profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, v.scale])) };   // device refreshes its settings from this
}

async function sendAlerts(list) {
  await Promise.all(list.map(async (e) => {
    const text = `${e.level === "alert" ? "🚨" : "⚠️"} ${e.title} — ${e.stage}\n${e.note || ""}`;
    console.log("[alert]", text.replace(/\n/g, " "));
    if (TG_TOKEN && TG_CHAT) {
      try {
        await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
          method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ chat_id: TG_CHAT, text }),
        });
      } catch (err) { console.error("[alert] telegram failed:", err.message); }
    }
  }));
}

// ---- read side ----
function eventView(r) {
  return {
    id: r.id, ts: r.ts, kind: r.kind, level: r.level, title: r.title, stage: r.stage,
    type: r.kind === "handling" ? "handling" : r.kind === "checkpoint" ? "stage" : "environmental",
    metric: r.metric, value: r.value, unit: r.unit, durationMs: r.duration_ms, sevG: r.sev_g,
    sevLabel: r.kind === "handling" ? SEV_WORD[r.level] : null, note: r.note, gWatch: r.g_watch_eff, gAlert: r.g_alert_eff,
  };
}
async function resolveScope(q) {
  let device = q.get("device"), trip = q.get("trip");
  if (!trip || !device) {
    const last = (await db.get("SELECT device, trip FROM readings ORDER BY ts DESC LIMIT 1")) || (await db.get("SELECT device, trip FROM events ORDER BY ts DESC LIMIT 1"));
    if (!last) return null;
    device = device || last.device; trip = trip || last.trip;
  }
  return { device, trip };
}
async function getState(q) {
  const t = await getThresholds();
  const alertsCfg = { telegram: !!(TG_TOKEN && TG_CHAT) };
  const scope = await resolveScope(q);
  if (!scope) return { empty: true, thresholds: t, alerts: alertsCfg, serverTime: Date.now() };
  const { device, trip } = scope;
  const [reading, cp, evRows, counts, devRow] = await Promise.all([
    db.get("SELECT * FROM readings WHERE device=? AND trip=? ORDER BY ts DESC LIMIT 1", [device, trip]),
    db.get("SELECT tag, ts FROM events WHERE device=? AND trip=? AND kind='checkpoint' ORDER BY ts DESC LIMIT 1", [device, trip]),
    db.all("SELECT * FROM events WHERE device=? AND trip=? ORDER BY ts DESC, id DESC LIMIT 200", [device, trip]),
    db.get("SELECT COUNT(*) AS n, MAX(CASE level WHEN 'alert' THEN 2 WHEN 'watch' THEN 1 ELSE 0 END) AS w FROM events WHERE device=? AND trip=? AND kind!='checkpoint' AND kind!='fan'", [device, trip]),
    db.get("SELECT produce FROM devices WHERE name=?", [device]),
  ]);
  const events = evRows.map(eventView);
  const levels = reading ? levelsOf(reading, t) : null;
  let overall = levels ? worse(worse(levels.temp, levels.hum), levels.gas) : "good";
  const recentHandling = events.find((e) => e.kind === "handling");
  // a recent rough-handling event also counts toward the headline status (last 10 min of the trip's clock)
  const refTs = reading ? reading.ts : Date.now();
  const recent = events.filter((e) => e.kind === "handling" && e.level !== "good" && e.ts >= refTs - 600e3);
  const recentWorst = recent.reduce((w, e) => worse(w, e.level), "good");
  overall = worse(overall, recentWorst);
  const produce = (devRow && devRow.produce) || "standard";
  return {
    device, trip, stage: cp ? STAGES[cp.tag] : "Unassigned", reading: reading || null, levels, overall, produce,
    shock: effectiveShock(t, produce, reading && reading.load),
    recentHandling: recent.length ? { level: recentWorst, count: recent.length, ts: recent[0].ts, title: recent[0].title } : null,
    worstSoFar: ["good", "watch", "alert"][counts.w || 0], eventCount: counts.n, latestHandling: recentHandling || null, events, thresholds: t,
    alerts: alertsCfg, serverTime: Date.now(),
  };
}
async function getEvent(id) {
  const r = await db.get("SELECT * FROM events WHERE id=?", [id]);
  if (!r) throw new HttpError(404, "no such event");
  const v = eventView(r);
  if (r.trace) v.trace = JSON.parse(r.trace);
  else if (r.metric) {                                                // environmental: the 13 readings leading up to the event
    const col = { temp: "temp", hum: "hum", gas: "gas" }[r.metric];
    const rows = await db.all(`SELECT ${col} AS v FROM readings WHERE device=? AND trip=? AND ts<=? AND ${col} IS NOT NULL ORDER BY ts DESC LIMIT 13`, [r.device, r.trip, r.ts]);
    v.trace = rows.reverse().map((x) => x.v);
  }
  return v;
}
const getTrips = () => db.all(`SELECT device, trip, MIN(ts) AS start, MAX(ts) AS end, COUNT(*) AS events FROM events GROUP BY device, trip
  UNION ALL SELECT device, trip, MIN(ts), MAX(ts), 0 FROM readings WHERE (device||'/'||trip) NOT IN (SELECT device||'/'||trip FROM events) GROUP BY device, trip
  ORDER BY end DESC LIMIT 50`);

// ---- auth ----
const sha = (x) => crypto.createHash("sha256").update(x).digest("hex");
function hashPassword(pw) {
  const salt = crypto.randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${crypto.scryptSync(pw, salt, 64).toString("hex")}`;
}
const DUMMY_HASH = hashPassword(crypto.randomBytes(8).toString("hex"));
function checkPassword(pw, stored) {
  const [alg, salt, hash] = stored.split("$");
  if (alg !== "scrypt") return false;
  const got = crypto.scryptSync(pw, Buffer.from(salt, "hex"), 64), want = Buffer.from(hash, "hex");
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
async function createUser(username, password) {
  if (!/^[\w.-]{3,32}$/.test(username)) throw new Error("username must be 3-32 chars of letters, digits, _ . -");
  if (typeof password !== "string" || password.length < 10) throw new Error("password must be at least 10 characters");
  await db.run("INSERT INTO users(username,pw,created) VALUES(?,?,?) ON CONFLICT(username) DO UPDATE SET pw=excluded.pw", [username, hashPassword(password), Date.now()]);
}
function parseCookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || "").split(";")) { const i = part.indexOf("="); if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); }
  return out;
}
async function sessionUser(req) {
  const tok = parseCookies(req).sid;
  if (!tok) return null;
  const row = await db.get("SELECT username, expires FROM sessions WHERE token=?", [sha(tok)]);
  if (!row) return null;
  if (row.expires < Date.now()) { await db.run("DELETE FROM sessions WHERE token=?", [sha(tok)]); return null; }
  return row.username;
}
const isSecure = (req) => PROD || req.headers["x-forwarded-proto"] === "https";
const cookie = (req, value, maxAge) => `sid=${value}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${maxAge}${isSecure(req) ? "; Secure" : ""}`;
const clientIp = (req) => (ON_VERCEL ? String(req.headers["x-forwarded-for"] || "").split(",")[0].trim() : "") || req.socket.remoteAddress || "unknown";
async function throttle(ip) {                                         // 10 tries / 10 min per IP, kept in the DB so it holds across serverless instances
  const now = Date.now(), a = await db.get("SELECT n, reset FROM attempts WHERE ip=?", [ip]);
  if (!a || a.reset < now) { await db.run("INSERT INTO attempts(ip,n,reset) VALUES(?,?,?) ON CONFLICT(ip) DO UPDATE SET n=1, reset=excluded.reset", [ip, 1, now + 600e3]); return; }
  if (a.n >= 10) throw new HttpError(429, "too many attempts, try again later");
  await db.run("UPDATE attempts SET n=n+1 WHERE ip=?", [ip]);
}
async function requireUser(req) {
  const u = await sessionUser(req);
  if (!u) throw new HttpError(401, "login required");
  return u;
}
function requireJson(req) {                                           // with SameSite=Strict, this blocks cross-site form posts
  if (!/^application\/json/i.test(req.headers["content-type"] || "")) throw new HttpError(415, "content-type must be application/json");
}
async function deviceFromKey(req) {
  const k = req.headers["x-device-key"];
  const d = k && (await db.get("SELECT * FROM devices WHERE key_hash=?", [sha(String(k))]));
  if (!d) throw new HttpError(401, "bad device key");
  return d;
}

// ---- devices ----
const newKey = () => "pg_" + crypto.randomBytes(24).toString("base64url");
async function createDevice(name, produce = "standard") {
  str(name, "name");
  if (!(produce in PROFILES)) throw new HttpError(400, "unknown produce profile");
  if (await db.get("SELECT 1 AS x FROM devices WHERE name=?", [name])) throw new HttpError(409, "device name already exists");
  const key = newKey();
  await db.run("INSERT INTO devices(name,key_hash,produce,created) VALUES(?,?,?,?)", [name, sha(key), produce, Date.now()]);
  return { name, produce, key };                                      // the key is shown once; only its hash is stored
}
const listDevices = async () => ({
  devices: await db.all("SELECT name, produce, created, last_seen AS lastSeen FROM devices ORDER BY name"),
  profiles: Object.fromEntries(Object.entries(PROFILES).map(([k, v]) => [k, v.label])),
});

// ---- http plumbing ----
const parseJson = (text) => { try { return text.length ? JSON.parse(text) : {}; } catch { throw new HttpError(400, "invalid JSON"); } };
async function readBody(req) {
  const b = req.body;                                                 // Vercel pre-parses the body; plain Node does not
  if (b !== undefined && b !== null) {
    if (Buffer.isBuffer(b)) return parseJson(b.toString());
    if (typeof b === "string") return parseJson(b);
    if (typeof b === "object") return b;
  }
  return new Promise((resolve, reject) => {
    let n = 0; const chunks = [];
    req.on("data", (c) => { n += c.length; if (n > MAX_BODY) { reject(new HttpError(413, "body too large")); req.destroy(); } else chunks.push(c); });
    req.on("end", () => { try { resolve(parseJson(Buffer.concat(chunks).toString())); } catch (e) { reject(e); } });
    req.on("error", reject);
  });
}
const SEC_HEADERS = {
  "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "x-frame-options": "DENY",
  "content-security-policy": "default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; font-src data:; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
};
function send(res, status, obj, extra = {}) {
  res.writeHead(status, { ...SEC_HEADERS, "content-type": "application/json", "cache-control": "no-store", ...extra });
  res.end(JSON.stringify(obj));
}
function sendFile(res, file) {
  res.writeHead(200, { ...SEC_HEADERS, "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
  res.end(fs.readFileSync(path.join(__dirname, "..", "views", file)));
}

async function handle(req, res) {
  const url = new URL(req.url, "http://x");
  const route = `${req.method} ${url.pathname}`;
  try {
    if (route === "GET /healthz") return send(res, 200, { ok: true });
    await init();
    if (route === "GET /login") return sendFile(res, "login.html");
    if (route === "GET /" || route === "GET /index.html") {
      if (!(await sessionUser(req))) { res.writeHead(302, { location: "/login" }); return res.end(); }
      return sendFile(res, "dashboard.html");
    }

    // device -> server (authenticated by per-device key, not by session)
    if (route === "POST /api/ingest") { requireJson(req); const dev = await deviceFromKey(req); return send(res, 200, await ingest(await readBody(req), dev)); }

    // auth
    if (route === "POST /api/login") {
      requireJson(req); await throttle(clientIp(req));
      const b = await readBody(req);
      const u = typeof b.username === "string" && (await db.get("SELECT * FROM users WHERE username=?", [b.username]));
      const ok = checkPassword(String(b.password || ""), u ? u.pw : DUMMY_HASH) && !!u;
      if (!ok) throw new HttpError(401, "wrong username or password");
      const tok = crypto.randomBytes(32).toString("base64url");
      await db.run("DELETE FROM sessions WHERE expires<?", [Date.now()]);
      await db.run("INSERT INTO sessions(token,username,expires) VALUES(?,?,?)", [sha(tok), u.username, Date.now() + SESSION_DAYS * 864e5]);
      return send(res, 200, { ok: true, username: u.username }, { "set-cookie": cookie(req, tok, SESSION_DAYS * 86400) });
    }
    if (route === "POST /api/logout") {
      requireJson(req);
      const tok = parseCookies(req).sid; if (tok) await db.run("DELETE FROM sessions WHERE token=?", [sha(tok)]);
      return send(res, 200, { ok: true }, { "set-cookie": cookie(req, "", 0) });
    }

    // everything below needs a logged-in user
    const user = await requireUser(req);
    if (route === "GET /api/me") return send(res, 200, { username: user });
    if (route === "GET /api/state") return send(res, 200, await getState(url.searchParams));
    if (route === "GET /api/trips") return send(res, 200, await getTrips());
    if (route === "GET /api/thresholds") return send(res, 200, await getThresholds());
    if (route === "GET /api/devices") return send(res, 200, await listDevices());
    const m = url.pathname.match(/^\/api\/events\/(\d+)$/);
    if (req.method === "GET" && m) return send(res, 200, await getEvent(Number(m[1])));

    if (req.method !== "GET") requireJson(req);
    if (route === "PUT /api/thresholds") {
      const t = await validateThresholds(await readBody(req));
      await client.batch(Object.entries(t).map(([k, v]) => ({ sql: "INSERT INTO settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", args: [k, v] })), "write");
      return send(res, 200, t);
    }
    if (route === "POST /api/devices") { const b = await readBody(req); return send(res, 201, await createDevice(b.name, b.produce)); }
    const dm = url.pathname.match(/^\/api\/devices\/([\w .:@+-]{1,64})(\/rotate-key)?$/);
    if (dm) {
      const name = dm[1];
      if (!(await db.get("SELECT 1 AS x FROM devices WHERE name=?", [name]))) throw new HttpError(404, "no such device");
      if (req.method === "PATCH" && !dm[2]) {
        const b = await readBody(req);
        if (!(b.produce in PROFILES)) throw new HttpError(400, "unknown produce profile");
        await db.run("UPDATE devices SET produce=? WHERE name=?", [b.produce, name]);
        return send(res, 200, { ok: true });
      }
      if (req.method === "POST" && dm[2]) {
        const key = newKey();
        await db.run("UPDATE devices SET key_hash=? WHERE name=?", [sha(key), name]);
        return send(res, 200, { name, key });
      }
    }
    throw new HttpError(404, "not found");
  } catch (err) {
    if (err instanceof HttpError) return send(res, err.status, { error: err.message });
    console.error(err);
    send(res, 500, { error: "internal error" });
  }
}

module.exports = { handle, init, createUser, createDevice, db, get dbLabel() { return DB_LABEL; } };
