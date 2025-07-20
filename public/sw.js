// public/sw.js
self.addEventListener('install', (e) => {
  e.waitUntil(
    caches.open('dissentbot-cache').then((cache) => {
      return cache.addAll([
        '/',
        '/index.html',
        '/styles.css',
        '/icon-192.png',
        '/icon-512.png',
        '/widget.js',
        '/api/chat'
      ]);
    })
  );
});

self.addEventListener('fetch', () => {});