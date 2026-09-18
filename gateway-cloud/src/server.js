import http from 'node:http';

/**
 * Tiny status + secret-QR web server. The host (HF Spaces) needs an open HTTP
 * port anyway; it doubles as the keep-alive ping target and lets the owner
 * scan the WhatsApp QR from the browser — no terminal needed.
 *
 * Routes:
 *   GET /                    → public status JSON (no secrets, no QR)
 *   GET /qr?key=<SECRET>     → QR page (the ONLY place the QR is exposed)
 *   anything else            → 404
 */

let qrSecret = 'dev-secret';
let port = 7860;

export function initServer({ secret, portNumber }) {
  qrSecret = secret;
  port = portNumber;
}

function statusJson(extra) {
  return JSON.stringify(extra, null, 2);
}

export function startServer(getStatus, getQrDataUrl) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    if (url.pathname === '/') {
      const s = getStatus();
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(statusJson(s));
      return;
    }
    if (url.pathname === '/qr') {
      if (url.searchParams.get('key') !== qrSecret) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('Not found');
        return;
      }
      const s = getStatus();
      let body;
      if (s.connected) {
        body = '<h2>✅ WhatsApp already connected</h2><p>Session MongoDB mein saved hai — QR ki zarurat nahi.</p>';
      } else if (getQrDataUrl()) {
        body = `<h2>📱 WhatsApp QR</h2>
          <p>Phone: WhatsApp → Settings → Linked Devices → Link a Device</p>
          <img src="${getQrDataUrl()}" alt="QR" style="width:320px;height:320px" />
          <p>(Page har 5 second mein refresh hota hai)</p>`;
      } else {
        body = '<h2>QR generate ho raha hai…</h2><p>5 second mein refresh.</p>';
      }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(`<!doctype html><html><head><meta charset="utf-8">
        <meta name="viewport" content="width=device-width,initial-scale=1">
        <meta http-equiv="refresh" content="5">
        <title>Tri3M Gateway</title>
        <style>body{font-family:system-ui,sans-serif;display:flex;flex-direction:column;align-items:center;padding:24px;background:#f8fafc}img{border:8px solid #fff;border-radius:8px;box-shadow:0 2px 8px rgba(0,0,0,.15)}</style>
        </head><body>${body}</body></html>`);
      return;
    }
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });
  server.listen(port, () => console.log(`🌐 HTTP server on :${port} — status at "/" , QR at "/qr?key=***"`));
  return server;
}
