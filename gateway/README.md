# Tri3M WhatsApp Gateway (Free — Baileys)

UltraMsg ka free replacement. Apne laptop/PC par chalta hai — koi payment nahi, koi trial nahi, koi limit nahi.

## Kya karta hai
- Assignment ki deadline khatam hote hi subject ke teacher ko WhatsApp messages
- 1 summary (submitted + not-submitted list, roll numbers ke saath)
- Phir har submitted student ka message — **asli file attachment ke saath** (link nahi, actual file!)
- Vercel wale engine se same claim system — kabhi double-send nahi hota
- Laptop band ho aur deadline miss ho jaye? Next start pe 24 ghante ki sab kuch catch-up

## Setup (ek dafa, 10 minute)

**1. Node.js install karo** (agar pehle se nahi): https://nodejs.org se LTS version (18+).

**2. Repo lao aur gateway folder mein jao:**
```
git pull https://github.com/moid000/IUB-CR-.git
cd IUB-CR-/gateway
```
(ya seedha repo download karke folder khol lo)

**3. `.env` file banao** (gateway folder ke andar) aur yeh line daalo:
```
MONGODB_URI=mongodb+srv://mofenabler_db_user:PASSWORD@iubcrlms.sdocxzg.mongodb.net/iubcrlms
```
PASSWORD apna Atlas DB password hai (wahi jo tumne 13 Sept ko reset kiya tha). Vercel Dashboard → Settings → Environment Variables mein bhi yehi `MONGODB_URI` ki value hai — wahan se copy kar sakte ho.

**4. Install + start:**
```
npm install
npm start
```

**5. QR scan karo** — terminal mein QR aa jayega. Phone par:
WhatsApp → Settings → **Linked Devices** → **Link a Device** → QR scan.

Bas. `✅ WhatsApp connected` aa gaya to system LIVE hai. Terminal ka window open rehne do.

## Roz ka usage
- Laptop on → terminal mein `npm start` (ya window wahi chalta rehne do)
- QR sirf pehli dafa maangta hai — session `auth/` folder mein save rehta hai
- `❌ Logged out` aaye to bas dobara QR scan kar do (khud naya QR generate ho jayega)

## Notes
- UltraMsg wala cron-job.org job ka kaam ab zaroori nahi — gateway khud poll karta hai. Chalta rehne do koi masla nahi (double-send claim system se impossible hai), lekin disable bhi kar sakte ho.
- Number format: CR portal pe jo bhi format likha ho (0301… ya 92301…), gateway khud normalize karta hai.
- Files: Cloudinary se download kar ke asli WhatsApp document banta hai. Agar download fail ho to link fallback.
