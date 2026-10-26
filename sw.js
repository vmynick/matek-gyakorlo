// Service worker: elmenti az app fájljait, így hálózat nélkül is elindul.
// A VERSION-t a közzététel írja át (GitHub Actions / deploy.ps1); ha változik, a telepített appok frissülnek.
const VERSION = 'dev';
// A github.io címen több app osztozik: csak a saját (ilyen előtagú) gyorsítótárunkhoz nyúlunk
const PREFIX = 'szorzotabla-';
const CACHE = PREFIX + VERSION;
const FILES = [
    './',
    'szorzotabla.html',
    'stats.js',
    'common.css',
    'config.js',
    'cloud.js',
    'szulo.html',
    'szulo.js',
    'vendor/supabase.js',
    'manifest.webmanifest',
    'icon.svg',
    'icon-192.png',
    'icon-512.png',
    'vendor/chart.umd.min.js',
    'vendor/confetti.browser.min.js',
];

// Az új verzió nem lép életbe azonnal: az oldal jelzi a frissítést, és akkor kéri (SKIP_WAITING),
// amikor nem zavar (nem teszt közben). Az első telepítés így is rögtön működik.
self.addEventListener('install', (e) => {
    e.waitUntil(caches.open(CACHE)
        .then((cache) => cache.addAll(FILES.map((f) => new Request(f, { cache: 'reload' })))));
});

self.addEventListener('message', (e) => {
    if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
    e.waitUntil(caches.keys()
        .then((keys) => Promise.all(keys
            .filter((k) => k.startsWith(PREFIX) && k !== CACHE)
            .map((k) => caches.delete(k))))
        .then(() => self.clients.claim()));
});

// Előbb a mentett példány (gyors, és offline is megy), ha nincs, akkor a hálózat.
// A hálózatról jött választ is elmentjük: ha egy másik app törölte a gyorsítótárunkat, így magától pótlódik.
self.addEventListener('fetch', (e) => {
    if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
    e.respondWith(caches.match(e.request, { ignoreSearch: true }).then((hit) => hit || fetch(e.request).then((res) => {
        if (res.ok) {
            const copy = res.clone();
            caches.open(CACHE).then((cache) => cache.put(e.request, copy));
        }
        return res;
    })));
});
