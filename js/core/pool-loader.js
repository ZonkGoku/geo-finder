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

// Obergrenze fuer einzelne Region-Abrufversuche ueber alle Wellen hinweg -
// verhindert eine Endlosschleife, falls die Mapillary-API generell nicht
// erreichbar ist. Ein fixer Wert (urspruenglich 20) reichte bei groesseren
// Kartenpaketen nicht: Hamburg hat z. B. 48 Regionen, aber viele davon haben
// live keine Mapillary-Abdeckung im engen 50m-Radius - bei 10 gewuenschten
// Runden brach das Budget ab, bevor der 48er-Pool ueberhaupt einmal ganz
// durchprobiert war (live bestaetigt: "RUNDE 01 / 03" trotz 10 gewaehlter
// Runden). Das Budget skaliert daher mit der Poolgroesse (grob 3 Versuche
// pro Region), bleibt aber nach oben gedeckelt.
const MIN_RESOLVE_ATTEMPTS = 24;
const MAX_RESOLVE_ATTEMPTS_CAP = 90;
function resolveAttemptBudget(regionCount) {
  return Math.min(MAX_RESOLVE_ATTEMPTS_CAP, Math.max(MIN_RESOLVE_ATTEMPTS, regionCount * 3));
}

/**
 * Liefert bis zu roundCount Runden-Orte fuer ein Kartenpaket. Bei
 * Mapillary-Paketen wird pro gewaehlter Region live ein Bild abgefragt.
 *
 * Liefert eine Region nichts (kein 360°-Bild im 50m-Radius gefunden,
 * Timeout, HTTP-Fehler), wurde das Ergebnis frueher einfach verworfen -
 * das Spiel startete dann mit WENIGER Runden als in der Lobby gewaehlt
 * (sichtbar als "RUNDE 01 / 01" im HUD, wenn nur eine von vielen Regionen
 * ein Bild lieferte). Jetzt wird in Wellen nachgefragt: fehlgeschlagene
 * Regionen werden durch weitere, noch nicht versuchte Regionen aus dem
 * Kartenpaket ersetzt, bis entweder roundCount erreicht ist oder das
 * Versuchslimit (MAX_RESOLVE_ATTEMPTS) ausgeschoepft ist. Reicht das
 * Kartenpaket selbst nicht fuer roundCount eindeutige Regionen (z. B. 10
 * gewuenschte Runden bei nur 8 definierten Regionen), wird der Regionen-Pool
 * fuer die letzten Versuche ein zweites Mal durchlaufen - ein zweites Foto
 * derselben Sehenswuerdigkeit ist immer noch besser, als das Spiel mit zu
 * wenigen Runden zu starten. Das Ergebnis kann trotzdem kuerzer als
 * roundCount sein, wenn die API durchgehend nicht erreichbar ist - der
 * Aufrufer (host.js) faengt das weiterhin ab.
 */
export async function resolveRoundLocations(mapSet, roundCount, seed) {
  if (mapSet.source === 'static') {
    return pickUniqueLocations(mapSet.locations, roundCount, seed);
  }

  if (mapSet.source === 'mapillary') {
    // Alle sichtbaren Fehler bei gleichzeitigen Anfragen betrafen den
    // frueheren bbox-Endpunkt, nicht Nebenlaeufigkeit selbst (siehe
    // mapillary-source.js) - Wellen von Parallel-Anfragen bleiben also
    // schnell UND robust.
    const pool = pickUniqueLocations(mapSet.regions, mapSet.regions.length, seed);
    const resolveAttempts = resolveAttemptBudget(pool.length);
    const resolved = [];
    let attempts = 0;
    let cursor = 0;

    while (resolved.length < roundCount && attempts < resolveAttempts) {
      const stillNeeded = roundCount - resolved.length;
      const attemptsLeft = resolveAttempts - attempts;
      const waveSize = Math.min(stillNeeded, attemptsLeft, pool.length);
      if (waveSize <= 0) break;

      const wave = [];
      for (let i = 0; i < waveSize; i++) {
        wave.push(pool[cursor % pool.length]);
        cursor++;
      }
      attempts += wave.length;

      const settled = await Promise.allSettled(wave.map((region) => fetchPanoramaForRegion(region)));
      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value) {
          resolved.push(result.value);
        } else if (result.status === 'rejected') {
          console.error('Mapillary-Abruf fehlgeschlagen, versuche Ersatz-Region:', result.reason);
        }
      }
    }
    return resolved;
  }

  throw new Error(`Unbekannte Kartenpaket-Quelle: ${mapSet.source}`);
}
