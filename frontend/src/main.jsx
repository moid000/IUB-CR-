import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import './index.css';
// Self-hosted Inter — identical font, but served from our own origin
// (hashed, CDN-cached files) instead of Google Fonts. Removes two
// third-party round-trips that slow down first paint in PK.
import '@fontsource/inter/400.css';
import '@fontsource/inter/500.css';
import '@fontsource/inter/600.css';
import '@fontsource/inter/700.css';

// Clean URLs: the SPA's static build still lives under /frontend/ (vite base),
// but pages are served at the root. If someone lands on a legacy /frontend/*
// page link, hop to the equivalent clean root URL (assets under /frontend/assets
// are fetched as static files and never execute this file).
const LEGACY = /^\/frontend(\/|$)/;
if (LEGACY.test(window.location.pathname)) {
  const clean = window.location.pathname.replace(/^\/frontend/, '') || '/';
  window.location.replace(clean + window.location.search + window.location.hash);
}

// Register the service worker early — device notifications (Web Push) are
// delivered by the SW even when the app is closed. Non-blocking, best-effort.
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register(`${import.meta.env.BASE_URL}sw.js`).catch(() => {});
}

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>
);
