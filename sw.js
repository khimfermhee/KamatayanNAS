const CACHE_NAME = 'kamatayannas-v1';

// Install event
self.addEventListener('install', (event) => {
    self.skipWaiting();
});

// Activate event
self.addEventListener('activate', (event) => {
    event.waitUntil(self.clients.claim());
});

// A basic fetch event is REQUIRED for browsers to treat this as a true PWA installable app.
self.addEventListener('fetch', (event) => {
    // We do not aggressively cache API calls because the NAS files change dynamically.
    // However, having this listener satisfies the PWA installability requirements 
    // so it opens as a standalone app without the browser URL bar.
    event.respondWith(fetch(event.request));
});
