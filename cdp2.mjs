// Generic CDP driver: node cdp2.mjs <wss> '<json commands array>'
// Each item: {m: "method", p: params, wait: ms, eval: "expression"}
import { createRequire } from 'node:module';
const require = createRequire(process.cwd() + '/package.json');
const WebSocket = require('ws');
const [wss, cmdJson] = process.argv.slice(2);
const cmds = JSON.parse(cmdJson);
const ws = new WebSocket(wss);
let id = 0;
const pending = new Map();
const events = [];
ws.onmessage = (m) => {
  const d = JSON.parse(m.data);
  if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result ?? d.error); pending.delete(d.id); }
  else if (d.method) events.push(d);
};
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.on('open', r));
const results = [];
for (const c of cmds) {
  if (c.wait) await new Promise((r) => setTimeout(r, c.wait));
  if (c.eval) {
    const out = await send('Runtime.evaluate', { returnByValue: true, awaitPromise: true, expression: c.eval });
    results.push({ step: c.name ?? 'eval', out: out.result ?? out.exceptionDetails });
  } else {
    const out = await send(c.m, c.p ?? {});
    results.push({ step: c.name ?? c.m, out });
  }
}
console.log(JSON.stringify(results, (k, v) => (k === 'description' ? undefined : v), 1).slice(0, 6000));
ws.close();
