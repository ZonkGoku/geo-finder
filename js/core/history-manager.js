// Geraeteweites (localStorage) Verlaufs-Gedaechtnis: "welche IDs wurden in
// diesem Namensraum zuletzt gezeigt" - fuer weniger Wiederholung ueber
// mehrere Partien hinweg (Heatmap-Zielländer, Runden-Standorte pro
// Kartenpaket). Bewusst eine WEICHE Praeferenz statt eines harten
// Ausschlusses: kleine Pools (z. B. "Weltweit" mit 11 Standorten, oder ein
// Mapillary-Regionen-Set mit nur 7-8 Eintraegen) haetten nach 1-2 Partien
// schlicht nichts mehr Neues zu bieten, wenn bereits Gezeigtes fuer immer
// gesperrt bliebe. Die Aufrufer (core/pool-loader.js, net/host.js) filtern
// daher NUR, wenn genug ungesehene Kandidaten uebrig bleiben, und fallen
// sonst auf den vollen Pool zurueck - siehe preferUnseen() unten.
//
// Kein Server/Accounts (siehe Projekt-Grundsatz) - der Verlauf ist rein
// lokal im Browser des jeweiligen Spielers, genau wie schon der bestehende
// core/verified-image-cache.js.
const KEY_PREFIX = 'geofinder-history-';
const MAX_HISTORY_PER_NAMESPACE = 200;

function key(namespace) {
  return `${KEY_PREFIX}${namespace}`;
}

/** Aelteste zuerst, neueste am Ende - siehe recordShown(). */
export function loadHistory(namespace) {
  try {
    const raw = localStorage.getItem(key(namespace));
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return []; // localStorage kann in manchen Kontexten (Privatmodus) werfen
  }
}

/**
 * Merkt eine oder mehrere IDs als "gerade gezeigt" vor. Eine bereits
 * vorhandene ID wird ans Ende verschoben (zaehlt ab jetzt wieder als ganz
 * frisch gezeigt), nicht dupliziert. Bei Ueberlaenge fliegen die AELTESTEN
 * zuerst raus.
 */
export function recordShown(namespace, ids) {
  try {
    const history = loadHistory(namespace);
    const list = Array.isArray(ids) ? ids : [ids];
    for (const id of list) {
      const idx = history.indexOf(id);
      if (idx !== -1) history.splice(idx, 1);
      history.push(id);
    }
    while (history.length > MAX_HISTORY_PER_NAMESPACE) history.shift();
    localStorage.setItem(key(namespace), JSON.stringify(history));
  } catch {
    /* voll/Privatmodus - Verlauf ist ein Bonus, kein Muss */
  }
}

/**
 * Bevorzugt Kandidaten, die NICHT im Verlauf stehen (bzw. nicht in einer
 * zusaetzlich uebergebenen extraExclude-Menge - z. B. IDs, die in DERSELBEN,
 * noch laufenden Partie schon dran waren). Bleiben davon mindestens
 * minRemaining uebrig, wird NUR diese engere Auswahl zurueckgegeben; sonst
 * (kleiner Pool, grossteils schon gezeigt) unveraendert der volle
 * candidates-Pool, damit die Partie nie an zu wenigen Kandidaten scheitert.
 */
export function preferUnseen(namespace, candidates, idFn, minRemaining, extraExclude = null) {
  const recent = new Set(loadHistory(namespace));
  const unseen = candidates.filter((c) => {
    const id = idFn(c);
    return !recent.has(id) && !extraExclude?.has(id);
  });
  return unseen.length >= minRemaining ? unseen : candidates;
}
