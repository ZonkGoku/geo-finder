import { TILE_URL, TILE_OPTIONS } from './tile-config.js';

export class GuessMap {
  constructor(containerEl, onChange) {
    this.onChange = onChange;
    this.marker = null;
    this.map = window.L.map(containerEl, {
      zoomControl: false,
      attributionControl: true,
      worldCopyJump: true,
    }).setView([20, 0], 2);

    window.L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(this.map);

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

  /**
   * Nur den Tipp-Marker entfernen, die Kartenansicht (Pan/Zoom) bleibt
   * unveraendert. So "merkt" sich die Karte zwischen Runden, wohin der
   * letzte Spieler navigiert hat, statt bei jeder Runde auf die
   * Standard-Weltansicht zurueckzuspringen.
   */
  reset() {
    this.clear();
  }

  /**
   * Zoomt einmalig (mit Flug-Animation) auf die Ausdehnung eines
   * Kartenpakets - z. B. beim Start einer neuen Partie oder beim Wechsel
   * des Kartenpakets. Wird bewusst NICHT bei jeder Runde erneut
   * aufgerufen, damit die manuelle Zoomposition des Spielers innerhalb
   * einer Partie erhalten bleibt (siehe reset()).
   */
  focusOnLocations(points, { maxZoom = 13 } = {}) {
    const coords = (points || [])
      .filter((p) => p?.lat != null && p?.lng != null)
      .map((p) => [p.lat, p.lng]);
    if (coords.length === 0) return;

    if (coords.length === 1) {
      this.map.flyTo(coords[0], maxZoom, { duration: 1.1 });
      return;
    }

    const bounds = window.L.latLngBounds(coords);
    this.map.flyToBounds(bounds, { padding: [48, 48], maxZoom, duration: 1.1 });
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
