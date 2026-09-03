// Kartenbild fuer Minimap/Ergebnis-/Uebersichtskarte.
// Geschichte: CARTOs anonymer basemaps.cartocdn.com-Zugang zeigte irgendwann
// ein "API KEY REQUIRED"-Wasserzeichen (Nutzer-Screenshot 2026-09-03) -> auf
// Esri's schluessellosen "World_Dark_Gray_Base" umgestellt. Der ist aber ein
// bewusst minimalistischer Basemap OHNE Landnutzungs-Einfaerbung - Parks,
// Wald, etc. sind darin schlicht nicht als gruene Flaeche vorgesehen (kein
// Bug, sondern Design des Stils). Nutzerwunsch: Gruenflaechen/Gelaende
// muessen erkennbar sein. Eine dunkle UND detaillierte Kachel-Quelle gibt es
// ohne API-Key/Account praktisch nicht mehr (Stadia/CARTO/Mapbox verlangen
// inzwischen alle einen kostenlosen Key) - stattdessen auf Esris "World
// Imagery" (echte Satellitenkacheln) gewechselt: zeigt Gruenflaechen/Wasser/
// Gelaende naturgetreu, komplett schluessellos und seit Jahren stabil.
// Bewusste Design-Ausnahme vom dunklen Neon-Look - die Karte war ohnehin
// schon als funktionale Ausnahme vom App-Theme markiert (siehe styles.css).
// Achtung: ArcGIS-Kachelreihenfolge ist {z}/{y}/{x}, nicht {z}/{x}/{y}.
export const TILE_URL = 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}';
export const TILE_ATTRIBUTION = '&copy; Esri, Maxar, Earthstar Geographics, and the GIS User Community';
export const TILE_OPTIONS = { attribution: TILE_ATTRIBUTION, maxZoom: 18 };
