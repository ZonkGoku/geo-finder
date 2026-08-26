const EARTH_RADIUS_KM = 6371;
const PERFECT_GUESS_THRESHOLD_KM = 0.05;
const MAX_SCORE = 5000;

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

export function scoreGuess(guess, actual, scaleKm) {
  if (!guess) {
    return { distanceKm: null, score: 0, noGuess: true };
  }
  const distanceKm = haversineDistanceKm(guess.lat, guess.lng, actual.lat, actual.lng);
  return { distanceKm, score: scoreForDistance(distanceKm, scaleKm), noGuess: false };
}
