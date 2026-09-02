import { MAPILLARY_ACCESS_TOKEN } from '../config.js';

const API_BASE = 'https://graph.mapillary.com/images';

function bboxFromPoint(lat, lng, radiusM) {
  const dLat = radiusM / 111320;
  const dLng = radiusM / (111320 * Math.cos((lat * Math.PI) / 180) || 1);
  return [lng - dLng, lat - dLat, lng + dLng, lat + dLat];
}

/**
 * Fragt echte Mapillary-Aufnahmen in einem kleinen Gebiet ab und liefert ein
 * einzelnes, zufällig gewähltes 360°-Bild (is_pano=true) zurück - oder null,
 * wenn dort keine sphärischen Aufnahmen vorliegen. Ungetestet gegen die
 * echte API in dieser Sandbox (kein Netzzugriff auf graph.mapillary.com hier),
 * daher bewusst defensiv: jeder Fehler wirft, der Aufrufer entscheidet, ob er
 * eine andere Region probiert.
 */
export async function fetchPanoramaForRegion(region) {
  const [west, south, east, north] = bboxFromPoint(region.lat, region.lng, region.radiusM || 400);
  const params = new URLSearchParams({
    access_token: MAPILLARY_ACCESS_TOKEN,
    fields: 'id,geometry,is_pano,thumb_2048_url',
    bbox: `${west},${south},${east},${north}`,
    limit: '50',
  });

  const res = await fetch(`${API_BASE}?${params.toString()}`);
  if (!res.ok) throw new Error(`Mapillary-Anfrage fehlgeschlagen (HTTP ${res.status})`);
  const json = await res.json();
  const images = (json.data || []).filter((img) => img.is_pano && img.thumb_2048_url);
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
