// Grenze-zu-Grenze-Distanz statt Mittelpunkt-zu-Mittelpunkt fuer den
// Heatmap-Modus (Nutzer-Feedback: eine Mittelpunkt-Distanz wirkt bei sehr
// grossen/laenglichen Laendern irrefuehrend - ein Tipp direkt an der Grenze
// zeigte trotzdem noch hunderte Kilometer "Distanz").
//
// Reines Punkt-zu-Punkt-Minimum ueber alle Randpunkte beider Laender (keine
// echte Kante-zu-Kante-Rechnung): bei diesem bereits vereinfachten 110m-
// Datensatz reicht das - echte Landgrenzen teilen sich hier so gut wie immer
// exakt denselben Randpunkt (siehe scripts/compute-country-neighbors.mjs,
// dessen Analyse 315 von 320 echten Nachbarschaften bei GENAU 0 Grad
// Ringabstand fand). Eine engere Kante-zu-Kante-Rechnung wuerde kaum
// praezisere Ergebnisse liefern, aber bei Laendern mit hunderten Randpunkten
// (Russland, Kanada) deutlich mehr Rechenzeit kosten.
//
// haversineDistanceKm() selbst ist bereits datumsgrenzensicher (die
// Sinus-Formel ist periodisch, numerisch weit auseinanderliegende, aber
// geografisch nahe Laengengrade wie 179°/-179° ergeben trotzdem die kurze
// Distanz) - keine gesonderte Umwrapping-Behandlung noetig, anders als beim
// Bounding-Box-Vorfilter im Offline-Erzeugungsskript.
import { haversineDistanceKm } from './scoring.js';

/** [lat,lng]-Liste ALLER Randpunkte (Aussenringe + Loecher) einer GeoJSON-
 * Polygon/MultiPolygon-Geometrie - Loecher zaehlen mit, weil ein Loch in
 * Land A oft exakt die Grenze zu einer Enklave B ist (z. B. Lesotho in
 * Suedafrika). */
export function boundaryPoints(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  const points = [];
  for (const rings of polygons) {
    for (const ring of rings) {
      for (const [lng, lat] of ring) points.push([lat, lng]);
    }
  }
  return points;
}

/** Kuerzeste Distanz zwischen irgendeinem Randpunkt von pointsA und irgendeinem von pointsB. */
export function borderDistanceKm(pointsA, pointsB) {
  let min = Infinity;
  for (const [latA, lngA] of pointsA) {
    for (const [latB, lngB] of pointsB) {
      const d = haversineDistanceKm(latA, lngA, latB, lngB);
      if (d < min) min = d;
    }
  }
  return min;
}
