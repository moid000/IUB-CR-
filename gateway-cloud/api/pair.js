import QRCode from 'qrcode';
import { connectMongo } from '../src/mongo.js';
import { authed, unauthorized, normalizePk } from '../src/gwsecrets.js';
import { openSocket, waitFor, isPaired } from '../src/sock.js';

/**
 * WhatsApp PAIRING page (secret: QR_SECRET).
 *
 * Vercel functions are ephemeral, so pairing works like this:
 *   1. Owner opens /api/pair?key=…&phone=03xxxxxxxxx
 *   2. This invocation opens a socket from the Mongo session, requests a
 *      PAIRING CODE, renders it (+ QR image) and KEEPS THE SOCKET ALIVE
 *      for ~50s so the code stays valid while it is entered.
 *   3. Owner enters the code: WhatsApp → Settings → Linked devices →
 *      Link with phone number. creds.update fires → session saved to Mongo.
 *   4. Page polls /api/status and confirms "Paired ✓".
 *   5. If the window was missed, the page auto-refreshes → new code.
 *
 * Pairing is needed ONCE. After that every sweep invocation connects
 * instantly from the saved session — laptop stays off forever.
 */

const HOLD_MS = 48000;
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
  .code{font-size:38px;letter-spacing:8px;font-weight:800;color:#4ade80;margin:18px 0}
  .qr{margin:16px auto;width:300px;background:#fff;padding:10px;border-radius:12px}
  input{font-size:18px;padding:12px;border-radius:10px;border:1px solid #334155;
        background:#0f172a;color:#e2e8f0;width:100%;box-sizing:border-box;text-align:center}
  button{margin-top:14px;font-size:16px;padding:12px 26px;border-radius:10px;border:0;
         background:#2563eb;color:#fff;font-weight:700;width:100%;cursor:pointer}
  .ok{color:#4ade80;font-size:22px;font-weight:800}
  .err{color:#f87171}
  ol{text-align:left;font-size:14px;color:#94a3b8;line-height:1.8}
</style></head><body><div class="card">${body}</div></body></html>`;
}

async function render(res, body, { holdMs = 0, wait } = {}) {
  res.statusCode = 200;
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.write(body);
  if (wait) await wait;
  if (holdMs) await new Promise((r) => setTimeout(r, holdMs));
  res.end();
}

export default async function handler(req, res) {
  if (!authed(req, 'QR_SECRET')) return unauthorized(res);

  const url = new URL(req.url, 'http://x');
  const phone = url.searchParams.get('phone');

  try {
    await connectMongo();

    const registered = await isPaired(); // Mongo creds check — no socket opened
    if (registered) {
      return render(res, shell(
        `<h1>✅ Already paired</h1>
         <p>Gateway session is linked. Nothing to do here —
         <a style="color:#60a5fa" href="/api/status?key=${KEY}">status</a></p>`));
    }

    if (!phone) {
      return render(res, shell(
        `<h1>Pair WhatsApp</h1>
         <p>Apna WhatsApp number daalo (03… ya 92…). Isi number par pairing code generate hoga.</p>
         <form method="GET">
           <input name="key" type="hidden" value="${KEY}">
           <input name="phone" placeholder="03xx-xxxxxxx" autofocus>
           <button type="submit">Get pairing code</button>
         </form>`));
    }

    const digits = normalizePk(phone);
    if (!digits) {
      return render(res, shell(
        `<h1 class="err">Invalid number</h1>
         <p>PK number 03… ya 92… format mein daalo. <a style="color:#60a5fa" href="/api/pair?key=${KEY}">Wapas</a></p>`));
    }

    // Open the real socket and request a pairing code
    const { sock, events, end } = await openSocket();
    await waitFor(() => events.qr || events.connected || events.closed, { timeoutMs: 12000 });

    if (events.connected) {
      end();
      return render(res, shell('<h1 class="ok">✅ Paired!</h1><p>Session saved.</p>'));
    }
    if (!events.qr) {
      end();
      return render(res, shell(
        `<h1 class="err">WhatsApp handshake failed</h1>
         <p>Thodi der baad page refresh karo.</p>`));
    }

    let code = null;
    try {
      code = await sock.requestPairingCode(digits);
    } catch (err) {
      end();
      return render(res, shell(
        `<h1 class="err">Pairing code error</h1><p>${err.message}</p>
         <p><a style="color:#60a5fa" href="/api/pair?key=${KEY}">Dobara try karo</a></p>`));
    }

    const qrDataUrl = await QRCode.toDataURL(events.qr, { width: 300, margin: 2 });

    // Page shows the code + QR, polls status, and holds this socket alive
    // while the owner enters the code.
    const pairedPromise = waitFor(() => events.connected || events.closed, {
      timeoutMs: HOLD_MS - 2000, everyMs: 500,
    });

    const body = shell(`
      <h1>Pairing code</h1>
      <p>Is number par: <b style="color:#e2e8f0">+${digits}</b></p>
      <div class="code" id="code">${code ?? '…'}</div>
      <ol>
        <li>Phone mein WhatsApp kholo</li>
        <li><b>Settings → Linked devices → Link with phone number</b></li>
        <li>Upar wala code enter karo (ya neeche QR scan karo)</li>
      </ol>
      <div class="qr"><img src="${qrDataUrl}" alt="QR" width="280"></div>
      <p id="status">Code ~50s ke liye valid hai — window nikal jaye to page khud naya code layega…</p>
      <script>
        (function(){
          var done = false;
          var el = document.getElementById('status');
          setInterval(function(){
            fetch('/api/status?key=${KEY}')
              .then(function(r){return r.text()})
              .then(function(t){
                if (t.indexOf('"paired":true') !== -1 && !done) {
                  done = true;
                  document.body.innerHTML = '<div class="card"><h1 class="ok">✅ Paired!</h1><p>WhatsApp linked — gateway ab 24/7 serverless sends karega. Ye page band kar sakte ho.</p></div>';
                }
              }).catch(function(){});
          }, 4000);
        })();
      </script>`);

    await render(res, body, { wait: pairedPromise.then(() => {
      end();
    }), holdMs: 0 });

    end();
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'text/html; charset=utf-8');
    res.end(shell(`<h1 class="err">Error</h1><p>${err.message}</p>`));
  }
}
