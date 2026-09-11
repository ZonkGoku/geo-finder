// Zeitmessung fuer die Ladekette einer Runde. Standardmaessig AUS - sonst
// waere die Konsole im Normalbetrieb voll. Einschalten in der Browser-Konsole:
//
//   localStorage.setItem('geofinder.debug', '1'); location.reload();
//
// und wieder aus mit localStorage.removeItem('geofinder.debug').
//
// Hintergrund: "Bilder laden ewig" kann an drei ganz verschiedenen Stellen
// liegen - der Mapillary-Suche (Listen-/Detailabfragen vor Rundenbeginn), dem
// Cloudflare-Proxy (nur im Mehrspielerbetrieb) oder dem Bild-Download selbst.
// Ohne Messung ist jede Optimierung geraten; diese drei Zahlen trennen die
// Faelle sauber voneinander.
const ENABLED = (() => {
  try {
    return localStorage.getItem('geofinder.debug') === '1';
  } catch {
    return false; // Privatmodus o.ae. - dann eben keine Messung
  }
})();

export function isTimingEnabled() {
  return ENABLED;
}

/** Misst eine asynchrone Operation und loggt ihre Dauer. Gibt das Ergebnis
 * unveraendert weiter, damit sich Aufrufstellen einfach umschliessen lassen,
 * ohne ihren Kontrollfluss zu aendern - auch im Fehlerfall (dann wird die
 * Dauer bis zum Fehler geloggt und der Fehler normal weitergeworfen). */
export async function timed(label, fn) {
  if (!ENABLED) return fn();
  const started = performance.now();
  try {
    const result = await fn();
    console.info(`[timing] ${label}: ${Math.round(performance.now() - started)}ms`);
    return result;
  } catch (err) {
    console.info(`[timing] ${label}: ${Math.round(performance.now() - started)}ms (FEHLER: ${err.message})`);
    throw err;
  }
}

export function logTiming(label, ms, extra = '') {
  if (!ENABLED) return;
  console.info(`[timing] ${label}: ${Math.round(ms)}ms${extra ? ` ${extra}` : ''}`);
}

export function logInfo(label, value) {
  if (!ENABLED) return;
  console.info(`[timing] ${label}: ${value}`);
}
