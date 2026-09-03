// Dunkles Kartenbild fuer den Dark-Mode-Vibe der App.
// CARTOs anonymer basemaps.cartocdn.com-Zugang (frueher hier verwendet) zeigt
// inzwischen live ein "API KEY REQUIRED"-Wasserzeichen statt echter Kacheln -
// per Nutzer-Screenshot am 2026-09-03 bestaetigt, betrifft also nicht nur den
// hellen Stil, sondern auch dark_all. Umgestellt auf Esri's dunklen
// Grau-Basemap, der seit Jahren ohne Key oeffentlich nutzbar ist (Achtung:
// ArcGIS-Kachelreihenfolge ist {z}/{y}/{x}, nicht {z}/{x}/{y}).
export const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}';
export const TILE_ATTRIBUTION = '&copy; Esri, HERE, Garmin, OpenStreetMap-Mitwirkende';
export const TILE_OPTIONS = { attribution: TILE_ATTRIBUTION, maxZoom: 16 };
