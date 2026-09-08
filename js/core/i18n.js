// Leichtgewichtiges i18n-System ohne Build-Schritt (passend zum Rest des
// Projekts: statisches Vanilla-JS, kein Bundler). Statische Texte tragen ein
// data-i18n-Attribut in index.html und werden per applyTranslations()
// gesetzt; dynamisch in JS erzeugte Strings rufen t() direkt auf.
//
// Umfang bewusst NICHT "jeder String der App": migriert sind Kopfzeile/
// Hauptmenue (immer sichtbar), die komplette PulseMap-Lobby-/In-Game-
// Oberflaeche, sowie die GESAMTE geteilte Lobby (Spieler-Panel, Spielregeln,
// Kartenpaket-Auswahl, Mutatoren, Ready/Start-Flow) - die Lobby ist EIN
// gemeinsames Bauteil fuer alle Modi, eine Teilmigration dort erzeugte
// genau die Mischsprachen-Situation, die diese Migration eigentlich loesen
// sollte (Nutzer-Report). Die klassischen Panorama-Modi bleiben deutsch NUR
// noch im eigentlichen IN-GAME-HUD/Leaderboard/Tages-Challenge-Kachel
// (nachdem "Match starten" gedrueckt wurde) - eine vollstaendige Migration
// auch dieser Screens ist eine eigene, deutlich groessere Aufgabe.
const STORAGE_KEY = 'geofinder-lang';
const SUPPORTED = ['en', 'de'];
const FALLBACK_LANG = 'en';

function detectInitialLang() {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored && SUPPORTED.includes(stored)) return stored;
  } catch {
    // localStorage nicht verfuegbar - Spracheinstellung ist ein Bonus, kein Muss
  }
  // Default Englisch, AUSSER die Browsersprache ist explizit Deutsch -
  // Nutzer-Vorgabe.
  const nav = (navigator.language || navigator.languages?.[0] || '').toLowerCase();
  return nav.startsWith('de') ? 'de' : FALLBACK_LANG;
}

let currentLang = detectInitialLang();
const listeners = new Set();

export function getLang() {
  return currentLang;
}

export function setLang(lang) {
  if (!SUPPORTED.includes(lang) || lang === currentLang) return;
  currentLang = lang;
  try {
    localStorage.setItem(STORAGE_KEY, lang);
  } catch {
    // s.o. - kein Muss
  }
  document.documentElement.setAttribute('lang', lang);
  listeners.forEach((fn) => fn(lang));
}

/** Wird bei jedem Sprachwechsel aufgerufen - liefert eine Unsubscribe-Funktion. */
export function onLangChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** vars: optionale {name: wert}-Platzhalter, z.B. t('roundOf', {n:2, total:5}). */
export function t(key, vars) {
  const dict = DICT[currentLang] || DICT[FALLBACK_LANG];
  let str = dict[key] ?? DICT[FALLBACK_LANG][key] ?? key;
  if (vars) {
    for (const [k, v] of Object.entries(vars)) str = str.replaceAll(`{${k}}`, String(v));
  }
  return str;
}

/** Setzt textContent (oder ein anderes Attribut ueber data-i18n-attr) auf
 * allen Elementen mit [data-i18n] im gegebenen Wurzelelement (Default:
 * gesamtes Dokument) - fuer den einmaligen initialen Durchlauf UND jeden
 * Sprachwechsel (siehe onLangChange() in boot()). */
export function applyTranslations(root = document) {
  root.querySelectorAll('[data-i18n]').forEach((el) => {
    const key = el.getAttribute('data-i18n');
    const attr = el.getAttribute('data-i18n-attr');
    const value = t(key);
    if (attr) el.setAttribute(attr, value);
    else el.textContent = value;
  });
}

/** Deutschen ODER englischen Anzeigenamen eines Landes je nach aktiver
 * Sprache - country braucht .name (Englisch, aus dem Datensatz) und
 * .nameDe (core/country-names-de.js). Zentrale Stelle statt an jeder
 * Anzeigestelle (Top-3, Vorschlagsliste, Ergebnis-Banner, Karten-Labels)
 * einzeln lang==='de' abzufragen. */
export function countryDisplayName(country) {
  if (!country) return '';
  return currentLang === 'de' ? country.nameDe : country.name;
}

const DICT = {
  en: {
    brandTagline: '360° multiplayer · up to 6 players · P2P over WebRTC',
    menuHeroTitle1: 'GUESS',
    menuHeroTitle2: 'THE WORLD.',
    menuHeroLede: 'No account. No server. Peer-to-peer over WebRTC — one link is enough to compete live against each other.',
    actionHostTitle: 'Create room',
    actionHostSub: 'Open lobby & share link',
    actionJoinTitle: 'Join',
    actionJoinSub: 'Enter code or link',
    actionSoloTitle: 'Play solo',
    actionSoloSub: 'No other players needed',
    actionDailyTitle: 'Daily challenge',
    actionDailySub: 'Same spots for everyone, every day',
    langToggleLabel: 'Language',
    carouselPulsemapTagline: 'Guess the target country from a live pulsing world map.',
    carouselExplorerLabel: '360° Explorer',
    carouselExplorerTagline: 'Explore real 360° panoramas and pin the location on the map.',
    carouselRoyaleLabel: 'Battle Royale',
    carouselRoyaleTagline: 'The worst guess is eliminated each round — until only one champion remains.',
    carouselCta: 'Play now',

    lobbyHeadingWaiting: 'Waiting for players',
    lobbyHeadingSolo: 'Solo settings',
    roomCodeLabel: 'Room code',
    copyLinkBtn: 'Copy link',
    copyLinkBtnCopied: 'Copied!',
    showQrBtn: 'Show QR code for mobile',
    qrModalTitle: 'Join on mobile',
    qrModalHint: 'Point your camera at it — lands directly in this lobby.',
    qrModalUnavailable: 'Link too long for a QR code — copy it instead.',
    closeBtn: 'Close',
    cancelBtn: 'Cancel',
    joinModalTitle: 'Join a game',
    joinModalPlaceholder: '6-character room code or full link',
    joinModalConfirm: 'Join',
    onboardingStep1: 'Copy room link',
    onboardingStep2: 'Send to friends',
    onboardingStep3: 'Start the match!',
    onboardingSubtextInvite: 'Share the link above to invite players.',
    onboardingSubtextReady: 'Ready to start!',
    connectingToRoom: 'Connecting to room via WebRTC…',
    playersHeading: 'Players',
    statusDisconnected: 'disconnected',
    statusReady: 'Ready',
    statusWaiting: 'waiting…',
    hostTag: 'Host',
    settingsHeading: 'Game rules',
    settingPresets: 'Quick start',
    presetClassicTitle: 'Classic Match',
    presetClassicDesc: '5 rounds · 90s · Points duel',
    presetSpeedTitle: 'Speed Round',
    presetSpeedDesc: '3 rounds · 30s · Points duel',
    presetMarathonTitle: 'Marathon',
    presetMarathonDesc: '10 rounds · 180s · Points duel',
    customRulesLabel: 'More rules',
    changeMapPackBtn: 'Change map pack',
    selectMapBtn: 'Select map',
    modePoints: 'Points duel',
    modeHp: 'HP duel (6000 HP)',
    modeCountryStreak: 'Country streak',
    modeBattleRoyale: 'Battle Royale',
    battleRoyaleModeNote:
      'The worst guess is eliminated after each round - the round count is derived automatically from the player count (always one fewer), until only one champion remains. Needs at least 2 players.',
    panoramaControlsLabel: 'Panorama controls',
    modifierFree: 'Free (zoom allowed)',
    modifierNoZoom: 'Zoom locked',
    mutatorsLabel: 'Mutators',
    mutatorFogDesc: 'Panorama starts blurred, clears over 15s',
    mutatorCompassDesc: 'View starts facing a random direction',
    mutatorNoPanDesc: 'Panorama locked, no looking around/zooming',
    mapsetPanelHeading: 'Map pack',
    mapsetSearchPlaceholder: 'Search map packs…',
    mapsetTagAll: 'All',
    mapsetTagCities: 'Cities',
    mapsetTagCulture: 'Culture',
    mapsetTagNature: 'Nature',
    mapsetEmpty: 'No map packs found.',
    mapsetLocationCount: '{count}+ locations',
    lobbyStageEmptyHint: 'Choose a map pack below',
    readyBtn: 'Ready',
    notReadyBtn: 'Not ready',
    startBtn: 'Start match',
    hintReadyToStart: 'Ready to start.',
    hintWaitForPlayer: 'Waiting for at least one player to join.',
    hintWaitForReady: 'Waiting for all players to be ready.',
    hintWaitForHost: 'Waiting for the host to start the game.',
    hintLoadingMapset: 'Loading map pack…',
    hintSearchingPanoramas: 'Searching 360° panoramas… ({found}/{target} found)',
    toastMapsetLoadFailed: "Couldn't load the map pack.",
    toastLinkCopied: 'Link copied',
    toastCopyFailed: "Couldn't copy — please select and copy manually",
    toastResultCopied: 'Result copied — paste it anywhere to share.',
    defaultPlayerName: 'Player',
    defaultOpponentName: 'A fellow player',
    hostLostTitle: 'Lost connection to host',
    hostLostMessage: "The match can't continue without the host. Your previous results aren't lost though — you can start a new match anytime.",
    hostLostAction: 'Back to menu',
    reconnectingTitle: 'Reconnecting…',
    reconnectingMessage: 'Attempt {attempt} of {max} — please wait.',
    reconnectingCancelAction: 'Cancel',
    reconnectSuccessToast: 'Reconnected.',

    pulsemapModeLabel: 'PulseMap',
    pulsemapModeNote: 'No map pack needed: type country names during the game — the world map colors in by distance to the target country.',
    settingRounds: 'Rounds',
    settingDuration: 'Round duration',
    settingMode: 'Mode',
    settingFlow: 'Flow',
    settingOpponentInfo: 'Opponent info',
    settingContinentHint: 'Continent hint (easy mode)',
    settingLabels: 'Map labels',
    turnModeEfficiency: 'Simultaneous (fewest guesses)',
    turnModeRace: 'Simultaneous (race)',
    turnModeTurns: 'Turn-based (tactics)',
    turnModeNoteEfficiency: 'Everyone keeps guessing simultaneously until everybody has solved it — fewest guesses wins the round. Ties get a small speed bonus.',
    turnModeNoteRace: 'Everyone guesses simultaneously — the round ends the instant someone hits the exact target.',
    turnModeNoteTurns: 'Take turns — only one person guesses at a time.',
    opponentInfoAll: 'All guesses',
    opponentInfoBest: 'Best distance only',
    opponentInfoBlind: 'Blind',
    continentHintOn: 'On',
    continentHintOff: 'Off',
    labelsOn: 'On',
    labelsOff: 'Off',

    searchPlaceholder: 'Enter a country…',
    top3Title: 'Your top 3 guesses',
    scoreLabel: 'Score',
    neighborBadge: 'Neighbor',
    shareResultBtn: 'Share result',
    resultTargetLabel: 'Target country: {name}',
    resultExact: 'Exact match!',
    resultFastest: '{name} was fastest!',
    resultTimeUp: 'Time is up.',
    resultBestScore: 'Best result! {attempts} {attemptsUnit}',
    resultBestScoreBonus: 'Best result! {attempts} {attemptsUnit} + speed bonus!',
    resultSolvedNotBest: 'Solved in {attempts} {attemptsUnit} — best this round: {best}.',
    resultNotFound: "Didn't find it.",
    attemptUnitOne: 'guess',
    attemptUnitMany: 'guesses',
    solvedWaiting: 'Solved in {attempts} {attemptsUnit} – waiting for the other players…',
    turnStatusWaiting: 'Waiting for {name}…',
  },
  de: {
    brandTagline: '360°-Multiplayer · bis zu 6 Spieler · P2P über WebRTC',
    menuHeroTitle1: 'ERRATE',
    menuHeroTitle2: 'DIE WELT.',
    menuHeroLede: 'Kein Account. Kein Server. Peer-to-Peer über WebRTC — ein Link genügt, um live gegeneinander anzutreten.',
    actionHostTitle: 'Raum erstellen',
    actionHostSub: 'Lobby eröffnen & Link teilen',
    actionJoinTitle: 'Beitreten',
    actionJoinSub: 'Code oder Link einfügen',
    actionSoloTitle: 'Solo spielen',
    actionSoloSub: 'Ohne Mitspieler üben',
    actionDailyTitle: 'Tages-Challenge',
    actionDailySub: 'Jeden Tag dieselben Orte für alle',
    langToggleLabel: 'Sprache',
    carouselPulsemapTagline: 'Errate das gesuchte Land anhand einer live pulsierenden Weltkarte.',
    carouselExplorerLabel: '360° Explorer',
    carouselExplorerTagline: 'Echte 360°-Panoramen erkunden und den Standort auf der Karte anpinnen.',
    carouselRoyaleLabel: 'Battle Royale',
    carouselRoyaleTagline: 'Jede Runde scheidet der schlechteste Tipp aus - bis nur ein Champion bleibt.',
    carouselCta: 'Direkt starten',

    lobbyHeadingWaiting: 'Warten auf Mitspieler',
    lobbyHeadingSolo: 'Solo-Einstellungen',
    roomCodeLabel: 'Raum-Code',
    copyLinkBtn: 'Link kopieren',
    copyLinkBtnCopied: 'Kopiert!',
    showQrBtn: 'QR-Code für Handy anzeigen',
    qrModalTitle: 'Mit dem Handy beitreten',
    qrModalHint: 'Kamera drauf halten — landet direkt in dieser Lobby.',
    qrModalUnavailable: 'Link zu lang für einen QR-Code — kopier ihn stattdessen.',
    closeBtn: 'Schließen',
    cancelBtn: 'Abbrechen',
    joinModalTitle: 'Einem Spiel beitreten',
    joinModalPlaceholder: '6-stelliger Code oder ganzer Link',
    joinModalConfirm: 'Beitreten',
    onboardingStep1: 'Link kopieren',
    onboardingStep2: 'An Freunde senden',
    onboardingStep3: 'Match starten!',
    onboardingSubtextInvite: 'Teile den Link oben, um Mitspieler einzuladen.',
    onboardingSubtextReady: 'Bereit zum Start!',
    connectingToRoom: 'Verbinde mit Raum über WebRTC…',
    playersHeading: 'Spieler',
    statusDisconnected: 'getrennt',
    statusReady: 'Bereit',
    statusWaiting: 'wartet…',
    hostTag: 'Host',
    settingsHeading: 'Spielregeln',
    settingPresets: 'Schnellstart',
    presetClassicTitle: 'Classic Match',
    presetClassicDesc: '5 Runden · 90s · Punkte-Duell',
    presetSpeedTitle: 'Speed Round',
    presetSpeedDesc: '3 Runden · 30s · Punkte-Duell',
    presetMarathonTitle: 'Marathon',
    presetMarathonDesc: '10 Runden · 180s · Punkte-Duell',
    customRulesLabel: 'Weitere Regeln',
    changeMapPackBtn: 'Kartenpaket ändern',
    selectMapBtn: 'Paket wählen',
    modePoints: 'Punkte-Duell',
    modeHp: 'HP-Duell (6000 HP)',
    modeCountryStreak: 'Country-Streak',
    modeBattleRoyale: 'Battle Royale',
    battleRoyaleModeNote:
      'Nach jeder Runde scheidet der schlechteste Tipp aus - die Rundenzahl ergibt sich automatisch aus der Spielerzahl (immer einer weniger), bis nur noch ein Champion übrig bleibt. Braucht mindestens 2 Spieler.',
    panoramaControlsLabel: 'Panorama-Steuerung',
    modifierFree: 'Frei (Zoom erlaubt)',
    modifierNoZoom: 'Zoom gesperrt',
    mutatorsLabel: 'Mutatoren',
    mutatorFogDesc: 'Panorama startet verschwommen, klart über 15s auf',
    mutatorCompassDesc: 'Blick startet in eine zufällige Richtung',
    mutatorNoPanDesc: 'Panorama fest, kein Umsehen/Zoomen',
    mapsetPanelHeading: 'Kartenpaket',
    mapsetSearchPlaceholder: 'Kartenpaket suchen…',
    mapsetTagAll: 'Alle',
    mapsetTagCities: 'Städte',
    mapsetTagCulture: 'Kultur',
    mapsetTagNature: 'Natur',
    mapsetEmpty: 'Keine Kartenpakete gefunden.',
    mapsetLocationCount: '{count}+ Orte',
    lobbyStageEmptyHint: 'Wähle unten ein Kartenpaket aus',
    readyBtn: 'Bereit',
    notReadyBtn: 'Nicht bereit',
    startBtn: 'Match starten',
    hintReadyToStart: 'Bereit zum Start.',
    hintWaitForPlayer: 'Warte, bis mindestens ein Mitspieler dem Raum beitritt.',
    hintWaitForReady: 'Warte, bis alle Mitspieler bereit sind.',
    hintWaitForHost: 'Warte auf den Host, das Spiel zu starten.',
    hintLoadingMapset: 'Lade Kartenpaket…',
    hintSearchingPanoramas: 'Suche 360°-Panoramen… ({found}/{target} gefunden)',
    toastMapsetLoadFailed: 'Kartenpaket konnte nicht geladen werden.',
    toastLinkCopied: 'Link kopiert',
    toastCopyFailed: 'Kopieren nicht möglich — bitte manuell markieren',
    toastResultCopied: 'Ergebnis kopiert — einfach einfügen und teilen.',
    defaultPlayerName: 'Spieler',
    defaultOpponentName: 'Ein Mitspieler',
    hostLostTitle: 'Verbindung zum Host verloren',
    hostLostMessage: 'Die Partie kann ohne den Host nicht fortgesetzt werden. Deine bisherigen Ergebnisse sind aber nicht verloren, du kannst jederzeit ein neues Duell starten.',
    hostLostAction: 'Zurück zum Menü',
    reconnectingTitle: 'Verbindung wird wiederhergestellt…',
    reconnectingMessage: 'Versuch {attempt} von {max} — bitte warten.',
    reconnectingCancelAction: 'Abbrechen',
    reconnectSuccessToast: 'Wieder verbunden.',

    pulsemapModeLabel: 'PulseMap',
    pulsemapModeNote: 'Kein Kartenpaket nötig: tippe im Spiel Landesnamen, die Weltkarte färbt sich nach Entfernung zum Zielland ein.',
    settingRounds: 'Runden',
    settingDuration: 'Rundendauer',
    settingMode: 'Modus',
    settingFlow: 'Spielablauf',
    settingOpponentInfo: 'Gegner-Info',
    settingContinentHint: 'Kontinent-Hinweis (Easy Mode)',
    settingLabels: 'Karten-Labels',
    turnModeEfficiency: 'Gleichzeitig (Wenigste Tipps)',
    turnModeRace: 'Gleichzeitig (Rennen)',
    turnModeTurns: 'Abwechselnd (Taktik)',
    turnModeNoteEfficiency: 'Alle tippen gleichzeitig weiter, bis jede:r geloest hat - wer die wenigsten Tipps braucht, gewinnt die Runde. Bei Gleichstand gibt es ein paar Extra-Punkte fuer mehr Tempo.',
    turnModeNoteRace: 'Alle tippen gleichzeitig - die Runde endet sofort beim ersten exakten Treffer.',
    turnModeNoteTurns: 'Reihum tippen, immer nur eine Person gleichzeitig.',
    opponentInfoAll: 'Alle Tipps',
    opponentInfoBest: 'Nur beste Distanz',
    opponentInfoBlind: 'Blind',
    continentHintOn: 'An',
    continentHintOff: 'Aus',
    labelsOn: 'An',
    labelsOff: 'Aus',

    searchPlaceholder: 'Land eingeben…',
    top3Title: 'Deine Top 3 Tipps',
    scoreLabel: 'Punkte',
    neighborBadge: 'Nachbarland',
    shareResultBtn: 'Ergebnis teilen',
    resultTargetLabel: 'Gesuchtes Land: {name}',
    resultExact: 'Exakter Treffer!',
    resultFastest: '{name} war am schnellsten!',
    resultTimeUp: 'Die Zeit ist abgelaufen.',
    resultBestScore: 'Bestes Ergebnis! {attempts} {attemptsUnit}',
    resultBestScoreBonus: 'Bestes Ergebnis! {attempts} {attemptsUnit} + Tempo-Bonus!',
    resultSolvedNotBest: 'Gelöst in {attempts} {attemptsUnit} – beste Runde: {best}.',
    resultNotFound: 'Nicht gefunden.',
    attemptUnitOne: 'Tipp',
    attemptUnitMany: 'Tipps',
    solvedWaiting: 'Gelöst in {attempts} {attemptsUnit} – warte auf die anderen Spieler…',
    turnStatusWaiting: 'Warten auf {name}…',
  },
};
