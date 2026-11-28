'use strict';
// 앱 셸은 캐시에서 바로 주고 뒤에서 새로 받는다(stale-while-revalidate).
// 데이터 JSON은 네트워크 먼저, 안 되면 캐시. 지도 타일(다른 출처)은 손대지 않는다.
importScripts('./config.js');
const VERSION = 'v10';
const SHELL_CACHE = `shell-${VERSION}`;
const DATA_CACHE = `data-${VERSION}`;
const DATA_PATH = self.APP_DATA.url;
const SHELL = [
  './',
  './index.html',
  './app.css',
  './app.js',
  './config.js',
  './unlock.js',
  './manifest.webmanifest',
  './vendor/leaflet/leaflet.css',
  './vendor/leaflet/leaflet.js',
  './vendor/leaflet/images/layers.png',
  './vendor/leaflet/images/layers-2x.png',
  './vendor/leaflet/images/marker-icon.png',
  './vendor/leaflet/images/marker-icon-2x.png',
  './vendor/leaflet/images/marker-shadow.png',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/maskable-192.png',
  './icons/maskable-512.png',
];

const dataUrl = new URL(DATA_PATH, self.location).href;

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const shell = await caches.open(SHELL_CACHE);
    await shell.addAll(SHELL);
    const data = await caches.open(DATA_CACHE);
    try {
      const res = await fetch(dataUrl, { cache: 'no-cache' });
      if (res.ok) await data.put(dataUrl, res);
    } catch (err) {
      // 처음 설치할 때 데이터를 못 받으면 다음 요청 때 채운다
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keep = [SHELL_CACHE, DATA_CACHE];
    for (const key of await caches.keys()) {
      if (!keep.includes(key)) await caches.delete(key);
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') return;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.href.split('?')[0] === dataUrl) {
    event.respondWith(networkFirst(request));
  } else if (request.mode === 'navigate') {
    event.respondWith(staleWhileRevalidate(request, new URL('./index.html', self.location).href));
  } else {
    event.respondWith(staleWhileRevalidate(request));
  }
});

async function networkFirst(request) {
  const cache = await caches.open(DATA_CACHE);
  try {
    const res = await fetch(request, { cache: 'no-cache' });
    if (res.ok) await cache.put(dataUrl, res.clone());
    return res;
  } catch (err) {
    const hit = await cache.match(dataUrl);
    if (hit) return hit;
    return new Response(JSON.stringify({ error: 'offline' }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

async function staleWhileRevalidate(request, fallbackKey) {
  const cache = await caches.open(SHELL_CACHE);
  const hit = await cache.match(request, { ignoreSearch: true })
    || (fallbackKey ? await cache.match(fallbackKey) : undefined);
  const refresh = fetch(request)
    .then(async (res) => {
      if (res.ok && res.type === 'basic') await cache.put(request, res.clone());
      return res;
    })
    .catch(() => undefined);
  if (hit) return hit;
  const res = await refresh;
  return res || new Response('오프라인입니다', { status: 503, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
}
