// Zeitmessung fuer die Ladekette einer Runde.
//
// Einschalten ohne jede technische Vorkenntnis: einfach "?debug=1" an die URL
// haengen, z. B.
//
//   https://<user>.github.io/geo-finder/?debug=1
//
// Dann erscheint unten links ein kleines Messfeld, das die Zeiten direkt im
// Bild anzeigt - keine Entwicklerwerkzeuge, kein Konsolenbefehl noetig, und
// ein Screenshot davon reicht zur Diagnose. Alternativ dauerhaft ueber
// localStorage.setItem('geofinder.debug','1'). Ohne beides ist alles hier ein
// No-Op und kostet nichts.
//
// Hintergrund: "Bilder laden ewig" kann an drei ganz verschiedenen Stellen
// liegen - der Mapillary-Suche (Listen-/Detailabfragen VOR Rundenbeginn), dem
// Cloudflare-Proxy (nur im Mehrspielerbetrieb) oder dem Bild-Download selbst.
// Ohne Messung ist jede Optimierung geraten; diese Zahlen trennen die Faelle
// sauber voneinander.
const ENABLED = (() => {
  try {
    if (new URLSearchParams(location.search).get('debug') === '1') return true;
  } catch {
    // location/URLSearchParams nicht verfuegbar (z. B. im Node-Test) - egal
  }
  try {
    return localStorage.getItem('geofinder.debug') === '1';
  } catch {
    return false; // Privatmodus o.ae. - dann eben keine Messung
  }
})();

export function isTimingEnabled() {
  return ENABLED;
}

// ---------------------------------------------------------------- Anzeige
// Bewusst ein eigenes, minimal gestyltes Element statt einer Klasse in
// styles.css: das hier ist ein Diagnosewerkzeug, kein Teil der Oberflaeche,
// und soll das Stylesheet nicht belasten.
const MAX_LINES = 40;
let panel = null;
let listEl = null;
const counters = new Map();

function ensurePanel() {
  if (panel || !ENABLED || typeof document === 'undefined') return panel;
  panel = document.createElement('div');
  panel.id = 'debug-timing-panel';
  panel.style.cssText = [
    'position:fixed', 'left:8px', 'bottom:8px', 'z-index:99999',
    'max-width:min(420px, calc(100vw - 16px))', 'max-height:44vh', 'overflow:auto',
    'background:rgba(8,12,20,0.92)', 'color:#dfe7f2', 'border:1px solid #2b3a52',
    'border-radius:8px', 'padding:8px 10px',
    'font:11px/1.45 ui-monospace,Menlo,Consolas,monospace',
    'white-space:pre-wrap',
  ].join(';');

  const head = document.createElement('div');
  head.style.cssText = 'display:flex;justify-content:space-between;gap:10px;margin-bottom:6px;color:#7fc7e8';
  head.innerHTML = '<b>Messung</b>';
  const close = document.createElement('button');
  close.textContent = '×';
  close.setAttribute('aria-label', 'Messfeld schliessen');
  close.style.cssText = 'background:none;border:none;color:#7fc7e8;font-size:15px;line-height:1;cursor:pointer;padding:0 2px';
  close.addEventListener('click', () => panel.remove());
  head.appendChild(close);

  listEl = document.createElement('div');
  panel.append(head, listEl);
  document.body.appendChild(panel);
  return panel;
}

function addLine(text) {
  if (!ENABLED) return;
  console.info(`[timing] ${text}`);
  if (typeof document === 'undefined') return;
  // Erst anhaengen, wenn es einen body gibt - Module laufen ggf. vor dem
  // ersten Rendern.
  if (!document.body) {
    document.addEventListener('DOMContentLoaded', () => addLine(text), { once: true });
    return;
  }
  if (!ensurePanel()) return;
  const line = document.createElement('div');
  line.textContent = text;
  listEl.appendChild(line);
  while (listEl.children.length > MAX_LINES) listEl.firstChild.remove();
  listEl.lastChild.scrollIntoView({ block: 'nearest' });
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
    logTiming(label, performance.now() - started);
    return result;
  } catch (err) {
    logTiming(label, performance.now() - started, `(FEHLER: ${err.message})`);
    throw err;
  }
}

export function logTiming(label, ms, extra = '') {
  if (!ENABLED) return;
  // Zusaetzlich zaehlen und aufsummieren: bei den Mapillary-Anfragen ist die
  // GESAMTZAHL pro Partie die eigentlich interessante Zahl, nicht die
  // Einzeldauer.
  const stat = counters.get(label) || { n: 0, total: 0 };
  stat.n += 1;
  stat.total += ms;
  counters.set(label, stat);
  addLine(`${label}: ${Math.round(ms)}ms${extra ? ` ${extra}` : ''}  [${stat.n}x, ges. ${Math.round(stat.total)}ms]`);
}

export function logInfo(label, value) {
  if (!ENABLED) return;
  addLine(`${label}: ${value}`);
}

/** Zwischenstand als Text - fuer "kopier mir die Zahlen"-Faelle. */
export function timingSummary() {
  return [...counters.entries()]
    .map(([label, s]) => `${label}: ${s.n}x, ges. ${Math.round(s.total)}ms, Schnitt ${Math.round(s.total / s.n)}ms`)
    .join('\n');
}
