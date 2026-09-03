import { pickUniqueLocations } from './rng.js';
import { fetchPanoramaForRegion } from '../panorama/mapillary-source.js';
import { isMapillaryConfigured } from '../config.js';

export async function loadMapSetIndex() {
  const res = await fetch('./data/map-sets/index.json');
  const json = await res.json();
  return json.sets.map((entry) => ({
    ...entry,
    available: entry.source === 'static' || isMapillaryConfigured(),
  }));
}

export async function loadMapSetDetail(entry) {
  const res = await fetch(`./data/map-sets/${entry.file}`);
  return res.json();
}

/**
 * Liefert die geografische Ausdehnung eines Kartenpakets als zwei
 * Eckpunkte (fuer GuessMap.focusOnLocations) - NICHT die einzelnen
 * Standorte selbst. Nur der Host laedt das komplette Kartenpaket mit allen
 * echten Koordinaten; an die Mitspieler geht ueber GAME_START lediglich
 * diese grobe Bounding-Box, damit die Minimap trotzdem sinnvoll einzoomen
 * kann, ohne den Mitspielern die komplette Koordinatenliste (= alle
 * moeglichen Antworten) offenzulegen.
 */
export function computeMapSetBounds(mapSet) {
  const points = mapSet.locations || mapSet.regions || [];
  if (points.length === 0) return null;

  let minLat = Infinity;
  let maxLat = -Infinity;
  let minLng = Infinity;
  let maxLng = -Infinity;
  for (const p of points) {
    if (p.lat < minLat) minLat = p.lat;
    if (p.lat > maxLat) maxLat = p.lat;
    if (p.lng < minLng) minLng = p.lng;
    if (p.lng > maxLng) maxLng = p.lng;
  }
  return [
    { lat: minLat, lng: minLng },
    { lat: maxLat, lng: maxLng },
  ];
}

/**
 * Liefert bis zu roundCount Runden-Orte fuer ein Kartenpaket. Bei
 * Mapillary-Paketen wird pro gewaehlter Region live ein Bild abgefragt;
 * liefert eine Region nichts (kein 360°-Bild in dem Gebiet gefunden oder
 * Netzwerkfehler), wird die naechste Reserve-Region versucht. Das Ergebnis
 * kann daher kuerzer als roundCount sein - der Aufrufer muss das abfangen.
 */
export async function resolveRoundLocations(mapSet, roundCount, seed) {
  if (mapSet.source === 'static') {
    return pickUniqueLocations(mapSet.locations, roundCount, seed);
  }

  if (mapSet.source === 'mapillary') {
    const candidateCount = Math.min(mapSet.regions.length, roundCount * 3);
    const candidates = pickUniqueLocations(mapSet.regions, candidateCount, seed);

    // Alle Kandidaten-Regionen parallel abfragen. Das fruehere sequentielle
    // Abklappern mit 350ms-Pause beruhte auf der (inzwischen widerlegten)
    // Annahme, gleichzeitige Anfragen wuerden das "reduce the amount of
    // data"-Problem ausloesen - das lag tatsaechlich am bbox-Endpunkt selbst,
    // nicht an Nebenlaeufigkeit (siehe mapillary-source.js). Mit der
    // Radiussuche ist Parallelisieren unproblematisch und macht das Laden
    // eines Kartenpakets deutlich spuerbar schneller.
    const settled = await Promise.allSettled(candidates.map((region) => fetchPanoramaForRegion(region)));

    const resolved = [];
    for (const result of settled) {
      if (resolved.length >= roundCount) break;
      if (result.status === 'fulfilled' && result.value) {
        resolved.push(result.value);
      } else if (result.status === 'rejected') {
        console.error('Mapillary-Abruf fehlgeschlagen:', result.reason);
      }
    }
    return resolved;
  }

  throw new Error(`Unbekannte Kartenpaket-Quelle: ${mapSet.source}`);
}
