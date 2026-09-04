import { HEATMAP_COLORS } from '../core/heatmap-color.js';

// Fester dunkler Basemap-Kachel-Layer statt des ueblichen Satellit/Karte-
// Umschalters (attachTileLayer in tile-config.js) - Satellitenbilder wuerden
// optisch mit den eingefaerbten Laender-Polygonen konkurrieren, ein neutraler
// dunkler Hintergrund laesst die Distanz-Farben klar hervortreten. Esri's
// "Canvas/World_Dark_Gray_Base" ist wie die anderen Esri-Layer dieser App
// schluessellos nutzbar (gleiche {z}/{y}/{x}-Reihenfolge-Eigenheit).
const DARK_TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const DARK_TILE_ATTRIBUTION = '&copy; Esri';

export class HeatmapMap {
  constructor(containerEl) {
    this.map = window.L.map(containerEl, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 2,
    }).setView([20, 10], 2);

    window.L.tileLayer(DARK_TILE_URL, { attribution: DARK_TILE_ATTRIBUTION, maxZoom: 12 }).addTo(this.map);

    this.layer = null;
    this.layerByCountryId = new Map();
  }

  /** countries: [{ id, name, geometry }] - einmal pro Partie aufgerufen. */
  setCountries(countries) {
    if (this.layer) this.map.removeLayer(this.layer);
    this.layerByCountryId.clear();

    const features = countries.map((c) => ({
      type: 'Feature',
      id: c.id,
      properties: { name: c.name },
      geometry: c.geometry,
    }));

    this.layer = window.L.geoJSON(features, {
      style: () => ({ color: 'rgba(255,255,255,0.28)', weight: 1, fillColor: HEATMAP_COLORS.unguessed, fillOpacity: 0 }),
    }).addTo(this.map);

    this.layer.eachLayer((layer) => {
      this.layerByCountryId.set(String(layer.feature.id), layer);
    });
  }

  colorCountry(countryId, color) {
    const layer = this.layerByCountryId.get(String(countryId));
    if (!layer) return;
    layer.setStyle({ fillColor: color, fillOpacity: color === HEATMAP_COLORS.unguessed ? 0 : 0.78 });
    layer.bringToFront();
  }

  /** Alle Faerbungen zuruecksetzen - vor jeder neuen Runde. */
  reset() {
    this.layerByCountryId.forEach((layer) => layer.setStyle({ fillColor: HEATMAP_COLORS.unguessed, fillOpacity: 0 }));
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
