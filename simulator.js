// Stand-in for the ESP32 until the hardware is wired up. Mimics its behaviour:
//  - posts readings every tick, handling events as they happen, NFC checkpoints at stage changes
//  - runs the fan locally against thresholds it received from the server (so it works offline)
//  - if the server is unreachable it buffers (like the SD card) and re-sends the backlog on reconnect
// Usage: node simulator.js --key <device key> [--url http://localhost:3000] [--tick 2000]
// Get a key with:  node server.js create-device crate-3   (or Settings > Devices in the dashboard)
"use strict";
const arg = (n, d) => { const i = process.argv.indexOf("--" + n); return i > 0 ? process.argv[i + 1] : d; };
const URL_BASE = arg("url", "http://localhost:3000");
const TICK = Number(arg("tick", 2000));
const DEVICE = arg("device", "crate-3");              // only used to name the trip; the server takes identity from the key
const KEY = arg("key", process.env.DEVICE_KEY || "");
if (!KEY) { console.error("missing --key (or DEVICE_KEY env). Create one: node server.js create-device crate-3"); process.exit(1); }
const TRIP = `${DEVICE}-${new Date().toISOString().slice(0, 16).replace(/[T:]/g, "")}`;

let th = { temp_watch: 8, temp_alert: 11, hum_watch: 90, hum_alert: 95, gas_watch: 300, gas_alert: 450, g_watch: 3, g_alert: 6, min_ms: 50 };
let temp = 6.1, hum = 68, gas = 190, fan = 0, tick = 0;
const buffer = { readings: [], events: [] };                          // the "SD card"
const rnd = (a, b) => a + Math.random() * (b - a);

// scripted journey: ticks at which each stage starts
const PLAN = [[0, "load"], [25, "transit"], [95, "unload"], [115, "end"]];
const stageAt = () => PLAN.filter(([t]) => tick >= t).pop()[1];
let lastStage = null;

function step() {
  tick++;
  const stage = stageAt();
  const ts = Date.now();
  if (stage !== lastStage) { buffer.events.push({ kind: "checkpoint", tag: stage, ts }); lastStage = stage; }

  // environment: warms up in transit (door-seal exposure), gas creeps up; fan pulls them back
  const heat = stage === "transit" ? 0.18 : 0.02;
  temp += heat * rnd(0.4, 1.2) - (fan ? 0.35 : 0.04);
  hum += rnd(-0.6, 0.6) + (fan ? -0.4 : 0.05);
  gas += (stage === "transit" ? 5 : 1.5) * rnd(0.5, 1.5) - (fan ? 9 : 0);
  temp = Math.max(3, Math.min(20, temp)); hum = Math.max(55, Math.min(99, hum)); gas = Math.max(150, gas);
  fan = (temp > th.temp_watch || hum > th.hum_watch || gas > th.gas_watch) ? 1 : (temp < th.temp_watch - 0.5 && gas < th.gas_watch - 30) ? 0 : fan;

  buffer.readings.push({ ts, temp: +temp.toFixed(1), hum: +hum.toFixed(0), gas: Math.round(gas), load: +(212 + rnd(-0.4, 0.4)).toFixed(1), fan });

  // handling: rougher while loading/unloading and on bad road in transit
  const p = stage === "transit" ? 0.07 : stage === "end" ? 0 : 0.1;
  if (Math.random() < p) {
    const big = Math.random() < 0.2;
    const g = big ? rnd(6.2, 11) : rnd(1.2, 5.5);
    const dur = Math.round(big ? rnd(150, 260) : rnd(40, 200));
    const peak = 5 + Math.floor(rnd(0, 3));
    const trace = Array.from({ length: 13 }, (_, i) => Math.round(18 + rnd(-3, 3) + (i === peak ? g * 9 : i === peak + 1 ? g * 5 : i === peak - 1 ? g * 2 : 0)));
    buffer.events.push({ kind: "handling", ts, g: +g.toFixed(1), duration_ms: dur, type: big ? "drop" : g > 4 ? "jolt" : "impact", trace, load_kg: 212 });
  }
}

async function sync() {
  if (!buffer.readings.length && !buffer.events.length) return;
  const sending = { readings: buffer.readings.splice(0), events: buffer.events.splice(0) };
  try {
    const res = await fetch(`${URL_BASE}/api/ingest`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-device-key": KEY },
      body: JSON.stringify({ trip: TRIP, ...sending }),
    });
    if (res.status === 401) { console.error("server rejected the device key"); process.exit(1); }
    if (!res.ok) throw new Error(`HTTP ${res.status} ${await res.text()}`);
    const out = await res.json();
    th = out.thresholds;
    console.log(`tick ${tick} ${stageAt().padEnd(7)} T=${temp.toFixed(1)} H=${hum.toFixed(0)} gas=${Math.round(gas)} fan=${fan}  sent ${out.readings}r/${out.events}e`);
  } catch (err) {
    buffer.readings.unshift(...sending.readings); buffer.events.unshift(...sending.events);   // keep for next try
    console.log(`tick ${tick} offline (${err.message}) — buffered ${buffer.readings.length} readings`);
  }
}

console.log(`simulating ${DEVICE}, trip ${TRIP} → ${URL_BASE} (tick ${TICK} ms)`);
const timer = setInterval(async () => {
  step(); await sync();
  if (tick > PLAN[PLAN.length - 1][0] + 5) { clearInterval(timer); console.log("trip finished"); }
}, TICK);
