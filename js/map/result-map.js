const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export class ResultMap {
  constructor(containerEl) {
    this.map = window.L.map(containerEl, { zoomControl: false, attributionControl: true }).setView([20, 0], 2);
    window.L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, subdomains: 'abcd', maxZoom: 18 }).addTo(this.map);
    this.layerGroup = window.L.layerGroup().addTo(this.map);
  }

  render(actual, results, players) {
    this.layerGroup.clearLayers();
    const bounds = [[actual.lat, actual.lng]];

    const targetIcon = window.L.divIcon({
      className: '',
      html: '<span class="map-pin map-pin--target"></span>',
      iconSize: [18, 18],
      iconAnchor: [9, 18],
    });
    window.L.marker([actual.lat, actual.lng], { icon: targetIcon }).addTo(this.layerGroup);

    for (const r of results) {
      if (r.lat == null || r.lng == null) continue;
      const player = players.get(r.playerId);
      const color = player?.color || '#8c99b8';
      const icon = window.L.divIcon({
        className: '',
        html: `<span class="map-pin" style="--pin-color:${color}"></span>`,
        iconSize: [18, 18],
        iconAnchor: [9, 18],
      });
      window.L.marker([r.lat, r.lng], { icon }).addTo(this.layerGroup);
      window.L.polyline(
        [
          [r.lat, r.lng],
          [actual.lat, actual.lng],
        ],
        { color: '#8c99b8', weight: 2, dashArray: '4 6', opacity: 0.8 }
      ).addTo(this.layerGroup);
      bounds.push([r.lat, r.lng]);
    }

    if (bounds.length > 1) {
      this.map.fitBounds(bounds, { padding: [36, 36] });
    } else {
      this.map.setView(bounds[0], 4);
    }
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
