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

Secrets live only in Vercel environment variables — never in Git, never in
frontend code, never in API responses.

## Deployment

Vercel project: `iub_cr_lms`. Pushing to `main` deploys; `vercel deploy --prod`
also works. Health check: `GET /api/health`.
