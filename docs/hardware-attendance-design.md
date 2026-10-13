# Hardware-Integrated Attendance System — Design (fingerprint / IoT)

Owner goal (2026-10-13): a fingerprint/IoT attendance device at the classroom
door that feeds Tri3M's existing attendance pipeline, with WhatsApp
integration and zero ongoing cost beyond the device itself.

Status: DESIGN. Nothing here is implemented yet; Phase 1 below is the
first code milestone.

## 1. What exists today (build on, don't replace)

- `AttendanceSession` (section, subject, codeHash, opensAt/expiresAt,
  status open/cancelled) — created by CR with a code/QR students self-mark.
- `AttendanceRecord` — append-only, ONE per student per session (unique
  index), method 'code' today; corrections are status flips + audit log.
- Portal pages (CR/student/admin), WhatsApp bot + Wasender gateway,
  MongoDB Atlas, Vercel serverless. Free-stack rule applies to this design.

The hardware path REUSES both collections: a device-opened session is just
an AttendanceSession with `method: 'device'` records. Portal, stats and any
future reports work unchanged.

## 2. Hardware (one-time ~PKR 4,000–6,000 / ~$15)

| Part | Choice | Why |
|---|---|---|
| MCU | ESP32-WROOM-32 dev board | WiFi+Ble, HTTPS/TLS in ROM, cheap, huge community |
| Sensor | R503 capacitive fingerprint (UART) | Stores templates ON-SENSOR (up to 192), matching happens locally; matches the enrollment model below |
| Feedback | 0.96" I2C OLED + passive buzzer + RGB LED | name + tick/cross, no phone needed |
| Power | 5V 2A USB adapter | classroom-safe |

Optional later: RFID reader for visitors, camera module is explicitly OUT
of scope (privacy + cost).

**Buddy-punching resistance** (physical layer): the sensor is at the door,
one scan per student per session is enforced server-side (existing unique
index already guarantees it), and the device auto-opens the session from the
live timetable slot — so there is no session to punch into before class.

## 3. Data flow

```
Student places finger → R503 matches template locally (ID or "not found")
  → ESP32 builds scan event {deviceId, fingerprintId, scanId, ts, slotHint}
  → HMAC-SHA256 (device secret) → POST /api/device/scan (HTTPS)
  → backend: verify sig + window + device status
  → resolves fingerprintId → student (Section-scoped binding)
  → marks AttendanceRecord (method 'device', idempotent by scanId)
  → JSON result {ok, studentFirstName?, already?} → OLED shows ✓/✗/dup
WiFi down? → event queued on flash (FATFS/LittleFS ring, ~500 events),
  synced later with the SAME scanId → backend dedupes, timestamps preserved.
```

Fingerprint TEMPLATES never leave the device. The backend only ever sees
the sensor's template index (1..192) per device — nothing biometric is
stored in Atlas. Enrollment templates live inside the R503's own storage;
losing a device loses nothing but the enrollment (re-enroll is 2 touches).

## 4. Backend additions

### 4.1 New model `AttendanceDevice`

```
section (ref, required)            // one device per section initially
label            "3M door device"
secretHash       bcrypt(sha256(deviceSecret))   // device proves itself with HMAC over the raw secret
secretLast4      for the admin panel "…a1b2" display
fingerprint      { capacity: 192 }
enrollmentMode   off | on         // CR toggles from portal to enroll a student
enrolledCount    number
status           active | revoked
lastSeenAt       heartbeat ts
fwVersion        string
```

- Secret is shown ONCE at registration (same UX as wipe codes).
- Revocation is instant: `/api/device/scan` rejects revoked devices.
- All device routes are rate-limited (per-device 30/min) and audit-logged.

### 4.2 New routes (`/api/device/*`, separate from student auth)

| Route | Purpose |
|---|---|
| `POST /api/device/register` | CR/admin creates device; returns deviceId+secret once |
| `POST /api/device/heartbeat` | 5-min liveness + queue depth; watchdog data for ops |
| `POST /api/device/scan` | THE ingestion endpoint (HMAC-signed) |
| `POST /api/device/enroll` | enrollment-mode template capture (step 5) |
| `GET/POST /api/admin/attendance-devices` | admin panel CRUD, rotate secret, revoke |

### 4.3 `POST /api/device/scan` — the security contract

```
Headers: X-Device-Id, X-Timestamp (epoch ms), X-Scan-Id (uuid from device),
         X-Signature = HMAC_SHA256(secret, deviceId + ts + scanId + body)
Body:    { fingerprintId: 1..192 }
Rules:
  - |now - ts| ≤ 90s (replay window; LittleFS-synced offline events get a
    separate signed "offlineSync" envelope with original ts + server-side
    session-time validation instead)
  - scanId idempotent (DeviceScanEvent upsert, same shape as
    WhatsAppEvent.botHandled claim — redelivery never double-marks)
  - device must be active + bound to a section
  - fingerprintId must be enrolled AND bound to a User in that section
Session resolution:
  1. an OPEN device session for the section right now → mark it
  2. else the live timetable slot (confirmed, started ≤ 20 min ago) →
     auto-open a session (method 'device') and mark
  3. else if within 10 min before a slot → open early-bird session
  4. else reject {ok:false, reason:'no_class'} (buzzer x2) — device is NOT
     a general-purpose attendance kiosk
Reply: { ok, already, name?, session? } — name is FIRST NAME only,
  never roll number + name together on the OLED.
```

## 5. Enrollment (the CR-verified identity link)

Fingerprint template → student binding must never be guessable:

1. CR opens portal → Attendance Devices → "Enroll student" → picks the
   student → portal shows a 4-digit PIN valid 10 min, sets
   `enrollmentMode: on`.
2. Student at device: device shows "Enroll: press finger" → R503 captures
   2 placements → template stored ON SENSOR at index N.
3. Device POSTs `/api/device/enroll {pin, fingerprintId: N}` (HMAC).
4. Backend validates pin + section, creates
   `FingerprintBinding {section, user, deviceId, fingerprintId, enrolledBy}`,
   turns enrollmentMode off. Binding is per-section — a fingerprint in 3M
   means nothing in 2M's device.
5. Duplicate-person check: portal warns if the student already has a
   binding; old binding is revoked (status flip, never deleted — same
   append-only rule as attendance).

## 6. Tri3M WhatsApp integration (the actual payoff)

Reuses existing pipes (Wasender pacing, group bot, CR DM, outbox retries):

- **End-of-slot summary to the section group** (via subject-group routing
  or General fallback): "3M • Programming Fundamentals: 34/42 present.
  Absent: <list>". Paced 5.2s, single message, only when a device session
  actually closed with records.
- **Private absent-nudge (opt-in per section, default OFF)**: one short
  DM per absent student, once per day, with the CR copied — never spam.
- **Bot answers**: "@Tri3M aaj ki attendance?" → "Aaj PF me 34/42 aaye
  (81%). Absent: …" — reads AttendanceRecord, never invents. This rides
  the NEW 12-turn memory: "aur kal?" → yesterday's number, context-aware.
- **CR morning digest**: first session of the day's attendance in the CR DM.
- **Device health**: heartbeat stale > 15 min during an active slot →
  one alert to the CR ("device offline, fingerprint attendance paused");
  the CR can fall back to code/QR sessions instantly (existing flow,
  unchanged).

## 7. Failure modes and answers

| Failure | Behavior |
|---|---|
| WiFi/power out at class time | CR opens a code/QR session as today; device syncs any buffered scans after recovery, backend marks them method 'device' into the SAME session if one was open |
| Device stolen/factory-reset | Secret was in NVS; reset wipes it → device can't talk. Revoke + re-register. Templates lost, re-enroll (2 touches/student) |
| Teacher takes class off-site | No timetable slot → device refuses (no_class) → CR opens manual session |
| Two devices one section later | Supported by design (deviceId in bindings/scan events); first rollout is single-device per section |
| Gemini/quota issues | None of this path touches the LLM; ingestion is pure API. Bot answers only READ attendance data |

## 8. Rollout plan

- **Phase 1 — backend skeleton** (next code milestone):
  AttendanceDevice + FingerprintBinding + DeviceScanEvent models,
  register/scan/heartbeat routes with HMAC + idempotency, tests
  (HD-1..: signature replay, revoked device, wrong section, double-scan,
  offline-sync dedupe, auto-open session from timetable, bot answer).
- **Phase 2 — firmware** (Arduino/ESP-IDF sketch in `firmware/attendance-door/`):
  sensor + display + signed HTTPS + LittleFS queue. Tested against the
  deployed Phase-1 API.
- **Phase 3 — portal + WhatsApp**: CR enrollment UI, admin device page,
  group summary + bot lookup, ops-diagnostics device tab.
- **Phase 4 — field trial**: one device on 3M's door for a week; compare
  device vs code attendance for the same slots, then decide rollout.

Everything Phase 1+ stays on the free stack: Atlas, Vercel serverless
(seconds, not minutes), no new paid services.
