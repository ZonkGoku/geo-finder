// Einmalig auszufuehren (node scripts/fix-antimeridian.mjs), behebt einen
// Leaflet-Rendering-Bug: Laender, die die Datumsgrenze (+-180 Grad) kreuzen
// (Russland, Fidschi - USA/Alaska betrifft es in diesem 110m-Datensatz nicht,
// siehe Diagnose unten), enthalten in data/geo/countries-110m.json Ringe, die
// OHNE Aufteilung ueber die Datumsgrenze hinweglaufen. Ein solcher Ring
// enthaelt z. B. einen Punkt bei Laenge 178.6 und den naechsten Punkt bei
// -180 - geografisch benachbart (nur 1.4 Grad auseinander), aber numerisch
// weit auseinander. Leaflet kennt die Datumsgrenze nicht und zeichnet die
// Kante zwischen zwei aufeinanderfolgenden Ring-Punkten immer als direkte
// gerade Linie im Bildschirmkoordinatensystem - bei diesem Punktepaar also
// eine dicke horizontale Linie quer durch die gesamte Weltkarte.
//
// Geloest wird das NUR in den Daten (nicht im Frontend, siehe
// js/map/heatmap-map.js - dort bleibt aufwendiges Styling/Hover/die
// Fill-Reveal- und Glow-Animationen unangetastet): jeder betroffene Ring wird
// entlang der Datumsgrenze in mehrere gueltige Teil-Polygone zerschnitten.
// Alle unbetroffenen Ringe (die meisten) bleiben unveraendert.
//
// Vorgehen pro Ring:
// 1. "Unwrap": die Laengengrade werden fortlaufend aufsummiert statt bei
//    +-180 zu springen (z. B. wird aus ...,178.6,-180,...,179.99 die Folge
//    ...,178.6,180,...,~183 - dieselbe Geometrie, nur ohne den kuenstlichen
//    Sprung). Danach ist der Ring ein normales, nicht mehr selbst-
//    ueberschneidendes Polygon, das lediglich ueber +180 (oder unter -180)
//    hinausragt.
// 2. Dieses "entrollte" Polygon wird mit turf.bboxClip() (robuste, gut
//    getestete Clipping-Implementierung statt einer selbstgebauten) in zwei
//    Haelften geschnitten: den Teil, der schon im gueltigen Bereich liegt,
//    und den ueberstehenden Teil.
// 3. Der ueberstehende Teil wird um 360 Grad zurueckverschoben, damit er
//    wieder im gueltigen -180..180-Bereich liegt (z. B. 183 Grad -> -177 Grad).
// 4. Beide Teile landen als eigene Eintraege im MultiPolygon des Features.
//
// turf.js wird bewusst NUR hier (Build-/Datenpflege-Zeit, node_modules per
// .gitignore nicht eingecheckt) verwendet, nie im Frontend - das Spiel selbst
// bleibt ein abhaengigkeitsfreies Vanilla-JS-Projekt ohne Build-Schritt, die
// bereinigte JSON-Datei ist danach ein normales statisches Asset wie zuvor.
import { readFile, writeFile } from 'node:fs/promises';
import * as turf from '@turf/turf';

const SRC = new URL('../data/geo/countries-110m.json', import.meta.url);
const OUT = SRC;

// Ein Ring "braucht" die Behandlung nur, wenn er tatsaechlich einen Sprung
// von mehr als 180 Grad zwischen zwei aufeinanderfolgenden Punkten enthaelt -
// alle anderen (die grosse Mehrheit, inkl. normal breiter Laender wie
// Russland selbst im Westen oder Frankreich, das lediglich den NULLmeridian
// kreuzt) bleiben unangetastet.
function ringCrossesAntimeridian(ring) {
  for (let i = 1; i < ring.length; i++) {
    if (Math.abs(ring[i][0] - ring[i - 1][0]) > 180) return true;
  }
  return false;
}

function unwrapRing(ring) {
  const out = [ring[0]];
  let offset = 0;
  for (let i = 1; i < ring.length; i++) {
    const rawDelta = ring[i][0] - ring[i - 1][0];
    if (rawDelta > 180) offset -= 360;
    else if (rawDelta < -180) offset += 360;
    out.push([ring[i][0] + offset, ring[i][1]]);
  }
  return out;
}

// Nach dem Entrollen MUSS ein Ring wieder exakt am Startpunkt schliessen
// (siehe unwrapRing()) - das gilt fuer jede "lokale" Datumsgrenzen-Ueberquerung
// (ein Land, das kurz ueber die Grenze reicht und zurueckkehrt, z. B.
// Russlands Tschuktschen-Halbinsel oder Fidschi). EIN bekannter Sonderfall
// schliesst NICHT: die Antarktis, deren Kuestenlinien-Ring buchstaeblich
// einmal komplett um den Pol herumlaeuft (Laenge durchgehend von -180 bis
// +180, schliesst am Pol statt an einem lokalen Ausgangspunkt). Das ist ein
// voellig anderes Problem (ein zirkumpolares Landstueck, das in einer
// rechteckigen Projektion eigentlich am unteren Kartenrand "entlanggezogen"
// werden muesste, inkl. Sonderbehandlung fuer den Pol selbst, wo Web-
// Mercator-CRS ohnehin mathematisch nicht mehr definiert ist) als die hier
// behandelten lokalen Ausreisser - wird bewusst NICHT angefasst (siehe
// Skip-Zweig unten), um nicht ungetestet einen neuen, komplexeren Bug am
// Suedpol einzufuehren. Nicht Teil des gemeldeten Symptoms (Russland/Fidschi/
// USA-Alaska).
function ringClosesAfterUnwrap(unwrapped) {
  const first = unwrapped[0];
  const last = unwrapped[unwrapped.length - 1];
  return Math.abs(first[0] - last[0]) < 1e-6 && Math.abs(first[1] - last[1]) < 1e-6;
}

/**
 * Zerschneidet EIN Polygon (rings = [Aussenring, ...Loecher]), das die
 * Datumsgrenze kreuzt, in mehrere gueltige Polygone. Gibt ein Array von
 * rings-Arrays zurueck (jedes Element ein eigenstaendiges Polygon fuers
 * MultiPolygon), oder null, wenn der Ring nicht der erwartete "lokale
 * Ausreisser"-Fall ist (siehe ringClosesAfterUnwrap()) - der Aufrufer laesst
 * das Polygon dann unveraendert statt es kaputt zu schneiden.
 */
function splitAntimeridianPolygon(rings) {
  const unwrapped = rings.map(unwrapRing);
  if (!unwrapped.every(ringClosesAfterUnwrap)) return null;
  const allLngs = unwrapped.flat().map((p) => p[0]);
  const min = Math.min(...allLngs);
  const max = Math.max(...allLngs);
  const overflowsPositive = max > 180;
  const overflowsNegative = min < -180;

  const poly = turf.polygon(unwrapped);
  const pieces = [];

  // Normalbereich: was nach dem Entrollen ohnehin schon in -180..180 liegt.
  const normalClip = turf.bboxClip(poly, [-180, -90, 180, 90]);
  for (const p of normalClip.geometry.type === 'Polygon' ? [normalClip.geometry.coordinates] : normalClip.geometry.coordinates) {
    pieces.push(p);
  }

  if (overflowsPositive) {
    const overflowClip = turf.bboxClip(poly, [180, -90, max + 1, 90]);
    for (const p of overflowClip.geometry.type === 'Polygon' ? [overflowClip.geometry.coordinates] : overflowClip.geometry.coordinates) {
      pieces.push(p.map((ring) => ring.map(([lng, lat]) => [lng - 360, lat])));
    }
  }
  if (overflowsNegative) {
    const overflowClip = turf.bboxClip(poly, [min - 1, -90, -180, 90]);
    for (const p of overflowClip.geometry.type === 'Polygon' ? [overflowClip.geometry.coordinates] : overflowClip.geometry.coordinates) {
      pieces.push(p.map((ring) => ring.map(([lng, lat]) => [lng + 360, lat])));
    }
  }
  return pieces;
}

const geojson = JSON.parse(await readFile(SRC, 'utf8'));

let fixedRings = 0;
let fixedFeatures = 0;
let skippedCircumpolar = [];
for (const feature of geojson.features) {
  const geometry = feature.geometry;
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const nextPolygons = [];
  let touchedThisFeature = false;

  for (const rings of polygons) {
    if (ringCrossesAntimeridian(rings[0])) {
      // Loecher (weitere Ringe), die selbst NICHT ueber die Datumsgrenze
      // laufen, wuerden durch splitAntimeridianPolygon() trotzdem korrekt
      // mitgeschnitten (turf.bboxClip erhaelt Loecher) - in diesem Datensatz
      // haben die betroffenen Ringe aber ohnehin keine Loecher.
      const pieces = splitAntimeridianPolygon(rings);
      if (pieces) {
        nextPolygons.push(...pieces);
        fixedRings++;
        touchedThisFeature = true;
      } else {
        // Zirkumpolarer Sonderfall (siehe ringClosesAfterUnwrap()) -
        // unveraendert lassen statt falsch zu zerschneiden.
        skippedCircumpolar.push(feature.properties.name);
        nextPolygons.push(rings);
      }
    } else {
      nextPolygons.push(rings);
    }
  }

  if (touchedThisFeature) {
    fixedFeatures++;
    geometry.type = 'MultiPolygon';
    geometry.coordinates = nextPolygons;
  }
}

await writeFile(OUT, JSON.stringify(geojson), 'utf8');
console.log(`${fixedRings} datumsgrenzen-ueberschreitende Ring(e) in ${fixedFeatures} Land/Laendern aufgeteilt.`);
if (skippedCircumpolar.length) {
  console.log(`Uebersprungen (zirkumpolarer Sonderfall, siehe Kommentar an ringClosesAfterUnwrap()): ${skippedCircumpolar.join(', ')}`);
}
console.log(`Geschrieben nach ${OUT.pathname}`);

// Sanity-Check: kein verbleibender Ring sollte noch einen >180-Grad-Sprung
// zwischen zwei aufeinanderfolgenden Punkten haben - ausser dem bewusst
// uebersprungenen zirkumpolaren Sonderfall oben (sonst meldet dieser Check
// bei jedem Lauf einen "Fehler", der gar keiner ist).
let remaining = 0;
for (const feature of geojson.features) {
  if (skippedCircumpolar.includes(feature.properties.name)) continue;
  const polygons = feature.geometry.type === 'Polygon' ? [feature.geometry.coordinates] : feature.geometry.coordinates;
  for (const rings of polygons) {
    for (const ring of rings) {
      if (ringCrossesAntimeridian(ring)) {
        remaining++;
        console.warn(`  [FAIL] verbleibender Sprung in ${feature.properties.name}`);
      }
    }
  }
}
console.log(remaining === 0 ? 'Sanity-Check OK: keine verbleibenden Datumsgrenzen-Spruenge.' : `Sanity-Check FEHLGESCHLAGEN: ${remaining} verbleibende Spruenge.`);
