// CARTO verlangt inzwischen einen API-Key für basemaps.cartocdn.com (zeigt
// sonst ein "API KEY REQUIRED"-Wasserzeichen statt echter Kacheln - live so
// aufgetreten). OpenStreetMaps eigener Tile-Server bleibt kostenlos und ohne
// Key, ist aber ein helles Farbschema; ein CSS-Filter (siehe styles.css,
// ".leaflet-host .leaflet-tile-pane") dreht das optisch auf dunkel, ohne auf
// einen Kachel-Anbieter mit Key umsteigen zu muessen.
export const TILE_URL = 'https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png';
export const TILE_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>-Mitwirkende';
export const TILE_OPTIONS = { attribution: TILE_ATTRIBUTION, subdomains: 'abc', maxZoom: 19 };
