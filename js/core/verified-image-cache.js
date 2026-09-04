// "Verified Image Pool": jede live erfolgreich aufgeloeste Mapillary-Aufnahme
// wird geraeteweit (localStorage des Hosts) gemerkt. Kuenftige Partien
// koennen daraus schoepfen, wenn die frische Live-Suche innerhalb ihres
// Versuchsbudgets nicht genug Runden liefert - das ist ein reiner
// Geschwindigkeits-/Zuverlaessigkeits-Backstop MIT NIEDRIGERER PRIORITAET,
// kein Ersatz fuer die Live-Suche: die gecachte thumb_2048_url selbst wird
// nie direkt wiederverwendet (kann ablaufen/entfernt worden sein), sondern
// nur die Bild-ID, die dann per fetchPanoramaById() frisch nachgeprueft wird.
const CACHE_KEY_PREFIX = 'geofinder-verified-images-';
const MAX_ENTRIES_PER_SET = 60;

function cacheKey(mapSetId) {
  return `${CACHE_KEY_PREFIX}${mapSetId}`;
}

export function loadVerifiedEntries(mapSetId) {
  try {
    const raw = localStorage.getItem(cacheKey(mapSetId));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // localStorage kann in manchen Kontexten (Privatmodus) werfen
  }
}

export function recordVerifiedEntry(mapSetId, location, regionId) {
  try {
    const entries = loadVerifiedEntries(mapSetId);
    const imageId = String(location.id).replace(/^mapillary-/, '');
    if (entries.some((e) => e.imageId === imageId)) return;
    entries.push({ imageId, regionId, name: location.name, lat: location.lat, lng: location.lng, ts: Date.now() });
    // Bei Ueberlaenge die AELTESTEN zuerst raus - neuere Funde sind eher noch
    // online als sehr alte.
    while (entries.length > MAX_ENTRIES_PER_SET) entries.shift();
    localStorage.setItem(cacheKey(mapSetId), JSON.stringify(entries));
  } catch {
    /* voll/Privatmodus - Cache ist ein Bonus, kein Muss */
  }
}
