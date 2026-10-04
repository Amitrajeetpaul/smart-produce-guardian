#pragma once
// ---- fill these in (do not commit real values) ----
#define WIFI_SSID     "your-wifi-or-phone-hotspot"
#define WIFI_PASS     "your-wifi-password"
#define SERVER_URL    "http://192.168.1.50:3000/api/ingest"   // https:// also works, see ROOT_CA below
#define DEVICE_KEY    "pg_paste-the-key-from-the-dashboard"

// NFC tag UIDs (4 bytes each) placed at the loading bay, truck, market dock and drop-off.
// Read yours from the serial monitor: unknown tags are printed as "tag AA:BB:CC:DD".
struct Tag { uint8_t uid[4]; const char* stage; };
static const Tag TAGS[] = {
  {{0x00,0x00,0x00,0x01}, "load"},
  {{0x00,0x00,0x00,0x02}, "transit"},
  {{0x00,0x00,0x00,0x03}, "unload"},
  {{0x00,0x00,0x00,0x04}, "end"},
};

// Load cell: calibrate once with a known weight (scale = raw_delta / kg).
#define LOAD_SCALE    22000.0f

// For https:// servers paste the PEM of the CA that signed your certificate (Railway/Let's Encrypt: ISRG Root X1).
// static const char ROOT_CA[] = "-----BEGIN CERTIFICATE-----\n...\n-----END CERTIFICATE-----\n";

// ---- pins (ESP32 DevKit v1) ----
#define PIN_SDA 21        // MPU6050 (0x69: tie AD0 to 3.3V!) and DS3231 (0x68) share I2C
#define PIN_SCL 22
#define PIN_SD_CS 5       // SD + RC522 share VSPI: SCK 18, MISO 19, MOSI 23
#define PIN_NFC_SS 4
#define PIN_NFC_RST 16
#define PIN_DHT 27
#define PIN_MQ135 34      // must be ADC1 (32-39): ADC2 stops working while Wi-Fi is on. MQ135 AO is 0-5 V: use a 10k/20k divider.
#define PIN_RELAY 26
#define PIN_HX_DT 32
#define PIN_HX_SCK 33
