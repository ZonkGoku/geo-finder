// Distanz -> Farbe fuer den Heatmap-Modus (Globle-inspiriert): je naeher das
// getippte Land am geheimen Zielland liegt, desto waermer die Farbe. Reine
// Funktion (Zahl -> Farbwert), unabhaengig von Leaflet/DOM testbar.
//
// "exact" wird bewusst als eigener Parameter uebergeben statt aus km<=X
// erraten: ob ein Treffer exakt ist, entscheidet der Vergleich der
// Länder-IDs (siehe net/host.js), nicht ein kleiner Distanzwert - zwei
// verschiedene, sehr kleine Nachbarlaender koennten sonst faelschlich als
// "exakt" durchgehen.
const NEAR_KM = 500;
const MID_KM = 2000;
const FAR_KM = 5000;

export const HEATMAP_COLORS = {
  exact: '#39ff8f',
  near: '#ff3b3b',
  mid: '#ff8a3d',
  far: '#ffd166',
  // War '#e8ecf5' - ein fast weisser Farbton, kaum von der (ebenfalls
  // weissen) unguessed-Fuellung zu unterscheiden. Ein "sehr weit weg"-Tipp
  // wirkte dadurch optisch fast wie gar kein Tipp. Jetzt ein klar
  // erkennbares kuehles Blau statt eines Beinahe-Weiss.
  cold: '#6fa8dc',
  // War 'transparent' - eine "transparente Fuellung" bleibt bei JEDER
  // fillOpacity unsichtbar (0 Alpha ist 0 Alpha), Laender ohne Tipp waren
  // dadurch nur an ihrer 1px-Umrisslinie erkennbar. Live gemeldet als "man
  // kann auf Mobile kaum was erkennen" - auf einem kleinen Bildschirm ist
  // eine fast unsichtbare Weltkarte praktisch unbedienbar. Jetzt ein echter
  // Farbwert, den heatmap-map.js bei niedriger Deckkraft als dezente
  // Landmassen-Einfaerbung nutzt (siehe UNGUESSED_FILL_OPACITY dort).
  unguessed: '#ffffff',
};

export function getColorForDistance(km, exact = false) {
  if (exact) return HEATMAP_COLORS.exact;
  if (km == null) return HEATMAP_COLORS.cold;
  if (km < NEAR_KM) return HEATMAP_COLORS.near;
  if (km < MID_KM) return HEATMAP_COLORS.mid;
  if (km < FAR_KM) return HEATMAP_COLORS.far;
  return HEATMAP_COLORS.cold;
}
