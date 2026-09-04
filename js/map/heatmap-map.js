import { HEATMAP_COLORS } from '../core/heatmap-color.js';

// Fester dunkler Basemap-Kachel-Layer statt des ueblichen Satellit/Karte-
// Umschalters (attachTileLayer in tile-config.js) - Satellitenbilder wuerden
// optisch mit den eingefaerbten Laender-Polygonen konkurrieren, ein neutraler
// dunkler Hintergrund laesst die Distanz-Farben klar hervortreten. CartoDB
// Dark Matter ist schluessellos nutzbar und bietet ein zusammenpassendes
// Kachel-Paar MIT und OHNE Beschriftungen vom selben Anbieter (statt Labels
// nachtraeglich als separaten Overlay-Layer draufzulegen) - genau das braucht
// die "Karten-Labels An/Aus"-Einstellung (siehe lobby heatmapLabels).
const DARK_TILE_URL_LABELS = 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_all/{z}/{x}/{y}.png';
const DARK_TILE_URL_NO_LABELS = 'https://{s}.basemaps.cartocdn.com/rastertiles/dark_nolabels/{z}/{x}/{y}.png';
const DARK_TILE_ATTRIBUTION = '&copy; OpenStreetMap contributors &copy; CARTO';

export class HeatmapMap {
  constructor(containerEl, { labels = true } = {}) {
    this.map = window.L.map(containerEl, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 2,
    }).setView([20, 10], 2);

    this.tileLayer = window.L.tileLayer(labels ? DARK_TILE_URL_LABELS : DARK_TILE_URL_NO_LABELS, {
      attribution: DARK_TILE_ATTRIBUTION,
      maxZoom: 12,
      subdomains: 'abcd',
    }).addTo(this.map);

    this.layer = null;
    this.layerByCountryId = new Map();
  }

  /** Wechselt den Basemap-Layer nachtraeglich (falls die Einstellung sich
   * zwischen zwei Runden nicht aendern kann - hier nur fuer Robustheit, die
   * Lobby-Einstellung steht schon fest bevor die Karte erzeugt wird). */
  setLabels(labels) {
    this.map.removeLayer(this.tileLayer);
    this.tileLayer = window.L.tileLayer(labels ? DARK_TILE_URL_LABELS : DARK_TILE_URL_NO_LABELS, {
      attribution: DARK_TILE_ATTRIBUTION,
      maxZoom: 12,
      subdomains: 'abcd',
    }).addTo(this.map);
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
