---
title: Tri3M Gateway
emoji: 📨
colorFrom: blue
colorTo: green
sdk: docker
app_port: 7860
pinned: false
---

# Tri3M WhatsApp Gateway — Cloud (24/7, free)

Laptop-free edition. Baileys + MongoDB-backed session + deadline sweep engine.

## Secrets (Space → Settings → Variables and secrets)
- `MONGODB_URI` — Atlas connection string (same as Vercel)
- `QR_SECRET` — password for the /qr page (koi bhi lamba random string)
- `POLL_SECONDS` (optional, default 60)

## First run
1. Space URL kholo: `https://<space-url>/qr?key=<QR_SECRET>`
2. Phone se QR scan karo → session MongoDB mein save
3. `https://<space-url>/` pe status dekho: `"whatsapp": "connected"`

Session restart/rebuild/redeploy ke baad bhi zinda rehta hai (MongoDB mein hai) — QR sirf logout hone par dobara chahiye.

Keep-alive: ek 15-min ping (cron-job.org/UptimeRobot) Space URL par → Space kabhi sleep nahi karega.
