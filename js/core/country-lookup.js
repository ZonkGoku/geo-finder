import { pointInGeometry } from './point-in-polygon.js';

let featuresPromise = null;

async function loadFeatures() {
  if (!featuresPromise) {
    featuresPromise = fetch('./data/geo/countries-110m.json')
      .then((res) => res.json())
      .then((geojson) => geojson.features);
  }
  return featuresPromise;
}

/** Muss einmal vor dem ersten findCountryAtPointSync()-Aufruf awaited werden. */
export async function ensureCountryData() {
  return loadFeatures();
}

/**
 * Liefert den Ländernamen (aus dem 110m-Datensatz von world-atlas), in dessen
 * Umriss der Punkt liegt, oder null (z. B. auf hoher See). Synchron, weil die
 * Daten vorher per ensureCountryData() geladen sein muessen - wird das
 * vergessen, liefert die Funktion einfach null statt zu werfen.
 */
export function findCountryAtPointSync(lat, lng, features) {
  if (!features) return null;
  for (const feature of features) {
    if (pointInGeometry(lat, lng, feature.geometry)) {
      return feature.properties.name;
    }
  }
  return null;
}

export async function findCountryAtPoint(lat, lng) {
  const features = await loadFeatures();
  return findCountryAtPointSync(lat, lng, features);
}
