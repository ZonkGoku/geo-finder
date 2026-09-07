// Nachbarland-/Kontinent-Einstufung fuer den Heatmap-Modus: reine Funktion
// (Land-Objekte + Distanz -> Einstufung), unabhaengig von Host/Client-Rolle
// testbar - genau wie core/heatmap-color.js (Distanz -> Farbe) nebenan.
//
// Wird NUR auf dem Host aufgerufen (net/host.js _handleHeatmapGuess()): er
// kennt als einziger sowohl das getippte als auch das Zielland und bleibt
// so alleinige Autoritaet, exakt wie schon Distanz/Treffer-Pruefung dort.
// Der zurueckgegebene level-String (keine Laender-IDs) wird an Ratende und
// bei heatmapOpponentInfo==='all' auch an Mitspieler verschickt - verraet
// fuer sich genommen nicht, welches Land getippt wurde.
//
// Reihenfolge ist wichtig: ein exakter Treffer ist immer 'exact', auch wenn
// (trivial) targetId in seinen eigenen neighbors nicht vorkommt. 'neighbor'
// hat Vorrang vor 'continent', weil eine geteilte Landgrenze eine deutlich
// staerkere Naeherungsaussage ist als "irgendwo auf demselben Kontinent".
export function getProximityLevel(guessed, target) {
  if (guessed.id === target.id) return 'exact';
  if (target.neighbors?.includes(guessed.id)) return 'neighbor';
  if (guessed.continent != null && guessed.continent === target.continent) return 'continent';
  return 'far';
}

const PROXIMITY_LABELS = {
  exact: 'Exakter Treffer!',
  neighbor: 'Knapp daneben! Es ist ein Nachbarland.',
  continent: 'Richtiger Kontinent',
  far: null,
};

/** UI-Text fuer einen level-Wert, oder null wenn kein besonderer Hinweis noetig ist (nur die km-Zahl zaehlt). */
export function proximityLabel(level) {
  return PROXIMITY_LABELS[level] ?? null;
}
