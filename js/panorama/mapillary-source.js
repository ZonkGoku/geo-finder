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

// id -> Promise<json|null> - dedupliziert Detail-Abfragen INNERHALB einer
// Session: resolveRoundLocations() in pool-loader.js probiert bei knapper
// Kartenpaket-Abdeckung denselben Regionen-Pool mehrfach durch (zweite
// Welle, siehe dortiger Kommentar), und Mapillarys 100er-Kandidatenliste
// pro Region ueberschneidet sich zwischen zwei Versuchen an derselben
// Stelle stark - ohne das wuerde dieselbe Bild-ID unnoetig ein zweites Mal
// per HTTP abgefragt. Bewusst NICHT ueber Regionen/Sessions hinweg
// persistiert (kein localStorage): thumb_2048_url-Links laufen ab (siehe
// Kommentar bei fetchPanoramaById), ein alter gecachter Wert waere nach
// einer Weile schlicht falsch.
const detailCache = new Map();

function fetchDetailCached(id, params, label) {
  if (detailCache.has(id)) return detailCache.get(id);
  const promise = fetchJson(`${API_BASE}/${id}?${params.toString()}`, label);
  detailCache.set(id, promise);
  // Ein fehlgeschlagener Abruf soll beim naechsten Mal (anderer Wave-
  // Durchlauf, anderes Kartenpaket-Detail) erneut versucht werden koennen,
  // statt fuer den Rest der Session als "kaputt" gecacht zu bleiben.
  promise.catch(() => detailCache.delete(id));
  return promise;
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
    // Nur fuer den "Weiterlaufen"-Beta-Modus gebraucht (siehe unten) - roh,
    // unpraefigiert, damit findNeighborImageId()/fetchSequenceImageIds()
    // direkt mit den IDs arbeiten koennen, die Mapillarys /image_ids-
    // Endpunkt liefert. NIE an Mitspieler senden (siehe net/host.js) - die
    // rohe Bild-ID erlaubt jedem, der sie kennt, eine direkte Mapillary-
    // Abfrage nach der exakten geometry (= der gesuchten Antwort).
    mapillaryImageId: detail.id ?? null,
    sequenceId: detail.sequence_id ?? null,
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
  const fieldsWithSequence = 'id,is_pano,geometry,thumb_2048_url,sequence_id';
  const detailParams = new URLSearchParams({ access_token: MAPILLARY_ACCESS_TOKEN, fields: fieldsWithSequence });
  try {
    const detail = await fetchJson(`${API_BASE}/${id}?${detailParams.toString()}`, regionMeta.name);
    return buildLocationFromDetail(detail, regionMeta);
  } catch (err) {
    // Live beobachtet: Mapillary lehnt "sequence_id" inzwischen als Feld auf
    // diesem Entity-Endpunkt komplett ab ("Tried accessing nonexisting field
    // (sequence_id)", code 100) - vermutlich ein API-seitiger Schema-Wechsel.
    // sequence_id wird NUR fuers optionale "Weiterlaufen"-Beta gebraucht
    // (siehe net/host.js), darf also nie die ganze Runden-Aufloesung ueber
    // den Verified-Image-Cache-Pfad zum Scheitern bringen - einmal ohne das
    // Feld erneut versuchen, statt das Bild komplett zu verwerfen. Simple
    // String-Pruefung statt eines Fehlercode-Vergleichs, weil Mapillary
    // denselben Fehlercode (100) auch fuer andere "ungueltige Anfrage"-Faelle
    // nutzt - nur bei DIESER spezifischen Meldung ist "ohne sequence_id
    // nochmal versuchen" die richtige Reaktion.
    if (/nonexisting field.*sequence_id/i.test(err.message)) {
      const fallbackParams = new URLSearchParams({
        access_token: MAPILLARY_ACCESS_TOKEN,
        fields: 'id,is_pano,geometry,thumb_2048_url',
      });
      try {
        const detail = await fetchJson(`${API_BASE}/${id}?${fallbackParams.toString()}`, regionMeta.name);
        return buildLocationFromDetail(detail, regionMeta);
      } catch (fallbackErr) {
        console.error('Verified-Image-Cache: Bild nicht mehr abrufbar:', fallbackErr);
        return null;
      }
    }
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
    candidateIds.map((id) => fetchDetailCached(id, detailParams, region.name))
  );

  for (const result of details) {
    if (result.status !== 'fulfilled') continue;
    const location = buildLocationFromDetail(result.value, region);
    if (location) return location;
  }

  return null;
}

// Ab hier: nur fuer den "Weiterlaufen"-Beta-Modus (siehe state.settings.
// mutators.walkBeta, net/host.js _startRound(), app.js syncWalkControls()).
// Bleibt bewusst getrennt von der obigen Runden-Aufloesung - anders als dort
// braucht "Weiterlaufen" die GESAMTE, geordnete Bilderliste einer Sequenz
// (nicht nur ein einzelnes zufaelliges Bild daraus), um vor/zurueck laufen zu
// koennen.

// sequenceId -> Promise<string[]> (geordnete Bild-IDs) - eine Sequenz aendert
// sich waehrend einer laufenden Partie nicht, ein zweiter Abruf derselben
// Sequenz (z. B. beim Zurücklaufen zu einem schon besuchten Abschnitt) waere
// reine Verschwendung.
const sequenceCache = new Map();

/**
 * Liefert die geordnete Liste aller Bild-IDs einer Mapillary-Sequenz. Wird
 * lazy beim ersten Klick auf "Weiterlaufen"/"Zurücklaufen" einer Runde
 * geladen, nicht schon beim Runden-Start - die meisten Spieler laufen nie,
 * der Abruf waere in den meisten Runden verschwendete Bandbreite/Latenz.
 */
export async function fetchSequenceImageIds(sequenceId) {
  if (!sequenceId) return [];
  if (sequenceCache.has(sequenceId)) return sequenceCache.get(sequenceId);

  const promise = (async () => {
    const params = new URLSearchParams({ access_token: MAPILLARY_ACCESS_TOKEN, sequence_id: sequenceId });
    const json = await fetchJson(`${API_BASE}/image_ids?${params.toString()}`);
    return (json?.data || []).map((d) => d.id);
  })();

  sequenceCache.set(sequenceId, promise);
  try {
    return await promise;
  } catch (err) {
    sequenceCache.delete(sequenceId); // fehlgeschlagener Abruf soll beim naechsten Klick erneut versucht werden
    throw err;
  }
}

/**
 * Reine Array-Logik, kein Netzwerk: findet die Nachbar-Bild-ID in Lauf-
 * richtung. null, wenn das aktuelle Bild nicht in der Liste vorkommt (sollte
 * nicht passieren) oder am Ende/Anfang der Sequenz - dann ist einfach Schluss
 * mit Weiterlaufen in diese Richtung.
 */
export function findNeighborImageId(sequenceImageIds, currentImageId, direction) {
  const index = sequenceImageIds.indexOf(currentImageId);
  if (index === -1) return null;
  const neighborIndex = direction === 'forward' ? index + 1 : index - 1;
  return sequenceImageIds[neighborIndex] ?? null;
}
