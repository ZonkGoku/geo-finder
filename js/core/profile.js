// Gemeinsames, versioniertes lokales Profil-Schema (Audit-Fund 1.5, siehe
// AUDIT_ROADMAP.md Paket 5) - Fundament fuer ein spaeteres Achievement-/
// Rang-/Daily-Streak-System (Paket 6), das sonst quer ueber drei getrennte,
// unabhaengige localStorage-Stores (player-stats.js, heatmap-stats.js,
// high-scores.js) haette aufgebaut werden muessen.
//
// Bewusst "referenziert" statt "migriert" (die zweite, im Audit explizit
// genannte Option): die drei bestehenden Stores bleiben unveraendert die
// Quelle der Wahrheit fuer ihre jeweiligen Werte - hier kommt nur (a) das
// neue Fortschritts-Schema hinzu, das es vorher gar nicht gab
// (Achievement-IDs, Daily-Streak), und (b) eine gebuendelte Lese-Sicht
// darueber. Eine echte Daten-MIGRATION der drei alten Stores in ein
// gemeinsames Schema haette eigene Rueckwaertskompatibilitaets-/
// Verlust-Risiken fuer bestehende Spielstaende - hier nicht noetig, um den
// eigentlichen Zweck (eine gemeinsame Grundlage fuer Paket 6) zu erfuellen.
import { getPlayerStats, averageScore } from './player-stats.js';
import { getHeatmapStats, averageAttempts } from './heatmap-stats.js';

const STORAGE_KEY = 'geofinder-profile';
const SCHEMA_VERSION = 1;

function defaults() {
  return {
    version: SCHEMA_VERSION,
    // Paket 6 (noch nicht gebaut): IDs freigeschalteter Achievements. Nur
    // das Speicher-/Lese-Fundament steht schon - welche Achievements es
    // gibt und wann sie freigeschaltet werden, ist bewusst NICHT Teil
    // dieser Aenderung, das legt erst die eigentliche Achievement-Aufgabe fest.
    unlockedAchievementIds: [],
    dailyStreak: { current: 0, best: 0, lastPlayedDateKey: null },
  };
}

function load() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== 'object') return defaults();
    // Migrations-Ansatzpunkt fuer spaetere Schema-Aenderungen (aktuell nur
    // Version 1, hier ist noch nichts zu tun) - ein zukuenftiges Feld mit
    // geaenderter Bedeutung bekaeme hier einen expliziten
    // "if (parsed.version < N) { ... }"-Migrationsschritt statt die alten
    // Werte einfach unveraendert zu uebernehmen.
    return {
      ...defaults(),
      ...parsed,
      version: SCHEMA_VERSION,
      dailyStreak: { ...defaults().dailyStreak, ...parsed.dailyStreak },
      unlockedAchievementIds: Array.isArray(parsed.unlockedAchievementIds) ? parsed.unlockedAchievementIds : [],
    };
  } catch {
    return defaults();
  }
}

function save(profile) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(profile));
  } catch {
    // localStorage voll/Privatmodus - Profil-Fortschritt ist ein Bonus, kein Muss
  }
}

export function getProfile() {
  return load();
}

function dateKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Einmal pro abgeschlossener Partie aufrufen (jeder Modus) - zaehlt die
 * Tagessträhne hoch, wenn der letzte Tageswechsel genau gestern war, setzt
 * sie auf 1 zurueck bei einer Luecke, und tut nichts, wenn heute schon
 * gezaehlt wurde (verhindert, dass mehrere Partien am selben Tag die
 * Straehne mehrfach hochzaehlen). Lokale Kalendertage (kein UTC), damit die
 * Straehne sich nach der tatsaechlichen Tageszeit des Geraets richtet. */
export function recordDailyPlay(now = new Date()) {
  const profile = load();
  const today = dateKey(now);
  if (profile.dailyStreak.lastPlayedDateKey === today) return profile.dailyStreak;
  const yesterday = dateKey(new Date(now.getTime() - 24 * 60 * 60 * 1000));
  const isConsecutive = profile.dailyStreak.lastPlayedDateKey === yesterday;
  profile.dailyStreak.current = isConsecutive ? profile.dailyStreak.current + 1 : 1;
  profile.dailyStreak.best = Math.max(profile.dailyStreak.best, profile.dailyStreak.current);
  profile.dailyStreak.lastPlayedDateKey = today;
  save(profile);
  return profile.dailyStreak;
}

/** Liefert true, wenn das Achievement neu freigeschaltet wurde (false, wenn
 * es das schon war) - fuer ein spaeteres "Achievement freigeschaltet!"-Toast. */
export function unlockAchievement(id) {
  const profile = load();
  if (profile.unlockedAchievementIds.includes(id)) return false;
  profile.unlockedAchievementIds.push(id);
  save(profile);
  return true;
}

export function hasAchievement(id) {
  return load().unlockedAchievementIds.includes(id);
}

/** Gebuendelte Sicht ueber die drei bestehenden Stores + das neue Schema
 * hier - eine Stelle, die ein spaeteres Achievement-/Rang-System abfragen
 * kann (z.B. "10 Partien insgesamt gespielt", ueber alle Modi hinweg),
 * statt selbst drei verschiedene Module einzeln zu kennen. */
export function getAggregatedStats() {
  const classic = getPlayerStats();
  const heatmap = getHeatmapStats();
  return {
    totalGamesPlayed: classic.gamesPlayed + heatmap.gamesCompleted,
    totalRoundsPlayed: classic.roundsPlayed + heatmap.roundsSolved,
    classic: { ...classic, averageScore: averageScore(classic) },
    heatmap: { ...heatmap, averageAttempts: averageAttempts(heatmap) },
  };
}
