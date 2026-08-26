const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

export class GuessMap {
  constructor(containerEl, onChange) {
    this.onChange = onChange;
    this.marker = null;
    this.map = window.L.map(containerEl, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
    }).setView([20, 0], 2);

    window.L.tileLayer(TILE_URL, { attribution: TILE_ATTRIBUTION, subdomains: 'abcd', maxZoom: 18 }).addTo(this.map);

    this.map.on('click', (e) => this.setGuess(e.latlng.lat, e.latlng.lng));
  }

  setGuess(lat, lng) {
    if (this.marker) {
      this.marker.setLatLng([lat, lng]);
    } else {
      const icon = window.L.divIcon({
        className: '',
        html: '<span class="map-pin map-pin--you"></span>',
        iconSize: [18, 18],
        iconAnchor: [9, 18],
      });
      this.marker = window.L.marker([lat, lng], { icon }).addTo(this.map);
    }
    this.onChange?.({ lat, lng });
  }

  clear() {
    if (this.marker) {
      this.map.removeLayer(this.marker);
      this.marker = null;
    }
  }

  reset() {
    this.clear();
    this.map.setView([20, 0], 2);
  }

  getGuess() {
    if (!this.marker) return null;
    const { lat, lng } = this.marker.getLatLng();
    return { lat, lng };
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
