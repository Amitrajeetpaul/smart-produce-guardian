// Run: npm test   (spawns the real server on a throwaway DB)
"use strict";
const { test, before, after } = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const fs = require("node:fs"), os = require("node:os"), path = require("node:path");

const PORT = 3900 + Math.floor(Math.random() * 90), BASE = `http://127.0.0.1:${PORT}`;
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pg-"));
let proc, cookie = "";
const T0 = Date.now() - 60_000;

const call = async (method, url, body, headers = {}) => {
  const res = await fetch(BASE + url, {
    method, redirect: "manual",
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  let json = null; try { json = await res.clone().json(); } catch {}
  return { status: res.status, json, headers: res.headers };
};

before(async () => {
  proc = spawn(process.execPath, [path.join(__dirname, "..", "cli.js")], {
    env: { ...process.env, PORT, DB_PATH: path.join(dir, "t.db"), ADMIN_PASSWORD: "correct horse battery" }, stdio: "ignore" });
  for (let i = 0; i < 50; i++) { try { if ((await fetch(BASE + "/healthz")).ok) return; } catch {} await new Promise((r) => setTimeout(r, 100)); }
  throw new Error("server did not start");
});
after(() => { proc.kill(); fs.rmSync(dir, { recursive: true, force: true }); });

test("dashboard and API are closed to anonymous users", async () => {
  assert.equal((await call("GET", "/")).status, 302);
  assert.equal((await call("GET", "/api/state")).status, 401);
  assert.equal((await call("PUT", "/api/thresholds", { temp_watch: 5 })).status, 401);
  assert.equal((await call("GET", "/login")).status, 200);
});

test("login: wrong password rejected, right one sets a hardened cookie", async () => {
  assert.equal((await call("POST", "/api/login", { username: "admin", password: "nope" })).status, 401);
  assert.equal((await call("POST", "/api/login", { username: "ghost", password: "nope" })).status, 401);
  const ok = await call("POST", "/api/login", { username: "admin", password: "correct horse battery" });
  assert.equal(ok.status, 200);
  const sc = ok.headers.get("set-cookie");
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/);
  cookie = sc.split(";")[0];
  assert.equal((await call("GET", "/")).status, 200);
});

test("mutations need JSON content-type (CSRF guard)", async () => {
  const res = await fetch(BASE + "/api/thresholds", { method: "PUT", headers: { cookie, "content-type": "text/plain" }, body: "{}" });
  assert.equal(res.status, 415);
});

let keys = {};
test("devices: create, duplicate rejected, key only returned once", async () => {
  for (const [name, produce] of [["berry-crate", "delicate"], ["potato-crate", "sturdy"]]) {
    const r = await call("POST", "/api/devices", { name, produce });
    assert.equal(r.status, 201); assert.match(r.json.key, /^pg_/); keys[name] = r.json.key;
  }
  assert.equal((await call("POST", "/api/devices", { name: "berry-crate" })).status, 409);
  const list = await call("GET", "/api/devices");
  assert.equal(list.json.devices.length, 2);
  assert.ok(!JSON.stringify(list.json).includes(keys["berry-crate"]));
});

test("ingest needs a valid device key and ignores a spoofed device name", async () => {
  assert.equal((await call("POST", "/api/ingest", { trip: "t", readings: [] })).status, 401);
  assert.equal((await call("POST", "/api/ingest", { trip: "t" }, { "x-device-key": "pg_wrong" })).status, 401);
  const r = await call("POST", "/api/ingest", { device: "potato-crate", trip: "spoof", readings: [{ ts: T0, temp: 5, hum: 60, gas: 150, load: 200, fan: 0 }] }, { "x-device-key": keys["berry-crate"] });
  assert.equal(r.status, 200);
  const trips = (await call("GET", "/api/trips")).json;
  assert.ok(trips.some((t) => t.device === "berry-crate" && t.trip === "spoof"));
  assert.ok(!trips.some((t) => t.device === "potato-crate"));
});

test("load-aware threshold: the same 4 g hit is severe for berries, harmless for potatoes", async () => {
  const hit = { kind: "handling", ts: T0 + 1000, g: 4, duration_ms: 120, load_kg: 200 };
  for (const name of ["berry-crate", "potato-crate"])
    await call("POST", "/api/ingest", { trip: "same", events: [hit], readings: [{ ts: T0, temp: 5, hum: 60, gas: 150, load: 200 }] }, { "x-device-key": keys[name] });
  const level = async (device) => (await call("GET", `/api/state?device=${device}&trip=same`)).json.events.find((e) => e.kind === "handling").level;
  assert.equal(await level("berry-crate"), "alert");   // delicate: 6 g * 0.6 = 3.6 g alert line
  assert.equal(await level("potato-crate"), "good");   // sturdy: 3 g * 1.6 = 4.8 g watch line
});

test("stage attribution, range events, duplicate-safe resync, short spikes dropped", async () => {
  const batch = {
    trip: "journey",
    events: [{ kind: "checkpoint", tag: "load", ts: T0 }, { kind: "checkpoint", tag: "transit", ts: T0 + 5000 },
      { kind: "handling", ts: T0 + 6000, g: 7, duration_ms: 200, type: "drop" }, { kind: "handling", ts: T0 + 7000, g: 9, duration_ms: 5 }],
    readings: [{ ts: T0 + 1000, temp: 6, hum: 60, gas: 150, load: 200, fan: 0 }, { ts: T0 + 6000, temp: 12, hum: 60, gas: 150, load: 200, fan: 1 }],
  };
  const first = await call("POST", "/api/ingest", batch, { "x-device-key": keys["potato-crate"] });
  assert.ok(first.json.events >= 5);
  const again = await call("POST", "/api/ingest", batch, { "x-device-key": keys["potato-crate"] });
  assert.equal(again.json.events, 0); assert.equal(again.json.readings, 0);
  const st = (await call("GET", "/api/state?device=potato-crate&trip=journey")).json;
  const drop = st.events.find((e) => e.title === "Drop detected");
  assert.equal(drop.stage, "In transit");
  assert.equal(st.events.filter((e) => e.kind === "handling").length, 1);      // the 5 ms spike was dropped
  assert.ok(st.events.some((e) => e.kind === "env" && e.level === "alert"));
  assert.ok(st.events.some((e) => e.kind === "fan" && /ON/.test(e.title)));
});

test("a recent severe impact raises the headline status even when readings are fine", async () => {
  const h = { "x-device-key": keys["potato-crate"] };
  await call("POST", "/api/ingest", { trip: "headline", readings: [{ ts: T0 + 30000, temp: 5, hum: 60, gas: 150, load: 200 }],
    events: [{ kind: "handling", ts: T0 + 30500, g: 20, duration_ms: 150, type: "drop" }] }, h);
  const st = (await call("GET", "/api/state?device=potato-crate&trip=headline")).json;
  assert.equal(st.levels.temp, "good");
  assert.equal(st.overall, "alert");
  assert.equal(st.recentHandling.level, "alert");
});

test("input validation", async () => {
  const h = { "x-device-key": keys["berry-crate"] };
  assert.equal((await call("POST", "/api/ingest", { trip: "v", readings: [{ ts: 5, temp: 1 }] }, h)).status, 400);
  assert.equal((await call("POST", "/api/ingest", { trip: "v", readings: [{ ts: T0, temp: "hot" }] }, h)).status, 400);
  assert.equal((await call("PUT", "/api/thresholds", { temp_watch: 12, temp_alert: 10 })).status, 400);
  assert.equal((await call("PUT", "/api/thresholds", { bogus: 1 })).status, 400);
  assert.equal((await call("PUT", "/api/thresholds", { temp_watch: 7.5 })).status, 200);
});

test("key rotation invalidates the old key; logout ends the session", async () => {
  const rot = await call("POST", "/api/devices/berry-crate/rotate-key", {});
  assert.equal((await call("POST", "/api/ingest", { trip: "r" }, { "x-device-key": keys["berry-crate"] })).status, 401);
  assert.equal((await call("POST", "/api/ingest", { trip: "r" }, { "x-device-key": rot.json.key })).status, 200);
  await call("POST", "/api/logout", {});
  assert.equal((await call("GET", "/api/state")).status, 401);
});
