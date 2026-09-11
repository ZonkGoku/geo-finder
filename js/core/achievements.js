// Achievements/Badges-Datenmodell (Phase 3 aus AUDIT_ROADMAP.md Abschnitt 5).
// Baut auf dem in profile.js bereits angelegten Speicher-Fundament
// (unlockedAchievementIds/unlockAchievement/hasAchievement) auf, das dort
// bewusst ohne die eigentliche Achievement-Liste eingefuehrt wurde ("Paket 6
// noch nicht gebaut") - dieses Modul liefert genau das: welche Achievements
// es gibt und wann sie freigeschaltet werden.
//
// Jede Bedingung liest ausschliesslich bereits vorhandene, geraeteweite
// Statistik (player-stats.js/heatmap-stats.js/profile.js ueber
// getAggregatedStats()) - keine neue Tracking-Infrastruktur noetig. Bewusst
// KEIN Achievement fuer "perfekte Punktzahl in einer Partie": player-stats.js
// speichert nur die GAME-Gesamtpunktzahl (Summe aller Runden), nicht den
// Pro-Runde-Score, und mischt ausserdem die score-fremden Skalen von
// HP-Duell (verbleibende HP) und Country-Streak (Trefferzahl) in dasselbe
// Feld (siehe rank-tier.js-Kommentar) - ein Schwellenwert darauf waere
// irrefuehrend genau.
import { getAggregatedStats, getProfile, unlockAchievement, hasAchievement } from './profile.js';
import { getHeatmapStats } from './heatmap-stats.js';
import { isGeoMaster } from './rank-tier.js';

export const ACHIEVEMENTS = [
  {
    id: 'first_game',
    icon: '🌍',
    nameKey: 'achFirstGameName',
    descKey: 'achFirstGameDesc',
    check: ({ aggregated }) => aggregated.totalGamesPlayed >= 1,
  },
  {
    id: 'ten_games',
    icon: '🎮',
    nameKey: 'achTenGamesName',
    descKey: 'achTenGamesDesc',
    check: ({ aggregated }) => aggregated.totalGamesPlayed >= 10,
  },
  {
    id: 'fifty_games',
    icon: '🧭',
    nameKey: 'achFiftyGamesName',
    descKey: 'achFiftyGamesDesc',
    check: ({ aggregated }) => aggregated.totalGamesPlayed >= 50,
  },
  {
    id: 'hundred_rounds',
    icon: '💯',
    nameKey: 'achHundredRoundsName',
    descKey: 'achHundredRoundsDesc',
    check: ({ aggregated }) => aggregated.totalRoundsPlayed >= 100,
  },
  {
    id: 'streak_3',
    icon: '🔥',
    nameKey: 'achStreak3Name',
    descKey: 'achStreak3Desc',
    check: ({ profile }) => profile.dailyStreak.best >= 3,
  },
  {
    id: 'streak_7',
    icon: '🔥',
    nameKey: 'achStreak7Name',
    descKey: 'achStreak7Desc',
    check: ({ profile }) => profile.dailyStreak.best >= 7,
  },
  {
    id: 'streak_30',
    icon: '🔥',
    nameKey: 'achStreak30Name',
    descKey: 'achStreak30Desc',
    check: ({ profile }) => profile.dailyStreak.best >= 30,
  },
  {
    id: 'pulsemap_ace',
    icon: '🎯',
    nameKey: 'achPulsemapAceName',
    descKey: 'achPulsemapAceDesc',
    check: ({ heatmap }) => heatmap.bestAttempts === 1,
  },
  {
    id: 'pulsemap_veteran',
    icon: '🗺️',
    nameKey: 'achPulsemapVeteranName',
    descKey: 'achPulsemapVeteranDesc',
    check: ({ heatmap }) => heatmap.roundsSolved >= 25,
  },
  {
    id: 'geo_master',
    icon: '👑',
    nameKey: 'achGeoMasterName',
    descKey: 'achGeoMasterDesc',
    check: ({ aggregated }) => isGeoMaster(aggregated.totalGamesPlayed),
  },
];

function gatherContext() {
  return { aggregated: getAggregatedStats(), heatmap: getHeatmapStats(), profile: getProfile() };
}

/** Nach jeder beendeten Partie aufrufen (siehe renderLeaderboard() in
 * app.js) - NACHDEM die zugrundeliegenden Stores (player-stats.js/
 * heatmap-stats.js/profile.js) fuer diese Partie schon aktualisiert wurden,
 * sonst wuerde z.B. "erste Partie gespielt" erst eine Partie zu spaet
 * auftauchen. Liefert die neu freigeschalteten Achievements (leeres Array,
 * wenn keine dazukamen) - fuer ein "Achievement freigeschaltet!"-Toast pro
 * Eintrag. */
export function checkAchievements() {
  const ctx = gatherContext();
  const unlocked = [];
  for (const achievement of ACHIEVEMENTS) {
    if (hasAchievement(achievement.id)) continue;
    if (achievement.check(ctx)) {
      unlockAchievement(achievement.id);
      unlocked.push(achievement);
    }
  }
  return unlocked;
}

/** Fuer die Achievements-Uebersicht (#achievements-modal) - jedes
 * Achievement plus seinen freigeschalteten/gesperrten Zustand. */
export function getAchievementsWithStatus() {
  return ACHIEVEMENTS.map((a) => ({ ...a, unlocked: hasAchievement(a.id) }));
}
