# IUB Class Management System

Production backend foundation for the IUB (Islamic University of Bahawalpur) class
management platform with three roles: **ADMIN**, **CR** (class representative),
and **STUDENT**.

## Stack

- **Backend**: Node.js + Express, deployed as a Vercel Serverless Function (`api/index.js`)
- **Database**: MongoDB Atlas + Mongoose (cached serverless connection)
- **Frontend**: React + Vite + Tailwind (later phase)
- **Auth**: JWT in httpOnly cookies, bcrypt, email OTP via Brevo (later phase)
- **Files**: Cloudinary signed direct uploads (later phase)

## Repository structure

```
/
├── backend/
│   ├── config/        # env validation + cached Mongo connection
│   ├── middleware/    # protect / role / sectionScope + error handling
│   ├── models/        # 15 Mongoose models (FileMeta is embedded)
│   ├── routes/        # /api routes (health only in this phase)
│   ├── controllers/   # route controllers
│   ├── services/      # service layer (later phases)
│   └── utils/         # scopedQuery helpers + audit logger
├── frontend/          # placeholder (later phase)
├── api/index.js       # Vercel Serverless entry → Express app
├── scripts/local.js   # local dev server (production runs serverless)
├── tests/             # DB/security invariant tests (in-memory Mongo)
├── vercel.json        # /api/* rewrite to the serverless function
└── package.json
```

## Local development

```bash
npm install
cp .env.example .env    # fill MONGODB_URI + JWT_SECRET
npm run dev             # → http://localhost:8080/api/health
```

## Tests

```bash
npm test
```

Tests run against an **in-memory MongoDB** (mongodb-memory-server). The
production Atlas database is never touched by automated tests.

## Environment variables

| Variable | Required | Notes |
|---|---|---|
| NODE_ENV | no | `production` on Vercel |
| MONGODB_URI | **yes** | Atlas connection string (Vercel env) |
| JWT_SECRET | **yes** | `openssl rand -hex 32` |
| ATTENDANCE_SECRET | later | HMAC key for QR tokens |
| ADMIN_EMAIL | later | env-seeded admin bootstrap |
| BREVO_API_KEY | later | OTP transactional email |
| CLOUDINARY_* | later | signed direct uploads |
| CORS_ORIGIN | no | local dev only; same-origin in production |
| ULTRAMSG_WEBHOOK_SECRET | teacher confirmation | Random 32-byte hex secret in Vercel Production only. Must match the `key` parameter in the UltraMsg received-message webhook URL. |

Secrets live only in Vercel environment variables — never in Git, never in
frontend code, never in API responses.

## Deployment

Vercel project: `iub_cr_lms`. Pushing to `main` deploys; `vercel deploy --prod`
also works. Health check: `GET /api/health`.

## Teacher class confirmation (UltraMsg, no Base44 runtime)

When a CR/GR adds or materially reschedules an upcoming class, the linked subject teacher gets a WhatsApp message identifying the actual department, semester, section, class, time, and CR/GR. Reply with `YES <reference>` or `NO <reference>` (the message includes its unique reference). A plain YES/NO cannot be safely attributed when that teacher has more than one class. The reply updates only that active timetable slot and is visible to students and representatives as confirmed/unavailable. Past classes and subjects without linked teachers never trigger a message.

Production UltraMsg instance settings: Webhook URL `https://iubcr.vercel.app/api/whatsapp/teacher-reply?key=<ULTRAMSG_WEBHOOK_SECRET>`; enable **Webhook on Received** only. Keep other webhook switches/settings unchanged. Set `ULTRAMSG_WEBHOOK_SECRET` as a Vercel Production *secret*, never in Git. The incoming route validates the secret, instance, sender, reference, event type, and linked teacher. Older replies after rescheduling, archiving or unlinking are ignored. Gateway failures never roll back a timetable edit; the existing cron-job.org deadline-sweep ping retries queued/failed confirmation sends up to three times. There is no Base44 data store, workflow or automation involved.
