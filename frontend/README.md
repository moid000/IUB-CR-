# IUB LMS — Frontend

React 18 + Vite + React Router + Tailwind CSS v4. Served by the same Vercel
project as the API (`/api/*` → serverless function, everything else → this SPA).

## Dev

```bash
# terminal 1 — backend (repo root): http://localhost:3000
npm run dev

# terminal 2 — frontend: http://localhost:5173 (proxies /api → :3000)
cd frontend && npm install && npm run dev
```

## Production

`npm run build` → `dist/`. No secrets are required at build time — the bundle
talks to the same-origin `/api/*`; authentication is the httpOnly `iub_auth`
cookie, so the JWT is never touched by JavaScript.

## Structure

- `src/api/` — centralized API client (error normalization, credentials include)
- `src/auth/` — session context + role-aware route guards
- `src/components/ui/` — reusable primitives (Button, Input, OtpInput, Modal, …)
- `src/pages/` — login, activation, password recovery, role placeholders
