import { pointInGeometry } from './point-in-polygon.js';

// Deterministischer PRNG (mulberry32), damit ein Host bei Bedarf reproduzierbare
// Rundenfolgen erzeugen kann (z. B. fuer "gleiche Runden fuer alle Gruppen").
export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeSeed() {
  return Math.floor(Math.random() * 0xffffffff);
}

export function pickUniqueLocations(pool, count, seed) {
  const rand = mulberry32(seed);
  const shuffled = [...pool];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }
  return shuffled.slice(0, Math.min(count, shuffled.length));
}

// Wandelt einen beliebigen String (z. B. ein Datum) deterministisch in einen
// 32-Bit-Seed um (FNV-1a) - fuer die Tages-Challenge, deren Seed sich aus
// dem aktuellen Datum ergeben soll statt ueber makeSeed() zufaellig zu sein.
export function hashStringToSeed(str) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// Alle [lng, lat]-Ringpunkte einer Polygon/MultiPolygon-Geometrie in eine
// Bounding-Box falten - Grundlage fuer die Verwerfungsstichprobe unten
// (Rejection Sampling braucht eine Flaeche, aus der schnell gleichverteilt
// gezogen werden kann, die Bounding-Box ist die einfachste, die eine
// beliebig geformte Polygon/Loch-Kombination immer vollstaendig umschliesst).
function geometryBounds(geometry) {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  const visitRing = (ring) => {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  };
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  for (const rings of polygons) {
    // rings[0] (die Aussenkontur) reicht fuer die Bounding-Box - Loecher
    // (rings[1+]) liegen per Definition innerhalb und koennen sie nie
    // erweitern.
    visitRing(rings[0]);
  }
  return { minLng, maxLng, minLat, maxLat };
}

/**
 * Liefert einen gleichverteilt zufaelligen Punkt INNERHALB einer Polygon-/
 * MultiPolygon-Geometrie (GeoJSON, [lng,lat]-Ringe) - Grundlage fuer
 * prozedural erzeugte Zielorte in grossen Kartenpaketen (siehe
 * AUDIT_ROADMAP.md Abschnitt 5), wo eine rein kuratierte Ortsliste bei
 * hoher gewuenschter Rundenzahl irgendwann zu Wiederholungen fuehrt.
 * Verwerfungsstichprobe (Rejection Sampling) statt einer analytischen
 * Formel: fuer beliebig geformte, ggf. gelochte (z.B. Laender mit
 * Enklaven) Polygone gibt es keine einfache direkte Formel, aber
 * Verwerfung ist fuer die kompakten, nicht extrem duennen Landesumrisse
 * hier schnell genug (typischerweise wenige bis niedrige zweistellige
 * Versuche, siehe maxAttempts als Notbremse fuer pathologisch duenne
 * Faelle wie schmale Kuestenstreifen-Staaten).
 *
 * rand: eine 0-1-Zufallsfunktion (z.B. mulberry32(seed)) statt Math.random,
 * damit dieselbe Ortsziehung bei Bedarf reproduzierbar bleibt (gleiche
 * Praemisse wie pickUniqueLocations oben). Gibt bei Ueberschreiten von
 * maxAttempts null zurueck statt einen Punkt AUSSERHALB der Geometrie
 * vorzutaeuschen - Aufrufer entscheiden selbst ueber einen Fallback
 * (z.B. Centroid oder ein kuratierter Ersatzort).
 */
export function getRandomPointInPolygon(geometry, rand = Math.random, maxAttempts = 200) {
  if (!geometry) return null;
  const { minLng, maxLng, minLat, maxLat } = geometryBounds(geometry);
  for (let i = 0; i < maxAttempts; i++) {
    const lng = minLng + rand() * (maxLng - minLng);
    const lat = minLat + rand() * (maxLat - minLat);
    if (pointInGeometry(lat, lng, geometry)) return { lat, lng };
  }
  return null;
}
