// navigator.vibrate() ist Chrome/Android-only (Safari/iOS implementiert die
// Vibration API grundsaetzlich nicht, Firefox Desktop ignoriert sie) - jede
// Funktion hier ist daher ein reiner Bonus-Effekt mit stillem No-Op-Fallback,
// nie eine Voraussetzung fuer irgendeine Spiellogik.
function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    // Manche Browser werfen bei ungueltigem Kontext (z. B. Hintergrund-Tab) - egal
  }
}

/** Kurzer Tick beim Setzen eines Kartenpins. */
export function tapLight() {
  vibrate(12);
}

/** Deutlicheres Feedback bei Rundenende/Enthuellung. */
export function tapMedium() {
  vibrate(35);
}

/** Starkes Feedback bei Schaden (HP-Modus) oder einem exakten Treffer. */
export function tapStrong() {
  vibrate([40, 30, 60]);
}
