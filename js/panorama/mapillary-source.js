import { MAPILLARY_ACCESS_TOKEN } from '../config.js';

const API_BASE = 'https://graph.mapillary.com';
const REQUEST_TIMEOUT_MS = 8000;
const LIST_LIMIT = 30;

// Mapillary lehnt bbox-Anfragen über 0.010 Quadratgrad ab (per Live-Test
// bestätigt: "Bounding box area is too large. Maximum allowed area is
// 0.010 square degrees"). Mit Sicherheitsmarge bleiben wir klar darunter.
const MAX_BBOX_AREA_DEG2 = 0.008;
const METERS_PER_DEGREE = 111320;

function bboxFromPoint(lat, lng, radiusM) {
  const latRad = (lat * Math.PI) / 180;
  const cosLat = Math.max(Math.cos(latRad), 0.01); // verhindert Explosion nahe den Polen

  let dLat = radiusM / METERS_PER_DEGREE;
  let dLng = radiusM / (METERS_PER_DEGREE * cosLat);

  const area = 4 * dLat * dLng;
  if (area > MAX_BBOX_AREA_DEG2) {
    const scale = Math.sqrt(MAX_BBOX_AREA_DEG2 / area);
    dLat *= scale;
    dLng *= scale;
  }

  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

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

/**
 * Fragt echte Mapillary-Aufnahmen in einem kleinen Gebiet ab und liefert ein
 * einzelnes, zufällig gewähltes 360°-Bild (is_pano=true) zurück - oder null,
 * wenn dort keine sphärischen Aufnahmen vorliegen.
 *
 * Zweistufig, weil Mapillary eine Listenabfrage mit `thumb_2048_url` für
 * viele Bilder gleichzeitig ablehnt ("Please reduce the amount of data
 * you're asking for" - live bestätigt): zuerst nur guenstige Felder fuer
 * die Liste holen, dann die Bild-URL nur fuer das eine gewaehlte Bild.
 */
export async function fetchPanoramaForRegion(region) {
  const [west, south, east, north] = bboxFromPoint(region.lat, region.lng, region.radiusM || 400);
  const listParams = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id,is_pano',
    bbox: `${west},${south},${east},${north}`,
    limit: String(LIST_LIMIT),
  });

  const listJson = await fetchJson(`${API_BASE}/images?${listParams.toString()}`, region.name);
  const panoIds = (listJson?.data || []).filter((img) => img.is_pano).map((img) => img.id);
  if (panoIds.length === 0) return null;

  const chosenId = panoIds[Math.floor(Math.random() * panoIds.length)];
  const detailParams = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id,geometry,thumb_2048_url',
  });
  const detail = await fetchJson(`${API_BASE}/${chosenId}?${detailParams.toString()}`, region.name);
  if (!detail?.thumb_2048_url) return null;

  const [lng, lat] = detail.geometry?.coordinates || [region.lng, region.lat];

  return {
    id: `mapillary-${detail.id}`,
    name: region.name,
    lat,
    lng,
    panoramaUrl: detail.thumb_2048_url,
    attribution: 'Mapillary-Mitwirkende',
    attributionUrl: 'https://www.mapillary.com/',
    coordSource: 'mapillary-live',
  };
}
