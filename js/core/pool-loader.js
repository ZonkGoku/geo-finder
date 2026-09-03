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

    // Nacheinander mit kurzer Pause, NICHT parallel: mehrere gleichzeitige
    // Anfragen mit demselben Token loesten live ein Rate-Limit bei Mapillary
    // aus ("reduce the amount of data you're asking for" kam sogar bei der
    // guenstigsten Abfrage, sobald mehrere Requests gleichzeitig liefen).
    // fetchPanoramaForRegion hat weiterhin ein eigenes Timeout, damit ein
    // einzelner haengender Request nicht die ganze Kette blockiert.
    const RATE_LIMIT_DELAY_MS = 350;
    const resolved = [];
    for (const region of candidates) {
      if (resolved.length >= roundCount) break;
      try {
        const loc = await fetchPanoramaForRegion(region);
        if (loc) resolved.push(loc);
      } catch (err) {
        console.error('Mapillary-Abruf fehlgeschlagen:', err);
      }
      await new Promise((r) => setTimeout(r, RATE_LIMIT_DELAY_MS));
    }
    return resolved;
  }

  throw new Error(`Unbekannte Kartenpaket-Quelle: ${mapSet.source}`);
}
