import { TILE_URL, TILE_OPTIONS } from './tile-config.js';

// Geteilt zwischen der Einzelrunden-Ergebniskarte und der Runden-Uebersicht
// auf dem Endstand - eine Flagge statt eines weiteren Tropfen-Pins, damit
// "das war das Ziel" unabhaengig von der Farbe sofort erkennbar ist.
function buildTargetIcon() {
  return window.L.divIcon({
    className: '',
    html: `<svg class="map-pin-target" viewBox="0 0 24 24" width="22" height="22">
      <line class="pole" x1="6" y1="21" x2="6" y2="4"/>
      <path class="flag" d="M6 4 L19 8 L6 12 Z"/>
      <circle class="base" cx="6" cy="21" r="2"/>
    </svg>`,
    iconSize: [22, 22],
    iconAnchor: [6, 21],
  });
}

export class ResultMap {
  constructor(containerEl) {
    this.map = window.L.map(containerEl, { zoomControl: false, attributionControl: true }).setView([20, 0], 2);
    window.L.tileLayer(TILE_URL, TILE_OPTIONS).addTo(this.map);
    this.layerGroup = window.L.layerGroup().addTo(this.map);
  }

  render(actual, results, players) {
    this.layerGroup.clearLayers();
    const bounds = [[actual.lat, actual.lng]];
    const lines = [];

    window.L.marker([actual.lat, actual.lng], { icon: buildTargetIcon() }).addTo(this.layerGroup);

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
      const line = window.L.polyline(
        [
          [r.lat, r.lng],
          [actual.lat, actual.lng],
        ],
        { color, weight: 2, dashArray: '4 6', opacity: 0.85 }
      ).addTo(this.layerGroup);
      lines.push(line);
      bounds.push([r.lat, r.lng]);
    }

    if (bounds.length > 1) {
      this.map.fitBounds(bounds, { padding: [36, 36] });
    } else {
      this.map.setView(bounds[0], 4);
    }

    // Linien "einzeichnen": erst unsichtbar (Laenge = 0), dann per
    // stroke-dashoffset-Transition auf die volle Laenge animieren. Muss nach
    // fitBounds passieren, weil sich die Pfadlaenge sonst noch aendert.
    requestAnimationFrame(() => this._animateLines(lines));
  }

  /**
   * Endstand-Uebersichtskarte: alle Runden auf einmal. Ersetzt den frueheren
   * Ansatz in app.js, der render() (fuer GENAU eine Runde gebaut) mit den
   * kombinierten Ergebnissen ALLER Runden aufrief - jede Tipp-Linie zeigte
   * dadurch faelschlich auf das Ziel der LETZTEN Runde statt auf das Ziel
   * der eigenen Runde (sichtbar als mehrere Tipp-Pins, deren Linien sich
   * alle an einem einzigen Punkt trafen). Jede Runde bekommt hier ihr
   * eigenes Ziel (mit Rundenzahl-Label) und ihre eigenen, korrekt
   * verbundenen Tipp-Pins.
   */
  renderOverview(rounds, players) {
    this.layerGroup.clearLayers();
    const bounds = [];
    const lines = [];

    rounds.forEach((round, index) => {
      const actual = round?.actual;
      if (!actual) return;
      bounds.push([actual.lat, actual.lng]);

      const targetMarker = window.L.marker([actual.lat, actual.lng], { icon: buildTargetIcon() }).addTo(this.layerGroup);
      targetMarker.bindTooltip(`Ziel R${index + 1}`, {
        permanent: true,
        direction: 'top',
        offset: [0, -18],
        className: 'map-round-label',
      });

      for (const r of round.results || []) {
        if (r.lat == null || r.lng == null) continue;
        const player = players.get(r.playerId);
        const color = player?.color || '#8c99b8';
        const icon = window.L.divIcon({
          className: '',
          html: `<span class="map-pin" style="--pin-color:${color}"></span>`,
          iconSize: [16, 16],
          iconAnchor: [8, 16],
        });
        window.L.marker([r.lat, r.lng], { icon }).addTo(this.layerGroup);
        const line = window.L.polyline(
          [
            [r.lat, r.lng],
            [actual.lat, actual.lng],
          ],
          { color, weight: 2, dashArray: '4 6', opacity: 0.85 }
        ).addTo(this.layerGroup);
        lines.push(line);
        bounds.push([r.lat, r.lng]);
      }
    });

    if (bounds.length > 1) {
      this.map.fitBounds(bounds, { padding: [30, 30] });
    } else if (bounds.length === 1) {
      this.map.setView(bounds[0], 4);
    }

    requestAnimationFrame(() => this._animateLines(lines));
  }

  _animateLines(lines) {
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    for (const line of lines) {
      const path = line._path;
      if (!path) continue;
      const length = path.getTotalLength ? path.getTotalLength() : 300;
      if (reduceMotion) continue;
      path.style.transition = 'none';
      path.style.strokeDasharray = `${length}`;
      path.style.strokeDashoffset = `${length}`;
      // Reflow erzwingen, damit der Browser den Startzustand tatsaechlich rendert
      // bevor die Transition zum Endzustand beginnt.
      path.getBoundingClientRect();
      path.style.transition = 'stroke-dashoffset 900ms ease-out';
      path.style.strokeDashoffset = '0';
    }
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
