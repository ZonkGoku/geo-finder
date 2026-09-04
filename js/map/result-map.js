import { attachTileLayer } from './tile-config.js';

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

// isYou bekommt einen zusaetzlichen hellen Ring (.is-you, siehe styles.css) -
// bei mehreren Spielerfarben auf einer dichten Karte war sonst nicht auf
// einen Blick erkennbar, welcher Pin der eigene Tipp war (Nutzerfeedback:
// "alle Spieler sehen das Gleiche", man erkennt den eigenen Tipp nicht).
function buildGuessIcon(color, isYou, size) {
  return window.L.divIcon({
    className: '',
    html: `<span class="map-pin${isYou ? ' is-you' : ''}" style="--pin-color:${color}"></span>`,
    iconSize: [size, size],
    iconAnchor: [size / 2, size],
  });
}

export class ResultMap {
  constructor(containerEl) {
    this.map = window.L.map(containerEl, { zoomControl: false, attributionControl: true }).setView([20, 0], 2);
    this.tiles = attachTileLayer(this.map);
    this.layerGroup = window.L.layerGroup().addTo(this.map);
  }

  toggleTileStyle() {
    return this.tiles.toggle();
  }

  render(actual, results, players, selfId) {
    this.layerGroup.clearLayers();
    const bounds = [[actual.lat, actual.lng]];
    const lines = [];

    window.L.marker([actual.lat, actual.lng], { icon: buildTargetIcon() }).addTo(this.layerGroup);

    const ownGuess = results.find((r) => r.playerId === selfId && r.lat != null && r.lng != null);

    for (const r of results) {
      if (r.lat == null || r.lng == null) continue;
      const player = players.get(r.playerId);
      const color = player?.color || '#8c99b8';
      const isYou = r.playerId === selfId;
      const marker = window.L.marker([r.lat, r.lng], { icon: buildGuessIcon(color, isYou, 18) }).addTo(this.layerGroup);
      if (isYou) {
        marker.bindTooltip('Du', { permanent: true, direction: 'top', offset: [0, -16], className: 'map-round-label' });
      }
      const line = window.L.polyline(
        [
          [r.lat, r.lng],
          [actual.lat, actual.lng],
        ],
        { color, weight: isYou ? 3 : 2, dashArray: '4 6', opacity: isYou ? 1 : 0.7, className: isYou ? 'result-line result-line-you' : 'result-line' }
      ).addTo(this.layerGroup);
      lines.push(line);
      bounds.push([r.lat, r.lng]);
    }

    // Kamera-Kinetik: statt die Endansicht sofort statisch zu zeigen, startet
    // die Kamera (falls ein eigener Tipp existiert) hart auf dem eigenen Pin
    // eingezoomt und "fliegt" dann sichtbar zur Gesamtansicht mit dem echten
    // Ziel raus - macht die Enthuellung zu einem Moment statt einem Umschalten.
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const flyOptions = { padding: [36, 36], duration: 1.6, easeLinearity: 0.22 };

    if (reduceMotion) {
      if (bounds.length > 1) this.map.fitBounds(bounds, { padding: [36, 36] });
      else this.map.setView(bounds[0], 4);
      requestAnimationFrame(() => this._animateLines(lines));
      return;
    }

    if (ownGuess) {
      this.map.setView([ownGuess.lat, ownGuess.lng], 9, { animate: false });
      this.map.once('moveend', () => this._animateLines(lines));
      setTimeout(() => {
        if (bounds.length > 1) this.map.flyToBounds(bounds, flyOptions);
        else this.map.flyTo(bounds[0], 4, flyOptions);
      }, 550);
    } else {
      if (bounds.length > 1) this.map.flyToBounds(bounds, flyOptions);
      else this.map.flyTo(bounds[0], 4, flyOptions);
      this.map.once('moveend', () => this._animateLines(lines));
    }
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
  renderOverview(rounds, players, selfId) {
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
        const isYou = r.playerId === selfId;
        const marker = window.L.marker([r.lat, r.lng], { icon: buildGuessIcon(color, isYou, 16) }).addTo(this.layerGroup);
        if (isYou) {
          marker.bindTooltip('Du', { permanent: true, direction: 'bottom', offset: [0, 4], className: 'map-round-label' });
        }
        const line = window.L.polyline(
          [
            [r.lat, r.lng],
            [actual.lat, actual.lng],
          ],
          { color, weight: isYou ? 3 : 2, dashArray: '4 6', opacity: isYou ? 1 : 0.65 }
        ).addTo(this.layerGroup);
        lines.push(line);
        bounds.push([r.lat, r.lng]);
      }
    });

    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    if (reduceMotion) {
      if (bounds.length > 1) this.map.fitBounds(bounds, { padding: [30, 30] });
      else if (bounds.length === 1) this.map.setView(bounds[0], 4);
      requestAnimationFrame(() => this._animateLines(lines));
      return;
    }

    const flyOptions = { padding: [30, 30], duration: 1.6, easeLinearity: 0.22 };
    if (bounds.length > 1) {
      this.map.flyToBounds(bounds, flyOptions);
    } else if (bounds.length === 1) {
      this.map.flyTo(bounds[0], 4, flyOptions);
    }
    this.map.once('moveend', () => this._animateLines(lines));
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
      // Leuchtender Puls erst NACH dem Einzeichnen - siehe .result-line.drawn
      // in styles.css (animierter drop-shadow-Glow via CSS statt JS-Loop).
      // Leaflet setzt die Linienfarbe als SVG "stroke"-Praesentationsattribut,
      // NICHT als CSS "color" - drop-shadow(...currentColor) in CSS braucht
      // aber genau die CSS color-Eigenschaft, deshalb hier explizit spiegeln.
      const strokeColor = path.getAttribute('stroke');
      if (strokeColor) path.style.color = strokeColor;
      setTimeout(() => path.classList.add('drawn'), 900);
    }
  }

  invalidate() {
    this.map.invalidateSize();
  }
}
