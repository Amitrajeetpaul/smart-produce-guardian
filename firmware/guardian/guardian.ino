// Smart Produce Guardian firmware (ESP32).  NOT yet compiled or run on hardware: expect to fix pin/library details.
// Libraries (Library Manager): Adafruit MPU6050, Adafruit Unified Sensor, RTClib, DHT sensor library, HX711 (bogde), MFRC522, ArduinoJson v7.
//
// Design: every reading/event is appended to the SD card first; a sync step ships the backlog to the server in batches
// and only advances a cursor after the server answers 200. So Wi-Fi loss never loses data, and re-sends are harmless
// (the server ignores duplicates). Fan control runs locally against the last thresholds the server sent.
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <SPI.h>
#include <SD.h>
#include <Preferences.h>
#include <ArduinoJson v7.h>
#include <Adafruit_MPU6050.h>
#include <RTClib.h>
#include <DHT.h>
#include <HX711.h>
#include <MFRC522.h>
#include "config.h"

Adafruit_MPU6050 mpu;  RTC_DS3231 rtc;  DHT dht(PIN_DHT, DHT22);  HX711 scale;  MFRC522 nfc(PIN_NFC_SS, PIN_NFC_RST);
Preferences prefs;

// thresholds (defaults match the server; replaced by every successful sync, persisted across reboots)
struct Th { float temp_watch=8, hum_watch=90, gas_watch=300, min_ms=50; } th;
const float G_FLOOR = 1.5f;            // start recording a candidate impact above this many g (server decides severity)
const uint32_t ENV_EVERY_MS = 2000, SYNC_EVERY_MS = 10000, BATCH_BYTES = 6000;

String trip;  bool fanOn = false;  float gasBaseline = 1;  float lastLoadKg = 0;
uint32_t lastEnv = 0, lastSync = 0;  uint64_t cursor = 0;

uint64_t nowMs() { return (uint64_t)rtc.now().unixtime() * 1000ULL + (millis() % 1000); }   // RTC second + sub-second from millis (approximate)

void logLine(char kind, const String& json) {          // "r{...}" = reading, "e{...}" = event
  File f = SD.open("/pending.ndj", FILE_APPEND);
  if (f) { f.print(kind); f.println(json); f.close(); } else Serial.println("SD write failed");
}

// ---------- sensing ----------
float gasIndex() {                                      // relative index: 100 = clean air measured at boot (not true ppm)
  long sum = 0; for (int i = 0; i < 8; i++) sum += analogRead(PIN_MQ135);
  return 100.0f * (sum / 8.0f) / gasBaseline;
}
void sampleEnv() {
  float t = dht.readTemperature(), h = dht.readHumidity();
  if (isnan(t) || isnan(h)) return;                     // skip a bad DHT read rather than log garbage
  float g = gasIndex();
  if (scale.is_ready()) lastLoadKg = scale.get_units(3);
  // local automation: works with no Wi-Fi. 0.5 C / 30 index hysteresis stops the relay chattering.
  if (t > th.temp_watch || h > th.hum_watch || g > th.gas_watch) fanOn = true;
  else if (t < th.temp_watch - 0.5f && h < th.hum_watch - 2 && g < th.gas_watch - 30) fanOn = false;
  digitalWrite(PIN_RELAY, fanOn ? HIGH : LOW);
  char buf[160];
  snprintf(buf, sizeof buf, "{\"ts\":%llu,\"temp\":%.1f,\"hum\":%.0f,\"gas\":%.0f,\"load\":%.1f,\"fan\":%d}", nowMs(), t, h, g, lastLoadKg, fanOn ? 1 : 0);
  logLine('r', buf);
}

// impact detector: a candidate starts when |a| exceeds G_FLOOR and ends when it falls back; peak + duration + trace are logged
bool inHit = false;  uint32_t hitStart = 0;  float hitPeak = 0;  uint8_t trace[13];  int traceN = 0;  uint32_t lastTr = 0;
void sampleImpact() {
  sensors_event_t a, g, temp;  mpu.getEvent(&a, &g, &temp);
  float mag = sqrtf(a.acceleration.x * a.acceleration.x + a.acceleration.y * a.acceleration.y + a.acceleration.z * a.acceleration.z) / 9.80665f;
  float dev = fabsf(mag - 1.0f);                        // deviation from resting 1 g
  uint32_t t = millis();
  if (!inHit && dev > G_FLOOR) { inHit = true; hitStart = t; hitPeak = dev; traceN = 0; lastTr = 0; }
  if (inHit) {
    if (dev > hitPeak) hitPeak = dev;
    if (traceN < 13 && t - lastTr >= 15) { trace[traceN++] = (uint8_t)min(255.0f, dev * 20); lastTr = t; }
    if (dev < G_FLOOR * 0.5f || t - hitStart > 2000) {  // hit over
      uint32_t dur = t - hitStart;  inHit = false;
      if (dur >= th.min_ms) {
        const char* type = hitPeak > 6 ? "drop" : hitPeak > 3 ? "jolt" : "impact";
        String j = "{\"kind\":\"handling\",\"ts\":" + String((unsigned long long)nowMs()) + ",\"g\":" + String(hitPeak, 1) + ",\"duration_ms\":" + dur +
                   ",\"type\":\"" + type + "\",\"load_kg\":" + String(lastLoadKg, 1) + ",\"trace\":[";
        for (int i = 0; i < traceN; i++) { if (i) j += ","; j += trace[i]; }
        logLine('e', j + "]}");
      }
    }
  }
}

void pollNfc() {
  if (!nfc.PICC_IsNewCardPresent() || !nfc.PICC_ReadCardSerial()) return;
  const char* stage = nullptr;
  for (const Tag& tg : TAGS) if (nfc.uid.size >= 4 && memcmp(nfc.uid.uidByte, tg.uid, 4) == 0) stage = tg.stage;
  if (stage) logLine('e', "{\"kind\":\"checkpoint\",\"tag\":\"" + String(stage) + "\",\"ts\":" + String((unsigned long long)nowMs()) + "}");
  else Serial.printf("unknown tag %02X:%02X:%02X:%02X\n", nfc.uid.uidByte[0], nfc.uid.uidByte[1], nfc.uid.uidByte[2], nfc.uid.uidByte[3]);
  nfc.PICC_HaltA();
}

// ---------- sync ----------
void loadCursor() { File f = SD.open("/cursor.txt"); if (f) { cursor = f.parseInt(); f.close(); } }
void saveCursor() { SD.remove("/cursor.txt"); File f = SD.open("/cursor.txt", FILE_WRITE); if (f) { f.print((unsigned long)cursor); f.close(); } }

void syncBacklog() {
  if (WiFi.status() != WL_CONNECTED) return;
  File f = SD.open("/pending.ndj");
  if (!f) return;
  if (cursor >= f.size()) { f.close(); SD.remove("/pending.ndj"); cursor = 0; saveCursor(); return; }
  f.seek(cursor);
  String readings, events;  uint64_t next = cursor;
  while (f.available() && readings.length() + events.length() < BATCH_BYTES) {
    String line = f.readStringUntil('\n');  next += line.length() + 1;  line.trim();
    if (line.length() < 3) continue;
    String& dst = (line[0] == 'r') ? readings : events;
    if (dst.length()) dst += ",";
    dst += line.substring(1);
  }
  f.close();
  String body = "{\"trip\":\"" + trip + "\",\"readings\":[" + readings + "],\"events\":[" + events + "]}";

  HTTPClient http;  WiFiClientSecure tls;  WiFiClient plain;
  bool https = String(SERVER_URL).startsWith("https");
  // if (https) tls.setCACert(ROOT_CA); else  <- use this once ROOT_CA is set; setInsecure() skips verification, test use only
  if (https) tls.setInsecure();
  if (!(https ? http.begin(tls, SERVER_URL) : http.begin(plain, SERVER_URL))) return;
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-device-key", DEVICE_KEY);
  http.setTimeout(8000);
  int code = http.POST(body);
  if (code == 200) {
    cursor = next;  saveCursor();
    JsonDocument doc;
    if (!deserializeJson(doc, http.getString())) {       // refresh thresholds so dashboard Settings reach the device
      JsonObject t = doc["thresholds"];
      if (!t.isNull()) {
        th.temp_watch = t["temp_watch"] | th.temp_watch;  th.hum_watch = t["hum_watch"] | th.hum_watch;
        th.gas_watch = t["gas_watch"] | th.gas_watch;     th.min_ms = t["min_ms"] | th.min_ms;
        prefs.putBytes("th", &th, sizeof th);
      }
    }
    Serial.printf("synced up to byte %lu\n", (unsigned long)cursor);
  } else Serial.printf("sync failed: HTTP %d (will retry)\n", code);   // 401 here = wrong DEVICE_KEY
  http.end();
}

void wifiKick() { if (WiFi.status() != WL_CONNECTED) WiFi.begin(WIFI_SSID, WIFI_PASS); }   // non-blocking; the loop never waits for Wi-Fi

// ---------- setup / loop ----------
void setup() {
  Serial.begin(115200);
  pinMode(PIN_RELAY, OUTPUT);  digitalWrite(PIN_RELAY, LOW);
  Wire.begin(PIN_SDA, PIN_SCL);
  if (!rtc.begin()) Serial.println("RTC missing");
  if (rtc.lostPower()) rtc.adjust(DateTime(F(__DATE__), F(__TIME__)));      // coarse fallback; refined by NTP below when online
  if (!mpu.begin(0x69)) Serial.println("MPU6050 missing (AD0 tied high? address 0x69)");
  mpu.setAccelerometerRange(MPU6050_RANGE_16_G);  mpu.setFilterBandwidth(MPU6050_BAND_260_HZ);
  dht.begin();  scale.begin(PIN_HX_DT, PIN_HX_SCK);  scale.set_scale(LOAD_SCALE);  scale.tare();
  SPI.begin(18, 19, 23);  nfc.PCD_Init();
  if (!SD.begin(PIN_SD_CS)) Serial.println("SD missing: data will NOT be buffered!");
  prefs.begin("guardian", false);  prefs.getBytes("th", &th, sizeof th);
  loadCursor();

  WiFi.mode(WIFI_STA);  wifiKick();
  analogReadResolution(12);
  Serial.println("warming up MQ135 (30 s) ...");  delay(30000);
  long s = 0; for (int i = 0; i < 32; i++) { s += analogRead(PIN_MQ135); delay(20); }
  gasBaseline = max(1.0f, s / 32.0f);
  if (WiFi.status() == WL_CONNECTED) { configTime(0, 0, "pool.ntp.org"); struct tm tmv; if (getLocalTime(&tmv, 3000)) rtc.adjust(DateTime(mktime(&tmv))); }
  DateTime n = rtc.now();  trip = "trip-" + String(n.unixtime());   // one trip id per power-up
  Serial.println("trip " + trip);
}

void loop() {
  uint32_t t = millis();
  sampleImpact();                                       // ~200 Hz
  if (t - lastEnv >= ENV_EVERY_MS) { lastEnv = t; sampleEnv(); pollNfc(); }
  if (t - lastSync >= SYNC_EVERY_MS) { lastSync = t; wifiKick(); syncBacklog(); }
  delay(5);
}
