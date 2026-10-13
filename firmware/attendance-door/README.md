# attendance-door firmware (ESP32 + R503)

Phase 2 of the hardware attendance system
(`docs/hardware-attendance-design.md`). The backend Phase 1 is live
(`/api/device/{heartbeat,scan,enroll}`, commit a2cf87c).

## Wiring

| Part | Pin (R503 wire color) | ESP32 |
|---|---|---|
| R503 | red (3V3) / black (GND) | 3V3 / GND |
| R503 | green (TX of sensor) | GPIO 16 (RX2) |
| R503 | blue (RX of sensor) | GPIO 17 (TX2) |
| SSD1306 | SDA / SCK | GPIO 21 / 22 |
| Buzzer | signal via 100R | GPIO 25 |
| LED | R / G / B | GPIO 26 / 27 / 14 |

## Build

Arduino CLI example (PlatformIO works identically):

```
arduino-cli compile --fqbn esp32:esp32:esp32 \
  --build-property "compiler.cpp.extra_flags=-DCONFIG_WIFI_SSID=\"...\" -DCONFIG_WIFI_PASSWORD=\"...\" -DCONFIG_DEVICE_ID=\"dev_...\" -DCONFIG_SECRET=\"64hex\"" \
  firmware/attendance-door
```

Libraries: Adafruit Fingerprint Sensor Library, Adafruit SSD1306 +
GFX, ArduinoJson, NTPClient. Core bundles mbedtls/LittleFS.

## Provisioning flow (no secrets in the repo)

1. CR: portal → Attendance Devices → Register. Copy `deviceId` + `secret`
   (shown ONCE) into the build flags above.
2. Flash, power up: OLED shows `Ready / online / 0 queued`.
3. CR: portal → device → Enroll student → give the student the 4-digit PIN
   (10-min validity) → student places finger twice at the door device →
   types the PIN on the serial console (field trial; keypad in phase 3).
4. Live class: touches inside a timetable slot mark attendance
   (`method: device`), outside a slot the device refuses (`no_class`).

## Security notes (mirror of the backend contract)

- HMAC key = `sha256(secret)` computed on BOTH ends; raw secret never
  leaves flash, templates never leave the sensor.
- Every request is signed over `deviceId|timestamp|scanId|body` with a
  90-second clock window — NTP time is mandatory (PKT = UTC+5, no DST).
- WiFi-down scans persist to LittleFS and replay with their original
  `occurredAt` and the SAME `scanId` — the backend replays the stored
  result instead of double-marking.
- `client.setInsecure()` is a phase-3 TODO: pin the deployment certificate
  before the field trial if the campus network allows it.
