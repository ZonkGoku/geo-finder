// Klassischer Ray-Casting-Test, einzeln pro Ring angewandt. Erwartet GeoJSON-
// Ringe als [lng, lat]-Paare (GeoJSON-Konvention: erst Länge, dann Breite).
function pointInRing(lng, lat, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    const intersects = yi > lat !== yj > lat && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function pointInPolygonRings(lng, lat, rings) {
  // rings[0] ist die Außenkontur, alles danach sind Löcher.
  if (!pointInRing(lng, lat, rings[0])) return false;
  for (let i = 1; i < rings.length; i++) {
    if (pointInRing(lng, lat, rings[i])) return false;
  }
  return true;
}

export function pointInGeometry(lat, lng, geometry) {
  if (!geometry) return false;
  if (geometry.type === 'Polygon') {
    return pointInPolygonRings(lng, lat, geometry.coordinates);
  }
  if (geometry.type === 'MultiPolygon') {
    return geometry.coordinates.some((polygon) => pointInPolygonRings(lng, lat, polygon));
  }
  return false;
}
