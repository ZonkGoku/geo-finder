const DEFAULT_HFOV = 100;
const MIN_HFOV = 50;
const MAX_HFOV = 120;
const ZOOM_STEP = 10;
// Muss zur opacity-Transition von .pano-layer in styles.css passen - danach
// wird die alte Schicht abgeraeumt.
const CROSSFADE_MS = 260;

let layerSeq = 0;

/**
 * Panorama-Anzeige mit ZWEI Schichten statt einer.
 *
 * Vorher rief load() als Erstes destroy() und baute danach neu auf: das alte
 * Bild war waehrend des gesamten Ladevorgangs weg (der Container stand auf
 * Opazitaet 0 ueber dem Hintergrund, dazu ein Spinner). Bei 300-800 KB pro
 * equirektangularem Bild sind das auf Mobilfunk ein bis zwei Sekunden
 * Schwarzbild bei JEDEM Rundenwechsel - genau in dem Moment, in dem das Spiel
 * eigentlich weitergeht. Zusaetzlich wurde pro Runde ein kompletter
 * WebGL-Kontext abgerissen und neu erzeugt.
 *
 * Jetzt laedt die naechste Runde in die unsichtbare zweite Schicht; erst wenn
 * Pannellum 'load' meldet, wird ueberblendet und die alte Schicht zerstoert.
 * Das kostet fuer die Dauer der Ueberblendung zwei WebGL-Kontexte - deshalb
 * wird die alte Schicht konsequent im Anschluss abgeraeumt und nicht erst
 * beim naechsten Wechsel.
 *
 * Die Schichten sind Kinder des uebergebenen Containers. Der
 * Fog-of-War-Weichzeichner haengt weiterhin am Container selbst und wirkt
 * dadurch unveraendert auf beide Schichten.
 */
export class PanoViewer {
  constructor(containerId) {
    this.container = document.getElementById(containerId);
    this.active = null;
    this.pending = null;
    this.zoomLocked = false;
  }

  _createLayer() {
    const el = document.createElement('div');
    // Pannellum adressiert sein Ziel ueber die Element-ID, die Schichten
    // brauchen also je eine eigene.
    el.id = `pano-layer-${++layerSeq}`;
    el.className = 'pano-layer';
    this.container.appendChild(el);
    return { el, viewer: null };
  }

  _destroyLayer(layer) {
    if (!layer) return;
    try {
      layer.viewer?.destroy();
    } catch {
      // Pannellum wirft beim Abraeumen gelegentlich, wenn der WebGL-Kontext
      // schon verloren ist - das Element muss trotzdem aus dem DOM.
    }
    layer.el.remove();
  }

  _buildConfig(panoramaUrl, { vaov, modifier, mutators }) {
    this.zoomLocked = modifier === 'no-zoom';
    const noPan = Boolean(mutators?.noPan);
    // "Broken Compass": Mapillary-Panoramen haben ohnehin keine verlaessliche
    // Ausrichtung an echtem geografischem Norden - yaw:0 ist immer schon nur
    // eine im Bild selbst beliebige Referenzrichtung, kein "echter Norden".
    // Der Mutator macht diese Referenz zusaetzlich pro Runde zufaellig, statt
    // sie (wie sonst) konstant bei 0 zu belassen, damit sich Spieler nicht
    // auf "der Blick startet immer gleich" verlassen koennen.
    const brokenCompass = Boolean(mutators?.brokenCompass);
    const config = {
      type: 'equirectangular',
      panorama: panoramaUrl,
      autoLoad: true,
      showControls: false,
      compass: false,
      hfov: DEFAULT_HFOV,
      minHfov: this.zoomLocked ? DEFAULT_HFOV : MIN_HFOV,
      maxHfov: this.zoomLocked ? DEFAULT_HFOV : MAX_HFOV,
      yaw: brokenCompass ? Math.random() * 360 - 180 : 0,
      draggable: !noPan,
      disableKeyboardCtrl: noPan,
    };
    if (vaov) config.vaov = vaov;
    return config;
  }

  /** Aktuelle Blickrichtung/Zoom der sichtbaren Schicht - fuer
   * preserveView beim Nachschaerfen. null, wenn nichts laeuft. */
  _currentView() {
    const viewer = this.viewer;
    if (!viewer) return null;
    try {
      return { yaw: viewer.getYaw(), pitch: viewer.getPitch(), hfov: viewer.getHfov() };
    } catch {
      return null; // Viewer schon abgeraeumt - dann eben Startansicht
    }
  }

  /** preserveView: uebernimmt Blickrichtung und Zoom der laufenden Schicht.
   * Zwingend beim Nachschaerfen der Aufloesung (siehe transitionPanorama() in
   * app.js) - ohne das wuerde die Ansicht mitten in der Runde auf die
   * Startrichtung zurueckspringen, sobald das scharfe Bild eintrifft. Das
   * waere schlimmer als ein etwas weicheres Bild. */
  load(panoramaUrl, { vaov, modifier = 'free', mutators, onLoad, preserveView = false } = {}) {
    const carriedView = preserveView ? this._currentView() : null;
    // Einen noch laufenden Ladevorgang verwerfen statt abzuwarten: beim
    // schnellen Weiterlaufen (Walk-Modus) gaebe es sonst zwei konkurrierende
    // Einblendungen, von denen die zuletzt fertige gewinnt - und das kann die
    // aeltere Anfrage sein.
    this._destroyLayer(this.pending);
    this.pending = null;

    const incoming = this._createLayer();
    const outgoing = this.active;
    const config = this._buildConfig(panoramaUrl, { vaov, modifier, mutators });
    if (carriedView) Object.assign(config, carriedView);
    const viewer = window.pannellum.viewer(incoming.el.id, config);
    incoming.viewer = viewer;
    this.pending = incoming;

    viewer.on('load', () => {
      this.pending = null;
      this.active = incoming;
      // Reflow erzwingen, damit der Browser den Startzustand (Opazitaet 0)
      // wirklich rendert, bevor die Transition beginnt - ohne das springt die
      // Schicht ohne Ueberblendung auf sichtbar. Gleiches Muster wie bei
      // .pano-foggy in transitionPanorama().
      incoming.el.getBoundingClientRect();
      incoming.el.classList.add('visible');
      if (outgoing) {
        outgoing.el.classList.remove('visible');
        setTimeout(() => this._destroyLayer(outgoing), CROSSFADE_MS);
      }
      onLoad?.();
    });

    viewer.on('error', () => {
      // Alte Schicht stehen lassen: ein weiterhin sichtbares altes Panorama
      // ist ein besserer Fehlerzustand als ein schwarzes Loch. onLoad wird
      // bewusst nicht gerufen - der Rundenablauf haengt an eigenen Timeouts,
      // nicht an diesem Callback.
      this._destroyLayer(incoming);
      if (this.pending === incoming) this.pending = null;
    });
  }

  /** Der gerade SICHTBARE Viewer - waehrend eines Ladevorgangs bewusst noch
   * der alte, damit Zoom und Kompass auf das Bild wirken, das der Spieler
   * tatsaechlich vor sich hat. */
  get viewer() {
    return this.active?.viewer ?? null;
  }

  zoomIn() {
    const viewer = this.viewer;
    if (!viewer || this.zoomLocked) return;
    viewer.setHfov(Math.max(MIN_HFOV, viewer.getHfov() - ZOOM_STEP), true);
  }

  zoomOut() {
    const viewer = this.viewer;
    if (!viewer || this.zoomLocked) return;
    viewer.setHfov(Math.min(MAX_HFOV, viewer.getHfov() + ZOOM_STEP), true);
  }

  resetNorth() {
    const viewer = this.viewer;
    if (!viewer) return;
    viewer.setYaw(0, true);
    viewer.setPitch(0, true);
  }

  toggleFullscreen() {
    this.viewer?.toggleFullscreen();
  }

  destroy() {
    this._destroyLayer(this.pending);
    this._destroyLayer(this.active);
    this.pending = null;
    this.active = null;
  }
}
