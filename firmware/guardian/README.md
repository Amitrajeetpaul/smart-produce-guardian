# ESP32 firmware

Untested on hardware: written against the spec and the server's API contract (see the top-level README). Expect to adjust pins and library versions.

1. Create the device in the dashboard (Settings > Devices) and copy the key shown once.
2. Edit `config.h`: Wi-Fi, `SERVER_URL`, `DEVICE_KEY`, NFC tag UIDs, load-cell scale.
3. Arduino IDE: board "ESP32 Dev Module", install the libraries listed at the top of `guardian.ino`, upload.
4. Wiring gotchas: MPU6050 and DS3231 both default to I2C 0x68, so tie the MPU6050 AD0 pin to 3.3 V (firmware uses 0x69). MQ135 output is up to 5 V: use a divider and ADC1 pin 34. The relay board may be active-low: invert the `digitalWrite` if the fan runs backwards. Run the MQ135 powered for a few minutes first; the firmware treats clean air at boot as index 100.
5. A phone hotspot works as the "Wi-Fi" in a truck; everything is buffered on the SD card until a sync succeeds.
