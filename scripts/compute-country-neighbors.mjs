// Einmalig auszufuehren (node scripts/compute-country-neighbors.mjs), wenn
// sich data/geo/countries-110m.json aendert. Erzeugt data/geo/country-
// neighbors.json: eine Liste direkter Landgrenzen-Nachbarn pro Land-ID, die
// der Heatmap-Modus fuer "Nachbarland!"-Feedback braucht (siehe
// core/heatmap-color.js).
//
// countries-110m.json enthaelt nur Umrisse, keine Adjazenz-Information.
// Bewusst KEIN externer "countries-neighbors.json"-Datensatz von GitHub -
// so ein Datensatz nutzt fast immer ISO-3166-Alpha-Codes als Schluessel,
// dieses Projekt aber UN-M49-Codes bzw. Namens-Slugs (siehe
// core/country-store.js resolveFeatureId()) fuer die 3 nicht UN-anerkannten
// Gebiete. Eine Code-Uebersetzungstabelle waere selbst wieder eine externe
// Abhaengigkeit mit Pflegeaufwand. Stattdessen: Nachbarschaft direkt aus den
// bereits vorhandenen Polygonen ableiten - zwei Laender sind Nachbarn, wenn
// der kuerzeste Abstand zwischen irgendeinem Kantensegment des einen und
// irgendeinem Kantensegment des anderen unter einem kleinen Schwellenwert
// liegt (exakt gemeinsame Grenzpunkte sind bei einem bereits vereinfachten
// 110m-Datensatz nicht garantiert, ein kleiner Toleranzabstand faengt das
// ab). Der Schwellenwert ist bewusst klein genug, um schmale Meerengen OHNE
// echte Landgrenze auszuschliessen (z. B. Spanien/Marokko ueber Gibraltar
// ~14km, UK/Frankreich ueber den Aermelkanal ~34km sind KEINE Nachbarn).
//
// Zwei Faellen, die eine naive erste Fassung dieses Skripts falsch
// beantwortet hat (per Stichprobe entdeckt, siehe unten):
// 1. Enklaven (Lesotho komplett von Suedafrika umschlossen): deren Grenze
//    verlaeuft oft als LOCH im umschliessenden Land, nicht nur als eigener
//    Aussenring. Nur Aussenringe zu vergleichen uebersah Lesotho komplett
//    (0 Nachbarn statt Suedafrika). Jetzt werden ALLE Ringe (Aussen + Loecher)
//    verglichen.
// 2. Datumsgrenze: Russland (spannt sich rechnerisch ueber +-180 Grad) wurde
//    faelschlich als Nachbar von Kanada erkannt, weil unverschobene
//    Laengengrade auf den GEGENUEBERLIEGENDEN Seiten der Datumsgrenze
//    numerisch weit auseinanderliegen, obwohl sie geografisch nah sind (oder
//    hier: umgekehrt zufaellig nah wirken, obwohl sie es nicht sind). Jeder
//    Laenderpaar-Vergleich verschiebt beide Ring-Kopien jetzt in einen
//    gemeinsamen lokalen Bezugsrahmen (relativ zum ersten Land), bevor er
//    Bounding-Box/Abstand berechnet.
import { readFile, writeFile } from 'node:fs/promises';

const SRC = new URL('../data/geo/countries-110m.json', import.meta.url);
const CENTROIDS = new URL('../data/geo/country-centroids.json', import.meta.url);
const OUT = new URL('../data/geo/country-neighbors.json', import.meta.url);

// In Dezimalgrad - grob 0.1 Grad ~ 10-11km am Aequator. Faengt
// Vereinfachungs-Luecken an echten Landgrenzen auf, bleibt aber deutlich
// unter der Breite der oben genannten Meerengen.
//
// War zunaechst 0.15: per Stichprobe bei Saudi-Arabien aufgefallen (Liste
// enthielt faelschlich Israel und Aegypten). Eine volle Abstands-Verteilung
// ueber alle erkannten Paare zeigte 315 von 320 Paaren bei GENAU 0 Grad
// (echte gemeinsame Kartentopologie) und nur 5 Ausreisser zwischen 0.09 und
// 0.15 Grad: 4 falsche Treffer ueber schmale Meerengen ohne echte
// Landgrenze (Israel-Saudi-Arabien 0.1491, Saudi-Arabien-Aegypten 0.1098,
// Trinidad und Tobago-Venezuela 0.1094, Kroatien-Italien 0.1021) sowie EIN
// echter, aber schmaler Grenzverlauf (Mauretanien-Marokko 0.0911, an der
// Westsahara). 0.1 liegt sauber zwischen diesen beiden Gruppen.
const NEIGHBOR_THRESHOLD_DEG = 0.1;
// Grobfilter-Puffer zusaetzlich zum radius-basierten Mittelpunkt-Check
// unten (siehe dortiger Kommentar) - faengt Rundungs-/Vereinfachungs-Rand-
// faelle ab.
const PRECHECK_PAD_DEG = 2;

function slug(name) {
  return `name-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function resolveFeatureId(feature) {
  return feature.id != null ? String(feature.id) : slug(feature.properties.name);
}

// ALLE Ringe (Aussenring + Loecher) - ein Loch in Land A ist oft exakt die
// Grenze zu einer Enklave B (siehe Lesotho-Kommentar oben).
function allRings(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  return polygons.flatMap((rings) => rings).filter((ring) => ring && ring.length >= 2);
}

// Verschiebt eine Laenge in die naeheste Entsprechung von ref (periodisch,
// 360 Grad) - macht zwei Ringe auf gegenueberliegenden Seiten der
// Datumsgrenze im selben lokalen Fenster vergleichbar.
function wrapNear(lng, ref) {
  let d = lng - ref;
  d -= Math.round(d / 360) * 360;
  return ref + d;
}

function rewrapRing(ring, ref) {
  return ring.map(([lng, lat]) => [wrapNear(lng, ref), lat]);
}

function boundingBox(rings) {
  let minLng = Infinity;
  let maxLng = -Infinity;
  let minLat = Infinity;
  let maxLat = -Infinity;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      if (lng < minLng) minLng = lng;
      if (lng > maxLng) maxLng = lng;
      if (lat < minLat) minLat = lat;
      if (lat > maxLat) maxLat = lat;
    }
  }
  return { minLng, maxLng, minLat, maxLat };
}

function bboxesNearby(a, b, pad) {
  return a.minLng - pad <= b.maxLng && b.minLng - pad <= a.maxLng && a.minLat - pad <= b.maxLat && b.minLat - pad <= a.maxLat;
}

function pointToSegmentDist(px, py, ax, ay, bx, by) {
  const dx = bx - ax;
  const dy = by - ay;
  const lenSq = dx * dx + dy * dy;
  let t = lenSq === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / lenSq;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx;
  const cy = ay + t * dy;
  return Math.hypot(px - cx, py - cy);
}

function segmentToSegmentDist(a1, a2, b1, b2) {
  return Math.min(
    pointToSegmentDist(a1[0], a1[1], b1[0], b1[1], b2[0], b2[1]),
    pointToSegmentDist(a2[0], a2[1], b1[0], b1[1], b2[0], b2[1]),
    pointToSegmentDist(b1[0], b1[1], a1[0], a1[1], a2[0], a2[1]),
    pointToSegmentDist(b2[0], b2[1], a1[0], a1[1], a2[0], a2[1])
  );
}

function minRingsDistance(ringsA, ringsB, earlyOutThreshold) {
  let best = Infinity;
  for (const ringA of ringsA) {
    for (let i = 0; i < ringA.length - 1; i++) {
      const a1 = ringA[i];
      const a2 = ringA[i + 1];
      for (const ringB of ringsB) {
        for (let j = 0; j < ringB.length - 1; j++) {
          const d = segmentToSegmentDist(a1, a2, ringB[j], ringB[j + 1]);
          if (d < best) best = d;
          if (best <= earlyOutThreshold) return best;
        }
      }
    }
  }
  return best;
}

function angularLngDiff(a, b) {
  const d = Math.abs(a - b) % 360;
  return Math.min(d, 360 - d);
}

// Jedes Land braucht einen eigenen, von seiner Groesse/Form abhaengigen
// Grobfilter-Radius statt eines pauschalen Schwellenwerts - ein pauschaler
// Wert (z. B. 35 Grad) schliesst bei sehr grossen/langgestreckten Laendern
// wie Russland (Mittelpunkt tief in Sibirien, aber Grenze zu Norwegen ganz
// im Westen) faelschlich echte Nachbarn aus. "Radius" hier: die groesste
// (periodische, datumsgrenzensichere) Winkeldistanz von JEDEM eigenen
// Randpunkt zum eigenen Mittelpunkt.
function countryRadius(rings, centroid) {
  let max = 0;
  for (const ring of rings) {
    for (const [lng, lat] of ring) {
      const d = Math.hypot(angularLngDiff(lng, centroid.lng), lat - centroid.lat);
      if (d > max) max = d;
    }
  }
  return max;
}

const [geojson, centroids] = await Promise.all([
  readFile(SRC, 'utf8').then(JSON.parse),
  readFile(CENTROIDS, 'utf8').then(JSON.parse),
]);

const countries = geojson.features.map((feature) => {
  const id = resolveFeatureId(feature);
  const rings = allRings(feature.geometry);
  const centroid = centroids[id];
  return { id, name: feature.properties.name, rings, centroid, radius: centroid ? countryRadius(rings, centroid) : 0 };
});

const neighbors = new Map(countries.map((c) => [c.id, new Set()]));

let candidatePairs = 0;
let hits = 0;
for (let i = 0; i < countries.length; i++) {
  for (let j = i + 1; j < countries.length; j++) {
    const a = countries[i];
    const b = countries[j];
    if (!a.centroid || !b.centroid) continue;
    const centroidDist = Math.hypot(angularLngDiff(a.centroid.lng, b.centroid.lng), a.centroid.lat - b.centroid.lat);
    if (centroidDist > a.radius + b.radius + PRECHECK_PAD_DEG) continue;
    candidatePairs++;

    // Beide Ring-Saetze relativ zu Land A's Mittelpunkt in ein gemeinsames
    // lokales Laengengrad-Fenster verschieben - loest den Datumsgrenzenfall
    // unabhaengig davon, welches der beiden Laender (falls ueberhaupt eins)
    // selbst ueber +-180 Grad hinaus verlaeuft.
    const ref = a.centroid.lng;
    const ringsA = a.rings.map((r) => rewrapRing(r, ref));
    const ringsB = b.rings.map((r) => rewrapRing(r, ref));
    const bboxA = boundingBox(ringsA);
    const bboxB = boundingBox(ringsB);
    if (!bboxesNearby(bboxA, bboxB, NEIGHBOR_THRESHOLD_DEG * 2)) continue;

    const dist = minRingsDistance(ringsA, ringsB, 0);
    if (dist <= NEIGHBOR_THRESHOLD_DEG) {
      neighbors.get(a.id).add(b.id);
      neighbors.get(b.id).add(a.id);
      hits++;
    }
  }
}

const result = {};
for (const c of countries) {
  result[c.id] = [...neighbors.get(c.id)].sort();
}

await writeFile(OUT, JSON.stringify(result), 'utf8');
console.log(`${countries.length} Laender, ${candidatePairs} Kandidaten-Paare nach Mittelpunkt-Grobfilter geprueft, ${hits} Nachbarschaften gefunden.`);
console.log(`Geschrieben nach ${OUT.pathname}`);

const byName = new Map(countries.map((c) => [c.name, c]));
function sampleCheck(nameA, nameB, expected) {
  const a = byName.get(nameA);
  const b = byName.get(nameB);
  if (!a || !b) return console.log(`  (Land nicht gefunden: ${nameA} oder ${nameB})`);
  const areNeighbors = result[a.id]?.includes(b.id);
  const mark = areNeighbors === expected ? 'OK' : 'FAIL';
  console.log(`  [${mark}] ${nameA} <-> ${nameB}: ${areNeighbors ? 'Nachbarn' : 'keine Nachbarn'} (erwartet: ${expected ? 'Nachbarn' : 'keine'})`);
}
console.log('Stichproben:');
sampleCheck('Germany', 'France', true);
sampleCheck('Germany', 'Poland', true);
sampleCheck('France', 'United Kingdom', false);
sampleCheck('Spain', 'Morocco', false);
sampleCheck('United States of America', 'Canada', true);
sampleCheck('Brazil', 'Argentina', true);
sampleCheck('Australia', 'New Zealand', false);
sampleCheck('Lesotho', 'South Africa', true);
sampleCheck('Russia', 'Canada', false);
sampleCheck('Russia', 'Norway', true);
sampleCheck('Mongolia', 'China', true);
sampleCheck('Chile', 'Argentina', true);
// Reine Meerengen ohne echte Landgrenze - der Grund, warum der Schwellenwert
// 0.1 statt grosszuegiger 0.15 Grad ist (siehe Kommentar oben).
sampleCheck('Israel', 'Saudi Arabia', false);
sampleCheck('Saudi Arabia', 'Egypt', false);
sampleCheck('Trinidad and Tobago', 'Venezuela', false);
sampleCheck('Croatia', 'Italy', false);
// Echte, aber schmale Grenze bei der Westsahara - darf trotz des knappen
// Schwellenwerts nicht mit-ausgeschlossen werden.
sampleCheck('Mauritania', 'Morocco', true);
