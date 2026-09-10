import { HEATMAP_COLORS } from '../core/heatmap-color.js';

// KEIN externer Kachel-Layer mehr als Hintergrund. Frueher Esri's Canvas-
// Basemap "World_Dark_Gray_Base" - trotz des Namens (und trotz Esris eigener
// Beschreibung als unbeschrifteter reiner Basemap) rendert dieser Layer bei
// mittleren Zoomstufen tatsaechlich Laendernamen direkt ins Kachel-Rasterbild
// (z.B. weit auseinandergezogenes "U N I T E D S T A T E S" quer ueber dem
// Land) - doppelt mit unseren eigenen permanenten Tooltips aus setCountries()
// (Nutzer-Report: Laendername erscheint zweimal). Da der Kachel-Layer hier
// ohnehin nur als neutraler dunkler Hintergrund hinter den eingefaerbten
// Laender-Polygonen dient (keine Strassen/Gelaende noetig), reicht dafuer ein
// simpler CSS-Hintergrund auf dem Map-Container voellig aus - und schliesst
// diese ganze Fehlerklasse (irgendein externer Layer bringt irgendwann doch
// wieder eigene Beschriftungen mit) dauerhaft aus, statt nur den naechsten
// vermeintlich "unbeschrifteten" Kachel-Dienst zu suchen.
// Laender-Umrisse waren bei weight:1/28% Deckkraft auf kleinen Bildschirmen
// kaum zu erkennen, und ungetippte Laender hatten wegen HEATMAP_COLORS.
// unguessed==='transparent' UEBERHAUPT keine Fuellung (0 Alpha bleibt 0
// Alpha, egal welche fillOpacity dabei stand) - die Weltkarte war praktisch
// nur eine fast unsichtbare Gitternetzlinie. Jetzt: deutlich kraeftigere
// Umrisslinie + eine dezente, aber klar sichtbare Grundfuellung fuer JEDES
// Land, damit die Landmassen-Formen sofort erkennbar sind, auch bevor
// ueberhaupt getippt wurde. Die "heisse" Einfaerbung nach einem Tipp bleibt
// bei GUESSED_FILL_OPACITY deutlich kraeftiger, damit sie klar heraussticht.
// Bewusst NICHT dieselbe Begruendung wie beim dunkel-fixierten .minimap-
// Leaflet-Host (der liegt ueber echten Fotos, siehe Kommentar dort) - die
// PulseMap-Weltkarte ist reine UI ohne Foto-Hintergrund und folgt darum dem
// Theme (.heatmap-map{ background: var(--surface-hi)/var(--surface) } in
// styles.css). BORDER_COLOR/unguessed-Fuellung standen hier trotzdem als
// fixe Hell-Werte (rgba(255,255,255,..)/'#ffffff'), auf Dunkelmodus
// zugeschnitten - im Hellmodus damit weiss auf weiss: die Weltkarte war
// praktisch unsichtbar (Live-Screenshot bestaetigt: nur noch eine
// schemenhafte, kaum erkennbare Kuestenlinie). isLightTheme() liest denselben
// data-theme-Attributwert wie initThemeToggle() in app.js.
function isLightTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light';
}
function getBorderColor() {
  return isLightTheme() ? 'rgba(20,24,31,0.55)' : 'rgba(255,255,255,0.6)';
}
function getUnguessedFillColor() {
  return isLightTheme() ? '#14181f' : HEATMAP_COLORS.unguessed;
}
const BORDER_WEIGHT = 1.4;
const UNGUESSED_FILL_OPACITY = 0.1;
const GUESSED_FILL_OPACITY = 0.82;

export class HeatmapMap {
  constructor(containerEl, { labels = true } = {}) {
    // Zoom 2 zeigt die GESAMTE Welt - auf einem schmalen Handy-Hochformat
    // (Breite < Hoehe) presst das jedes Land auf ein paar Pixel zusammen,
    // selbst mit staerkeren Umrissen/Fuellung von oben kaum noch lesbar.
    // Etwas naeher heranzoomen ist der groessere Hebel dagegen: Panning per
    // Wischgeste ist auf Touch-Geraeten ohnehin die natuerliche Erwartung.
    const isNarrowViewport = typeof window !== 'undefined' && window.innerWidth < 600;
    this.map = window.L.map(containerEl, {
      zoomControl: false,
      attributionControl: false,
      worldCopyJump: true,
      minZoom: 2,
      maxZoom: 12,
    }).setView([20, 10], isNarrowViewport ? 2.6 : 2);

    this._labelsEnabled = labels;

    this.layer = null;
    this.layerByCountryId = new Map();
  }

  /** Wechselt die Laendername-Beschriftung nachtraeglich (falls die
   * Einstellung sich zwischen zwei Runden nicht aendern kann - hier nur fuer
   * Robustheit, die Lobby-Einstellung steht schon fest bevor die Karte
   * erzeugt wird). Bindet/loest die Hover-Tooltips aus setCountries() auf
   * allen bereits vorhandenen Laender-Layern. */
  setLabels(labels) {
    this._labelsEnabled = labels;
    this.layerByCountryId.forEach((layer) => this._applyLabel(layer));
  }

  /** Labels sind bewusst NICHT permanent (frueher permanent:true) - bei 177
   * Laendern ueberlappten sich die staendig sichtbaren Texte in dicht
   * gepackten Regionen wie Europa oder der Karibik zu unlesbarem Gewusel
   * (Nutzer-Report: "Label Collision"). Stattdessen nur noch ein
   * Hover-Tooltip (sticky:true folgt dem Mauszeiger statt an einem festen
   * Punkt zu kleben) - zeigt immer genau EINEN Namen an, nie mehrere
   * uebereinander. labelsEnabled=false bindet gar keinen Tooltip (auch nicht
   * per Hover), damit die "Karten-Label = aus"-Einstellung wie vorgesehen
   * wirklich jeden Laendernamen unterdrueckt. */
  _applyLabel(layer) {
    const hasTooltip = typeof layer.getTooltip === 'function' && layer.getTooltip();
    if (this._labelsEnabled && !hasTooltip) {
      layer.bindTooltip(layer.feature.properties.displayName, {
        sticky: true,
        direction: 'top',
        offset: [0, -6],
        className: 'heatmap-country-label',
      });
    } else if (!this._labelsEnabled && hasTooltip) {
      layer.unbindTooltip();
    }
  }

  /** countries: [{ id, name, geometry, displayName }] - displayName kommt
   * bereits sprachaufgeloest vom Aufrufer (siehe countryDisplayName() in
   * core/i18n.js, aufgerufen in app.js ensureHeatmapWidgets()) - dieses
   * Modul bleibt bewusst i18n-unabhaengig, reines Kartenmodul. Einmal pro
   * Partie aufgerufen. */
  setCountries(countries) {
    if (this.layer) this.map.removeLayer(this.layer);
    this.layerByCountryId.clear();

    const features = countries.map((c) => ({
      type: 'Feature',
      id: c.id,
      properties: { name: c.name, displayName: c.displayName },
      geometry: c.geometry,
    }));

    this.layer = window.L.geoJSON(features, {
      style: () => ({
        color: getBorderColor(),
        weight: BORDER_WEIGHT,
        fillColor: getUnguessedFillColor(),
        fillOpacity: UNGUESSED_FILL_OPACITY,
      }),
    }).addTo(this.map);

    this.layer.eachLayer((layer) => {
      this.layerByCountryId.set(String(layer.feature.id), layer);
      this._applyLabel(layer);
    });
  }

  /**
   * proximity (optional): 'exact' | 'neighbor' | 'continent' | 'far' aus
   * core/heatmap-proximity.js - steuert nur den Gluehrand-Effekt (siehe
   * .leaflet-interactive.proximity-* in styles.css), NICHT die Fuellfarbe
   * selbst (die bleibt die Distanz-Farbskala aus heatmap-color.js). Das
   * eigentliche Fade-In beim Einfaerben ist eine reine CSS-Transition auf
   * .leaflet-interactive (fill/fill-opacity) - hier wird nur der Zielwert
   * gesetzt, nicht animiert.
   */
  colorCountry(countryId, color, proximity = null) {
    const layer = this.layerByCountryId.get(String(countryId));
    if (!layer) return;
    const isUnguessed = color === getUnguessedFillColor();
    layer.setStyle({ fillColor: color, fillOpacity: isUnguessed ? UNGUESSED_FILL_OPACITY : GUESSED_FILL_OPACITY });
    layer.bringToFront();

    const path = layer.getElement?.();
    if (path) {
      path.classList.remove('proximity-exact', 'proximity-neighbor');
      if (proximity === 'exact' || proximity === 'neighbor') {
        path.classList.add(`proximity-${proximity}`);
      }
      if (!isUnguessed) {
        // Kurzer Einschlag-Puls bei JEDEM neuen Tipp (auch 'far'/'continent'),
        // unabhaengig von der dauerhaften proximity-exact/-neighbor-Gluehkante
        // oben - sonst wirkte ein "kalter" Tipp nur wie ein lautloser
        // Farbwechsel statt eines spuerbaren Treffers. Farbe kommt per
        // CSS-Variable aus derselben Distanz-Farbskala wie die Fuellung
        // (heatmap-color.js), damit Puls und Einfaerbung als ein Effekt lesen.
        path.style.setProperty('--pulse-color', color);
        path.classList.remove('guess-pulse');
        void path.offsetWidth; // Reflow erzwingen: ein zweiter Tipp auf dasselbe Land (anderer
        // Spieler) soll die Animation erneut abspielen statt sie stumm zu ignorieren.
        path.classList.add('guess-pulse');
      }
    }
  }

  /** Fliegt die Karte zum getippten Land (Nutzer-Wunsch: nach jedem eigenen
   * Tipp soll die Karte automatisch dorthin schwenken statt stehen zu
   * bleiben, wo man vorher gerade hingezoomt/-gepannt hatte). Nutzt die
   * echte Polygon-Bounding-Box des Landes (layer.getBounds(), von Leaflets
   * GeoJSON-Layer eingebaut) statt nur des Centroid-Punkts - ein Punkt allein
   * wuerde bei laenglichen/grossen Laendern (z.B. Chile, Russland) keinen
   * sinnvollen Zoom-Level ergeben. maxZoom deckelt das Heranzoomen bei sehr
   * kleinen Laendern (Stadtstaaten/Inseln) - komplett auf das Land zu
   * zoomen wuerde dort den geografischen Kontext (Nachbarlaender/Kontinent)
   * verlieren, der fuer die naechste Runde noch hilfreich ist. Nur fuer den
   * EIGENEN Tipp aufgerufen (siehe handleHeatmapGuessPick() in app.js) -
   * bei jedem eingehenden Tipp eines Mitspielers mitzuschwenken waere
   * eine staendig wegruckende Kamera waehrend man selbst noch ueberlegt. */
  focusOnCountry(countryId) {
    const layer = this.layerByCountryId.get(String(countryId));
    if (!layer) return;
    this.map.flyToBounds(layer.getBounds(), { padding: [40, 40], maxZoom: 5, duration: 0.8 });
  }

  /** Container-relative Pixelposition eines Punkts - fuer an die Karte
   * angeheftete Effekte (Konfetti-/Radar-Ping-Ursprung, siehe app.js
   * renderHeatmapRoundResult()). */
  containerPointFor(lat, lng) {
    const p = this.map.latLngToContainerPoint([lat, lng]);
    const rect = this.map.getContainer().getBoundingClientRect();
    return { x: rect.left + p.x, y: rect.top + p.y };
  }

  /** Alle Faerbungen zuruecksetzen - vor jeder neuen Runde. */
  reset() {
    this.layerByCountryId.forEach((layer) => {
      layer.setStyle({ fillColor: getUnguessedFillColor(), fillOpacity: UNGUESSED_FILL_OPACITY });
      layer.getElement?.()?.classList.remove('proximity-exact', 'proximity-neighbor');
    });
  }

  invalidate() {
    this.map.invalidateSize();
  }

  /** Vollstaendiger Teardown - Leaflets eigenes map.remove() loest alle DOM-
   * Event-Listener und internen Layer-/Tile-Referenzen der Karteninstanz,
   * damit beim Zurueck-zum-Menue kein Leaflet-Kontext im Hintergrund
   * weiterlebt (siehe resetToMenu() in app.js, Audit-Fund zum heatmapMap-
   * Lifecycle). Nach destroy() ist diese Instanz nicht mehr nutzbar - die
   * naechste Partie erzeugt ueber ensureHeatmapWidgets() eine neue. */
  destroy() {
    this.map.remove();
    this.layerByCountryId.clear();
    this.layer = null;
  }
}
