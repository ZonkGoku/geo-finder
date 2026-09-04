import { HEATMAP_COLORS } from '../core/heatmap-color.js';

// Fester dunkler Basemap-Kachel-Layer statt des ueblichen Satellit/Karte-
// Umschalters (attachTileLayer in tile-config.js) - Satellitenbilder wuerden
// optisch mit den eingefaerbten Laender-Polygonen konkurrieren, ein neutraler
// dunkler Hintergrund laesst die Distanz-Farben klar hervortreten.
// Urspruenglich CartoDB Dark Matter (schluessellos nutzbares Kachel-Paar MIT/
// OHNE Beschriftungen) - CartoDBs anonymer basemaps.cartocdn.com-Zugang zeigt
// inzwischen aber (wie schon einmal bei tile-config.js erlebt) ein "API KEY
// REQUIRED"-Wasserzeichen ueber der gesamten Karte. Stattdessen jetzt Esri's
// ebenfalls schluessellose "Canvas"-Dienste: World_Dark_Gray_Base (reiner
// Basemap ohne jede Beschriftung) plus World_Dark_Gray_Reference (nur die
// Beschriftungen, als transparenter Overlay-Layer) - zusammen ergeben sie
// dasselbe "mit/ohne Labels"-Paar, nur als zwei uebereinandergelegte Layer
// statt zwei alternativer Einzel-URLs.
const DARK_BASE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
const DARK_LABELS_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Reference/MapServer/tile/{z}/{y}/{x}';
const DARK_TILE_ATTRIBUTION = '&copy; Esri';
const DARK_MAX_ZOOM = 12;

export class HeatmapMap {
  constructor(containerEl, { labels = true } = {}) {
    this.map = window.L.map(containerEl, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
      minZoom: 2,
    }).setView([20, 10], 2);

    this.baseLayer = window.L.tileLayer(DARK_BASE_URL, {
      attribution: DARK_TILE_ATTRIBUTION,
      maxZoom: DARK_MAX_ZOOM,
    }).addTo(this.map);
    this.labelsLayer = null;
    if (labels) this._addLabelsLayer();

    this.layer = null;
    this.layerByCountryId = new Map();
  }

  _addLabelsLayer() {
    this.labelsLayer = window.L.tileLayer(DARK_LABELS_URL, { maxZoom: DARK_MAX_ZOOM }).addTo(this.map);
  }

  /** Wechselt den Beschriftungs-Overlay nachtraeglich (falls die Einstellung sich
   * zwischen zwei Runden nicht aendern kann - hier nur fuer Robustheit, die
   * Lobby-Einstellung steht schon fest bevor die Karte erzeugt wird). */
  setLabels(labels) {
    if (labels && !this.labelsLayer) {
      this._addLabelsLayer();
    } else if (!labels && this.labelsLayer) {
      this.map.removeLayer(this.labelsLayer);
      this.labelsLayer = null;
    }
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
