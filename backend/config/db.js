import mongoose from 'mongoose';
import { env } from './env.js';

/**
 * Cached MongoDB connection for Vercel Serverless.
 *
 * - Warm invocations reuse the same connection promise (stored on globalThis,
 *   which persists across invocations of the same lambda instance).
 * - Cold starts create exactly one connection.
 * - On failure the cache is cleared so the next invocation can retry.
 * - Errors never contain the connection string or credentials.
 */
export async function connectDB() {
  if (globalThis.__mongoConn) return globalThis.__mongoConn;

  const connectPromise = mongoose
    .connect(env.mongoUri, {
      serverSelectionTimeoutMS: 10_000,
    })
    .catch((err) => {
      globalThis.__mongoConn = null; // allow retry on the next invocation
      throw err;
    });

  globalThis.__mongoConn = connectPromise;
  return connectPromise;
}

export async function dbStatus() {
  const states = {
    0: 'disconnected',
    1: 'connected',
    2: 'connecting',
    3: 'disconnecting',
  };
  return states[mongoose.connection.readyState] || 'unknown';
}
