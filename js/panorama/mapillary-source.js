import { MAPILLARY_ACCESS_TOKEN } from '../config.js';

const API_BASE = 'https://graph.mapillary.com/images';
const REQUEST_TIMEOUT_MS = 8000;

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
 * Fragt echte Mapillary-Aufnahmen in einem kleinen Gebiet ab und liefert ein
 * einzelnes, zufällig gewähltes 360°-Bild (is_pano=true) zurück - oder null,
 * wenn dort keine sphärischen Aufnahmen vorliegen. Bricht nach
 * REQUEST_TIMEOUT_MS selbst ab (Browser-fetch() hat sonst kein Timeout und
 * ein haengender Request wuerde die ganze Rundenauswahl blockieren).
 */
export async function fetchPanoramaForRegion(region) {
  const [west, south, east, north] = bboxFromPoint(region.lat, region.lng, region.radiusM || 400);
  const params = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id,geometry,is_pano,thumb_2048_url',
    bbox: `${west},${south},${east},${north}`,
    limit: '50',
  });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  let res;
  try {
    res = await fetch(`${API_BASE}?${params.toString()}`, { signal: controller.signal });
  } catch (err) {
    if (err.name === 'AbortError') {
      throw new Error(`Mapillary-Anfrage für "${region.name}" hat zu lange gedauert (Timeout)`);
    }
    throw new Error(`Mapillary-Anfrage für "${region.name}" fehlgeschlagen: ${err.message}`);
  } finally {
    clearTimeout(timer);
  }

  const json = await res.json().catch(() => null);
  if (!res.ok) {
    const apiMessage = json?.error?.message;
    throw new Error(
      apiMessage
        ? `Mapillary-Anfrage fehlgeschlagen für "${region.name}": ${apiMessage}`
        : `Mapillary-Anfrage fehlgeschlagen für "${region.name}" (HTTP ${res.status})`
    );
  }

  const images = (json?.data || []).filter((img) => img.is_pano && img.thumb_2048_url);
  if (images.length === 0) return null;

  const pick = images[Math.floor(Math.random() * images.length)];
  const [lng, lat] = pick.geometry?.coordinates || [region.lng, region.lat];

  return {
    id: `mapillary-${pick.id}`,
    name: region.name,
    lat,
    lng,
    panoramaUrl: pick.thumb_2048_url,
    attribution: 'Mapillary-Mitwirkende',
    attributionUrl: 'https://www.mapillary.com/',
    coordSource: 'mapillary-live',
  };
}
