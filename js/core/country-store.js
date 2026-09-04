// Laedt und indiziert die Laenderdaten fuer den Heatmap-Modus: Polygone
// (fuer die Leaflet-Einfaerbung) aus dem bereits vorhandenen
// data/geo/countries-110m.json (auch von core/country-lookup.js fuer den
// Country-Streak-Modus genutzt) plus Mittelpunkte aus dem neu erzeugten
// data/geo/country-centroids.json (siehe scripts/compute-country-centroids.mjs -
// das 110m-Datenset selbst enthaelt nur Umrisse, keine Mittelpunkte).
let storePromise = null;

// 3 der 177 Features (Nordzypern, Somaliland, Kosovo) haben im Datensatz
// KEIN "id"-Feld (nur internationale anerkannte Staaten tragen einen UN
// M49-Code) - derselbe Namens-Slug-Fallback wie im Erzeugungsskript haelt
// Polygon und Mittelpunkt fuer diese drei trotzdem konsistent zusammen.
function resolveFeatureId(feature) {
  if (feature.id != null) return String(feature.id);
  return `name-${feature.properties.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

async function build() {
  const [geoRes, centroidRes] = await Promise.all([
    fetch('./data/geo/countries-110m.json').then((r) => r.json()),
    fetch('./data/geo/country-centroids.json').then((r) => r.json()),
  ]);

  const countries = [];
  for (const feature of geoRes.features) {
    const id = resolveFeatureId(feature);
    const centroid = centroidRes[id];
    if (!centroid) continue; // sollte nach obigem Skript nie vorkommen, aber lieber ueberspringen als mit lat/lng=null weiterrechnen
    countries.push({
      id,
      name: feature.properties.name,
      geometry: feature.geometry,
      lat: centroid.lat,
      lng: centroid.lng,
    });
  }

  const byId = new Map(countries.map((c) => [c.id, c]));
  const byNameLower = new Map(countries.map((c) => [c.name.toLowerCase(), c]));
  return { countries, byId, byNameLower };
}

/** Muss einmal vor dem ersten Zugriff auf ein CountryStore-Objekt awaited werden. */
export function ensureCountryStore() {
  if (!storePromise) storePromise = build();
  return storePromise;
}

export function findCountryByName(store, rawName) {
  return store.byNameLower.get((rawName || '').trim().toLowerCase()) || null;
}

/**
 * Autocomplete-Vorschlaege: Namen, die den Suchtext enthalten, Treffer am
 * Wortanfang zuerst (z. B. "Ger" -> "Germany" vor "Algeria").
 */
export function searchCountries(store, query, limit = 8) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  return store.countries
    .filter((c) => c.name.toLowerCase().includes(q))
    .sort((a, b) => {
      const aStarts = a.name.toLowerCase().startsWith(q) ? 0 : 1;
      const bStarts = b.name.toLowerCase().startsWith(q) ? 0 : 1;
      return aStarts - bStarts || a.name.localeCompare(b.name);
    })
    .slice(0, limit);
}

export function randomCountry(store, rand = Math.random) {
  const idx = Math.floor(rand() * store.countries.length);
  return store.countries[idx];
}
