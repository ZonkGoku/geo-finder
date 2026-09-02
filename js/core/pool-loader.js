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

    // Parallel in Batches statt nacheinander: fetchPanoramaForRegion hat
    // zwar selbst ein Timeout, aber sequenziell koennten 8 Regionen x 8s
    // trotzdem wie ein Haenger wirken. So ist die Obergrenze ein einzelnes
    // Batch-Timeout, nicht die Summe aller Versuche.
    const BATCH_SIZE = 4;
    const resolved = [];
    for (let i = 0; i < candidates.length && resolved.length < roundCount; i += BATCH_SIZE) {
      const batch = candidates.slice(i, i + BATCH_SIZE);
      const settled = await Promise.allSettled(batch.map((region) => fetchPanoramaForRegion(region)));
      for (const outcome of settled) {
        if (outcome.status === 'fulfilled' && outcome.value) resolved.push(outcome.value);
        else if (outcome.status === 'rejected') console.error('Mapillary-Abruf fehlgeschlagen:', outcome.reason);
      }
    }
    return resolved.slice(0, roundCount);
  }

  throw new Error(`Unbekannte Kartenpaket-Quelle: ${mapSet.source}`);
}
