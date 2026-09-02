const EARTH_RADIUS_KM = 6371;
const PERFECT_GUESS_THRESHOLD_KM = 0.05;
const MAX_SCORE = 5000;

const MAX_TIME_BONUS = 500;
const TIME_BONUS_GRACE_MS = 2000; // erste 2s zaehlen voll, verhindert Vorteil durch Klick-Reflex allein

const STREAK_DISTANCE_KM = 1000; // Distanz-Schwelle fuer eine "warme" Runde
const STREAK_BONUS = { 2: 200, 3: 500 }; // ab N Runden in Folge unter der Schwelle
const STREAK_BONUS_MAX_STREAK = 3;

function toRad(deg) {
  return (deg * Math.PI) / 180;
}

export function haversineDistanceKm(lat1, lng1, lat2, lng2) {
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return EARTH_RADIUS_KM * c;
}

export function scoreForDistance(distanceKm, scaleKm) {
  if (distanceKm <= PERFECT_GUESS_THRESHOLD_KM) return MAX_SCORE;
  const raw = MAX_SCORE * Math.exp(-distanceKm / scaleKm);
  return Math.max(0, Math.min(MAX_SCORE, Math.round(raw)));
}

/**
 * Zeit-Bonus: linear von MAX_TIME_BONUS (sofortiger Tipp) auf 0 (Tipp exakt
 * beim Ablauf des Zeitlimits) abfallend. Nur sinnvoll im Duell - eine
 * einzelne Person hat niemand, gegen den sie "schneller" sein koennte,
 * daher entscheidet der Aufrufer (Host), ob er den Bonus ueberhaupt vergibt.
 */
export function computeTimeBonus(elapsedMs, timeLimitMs) {
  if (elapsedMs <= TIME_BONUS_GRACE_MS) return MAX_TIME_BONUS;
  const usableWindow = timeLimitMs - TIME_BONUS_GRACE_MS;
  if (usableWindow <= 0) return 0;
  const remainingFraction = 1 - (elapsedMs - TIME_BONUS_GRACE_MS) / usableWindow;
  return Math.max(0, Math.round(MAX_TIME_BONUS * Math.max(0, Math.min(1, remainingFraction))));
}

/** Naechster Streak-Zaehler nach dieser Runde (0 = Streak gerissen). */
export function nextStreak(currentStreak, distanceKm) {
  if (distanceKm == null) return 0;
  return distanceKm <= STREAK_DISTANCE_KM ? currentStreak + 1 : 0;
}

export function computeStreakBonus(streakAfterRound) {
  const capped = Math.min(streakAfterRound, STREAK_BONUS_MAX_STREAK);
  return STREAK_BONUS[capped] || 0;
}

export function scoreGuess(guess, actual, scaleKm) {
  if (!guess) {
    return { distanceKm: null, score: 0, noGuess: true };
  }
  const distanceKm = haversineDistanceKm(guess.lat, guess.lng, actual.lat, actual.lng);
  return { distanceKm, score: scoreForDistance(distanceKm, scaleKm), noGuess: false };
}

export const COUNTRY_STREAK_POINTS = 1000;

/** Country-Streak-Modus: nur richtig/falsch zaehlt, keine Distanz-Feinheit. */
export function scoreCountryGuess(guessedCountry, actualCountry) {
  const correct = Boolean(guessedCountry) && guessedCountry === actualCountry;
  return { correct, score: correct ? COUNTRY_STREAK_POINTS : 0 };
}

/** Country-Streak: einfacher als der distanzbasierte Streak - jede richtige
 * Runde zaehlt hoch, jede falsche reisst die Kette komplett ab. */
export function nextCountryStreak(currentStreak, correct) {
  return correct ? currentStreak + 1 : 0;
}

export { STREAK_DISTANCE_KM, MAX_TIME_BONUS };
