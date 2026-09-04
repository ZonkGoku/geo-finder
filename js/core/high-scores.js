// Geraeteweite persoenliche Bestleistungen (localStorage) pro Kartenpaket +
// Modus-Kombination - kein Account/Backend noetig, passt zur "keine
// Accounts"-Philosophie der App, gibt aber trotzdem ein Stueck echte
// Meta-Progression (siehe Game-Audit: fehlende Fortschritts-Elemente waren
// eine der groessten Luecken gegenueber GeoGuessr/Geotastic).
const STORAGE_KEY = 'geofinder-highscores';

function loadAll() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : {};
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function key(mapSetId, mode) {
  return `${mapSetId}::${mode}`;
}

export function getHighScore(mapSetId, mode) {
  const all = loadAll();
  return all[key(mapSetId, mode)] ?? null;
}

/** Schreibt den neuen Bestwert nur, wenn er den bisherigen uebertrifft. Liefert true, wenn es ein neuer Rekord war. */
export function recordScoreIfBest(mapSetId, mode, score) {
  if (mapSetId == null || score == null) return false;
  try {
    const all = loadAll();
    const k = key(mapSetId, mode);
    const previous = all[k];
    if (previous != null && previous >= score) return false;
    all[k] = score;
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all));
    return true;
  } catch {
    return false; // voll/Privatmodus - Highscore ist ein Bonus, kein Muss
  }
}
