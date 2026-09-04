// Einmalig auszufuehren (node scripts/compute-country-centroids.mjs), wenn
// sich data/geo/countries-110m.json aendert. Erzeugt data/geo/country-
// centroids.json: einen Mittelpunkt (lat/lng) pro Land, den der Heatmap-
// Modus (js/core/country-store.js) fuer die Distanzberechnung braucht.
//
// countries-110m.json (world-atlas, 110m-Aufloesung) enthaelt NUR
// Polygon-/MultiPolygon-Umrisse, keine Mittelpunkte. Ein einfacher
// Eckpunkt-Mittelwert waere fuer die Distanzmessung ungeeignet (verzerrt bei
// ungleichmaessig dichten Stuetzpunkten, komplett falsch bei Loechern/
// Inselgruppen), daher die flaechengewichtete Standardformel fuer
// Polygon-Schwerpunkte (Shoelace-Formel). Bei MultiPolygons (z. B.
// Indonesien, Japan, USA mit Alaska) wird bewusst nur der FLAECHENGROESSTE
// Teil-Ring verwendet statt aller Inseln gemittelt - sonst landet der
// Mittelpunkt eines Archipels im offenen Meer zwischen den Inseln.
// Laender, die die Datumsgrenze kreuzen (z. B. Fidschi, Russland), werden
// vor der Rechnung auf einen zusammenhaengenden Longitude-Bereich verschoben
// und danach zurueckgewrappt, sonst kippt der Mittelpunkt faelschlich auf
// Laenge ~0.
import { readFile, writeFile } from 'node:fs/promises';

const SRC = new URL('../data/geo/countries-110m.json', import.meta.url);
const OUT = new URL('../data/geo/country-centroids.json', import.meta.url);

function normalizeRingLng(ring) {
  const lngs = ring.map((p) => p[0]);
  const min = Math.min(...lngs);
  const max = Math.max(...lngs);
  if (max - min <= 180) return ring;
  return ring.map(([lng, lat]) => [lng < 0 ? lng + 360 : lng, lat]);
}

// Flaechengewichteter Schwerpunkt eines einzelnen Rings (Shoelace-Formel).
// Liefert { area, cx, cy } - area ist signiert (Vorzeichen zeigt Wickelsinn),
// fuer den Groessenvergleich zwischen Ringen wird nur |area| gebraucht.
function ringCentroid(ring) {
  const pts = normalizeRingLng(ring);
  let area = 0;
  let cx = 0;
  let cy = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const [x0, y0] = pts[i];
    const [x1, y1] = pts[i + 1];
    const cross = x0 * y1 - x1 * y0;
    area += cross;
    cx += (x0 + x1) * cross;
    cy += (y0 + y1) * cross;
  }
  area /= 2;
  if (Math.abs(area) < 1e-12) {
    // Entarteter Ring (Flaeche ~0) - Eckpunkt-Mittelwert als Fallback statt
    // Division durch (fast) null.
    const avgX = pts.reduce((s, p) => s + p[0], 0) / pts.length;
    const avgY = pts.reduce((s, p) => s + p[1], 0) / pts.length;
    return { area: 0, cx: avgX, cy: avgY };
  }
  cx /= 6 * area;
  cy /= 6 * area;
  return { area, cx, cy };
}

function wrapLng(lng) {
  if (lng > 180) return lng - 360;
  if (lng < -180) return lng + 360;
  return lng;
}

function featureCentroid(geometry) {
  const polygons = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
  let best = null;
  for (const rings of polygons) {
    const outer = rings[0]; // Loecher (weitere Ringe) fuer den Schwerpunkt ignoriert - siehe Kommentar oben
    if (!outer || outer.length < 4) continue;
    const c = ringCentroid(outer);
    if (!best || Math.abs(c.area) > Math.abs(best.area)) best = c;
  }
  if (!best) return null;
  return { lat: best.cy, lng: wrapLng(best.cx) };
}

// 3 der 177 Features (Nordzypern, Somaliland, Kosovo - allesamt umstrittene,
// nicht UN-anerkannte Gebiete) haben im world-atlas-Datensatz GAR KEIN "id"-
// Feld (nur international anerkannte Staaten tragen einen UN M49-Code).
// Ohne Fallback wuerden alle drei denselben "undefined"-Schluessel teilen
// und sich gegenseitig ueberschreiben (177 Features -> nur 175 Eintraege!).
// Ein aus dem Namen abgeleiteter Slug haelt sie auseinander - wichtig, weil
// "Kosovo" ein sehr plausibler Tipp im Heatmap-Modus ist.
function slug(name) {
  return `name-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

const geojson = JSON.parse(await readFile(SRC, 'utf8'));
const result = {};
for (const feature of geojson.features) {
  const centroid = featureCentroid(feature.geometry);
  if (!centroid) {
    console.warn('Kein Schwerpunkt berechenbar fuer:', feature.properties?.name, feature.id);
    continue;
  }
  const id = feature.id ?? slug(feature.properties.name);
  result[id] = {
    name: feature.properties.name,
    lat: Number(centroid.lat.toFixed(4)),
    lng: Number(centroid.lng.toFixed(4)),
  };
}

await writeFile(OUT, JSON.stringify(result), 'utf8');
console.log(`${Object.keys(result).length} Laender-Mittelpunkte geschrieben nach ${OUT.pathname}`);
