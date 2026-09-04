// Kartenbild fuer Minimap/Ergebnis-/Uebersichtskarte.
// Geschichte: CARTOs anonymer basemaps.cartocdn.com-Zugang zeigte irgendwann
// ein "API KEY REQUIRED"-Wasserzeichen -> auf Esri's schluessellosen
// "World_Dark_Gray_Base" umgestellt. Der ist aber ein bewusst minimalistischer
// Basemap OHNE Landnutzungs-Einfaerbung - Parks/Wald etc. nicht erkennbar.
// Als naechstes auf "World Imagery" (Satellit) gewechselt, aber Nutzer wollte
// auch eine normale Kartenansicht zurueck (Satellit allein "ist nicht gut").
// Beides bleibt also verfuegbar, per Umschalter (siehe attachTileLayer unten)
// - beide sind schluessellos nutzbare Esri-REST-Kacheldienste, gleiche
// Reihenfolge-Eigenheit ({z}/{y}/{x}, nicht {z}/{x}/{y}).
export const TILE_SETS = {
  satellite: {
    label: 'Satellit',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community',
    maxZoom: 18,
  },
  street: {
    label: 'Karte',
    url: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}',
    attribution: '&copy; Esri, HERE, Garmin, FAO, NOAA, USGS, OpenStreetMap-Mitwirkende',
    maxZoom: 19,
  },
};
const DEFAULT_STYLE = 'satellite';
const STYLE_STORAGE_KEY = 'geofinder-map-style';

function loadStoredStyle() {
  try {
    const stored = localStorage.getItem(STYLE_STORAGE_KEY);
    if (stored && TILE_SETS[stored]) return stored;
  } catch {
    /* localStorage kann in manchen Kontexten (z.B. Privatmodus) werfen */
  }
  return DEFAULT_STYLE;
}

function saveStoredStyle(style) {
  try {
    localStorage.setItem(STYLE_STORAGE_KEY, style);
  } catch {
    /* siehe oben */
  }
}

/**
 * Haengt einen umschaltbaren Tile-Layer an eine Leaflet-Karte. Der zuletzt
 * gewaehlte Stil wird geraeteweit gemerkt (localStorage), damit er nicht bei
 * jeder neuen Karteninstanz (Minimap/Ergebnis/Uebersicht) auf Satellit
 * zurueckspringt.
 */
// Beide Kachel-Sets sind unabhaengige Esri-REST-Endpunkte - ein Ausfall/
// Rate-Limit betrifft praktisch nie beide gleichzeitig. Bekommt eine frisch
// angehaengte Karte innerhalb dieser Zeit KEIN einziges Kachelbild (siehe
// TILE_FALLBACK_MS unten), wechselt attachTileLayer() automatisch einmalig
// auf den jeweils anderen Dienst, statt dauerhaft leer zu bleiben (live
// gemeldet: Minimap zeigte nur den Pin, keine Kacheln).
const TILE_FALLBACK_MS = 4000;

export function attachTileLayer(map) {
  let style = loadStoredStyle();
  let loadedAnyTile = false;
  let fallbackTried = false;

  function buildLayer(key) {
    const cfg = TILE_SETS[key] || TILE_SETS[DEFAULT_STYLE];
    const tileLayer = window.L.tileLayer(cfg.url, { attribution: cfg.attribution, maxZoom: cfg.maxZoom });
    tileLayer.on('tileload', () => {
      loadedAnyTile = true;
    });
    return tileLayer;
  }

  let layer = buildLayer(style).addTo(map);

  setTimeout(() => {
    if (loadedAnyTile || fallbackTried) return;
    fallbackTried = true;
    const next = style === 'satellite' ? 'street' : 'satellite';
    console.warn(`[GeoFinder] Keine Kacheln von "${style}" erhalten, wechsle automatisch auf "${next}".`);
    map.removeLayer(layer);
    style = next;
    layer = buildLayer(style).addTo(map);
  }, TILE_FALLBACK_MS);

  return {
    get style() {
      return style;
    },
    toggle() {
      const next = style === 'satellite' ? 'street' : 'satellite';
      map.removeLayer(layer);
      layer = buildLayer(next).addTo(map);
      style = next;
      saveStoredStyle(style);
      return style;
    },
  };
}
