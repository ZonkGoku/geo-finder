// Laedt und indiziert die Laenderdaten fuer den Heatmap-Modus: Polygone
// (fuer die Leaflet-Einfaerbung) aus dem bereits vorhandenen
// data/geo/countries-110m.json (auch von core/country-lookup.js fuer den
// Country-Streak-Modus genutzt) plus Mittelpunkte aus dem neu erzeugten
// data/geo/country-centroids.json (siehe scripts/compute-country-centroids.mjs -
// das 110m-Datenset selbst enthaelt nur Umrisse, keine Mittelpunkte), sowie
// Landgrenzen-Nachbarn (data/geo/country-neighbors.json, siehe
// scripts/compute-country-neighbors.mjs) und Kontinent (data/geo/country-
// continents.json, siehe scripts/compute-country-continents.mjs) fuer das
// "Nachbarland!"/"gleicher Kontinent"-Feedback (core/heatmap-proximity.js).
import { boundaryPoints } from './border-distance.js';
import { displayNameDe, searchTermsFor } from './country-names-de.js';

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
  const [geoRes, centroidRes, neighborsRes, continentRes] = await Promise.all([
    fetch('./data/geo/countries-110m.json').then((r) => r.json()),
    fetch('./data/geo/country-centroids.json').then((r) => r.json()),
    fetch('./data/geo/country-neighbors.json').then((r) => r.json()),
    fetch('./data/geo/country-continents.json').then((r) => r.json()),
  ]);

  const countries = [];
  for (const feature of geoRes.features) {
    const id = resolveFeatureId(feature);
    const centroid = centroidRes[id];
    if (!centroid) continue; // sollte nach obigem Skript nie vorkommen, aber lieber ueberspringen als mit lat/lng=null weiterrechnen
    const name = feature.properties.name;
    countries.push({
      id,
      name,
      // Deutscher Anzeigename (core/country-names-de.js) - das restliche UI
      // ist durchgehend deutsch, daher wird ueberall dort, wo ein Laendername
      // angezeigt wird (Top-3-Liste, Vorschlagsliste, Zielland-Anzeige,
      // Aktivitaets-Meldungen), dieser statt des englischen Datensatz-Namens
      // genutzt. Die Suche selbst bleibt bilingual (siehe searchTerms unten).
      nameDe: displayNameDe(name),
      // Alle Teilstrings, gegen die eine Sucheingabe treffen soll: englischer
      // Name, deutscher Name, plus etwaige Kurzform-Aliase ("USA" etc.) -
      // vorberechnet statt bei jedem Tastenanschlag neu zusammengesetzt.
      searchTerms: searchTermsFor(name).map((t) => t.toLowerCase()),
      geometry: feature.geometry,
      lat: centroid.lat,
      lng: centroid.lng,
      // [] statt undefined, falls ein Land (sollte nach dem Erzeugungsskript
      // nicht vorkommen) fehlt - vermeidet ".includes ist keine Funktion" an
      // den Aufrufstellen in heatmap-proximity.js.
      neighbors: neighborsRes[id] || [],
      continent: continentRes[id] || null,
      // Einmal beim Laden vorberechnet statt bei jedem Tipp neu aus der
      // rohen Geometrie extrahiert (siehe core/border-distance.js) - Laender
      // mit hunderten Randpunkten (Russland, Kanada) sollen nicht bei jedem
      // Rateversuch erneut durchlaufen werden muessen.
      boundaryPoints: boundaryPoints(feature.geometry),
    });
  }

  const byId = new Map(countries.map((c) => [c.id, c]));
  const byNameLower = new Map(countries.map((c) => [c.name.toLowerCase(), c]));
  // Exakte Treffer (Enter ohne Auswahl aus der Vorschlagsliste, siehe
  // findCountryByName()) sollen auch bei komplett eingetipptem deutschen
  // Namen oder Alias funktionieren ("Vereinigte Staaten", "USA"), nicht nur
  // beim englischen Datensatz-Namen - jeder Suchbegriff zeigt hier auf das
  // Land, nicht nur der Primaerschluessel.
  const byAnyNameLower = new Map();
  for (const c of countries) {
    for (const term of c.searchTerms) if (!byAnyNameLower.has(term)) byAnyNameLower.set(term, c);
  }
  return { countries, byId, byNameLower, byAnyNameLower };
}

/** Muss einmal vor dem ersten Zugriff auf ein CountryStore-Objekt awaited werden. */
export function ensureCountryStore() {
  if (!storePromise) storePromise = build();
  return storePromise;
}

export function findCountryByName(store, rawName) {
  const q = (rawName || '').trim().toLowerCase();
  return store.byAnyNameLower.get(q) || store.byNameLower.get(q) || null;
}

/**
 * Autocomplete-Vorschlaege: bilingual (DE/EN, siehe core/country-names-de.js) -
 * ein Land matcht, sobald IRGENDEIN Suchbegriff (englischer Name, deutscher
 * Name, Kurzform-Alias) den Suchtext enthaelt. Treffer am Wortanfang eines
 * Begriffs zuerst (z. B. "Ger" -> "Germany"/"Deutschland" vor "Algeria").
 */
export function searchCountries(store, query, limit = 8) {
  const q = (query || '').trim().toLowerCase();
  if (!q) return [];
  return store.countries
    .filter((c) => c.searchTerms.some((term) => term.includes(q)))
    .sort((a, b) => {
      const aStarts = a.searchTerms.some((term) => term.startsWith(q)) ? 0 : 1;
      const bStarts = b.searchTerms.some((term) => term.startsWith(q)) ? 0 : 1;
      return aStarts - bStarts || a.nameDe.localeCompare(b.nameDe);
    })
    .slice(0, limit);
}

export function randomCountry(store, rand = Math.random) {
  const idx = Math.floor(rand() * store.countries.length);
  return store.countries[idx];
}
