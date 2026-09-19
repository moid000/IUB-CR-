/**
 * Web Push client — register SW, ask permission, subscribe via VAPID key.
 * Free VAPID-based web push; no external service.
 */
import { authApi } from '../api/auth.js';

let swRegistration = null;

export async function ensureSw() {
  if (!('serviceWorker' in navigator)) throw new Error('This browser does not support notifications');
  if (!swRegistration) swRegistration = await navigator.serviceWorker.register('/sw.js');
  return swRegistration;
}

export function pushSupported() {
  return 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

async function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const raw = atob(base64);
  const arr = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
  return arr;
}

/** Current state for UI rendering. */
export async function pushState() {
  if (!pushSupported()) return { supported: false };
  const reg = await ensureSw();
  const permission = Notification.permission; // 'granted' | 'denied' | 'default'
  let subscribed = false;
  if (permission === 'granted') {
    const sub = await reg.pushManager.getSubscription();
    subscribed = Boolean(sub);
  }
  return { supported: true, permission, subscribed };
}

/** Enable: permission + VAPID subscribe + server register. */
export async function enablePush() {
  const reg = await ensureSw();
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') throw new Error('Notification permission was not granted');
  const existing = await reg.pushManager.getSubscription();
  const sub = existing || await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: await urlBase64ToUint8Array((await authApi.pushKey()).data),
  });
  await authApi.pushSubscribe(sub.toJSON());
  return { subscribed: true };
}

/** Disable: server forget + browser unsubscribe. */
export async function disablePush() {
  const reg = await ensureSw();
  const sub = await reg.pushManager.getSubscription();
  if (sub) {
    try { await authApi.pushUnsubscribe({ endpoint: sub.endpoint }); } catch (e) { /* best-effort */ }
    await sub.unsubscribe();
  }
  return { subscribed: false };
}
