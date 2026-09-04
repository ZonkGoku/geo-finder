import { hashStringToSeed } from './rng.js';

// Tages-Challenge & teilbare Challenge-Links teilen sich denselben
// Seed-Mechanismus wie jedes normale Spiel (core/rng.js, net/host.js) - nur
// die Seed-Quelle unterscheidet sich (aus dem Datum abgeleitet bzw. aus
// einem Link uebernommen statt zufaellig ueber makeSeed()), damit alle
// Spieler exakt dieselben Runden bekommen.

// "weltweit" ist bewusst das einzige Kartenpaket mit source:"static" (siehe
// data/map-sets/index.json) - alle anderen Pakete brauchen einen live
// Mapillary-Abruf und damit Netzwerk + einen eigenen Zugangstoken, was
// pixel-identische Ergebnisse fuer jeden Spieler nicht hart garantieren
// kann. Die Tages-Challenge braucht diese Garantie, deshalb ein fester Pool
// statt der zuletzt in der Lobby gewaehlten Einstellung.
export const DAILY_CHALLENGE_MAPSET_ID = 'weltweit';

// Feste Einstellungen fuer die Tages-Challenge, unabhaengig von den zuletzt
// gewaehlten Lobby-Werten - sonst waeren die taeglichen Ergebnisse zwischen
// Spielern nicht fair vergleichbar (unterschiedliche Rundenzahl/Zeitlimit
// wuerden ganz andere Punktzahlen ermoeglichen).
export const DAILY_CHALLENGE_SETTINGS = Object.freeze({
  roundCount: 5,
  timeLimitMs: 90000,
  mode: 'points',
  modifier: 'free',
  mutators: Object.freeze({ fogOfWar: false, brokenCompass: false, noPan: false }),
});

const DAILY_STORAGE_KEY = 'geofinder-daily-challenge';

// UTC statt lokaler Zeitzone: ein fester, weltweit gleicher Tageswechsel -
// sonst waere "heute" fuer zwei Spieler in unterschiedlichen Zeitzonen ein
// anderer Seed, was dem Sinn einer Tages-Challenge widerspricht.
export function todayKeyUTC() {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

export function dailySeed(dateKey = todayKeyUTC()) {
  return hashStringToSeed(`geofinder-daily-${dateKey}`);
}

export function getDailyResult(dateKey = todayKeyUTC()) {
  try {
    const raw = localStorage.getItem(DAILY_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return parsed && parsed.date === dateKey ? parsed : null;
  } catch {
    return null;
  }
}

export function recordDailyResult(score, dateKey = todayKeyUTC()) {
  try {
    localStorage.setItem(DAILY_STORAGE_KEY, JSON.stringify({ date: dateKey, score, completedAt: Date.now() }));
  } catch {
    // localStorage voll/Privatmodus - der Tages-Status ist ein Bonus, kein Muss
  }
}

// ---------------------------------------------------------------- Challenge-Links

// Kompaktes, von Hand lesbares Format statt JSON+Base64: seed:mapSetId:
// roundCount:timeLimitMs(oder "x" fuer unbegrenzt):mode:modifier. ":" ist als
// Trenner bewusst gewaehlt, weil sowohl Kartenpaket-IDs (z. B. "new-york")
// als auch mode/modifier-Werte (z. B. "country-streak", "no-zoom") selbst
// Bindestriche enthalten.
export function encodeChallengeLink({ seed, mapSetId, roundCount, timeLimitMs, mode, modifier }) {
  const parts = [seed, mapSetId, roundCount, timeLimitMs ?? 'x', mode, modifier];
  return parts.map((p) => encodeURIComponent(String(p))).join(':');
}

export function decodeChallengeLink(raw) {
  if (!raw) return null;
  const parts = raw.split(':').map((p) => decodeURIComponent(p));
  if (parts.length !== 6) return null;
  const [seedStr, mapSetId, roundCountStr, timeLimitStr, mode, modifier] = parts;
  const seed = Number(seedStr);
  const roundCount = Number(roundCountStr);
  if (!Number.isFinite(seed) || !mapSetId || !Number.isFinite(roundCount) || roundCount <= 0) return null;
  return {
    seed,
    mapSetId,
    roundCount,
    timeLimitMs: timeLimitStr === 'x' ? null : Number(timeLimitStr),
    mode: mode || 'points',
    modifier: modifier || 'free',
  };
}
