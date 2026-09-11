// Lokales Rang-Tier-System (Bronze/Silber/Gold/Geo-Master) - Phase 3 aus
// AUDIT_ROADMAP.md Abschnitt 5. Bewusst NICHT skill-basiert (kein Versuch,
// Punktzahlen ueber Punkte-Duell/HP-Duell/Country-Streak/Battle-Royale
// hinweg auf eine gemeinsame Skala zu normalisieren - die Modi haben
// grundverschiedene Score-Bedeutungen, siehe player-stats.js'
// bestGameScore-Kommentar). Stattdessen ein reiner Fortschritts-/Hingabe-
// Indikator ueber die Gesamtzahl gespielter Partien (klassisch + PulseMap
// zusammen, via getAggregatedStats().totalGamesPlayed) - ehrlich einfach
// statt einer scheinbar praezisen, aber tatsaechlich verzerrten "Skill"-
// Zahl.
const TIERS = [
  { id: 'bronze', icon: '🥉', minGames: 0, nameKey: 'rankTierBronze' },
  { id: 'silver', icon: '🥈', minGames: 5, nameKey: 'rankTierSilver' },
  { id: 'gold', icon: '🥇', minGames: 15, nameKey: 'rankTierGold' },
  { id: 'geo-master', icon: '👑', minGames: 40, nameKey: 'rankTierGeoMaster' },
];

/** Aktuelles Tier + (falls vorhanden) das naechste Tier mit der noch
 * fehlenden Partienzahl - fuer eine "noch 3 Partien bis Gold"-Anzeige. */
export function getRankTier(totalGamesPlayed) {
  const games = Number.isFinite(totalGamesPlayed) ? totalGamesPlayed : 0;
  let current = TIERS[0];
  for (const tier of TIERS) {
    if (games >= tier.minGames) current = tier;
  }
  const currentIndex = TIERS.indexOf(current);
  const next = TIERS[currentIndex + 1] ?? null;
  return {
    ...current,
    next: next ? { ...next, gamesNeeded: next.minGames - games } : null,
  };
}

export function isGeoMaster(totalGamesPlayed) {
  return getRankTier(totalGamesPlayed).id === 'geo-master';
}
