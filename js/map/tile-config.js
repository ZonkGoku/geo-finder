// Dunkles Kartenbild fuer den Dark-Mode-Vibe der App (CARTO "Dark Matter").
// ACHTUNG: basemaps.cartocdn.com war in diesem Projekt bereits einmal live
// defekt - CARTO verlangte fuer die HELLEN Kacheln plötzlich einen API-Key
// und zeigte ein "API KEY REQUIRED"-Wasserzeichen statt echter Kacheln.
// Ob das nur den hellen Stil betraf oder generell alle anonymen CARTO-
// Anfragen (inkl. dark_all), laesst sich von hier aus nicht pruefen -
// unbedingt nach dem Deploy live gegenchecken. Falls auch dark_all das
// Wasserzeichen zeigt: auf die Esri-Alternative unten wechseln (echt
// kostenlos, kein Key, seit Jahren stabil).
export const TILE_URL = 'https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png';
export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende &copy; <a href="https://carto.com/attributions">CARTO</a>';
export const TILE_OPTIONS = { attribution: TILE_ATTRIBUTION, subdomains: 'abcd', maxZoom: 20 };

// Fallback, falls CARTO wieder "API KEY REQUIRED" zeigt - Esri's dunkler
// Grau-Basemap ist seit Jahren ohne Key oeffentlich nutzbar (Achtung:
// ArcGIS-Kachelreihenfolge ist {z}/{y}/{x}, nicht {z}/{x}/{y}):
// export const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
// export const TILE_ATTRIBUTION = '&copy; Esri, HERE, Garmin, OpenStreetMap-Mitwirkende';
// export const TILE_OPTIONS = { attribution: TILE_ATTRIBUTION, maxZoom: 16 };
