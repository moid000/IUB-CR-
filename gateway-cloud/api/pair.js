export const maxDuration = 60;
import { connectMongo } from '../src/mongo.js';
import { authed, unauthorized } from '../src/gwsecrets.js';
import { isPaired } from '../src/sock.js';

/**
 * WhatsApp PAIRING page (secret: QR_SECRET) — LIVE CODE DISPLAY mode.
 *
 * History: the original page created its OWN pairing session, which (a)
 * raced with the Vercel 60s function limit and (b) CONFLICTED with the
 * sandbox pairing helper — every auto-reload wiped wa_store, invalidated
 * the sandbox's pairing code and produced "check your number" errors.
 *
 * NOW: the sandbox helper (scripts/pair-sandbox.mjs) owns the single
 * pairing session and pushes every fresh code/QR to /api/live-code.
 * This page is a dumb READ-ONLY display: it polls /api/live-code every
 * 3s and shows the CURRENT code + QR, so the owner can always type the
 * newest code within its ~20-60s life. No socket, no wipe, no code
 * generation happens here. If re-pairing is ever needed, restore the
 * original full flow (git history has it).
 */
const KEY = process.env.QR_SECRET || '';

function shell(body) {
  return `<!doctype html><html><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Tri3M Gateway — Pair WhatsApp</title>
<style>
  body{font-family:system-ui,sans-serif;background:#0f172a;color:#e2e8f0;
       display:flex;align-items:center;justify-content:center;min-height:100vh;margin:0;padding:16px}
  .card{max-width:420px;width:100%;background:#1e293b;border-radius:16px;padding:28px;text-align:center}
  h1{font-size:20px;margin:0 0 6px}
  p{font-size:14px;color:#94a3b8;margin:8px 0;line-height:1.5}
  .code{font-size:40px;letter-spacing:8px;font-weight:800;color:#4ade80;margin:18px 0;
        border:2px dashed #334155;border-radius:12px;padding:12px}
  .age{font-size:12px;color:#64748b}
  .qr{margin:16px auto;width:280px;background:#fff;padding:10px;border-radius:12px}
  .ok{color:#4ade80;font-size:22px;font-weight:800}
  .err{color:#f87171}
  ol{text-align:left;font-size:14px;color:#94a3b8;line-height:1.8}
  .dot{display:inline-block;width:8px;height:8px;border-radius:50%;background:#4ade80;
       margin-right:6px;animation:blink 1.4s infinite}
  @keyframes blink{0%,100%{opacity:1}50%{opacity:.25}}
</style></head><body><div class="card">${body}</div></body></html>`;
}

export default async function handler(req, res) {
  if (!authed(req, 'QR_SECRET')) return unauthorized(res);

  try {
    await connectMongo();
    const registered = await isPaired();
    if (registered) {
      res.setHeader('content-type', 'text/html; charset=utf-8');
      return res.end(shell(
        `<h1>✅ Already paired</h1>
         <p>Gateway session is linked. Nothing to do here —
         <a style="color:#60a5fa" href="/api/status?key=${KEY}">status</a></p>`));
    }

    const body = shell(`
      <h1><span class="dot"></span>Live pairing code</h1>
      <div class="code" id="code">…</div>
      <p class="age" id="age"></p>
      <ol>
        <li>Phone pe: WhatsApp → <b>Settings → Linked devices</b></li>
        <li><b>Link a device</b> → <b>Link with phone number instead</b></li>
        <li>Upar jo code <b>abhi</b> dikh raha hai, FORAN type karo</li>
      </ol>
      <p style="color:#60a5fa">Code apne aap update hota rehta hai. Agar WhatsApp "invalid" bole to rukna mat — is page pe jo NAYA code aaya hai usi waqt phir type karo.</p>
      <div class="qr" id="qrbox" style="display:none"><img id="qr" alt="QR" width="240"></div>
      <p class="age">(QR kisi laptop screen pe khol ke scan bhi kar sakte ho)</p>
      <script>
        (function(){
          var done = false;
          function poll(){
            if (done) return;
            fetch('/api/live-code?key=${KEY}')
              .then(function(r){return r.json()})
              .then(function(d){
                if (d.code) {
                  document.getElementById('code').textContent = d.code;
                  document.getElementById('age').textContent =
                    'ye code ' + (d.ageSec || 0) + ' sec purana hai — jitna naya ho utna behtar';
                }
                if (d.qr) {
                  document.getElementById('qrbox').style.display = 'block';
                  document.getElementById('qr').src = d.qr;
                }
              }).catch(function(){});
          }
          poll();
          setInterval(poll, 3000);
          setInterval(function(){
            if (done) return;
            fetch('/api/status?key=${KEY}')
              .then(function(r){return r.text()})
              .then(function(t){
                if (t.indexOf('"paired":true') !== -1) {
                  done = true;
                  document.body.innerHTML = '<div class="card"><h1 class="ok">✅ Paired!</h1><p>WhatsApp linked — gateway ab 24/7 serverless sends karega. Ye page band kar sakte ho.</p></div>';
                }
              }).catch(function(){});
          }, 3000);
        })();
      </script>`);

    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(body);
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(shell(`<h1 class="err">Error</h1><p>${err.message}</p>`));
  }
}
