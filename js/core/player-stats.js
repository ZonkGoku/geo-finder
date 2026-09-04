// Geraeteweite Lebenszeit-Statistik (localStorage) - kein Account/Backend,
// aber trotzdem ein Gefuehl von Fortschritt ueber eine einzelne Partie
// hinaus (siehe Game-Audit: fehlende Meta-Progression war eine der
// groessten Luecken gegenueber GeoGuessr/Geotastic). Ergaenzt
// high-scores.js (das nur den Bestwert PRO Kartenpaket+Modus kennt) um
// aggregierte Werte ueber ALLE Partien hinweg.
const STORAGE_KEY = 'geofinder-player-stats';

function defaults() {
  return { gamesPlayed: 0, roundsPlayed: 0, totalScore: 0, bestGameScore: 0 };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? { ...defaults(), ...parsed } : defaults();
  } catch {
    return defaults();
  }
}

export function getPlayerStats() {
  return load();
}

export function averageScore(stats = load()) {
  return stats.gamesPlayed > 0 ? Math.round(stats.totalScore / stats.gamesPlayed) : 0;
}

export function recordGamePlayed(finalScoreTotal, roundCount) {
  try {
    const stats = load();
    stats.gamesPlayed += 1;
    stats.roundsPlayed += roundCount || 0;
    stats.totalScore += finalScoreTotal || 0;
    stats.bestGameScore = Math.max(stats.bestGameScore, finalScoreTotal || 0);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(stats));
  } catch {
    // localStorage voll/Privatmodus - Statistik ist ein Bonus, kein Muss
  }
}
