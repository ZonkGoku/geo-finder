// Geraeteweite PulseMap-Statistik (localStorage) - rein lokal, keine
// Cross-Device-/Cross-Player-Aggregation (siehe AAA-Audit, Abschnitt "Soft
// Launch & Analytics": ein echtes populationsweites Mass ("ist Blind Heat
// zu schwer?") braucht einen Server, den es hier bewusst nicht gibt - das
// hier ist eine persoenliche Fortschrittsanzeige, kein Analytics-System).
// Ergaenzt player-stats.js (score-basiert, fuer die klassischen Modi) um
// PulseMap-eigene Begriffe: Tipps-bis-zum-Treffer statt Punktzahl,
// Abbruch-Runde statt Endstand.
const STORAGE_KEY = 'geofinder-heatmap-stats';

function defaults() {
  return {
    roundsSolved: 0, // Runden, in denen DIESES Geraet das Zielland selbst gefunden hat
    totalAttempts: 0, // Summe der Tipps bis zum Treffer ueber alle geloesten Runden (fuer den Schnitt)
    bestAttempts: null, // wenigste Tipps, die je fuer einen Treffer noetig waren
    gamesStarted: 0,
    gamesCompleted: 0, // Partie bis zur letzten Runde durchgespielt
    // roundIndex (0-basiert) -> wie oft eine Partie GENAU in dieser Runde
    // abgebrochen wurde (Bildschirm verlassen, waehrend diese Runde noch
    // aktiv war) - zeigt, wo Spieler typischerweise aussteigen.
    dropOffByRound: {},
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? { ...defaults(), ...parsed, dropOffByRound: { ...parsed.dropOffByRound } } : defaults();
  } catch {
    return defaults();
  }
}

function save(stats) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // localStorage voll/Privatmodus - Statistik ist ein Bonus, kein Muss
  }
}

export function getHeatmapStats() {
  return load();
}

export function averageAttempts(stats = load()) {
  return stats.roundsSolved > 0 ? Math.round((stats.totalAttempts / stats.roundsSolved) * 10) / 10 : null;
}

/** Haeufigste Abbruch-Runde (1-basiert fuer die Anzeige) + deren Anteil an
 * allen erfassten Abbruechen - "die meisten Spieler steigen in Runde X aus". */
export function topDropOffRound(stats = load()) {
  const entries = Object.entries(stats.dropOffByRound);
  if (entries.length === 0) return null;
  const totalDropOffs = entries.reduce((sum, [, count]) => sum + count, 0);
  const [roundIndexStr, count] = entries.sort((a, b) => b[1] - a[1])[0];
  return { roundNumber: Number(roundIndexStr) + 1, count, share: count / totalDropOffs };
}

export function recordHeatmapGameStarted() {
  const stats = load();
  stats.gamesStarted += 1;
  save(stats);
}

export function recordHeatmapSolve(attempts) {
  if (!Number.isFinite(attempts) || attempts <= 0) return;
  const stats = load();
  stats.roundsSolved += 1;
  stats.totalAttempts += attempts;
  stats.bestAttempts = stats.bestAttempts == null ? attempts : Math.min(stats.bestAttempts, attempts);
  save(stats);
}

export function recordHeatmapGameCompleted() {
  const stats = load();
  stats.gamesCompleted += 1;
  save(stats);
}

export function recordHeatmapDropOff(roundIndex) {
  if (!Number.isFinite(roundIndex) || roundIndex < 0) return;
  const stats = load();
  stats.dropOffByRound[roundIndex] = (stats.dropOffByRound[roundIndex] || 0) + 1;
  save(stats);
}
