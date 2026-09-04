import { pickUniqueLocations } from './rng.js';
import { fetchPanoramaForRegion, fetchPanoramaById } from '../panorama/mapillary-source.js';
import { isMapillaryConfigured } from '../config.js';
import { ensureCountryData, findCountryAtPointSync } from './country-lookup.js';
import { loadVerifiedEntries, recordVerifiedEntry } from './verified-image-cache.js';

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

// Kleine Streuung um die handverlesenen Regionen-Koordinaten statt echter
// zufaelliger Bounding-Boxen: ein rein zufaelliger Punkt irgendwo in einer
// "Europa"-Box liegt ueberwiegend NICHT innerhalb der harten 50m-Radius-
// Grenze irgendeiner echten Mapillary-Aufnahme (die Abdeckung ist extrem
// dicht an bestimmten Strassen und ansonsten praktisch leer) - das haette
// die Ladezeiten/Fehlerquote massiv verschlechtert statt Abwechslung zu
// bringen. Ein kleiner Radius um einen bereits als "hat Strassenfotos"
// bekannten Punkt gibt trotzdem Varianz zwischen Partien, ohne die
// Trefferquote zu ruinieren.
const JITTER_RADIUS_M = 180;
const METERS_PER_DEGREE_LAT = 111320;

function jitterRegion(region) {
  const r = JITTER_RADIUS_M * Math.sqrt(Math.random());
  const theta = Math.random() * 2 * Math.PI;
  const dLat = (r * Math.cos(theta)) / METERS_PER_DEGREE_LAT;
  const metersPerDegreeLng = METERS_PER_DEGREE_LAT * Math.cos((region.lat * Math.PI) / 180);
  const dLng = metersPerDegreeLng > 1 ? (r * Math.sin(theta)) / metersPerDegreeLng : 0;
  return { ...region, lat: region.lat + dLat, lng: region.lng + dLng };
}

/**
 * Verwirft einen gejitterten Punkt, wenn er (selten, aber moeglich bei
 * Regionen nahe einer Kueste) im Wasser landet - Land-Check per Punkt-in-
 * Polygon gegen echte Laendergrenzen (dieselben Daten wie der Country-
 * Streak-Modus), NICHT per Haversine (Haversine misst nur Distanz zwischen
 * zwei Punkten, kann nicht "liegt das auf Land" beantworten). Bei
 * fehlenden Laenderdaten (z. B. Netzwerkproblem) wird der Punkt statt
 * eines harten Fehlers einfach durchgelassen.
 */
async function ensureOnLand(candidate, region, countryFeatures) {
  if (!countryFeatures) return candidate;
  if (findCountryAtPointSync(candidate.lat, candidate.lng, countryFeatures)) return candidate;
  for (let attempt = 0; attempt < 3; attempt++) {
    const retry = jitterRegion(region);
    if (findCountryAtPointSync(retry.lat, retry.lng, countryFeatures)) return retry;
  }
  return region; // dreimal im Wasser gelandet - lieber der exakte Originalpunkt als gar keiner
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
    // Laendergrenzen sind lokale, im Repo mitgelieferte Daten (kein externer
    // Dienst) - fuer den Jitter-Land-Check hier immer laden, nicht nur im
    // Country-Streak-Modus. Schlaegt das fehl (Netzwerkproblem), macht
    // ensureOnLand() unten einfach ungeprueft weiter.
    const countryFeatures = await ensureCountryData().catch(() => null);

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

      const jittered = await Promise.all(wave.map((region) => ensureOnLand(jitterRegion(region), region, countryFeatures)));
      const settled = await Promise.allSettled(jittered.map((region, i) => fetchPanoramaForRegion(region).then((loc) => ({ loc, region: wave[i] }))));
      for (const result of settled) {
        if (result.status === 'fulfilled' && result.value.loc) {
          resolved.push(result.value.loc);
          recordVerifiedEntry(mapSet.id, result.value.loc, result.value.region.id);
        } else if (result.status === 'rejected') {
          console.error('Mapillary-Abruf fehlgeschlagen, versuche Ersatz-Region:', result.reason);
        }
      }
    }

    // Verified Image Pool als letzter Rueckfallschritt: gecachte, frueher
    // schon einmal erfolgreich gefundene Bild-IDs desselben Kartenpakets -
    // bewusst NIEDRIGERE Prioritaet als die frische Live-Suche oben (nur
    // genutzt, wenn die trotz Wellen-Retry immer noch nicht reicht), und
    // jede ID wird per fetchPanoramaById() neu verifiziert statt eine
    // moeglicherweise abgelaufene alte thumb_2048_url zu recyceln.
    if (resolved.length < roundCount) {
      const usedIds = new Set(resolved.map((l) => l.id));
      const cached = shuffleCopy(loadVerifiedEntries(mapSet.id)).filter((e) => !usedIds.has(`mapillary-${e.imageId}`));
      for (const entry of cached) {
        if (resolved.length >= roundCount) break;
        const location = await fetchPanoramaById(entry.imageId, entry);
        if (location) resolved.push(location);
      }
    }

    return resolved;
  }

  throw new Error(`Unbekannte Kartenpaket-Quelle: ${mapSet.source}`);
}

function shuffleCopy(arr) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}
