import { connectMongo } from '../src/mongo.js';
import { authed, unauthorized } from '../src/gwsecrets.js';
import { openSocket, senderFrom, waitFor, isPaired } from '../src/sock.js';
import { runSweep } from '../src/sweep.js';
import { Assignment, WaStore } from '../src/models.js';

const WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * SERVERLESS deadline sweep (Vercel, pinged by cron-job.org every 5 min).
 *
 * Cheap path first: if NOTHING is due, no WhatsApp socket is opened at all.
 * Only when an assignment is due does this connect Baileys (session from
 * Mongo), send summary + per-submission messages, and disconnect.
 * Same deadlineNotifiedAt claim as every other engine → no double sends.
 */

async function saveMeta(patch) {
  await WaStore.findByIdAndUpdate('meta-gateway', { $set: patch }, { upsert: true })
    .catch(() => {});
}

export default async function handler(req, res) {
  if (!authed(req, 'SWEEP_SECRET')) return unauthorized(res);

  const started = Date.now();
  try {
    await connectMongo();

    const nowMs = Date.now();
    const dueQuery = {
      status: 'published',
      deadline: { $lte: nowMs, $gte: new Date(nowMs - WINDOW_MS) },
      deadlineNotifiedAt: null,
    };
    const dueCount = await Assignment.countDocuments(dueQuery);
    const paired = await isPaired();

    if (!dueCount) {
      await saveMeta({ lastSweepAt: new Date(), lastResult: 'idle' });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        ok: true, due: 0, paired, idle: true, ms: Date.now() - started,
      }));
    }

    if (!paired) {
      // Due work exists but nobody ever paired the gateway — leave claims
      // untouched (24h window keeps retrying) and say so loudly.
      await saveMeta({ lastSweepAt: new Date(), lastResult: 'unpaired' });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        ok: true, due: dueCount, paired, idle: false,
        error: 'assignments due but gateway not paired — open /api/pair to link WhatsApp',
      }));
    }

    const { sock, events, end } = await openSocket();
    const live = await waitFor(() => events.connected || events.closed, { timeoutMs: 25000 });

    if (!live || !events.connected) {
      end();
      await saveMeta({
        lastSweepAt: new Date(),
        lastResult: `socket-fail (${events.reason ?? 'timeout'})`,
      });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      return res.end(JSON.stringify({
        ok: false, due: dueCount, paired,
        error: 'whatsapp socket failed to connect', reason: events.reason ?? 'timeout',
      }));
    }

    const send = senderFrom(sock);
    await runSweep(send);
    end();
    await saveMeta({ lastSweepAt: new Date(), lastResult: `swept ${dueCount}` });

    res.statusCode = 200;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({
      ok: true, due: dueCount, paired, idle: false, ms: Date.now() - started,
    }));
  } catch (err) {
    res.statusCode = 500;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}
