// Service Worker fuer GeoFinder: cached den App-Shell (HTML/CSS/JS/Vendor-
// Libs) und die Kartenpaket-JSONs beim ersten Seitenaufruf im Hintergrund
// vor, damit Wiederholungsbesuche (und Leaflet-Kacheln zwischen Runden)
// nicht jedes Mal neu vom Netz kommen muessen. Registrierung in app.js.
//
// Bewusst NICHT gecached: Anfragen an graph.mapillary.com (live, pro Runde
// einzigartige Daten - Caching waere hier schlicht falsch) und alles, was
// kein GET ist.
//
// Alle Pfade sind relativ zu diesem Skript, nicht root-relativ - wichtig,
// weil GitHub Pages dieses Projekt unter einem Unterpfad
// (https://<user>.github.io/geo-finder/) ausliefert, nicht unter der
// Domain-Wurzel.
const CACHE_VERSION = 'geofinder-v2';
const APP_SHELL_CACHE = `${CACHE_VERSION}-shell`;
const RUNTIME_CACHE = `${CACHE_VERSION}-runtime`;

const APP_SHELL_URLS = [
  './',
  './index.html',
  './css/styles.css',
  './js/app.js',
  './js/config.js',
  './js/audio/sound.js',
  './js/core/country-lookup.js',
  './js/core/point-in-polygon.js',
  './js/core/pool-loader.js',
  './js/core/rng.js',
  './js/core/scoring.js',
  './js/core/state.js',
  './js/core/verified-image-cache.js',
  './js/map/guess-map.js',
  './js/map/result-map.js',
  './js/map/tile-config.js',
  './js/net/client.js',
  './js/net/host.js',
  './js/net/peer-manager.js',
  './js/net/protocol.js',
  './js/panorama/mapillary-source.js',
  './js/panorama/pano-viewer.js',
  './js/ui/router.js',
  './js/ui/toast.js',
  './lib/peerjs/peerjs.min.js',
  './lib/leaflet/leaflet.js',
  './lib/leaflet/leaflet.css',
  './lib/leaflet/images/layers.png',
  './lib/leaflet/images/layers-2x.png',
  './lib/leaflet/images/marker-icon.png',
  './lib/leaflet/images/marker-icon-2x.png',
  './lib/leaflet/images/marker-shadow.png',
  './lib/pannellum/pannellum.js',
  './lib/pannellum/pannellum.css',
  './data/geo/countries-110m.json',
  './data/map-sets/index.json',
];

// Domains, deren Antworten cache-first behandelt werden (aendern sich
// praktisch nie: Kartenkacheln sind pro z/x/y effektiv unveraenderlich,
// Google-Fonts-Dateien sind versioniert/immutable).
const CACHE_FIRST_HOSTS = ['server.arcgisonline.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
// Nie cachen - live, pro Runde einzigartige Daten.
const NEVER_CACHE_HOSTS = ['graph.mapillary.com'];

self.addEventListener('install', (event) => {
  // Ohne skipWaiting() bleibt eine neu installierte SW-Version im "waiting"-
  // Zustand haengen, bis ALLE Tabs der Seite geschlossen wurden - ein
  // einfaches Reload reicht dann nicht, um Fixes/neue Assets zu bekommen
  // (live erlebt: CACHE_VERSION-Bump allein aktualisierte die offene Seite
  // nicht). skipWaiting() + das bereits vorhandene clients.claim() unten
  // sorgen zusammen dafuer, dass ein Reload immer die neueste Version laedt.
  self.skipWaiting();
  event.waitUntil(
    (async () => {
      const cache = await caches.open(APP_SHELL_CACHE);
      // addAll() ist alles-oder-nichts - ein einzelner 404 wuerde sonst die
      // GESAMTE Vorab-Ladung verhindern. Einzeln cachen und Fehler pro
      // Datei nur loggen, statt die Installation daran scheitern zu lassen.
      await Promise.all(
        APP_SHELL_URLS.map((url) =>
          cache.add(url).catch((err) => console.warn(`[sw] Vorab-Cache fehlgeschlagen fuer ${url}:`, err.message))
        )
      );
      // Zusaetzlich alle einzelnen Kartenpaket-JSONs vorladen, deren Namen
      // erst nach dem Laden von index.json bekannt sind.
      try {
        const indexRes = await cache.match('./data/map-sets/index.json');
        const indexJson = indexRes ? await indexRes.clone().json() : null;
        const files = (indexJson?.sets || []).map((s) => `./data/map-sets/${s.file}`);
        await Promise.all(
          files.map((url) => cache.add(url).catch((err) => console.warn(`[sw] Kartenpaket-Vorab-Cache fehlgeschlagen fuer ${url}:`, err.message)))
        );
      } catch (err) {
        console.warn('[sw] Kartenpaket-Index konnte beim Vorab-Cachen nicht gelesen werden:', err.message);
      }
    })()
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(
        keys.filter((key) => key.startsWith('geofinder-') && key !== APP_SHELL_CACHE && key !== RUNTIME_CACHE).map((key) => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

async function cacheFirst(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  if (cached) return cached;
  const response = await fetch(request);
  if (response.ok) cache.put(request, response.clone());
  return response;
}

async function staleWhileRevalidate(request, cacheName) {
  const cache = await caches.open(cacheName);
  const cached = await cache.match(request);
  const networkPromise = fetch(request)
    .then((response) => {
      if (response.ok) cache.put(request, response.clone());
      return response;
    })
    .catch(() => null);
  // Sofort aus dem Cache antworten, wenn vorhanden - die Netzwerkantwort
  // aktualisiert den Cache im Hintergrund fuer den NAECHSTEN Aufruf, blockiert
  // aber nicht die aktuelle Anfrage.
  return cached || (await networkPromise) || Response.error();
}

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (NEVER_CACHE_HOSTS.includes(url.hostname)) return;

  if (CACHE_FIRST_HOSTS.includes(url.hostname)) {
    event.respondWith(cacheFirst(request, RUNTIME_CACHE));
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(staleWhileRevalidate(request, APP_SHELL_CACHE));
  }
  // Alles andere (z.B. das PeerJS-Signaling, sonstige Drittanbieter) laeuft
  // unangetastet durch den Service Worker durch.
});
