/*
 * Tri3M hardware attendance — classroom door device (Phase 2)
 * docs/hardware-attendance-design.md
 *
 * HARDWARE: ESP32-WROOM-32 + R503 fingerprint sensor (UART2) +
 *           SSD1306 0.96" OLED (I2C) + passive buzzer + RGB LED.
 *
 * PROVISIONING (once, per device): the CR registers the device in the
 * portal (CR -> Attendance Devices -> Register). The portal shows
 *   deviceId  dev_xxxxxxxxxxxx      (flash into CONFIG_DEVICE_ID)
 *   secret    64-hex chars          (flash into CONFIG_SECRET)
 * The backend stores ONLY sha256(secret) — which is exactly the HMAC key
 * this firmware derives at boot (same one-way hash, design §3).
 *
 * SECURITY CONTRACT (mirror of backend/services/deviceAttendanceService.js):
 *   X-Device-Id, X-Timestamp (ms), X-Scan-Id (uuid), X-Signature =
 *     HMAC_SHA256(key = sha256(secret), deviceId|ts|scanId|JSON(body))
 *   |now - ts| <= 90s — the device MUST keep NTP time (PKT = UTC+5).
 *   Offline scans queue on LittleFS and sync later with occurredAt set;
 *   scanId NEVER changes for a retry (backend replays the same result).
 *
 * LOOP: poll sensor -> local match gives template index (1..192) ->
 *   HTTPS POST /api/device/scan -> OLED shows name/already/late -> buzz.
 *   Enrollment mode: heartbeat poll -> device shows "Enroll: press finger"
 *   -> 2 placements -> POST /api/device/enroll {pin from the CR, slot N}.
 */
#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <mbedtls/md.h>
#include <NTPClient.h>
#include <WiFiUdp.h>
#include <LittleFS.h>
#include <Adafruit_Fingerprint.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>
#include <time.h>

/* ---------------- CONFIG (per device, from the CR portal) -------------- */
static const char* WIFI_SSID     = CONFIG_WIFI_SSID;    // -DCONFIG_WIFI_SSID=\"...\"
static const char* WIFI_PASSWORD = CONFIG_WIFI_PASSWORD;
static const char* API_HOST      = "iubcr.vercel.app";  // no scheme, no slash
static const char* DEVICE_ID     = CONFIG_DEVICE_ID;   // dev_xxxxxxxxxxxx
static const char* DEVICE_SECRET = CONFIG_SECRET;      // 64 hex chars

/* ---------------- PINS ----------------------------------------------- */
// R503 (UART2): green RX wire -> TX (17), blue TX wire -> RX (16), red 3V3, black GND
static const int PIN_FP_RX = 16;
static const int PIN_FP_TX = 17;
static const int PIN_BUZZ  = 25;   // passive buzzer via 100R
static const int PIN_LED_R = 26;   // red   (reject / wifi down)
static const int PIN_LED_G = 27;   // green (marked)
static const int PIN_LED_B = 14;   // blue  (enrollment / sync)

/* ---------------- TUNABLES ------------------------------------------- */
static const uint32_t SCAN_RETRY_MS   = 3500;   // re-arm after a scan
static const uint32_t HB_EVERY_MS     = 5 * 60 * 1000; // heartbeat cadence
static const size_t   QUEUE_LIMIT     = 500;    // offline ring capacity
static const int      HTTP_TIMEOUT_MS = 12000;

/* ---------------- GLOBALS -------------------------------------------- */
static HardwareSerial fpSerial(2);
static Adafruit_Fingerprint finger(&fpSerial);
static Adafruit_SSD1306 oled(128, 64, &Wire, -1);
static WiFiUDP ntpUdp;
static NTPClient ntp(ntpUdp, "pool.ntp.org", 5 * 3600, 60 * 60 * 1000); // PKT=UTC+5

static char hmacKey[65];          // sha256(secret), hex
static char scanIdBuf[45];        // current scan uuid
static uint32_t lastHbMs = 0;

/* ============================ crypto ================================= */
static void toHex(const uint8_t* in, size_t len, char* out, size_t outLen) {
  const char* h = "0123456789abcdef";
  for (size_t i = 0; i < len && 2 * i + 1 < outLen; i++) {
    out[2 * i]     = h[in[i] >> 4];
    out[2 * i + 1] = h[in[i] & 0xF];
  }
  out[2 * (len < (outLen - 1) / 2 ? len : (outLen - 1) / 2)] = 0;
}

/** sha256(data) hex -> out (>=65 bytes). Uses mbedtls (ESP32 ROM). */
static void sha256Hex(const char* data, size_t dataLen, char* out) {
  uint8_t digest[32];
  mbedtls_md_context_t ctx;
  mbedtls_md_init(&ctx);
  mbedtls_md_setup(&ctx, mbedtls_md_info_from_type(MBEDTLS_MD_SHA256), 0);
  mbedtls_md_starts(&ctx);
  mbedtls_md_update(&ctx, (const uint8_t*)data, dataLen);
  mbedtls_md_finish(&ctx, digest);
  mbedtls_md_free(&ctx);
  toHex(digest, 32, out, 65);
}

/** HMAC-SHA256(keyHex, payload) -> hex signature (>=65 bytes out). */
static void hmacSha256Hex(const char* keyHex, const char* payload, char* out) {
  uint8_t key[32], mac[32];
  for (int i = 0; i < 32; i++) {
    key[i] = (uint8_t)strtoul(keyHex + 2 * i, NULL, 16);
  }
  mbedtls_md_hmac(mbedtls_md_info_from_type(MBEDTLS_MD_SHA256),
                  key, 32, (const uint8_t*)payload, strlen(payload), mac);
  toHex(mac, 32, out, 65);
}

static void newScanId(char* out, size_t len) { // uuid-v4-ish
  uint8_t rnd[16];
  esp_fill_random(rnd, sizeof(rnd));
  rnd[6] = (rnd[6] & 0x0F) | 0x40;
  rnd[8] = (rnd[8] & 0x3F) | 0x80;
  snprintf(out, len,
    "%02x%02x%02x%02x-%02x%02x-%02x%02x-%02x%02x-%02x%02x%02x%02x%02x%02x",
    rnd[0], rnd[1], rnd[2], rnd[3], rnd[4], rnd[5], rnd[6], rnd[7],
    rnd[8], rnd[9], rnd[10], rnd[11], rnd[12], rnd[13], rnd[14], rnd[15]);
}

/* ============================ feedback =============================== */
static void beep(int n, int ms = 60) {
  for (int i = 0; i < n; i++) {
    digitalWrite(PIN_BUZZ, HIGH); delay(ms); digitalWrite(PIN_BUZZ, LOW);
    if (i < n - 1) delay(80);
  }
}
static void led(int r, int g, int b) {
  digitalWrite(PIN_LED_R, r); digitalWrite(PIN_LED_G, g); digitalWrite(PIN_LED_B, b);
}
static void oledMsg(const char* l1, const char* l2 = "", const char* l3 = "") {
  oled.clearDisplay(); oled.setCursor(0, 0); oled.setTextSize(1); oled.setTextColor(SSD1306_WHITE);
  oled.println(l1); oled.println(l2); oled.println(l3); oled.display();
}

/* ============================ offline queue =========================== */
/* One line per queued scan (bounded, crash-safe on reboot):
 * occurredAt|fingerprintId|scanId
 */
static void queueAppend(uint64_t occurredAt, uint16_t fid, const char* scanId) {
  File f = LittleFS.open("/queue.log", FILE_APPEND);
  if (!f) return;
  f.printf("%llu|%u|%s\n", (unsigned long long)occurredAt, fid, scanId);
  f.close();
}
static size_t queueDepth() {
  File f = LittleFS.open("/queue.log", FILE_READ);
  if (!f) return 0;
  size_t n = 0; while (f.available() && f.readStringUntil('\n').length()) n++;
  f.close(); return n;
}
static void queueDropFirst(size_t count) { // ring bound: drop oldest
  File f = LittleFS.open("/queue.log", FILE_READ);
  if (!f) return;
  String all = f.readString(); f.close();
  File g = LittleFS.open("/queue.tmp", FILE_WRITE);
  size_t skipped = 0; int start = 0;
  while (start < (int)all.length() && skipped < count) {
    int nl = all.indexOf('\n', start);
    if (nl < 0) break;
    start = nl + 1; skipped++;
  }
  g.print(all.substring(start)); g.close();
  LittleFS.remove("/queue.log");
  LittleFS.rename("/queue.tmp", "/queue.log");
}

/* ============================ API ===================================== */
/** Signed POST. body JSON must be EXACTLY the string that was signed. */
static int apiPost(const char* path, const String& body, String& response,
                   const char* scanIdOverride = nullptr) {
  if (WiFi.status() != WL_CONNECTED) return -1;
  time_t nowS = time(nullptr);
  int64_t ts = (int64_t)nowS * 1000;
  newScanId(scanIdBuf, sizeof(scanIdBuf));
  const char* nonce = scanIdOverride ? scanIdOverride : scanIdBuf;

  char tsBuf[24]; snprintf(tsBuf, sizeof(tsBuf), "%lld", (long long)ts);
  String payload = String(DEVICE_ID) + "|" + tsBuf + "|" + nonce + "|" + body;

  char sig[65]; hmacSha256Hex(hmacKey, payload.c_str(), sig);

  WiFiClientSecure client; client.setInsecure(); // TODO phase-3: pin the cert
  HTTPClient http;
  if (!http.begin(client, String("https://") + API_HOST + path)) return -2;
  http.setTimeout(HTTP_TIMEOUT_MS);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Id", DEVICE_ID);
  http.addHeader("X-Timestamp", tsBuf);
  http.addHeader("X-Scan-Id", nonce);
  http.addHeader("X-Signature", sig);
  int code = http.POST(body);
  if (code > 0) response = http.getString();
  http.end();
  return code;
}

/** The scan flow. Returns after user feedback. */
static void doScan(uint16_t fid, uint64_t occurredAt, const char* scanId,
                   bool offlineQueued) {
  JsonDocument body;
  body["fingerprintId"] = fid;
  body["scanId"] = scanId;
  body["occurredAt"] = (JsonVariant)occurredAt;
  String bodyStr; serializeJson(body, bodyStr);
  if (occurredAt == 0) { // live scan: no occurredAt field at all
    bodyStr = String("{\"fingerprintId\":") + fid + ",\"scanId\":\"" + scanId + "\"}";
  }

  String resp; int code = apiPost("/api/device/scan", bodyStr, resp, scanId);
  if (code == -1 || code == -2) { // wifi down -> queue for later sync
    if (!offlineQueued) queueAppend(occurredAt ? occurredAt : (uint64_t)time(nullptr) * 1000, fid, scanId);
    oledMsg("WiFi down", "Scan queued", String(queueDepth()) + " waiting");
    led(1, 1, 0); beep(1);
    return;
  }
  JsonDocument doc; deserializeJson(doc, resp);
  const char* result = doc["result"] | "";
  if (doc["ok"] == true || strcmp(result, "duplicate") == 0) {
    if (strcmp(result, "duplicate") == 0) {
      oledMsg("Salam", doc["name"] | "?", "already marked");
      led(0, 0, 1); beep(1);
    } else {
      oledMsg("Marked:", doc["name"] | "shukriya",
              doc["session"]["subject"] | "");
      led(0, 1, 0); beep(2, 40);
    }
  } else if (strcmp(result, "no_class") == 0) {
    oledMsg("No class now", "Per timetable", "device locked");
    led(1, 0, 0); beep(3);
  } else {
    oledMsg("Not enrolled", "CR se enroll", "karwao pehle");
    led(1, 0, 0); beep(3);
  }
}

/** Drain the offline queue (oldest first), honoring pacing. */
static void syncQueue() {
  while (WiFi.status() == WL_CONNECTED) {
    File f = LittleFS.open("/queue.log", FILE_READ);
    if (!f) return;
    String line = f.readStringUntil('\n');
    f.close();
    if (!line.length()) { LittleFS.remove("/queue.log"); return; }

    int p1 = line.indexOf('|'), p2 = line.indexOf('|', p1 + 1);
    uint64_t occurredAt = strtoull(line.c_str(), NULL, 10);
    uint16_t fid = (uint16_t)line.substring(p1 + 1, p2).toInt();
    String scanId = line.substring(p2 + 1); scanId.trim();
    doScan(fid, occurredAt, scanId.c_str(), true);
    queueDropFirst(1);
    delay(300); // gentle with the serverless API
  }
}

/* ============================ enrollment =============================== */
static void enrollFlow(bool enrollPinned) { // enrollmentMode came via heartbeat
  oledMsg("ENROLL MODE", "CR ne PIN diya hai", "unho ne likhwalo");
  led(0, 0, 1);
  // two placements, matching on-device at the end (sensor-side template)
  for (uint8_t slot = 1; slot <= 192; slot++) {
    if (finger.loadModel(slot) != FINGERPRINT_OK) { // first free slot
      int tries = 0;
      for (uint8_t step = 1; step <= 2; step++) {
        oledMsg("Finger #1:", step == 1 ? "place & lift" : "place again", "");
        int st;
        while ((st = finger.getImage()) != FINGERPRINT_OK) { delay(100);
          if (++tries > 600) return; }
        if (finger.image2Tz(step) != FINGERPRINT_OK) return;
        if (step == 2 && finger.createModel() != FINGERPRINT_OK) return;
        if (step == 2 && finger.storeModel(slot) != FINGERPRINT_OK) return;
      }
      // PIN: typed on the CR portal shown next to the student (phase-3 keypad
      // or CR relays it): here we take it from serial for the field trial
      oledMsg("PIN daalo", "Serial console", "(CR kehl raha hai)");
      while (!Serial.available()) delay(50);
      String pin = Serial.readStringUntil('\n'); pin.trim();
      JsonDocument body;
      body["fingerprintId"] = slot;
      body["pin"] = pin;
      String bs; serializeJson(body, bs);
      String resp; int code = apiPost("/api/device/enroll", bs, resp);
      JsonDocument doc; deserializeJson(doc, resp);
      if (code == 200 && doc["ok"] == true) {
        oledMsg("Enrolled:", doc["name"] | "done", "shukriya!");
        led(0, 1, 0); beep(2, 40);
      } else {
        oledMsg("Enroll failed", doc["reason"] | "try again", "CR se check");
        led(1, 0, 0); beep(3);
      }
      return;
    }
  }
  oledMsg("Sensor full", "192/192", "");
}

/* ============================ setup/loop =============================== */
void setup() {
  Serial.begin(115200);
  pinMode(PIN_BUZZ, OUTPUT); pinMode(PIN_LED_R, OUTPUT);
  pinMode(PIN_LED_G, OUTPUT); pinMode(PIN_LED_B, OUTPUT);
  led(1, 0, 0);

  Wire.begin(21, 22); // SDA=21 SCL=22
  if (!oled.begin(SSD1306_SWITCHCAPVCC, 0x3C)) { /* keep going without it */ }
  oledMsg("Tri3M", "attendance device", "booting...");

  if (!LittleFS.begin(true)) { oledMsg("FS error", "re-flash", ""); }
  sha256Hex(DEVICE_SECRET, strlen(DEVICE_SECRET), hmacKey); // THE HMAC key

  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  for (int i = 0; i < 40 && WiFi.status() != WL_CONNECTED; i++) { delay(250); }
  ntp.begin();
  configTime(5 * 3600, 0, "pool.ntp.org", "time.google.com"); // PKT, no DST

  fpSerial.begin(57600, SERIAL_8N1, PIN_FP_RX, PIN_FP_TX);
  finger.begin(57600);
  if (finger.verifyPassword() != FINGERPRINT_OK) {
    oledMsg("Sensor error", "R503 wiring?", "RX16 TX17");
    led(1, 0, 0); beep(5);
  } else {
    oledMsg("Ready", WiFi.status() == WL_CONNECTED ? "online" : "OFFLINE",
            String(queueDepth()) + " queued");
    led(WiFi.status() == WL_CONNECTED ? 0 : 1, WiFi.status() == WL_CONNECTED ? 1 : 0, 0);
    if (WiFi.status() == WL_CONNECTED) syncQueue();
  }
}

void loop() {
  if (WiFi.status() != WL_CONNECTED) { // keep trying quietly
    WiFi.reconnect(); delay(2500);
    if (WiFi.status() == WL_CONNECTED) { ntp.update(); syncQueue(); }
  }

  // heartbeat every 5 min — also the enrollment-mode poll
  uint32_t ms = millis();
  if (WiFi.status() == WL_CONNECTED && ms - lastHbMs >= HB_EVERY_MS) {
    lastHbMs = ms;
    String resp; int code = apiPost("/api/device/heartbeat", "{\"fwVersion\":\"1.0.0\"}", resp);
    if (code == 200) {
      JsonDocument doc; deserializeJson(doc, resp);
      if (doc["enrollmentMode"] == "on") enrollFlow(true);
    }
  }

  // finger poll — non-blocking-ish; the sensor buffers a touch
  uint8_t st = finger.getImage();
  if (st == FINGERPRINT_NOFINGER) { delay(80); return; }
  if (st != FINGERPRINT_OK) { delay(300); return; }
  if (finger.image2Tz() != FINGERPRINT_OK) { led(1, 0, 0); beep(3); delay(SCAN_RETRY_MS); return; }
  if (finger.fingerSearch() != FINGERPRINT_OK) {
    oledMsg("Not recognized", "enroll first", "");
    led(1, 0, 0); beep(3); delay(SCAN_RETRY_MS); return;
  }
  // matched locally: template index = finger.fingerID (1..192)
  uint64_t nowMs = (uint64_t)time(nullptr) * 1000;
  char sid[45]; newScanId(sid, sizeof(sid));
  doScan(finger.fingerID, nowMs, sid, false);
  delay(SCAN_RETRY_MS);
}
