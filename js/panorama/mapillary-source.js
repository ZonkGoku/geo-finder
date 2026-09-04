import { MAPILLARY_ACCESS_TOKEN } from '../config.js';

const API_BASE = 'https://graph.mapillary.com';
const REQUEST_TIMEOUT_MS = 8000;
// Die Bildradiussuche (seit 2026-04-02 Teil der API) erlaubt maximal 50m
// Radius und 100 Ergebnisse - beides harte Serverlimits, kein Tuning-Spielraum.
const SEARCH_RADIUS_M = 50;
// Max. erlaubtes limit fuer die Radiussuche ist 100 - ausgeschoepft, damit der
// anschliessende Shuffle aus einer moeglichst grossen Kandidatenmenge waehlt
// und nicht jedes Mal dasselbe Foto fuer eine Region liefert.
const LIST_LIMIT = 100;
const MAX_DETAIL_ATTEMPTS = 8;

/**
 * fetch() mit eigenem Timeout (Browser-fetch() hat sonst keins) und
 * einheitlicher Fehlermeldung inkl. der von Mapillary gelieferten
 * Fehlerbeschreibung, falls vorhanden.
 */
async function fetchJson(url, label) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Mapillary-Anfrage für "${label}" hat zu lange gedauert (Timeout)`);
    }
    throw new Error(`Mapillary-Anfrage für "${label}" fehlgeschlagen: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const apiMessage = json?.error?.message;
    throw new Error(
      apiMessage
        ? `Mapillary-Anfrage fehlgeschlagen für "${label}": ${apiMessage}`
        : `Mapillary-Anfrage fehlgeschlagen für "${label}" (HTTP ${res.status})`
    );
  }
  return json;
}

// rand ist optional (Default Math.random) - resolveRoundLocations() in
// pool-loader.js reicht bei einem seed-gebundenen Spiel (Tages-Challenge/
// Challenge-Link) einen mulberry32-Strom durch, sonst waere die Wahl UNTER
// mehreren Bildkandidaten am selben Punkt weiterhin zufaellig und ein
// gegebener Seed koennte trotz identischer Suchkoordinaten ein anderes Foto
// liefern.
function shuffle(arr, rand = Math.random) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function buildLocationFromDetail(detail, regionMeta) {
  if (!detail?.is_pano || !detail?.thumb_2048_url) return null;
  const [lng, lat] = detail.geometry?.coordinates || [regionMeta.lng, regionMeta.lat];
  return {
    id: `mapillary-${detail.id}`,
    name: regionMeta.name,
    lat,
    lng,
    panoramaUrl: detail.thumb_2048_url,
    attribution: 'Mapillary-Mitwirkende',
    attributionUrl: 'https://www.mapillary.com/',
    coordSource: 'mapillary-live',
  };
}

/**
 * Holt ein EINZELNES, bereits bekanntes Bild direkt per ID nach - ueberspringt
 * die Listensuche komplett. Genutzt vom "Verified Image Pool"
 * (core/pool-loader.js): eine in einer frueheren Partie erfolgreich
 * aufgeloeste Bild-ID wird hier neu abgefragt statt die damals gecachte
 * thumb_2048_url direkt wiederzuverwenden - Mapillary-Thumb-URLs koennen
 * ablaufen oder das Bild kann inzwischen entfernt worden sein. Liefert null,
 * wenn die ID nicht mehr existiert oder kein Pano (mehr) ist.
 */
export async function fetchPanoramaById(id, regionMeta) {
  const detailParams = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id,is_pano,geometry,thumb_2048_url',
  });
  try {
    const detail = await fetchJson(`${API_BASE}/${id}?${detailParams.toString()}`, regionMeta.name);
    return buildLocationFromDetail(detail, regionMeta);
  } catch (err) {
    console.error('Verified-Image-Cache: Bild nicht mehr abrufbar:', err);
    return null;
  }
}

/**
 * Fragt echte Mapillary-Aufnahmen nahe einer Region ab und liefert ein
 * einzelnes, zufällig gewähltes 360°-Bild (is_pano=true) zurück - oder null,
 * wenn dort keine sphärischen Aufnahmen vorliegen.
 *
 * Nutzt die Bilder-Radiussuche (lat/lng/radius) statt einer bbox-Suche:
 * Die bbox-Variante hat live reproduzierbar und unabhängig von Anfragegröße
 * (selbst bei fields=id, limit=10, minimaler bbox) einen "reduce the amount
 * of data"-Fehler ausgelöst - laut Mapillary-Doku ein Graph-API-Fehler aus
 * der zugrunde liegenden Meta-Infrastruktur, keine bbox-Größenbeschränkung.
 * Die Radiussuche ist ein eigener, neuerer Endpunkt-Pfad und umgeht das.
 * `is_pano` kann laut Doku nicht zusammen mit lat/lng gefiltert werden,
 * daher wird das pro Bild einzeln in der Detailabfrage geprüft.
 */
export async function fetchPanoramaForRegion(region, rand = Math.random) {
  const listParams = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id',
    lat: String(region.lat),
    lng: String(region.lng),
    radius: String(SEARCH_RADIUS_M),
    limit: String(LIST_LIMIT),
  });

  const listJson = await fetchJson(`${API_BASE}/images?${listParams.toString()}`, region.name);
  const ids = shuffle((listJson?.data || []).map((img) => img.id), rand);
  if (ids.length === 0) return null;

  const detailParams = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id,is_pano,geometry,thumb_2048_url',
  });

  // Die Detailabfragen laufen gegen den Entity-Endpunkt (graph.mapillary.com/:id),
  // nicht gegen den Such-Endpunkt, der die urspruengliche bbox-Anfrage betraf -
  // laut Doku 60.000 Anfragen/Minute erlaubt, also unproblematisch parallel.
  // Das serielle Abklappern mit 350ms-Pause war unnoetige Vorsicht und hat
  // Kartenpakete wie Hamburg spuerbar verlangsamt.
  const candidateIds = ids.slice(0, MAX_DETAIL_ATTEMPTS);
  const details = await Promise.allSettled(
    candidateIds.map((id) => fetchJson(`${API_BASE}/${id}?${detailParams.toString()}`, region.name))
  );

  for (const result of details) {
    if (result.status !== 'fulfilled') continue;
    const location = buildLocationFromDetail(result.value, region);
    if (location) return location;
  }

  return null;
}
