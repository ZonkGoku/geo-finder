// Leichtgewichtiges i18n-System ohne Build-Schritt (passend zum Rest des
// Projekts: statisches Vanilla-JS, kein Bundler). Statische Texte tragen ein
// data-i18n-Attribut in index.html und werden per applyTranslations()
// gesetzt; dynamisch in JS erzeugte Strings rufen t() direkt auf.
//
// Migriert ist inzwischen der komplette Spielweg: Kopfzeile/Hauptmenue, die
// geteilte Lobby (Spieler-Panel, Spielregeln, Kartenauswahl, Mutatoren,
// Ready/Start-Flow), die gesamte PulseMap-Oberflaeche UND seit dem
// Kern-Loop-Abschnitt weiter unten auch In-Game-HUD, Rundenergebnis und
// Endstand. Letztere waren zuvor die groesste Luecke: null
// data-i18n-Attribute bei englischem Default, ein englischsprachiger Spieler
// bekam ab dem Startknopf eine durchgehend deutsche Partie.
//
// Noch NICHT migriert sind Rand-/Fehlerpfade ausserhalb einer laufenden
// Partie (Verbindungsfehler beim Beitreten, Challenge-Link-Fehler,
// Tages-Challenge-Kachel, Menue-Statistiken) - die stehen weiterhin deutsch
// im Code.
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
    const attrList = el.getAttribute('data-i18n-attr');
    const value = t(key);
    // Kommaliste statt eines einzelnen Attributs: die Panorama-Steuerung hat
    // Buttons, deren aria-label und title denselben Text tragen sollen -
    // vorher haette das zwei Elemente oder zwei Durchlaeufe gebraucht.
    // Einzelwert bleibt gueltig (split(',') liefert dann ein Element).
    if (attrList) for (const attr of attrList.split(',')) el.setAttribute(attr.trim(), value);
    else el.textContent = value;
  });
  // Eigener Durchlauf fuer Elemente, die BEIDES brauchen: sichtbaren Text
  // (ueber data-i18n) UND einen abweichenden Tooltip - etwa der
  // Tipp-bestaetigen-Button, dessen title zusaetzlich das Tastenkuerzel
  // nennt. Ueber data-i18n-attr allein ginge das nicht, weil dieses
  // Attribut den Textinhalt gerade ersetzt statt ergaenzt.
  root.querySelectorAll('[data-i18n-title]').forEach((el) => {
    el.setAttribute('title', t(el.getAttribute('data-i18n-title')));
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
    changeMapPackBtn: 'Select Map',
    selectMapBtn: 'Select map',
    modePoints: 'Points duel',
    modeHp: 'HP duel (6000 HP)',
    modeCountryStreak: 'Country streak',
    modeBattleRoyale: 'Battle Royale',

    // Kurz-Kacheln pro Modus (siehe #mode-summary in index.html,
    // renderModeSummary() in app.js) - IMMER sichtbares 2x2-Icon-Raster statt
    // eines Fliesstext-Satzes. Nutzer-Vorgabe: "statt der Beschreibung
    // einfach kleine Kacheln", auf einen Blick erfassbar statt gelesen
    // werden zu muessen. Je 3-5 Woerter pro Kachel, Icon macht den Rest
    // (siehe MODE_SUMMARY.ruleIcons in app.js).
    rulesPoints1: 'See a 360° photo',
    rulesPoints2: 'Drop a pin on the map',
    rulesPoints3: 'Closer pin = more points',
    rulesPoints4: 'Most points wins',
    rulesHp1: 'Both start at 6000 HP',
    rulesHp2: 'Guess the spot each round',
    rulesHp3: 'Worse guess loses HP',
    rulesHp4: '0 HP = you lose',
    rulesCountryStreak1: 'See a 360° photo',
    rulesCountryStreak2: 'Only the country matters',
    rulesCountryStreak3: 'Click anywhere inside it',
    rulesCountryStreak4: 'Most countries wins',
    rulesHeatmap1: 'Type a country name',
    rulesHeatmap2: 'Map lights up in color',
    rulesHeatmap3: 'Warmer = closer guess',
    rulesHeatmap4: 'Fewest guesses wins',
    rulesBattleRoyale1: '3+ players in one lobby',
    rulesBattleRoyale2: 'Guess the spot, like Points Duel',
    rulesBattleRoyale3: 'Worst guess is eliminated',
    rulesBattleRoyale4: 'Last one standing wins',

    // Rang-Tiere (core/rank-tier.js) + Erfolge (core/achievements.js) -
    // siehe Kommentare dort fuer die zugrunde liegenden Bedingungen.
    rankTierBronze: 'Bronze',
    rankTierSilver: 'Silver',
    rankTierGold: 'Gold',
    rankTierGeoMaster: 'Geo-Master',
    rankTierNext: '{count} more to {name}',
    rankTierMax: 'Highest rank reached',
    achievementsCta: 'Achievements',
    achievementsModalTitle: 'Achievements',
    achievementUnlockedToast: 'Achievement unlocked: {name}',
    achFirstGameName: 'First Steps',
    achFirstGameDesc: 'Play your first game',
    achTenGamesName: 'Regular',
    achTenGamesDesc: 'Play 10 games',
    achFiftyGamesName: 'Globetrotter',
    achFiftyGamesDesc: 'Play 50 games',
    achHundredRoundsName: 'Century Club',
    achHundredRoundsDesc: 'Play 100 rounds total',
    achStreak3Name: 'Three in a Row',
    achStreak3Desc: 'Play 3 days in a row',
    achStreak7Name: 'A Week Strong',
    achStreak7Desc: 'Play 7 days in a row',
    achStreak30Name: 'A Month Strong',
    achStreak30Desc: 'Play 30 days in a row',
    achPulsemapAceName: 'First Try',
    achPulsemapAceDesc: 'Solve a PulseMap round in 1 guess',
    achPulsemapVeteranName: 'PulseMap Veteran',
    achPulsemapVeteranDesc: 'Solve 25 PulseMap rounds',
    achGeoMasterName: 'Geo-Master',
    achGeoMasterDesc: 'Reach the Geo-Master rank',

    panoramaControlsLabel: 'Panorama controls',
    modifierFree: 'Free (zoom allowed)',
    modifierNoZoom: 'Zoom locked',
    mutatorsLabel: 'Mutators',
    mutatorFogDesc: 'Panorama starts blurred, clears over 15s',
    mutatorCompassDesc: 'View starts facing a random direction',
    mutatorNoPanDesc: 'Panorama locked, no looking around/zooming',
    mapsetPanelHeading: 'Select Map',
    mapsetSearchPlaceholder: 'Search maps…',
    mapsetTagAll: 'All',
    mapsetTagCities: 'Cities',
    mapsetTagCulture: 'Culture',
    mapsetTagNature: 'Nature',
    mapsetEmpty: 'No maps found.',
    mapsetLocationCount: '{count}+ locations',
    lobbyStageEmptyHint: 'Select a map below to get started',
    readyBtn: 'Ready',
    notReadyBtn: 'Not ready',
    startBtn: 'Start match',
    hintReadyToStart: 'Ready to start.',
    hintWaitForPlayer: 'Waiting for at least one player to join.',
    hintWaitForReady: 'Waiting for all players to be ready.',
    hintWaitForHost: 'Waiting for the host to start the game.',
    hintLoadingMapset: 'Loading map…',
    hintSearchingPanoramas: 'Searching 360° panoramas… ({found}/{target} found)',
    toastMapsetLoadFailed: "Couldn't load the map.",
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
    heatmapPingHint: 'Tap a country to ping it',
    toastProxyFallback:
      '⚠ Round {round}: anti-cheat proxy unreachable, sent unprotected (raw location is visible to other players this round)',
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

    // ---------------------------------------------------------------- Kern-Loop
    // HUD, Rundenergebnis und Endstand - die drei Screens, in denen das
    // eigentliche Spiel stattfindet. Waren bis hierhin komplett unuebersetzt
    // (0 data-i18n-Attribute), obwohl die App auf Englisch als Default steht:
    // ein englischsprachiger Spieler bekam ab dem Startknopf eine deutsche
    // Partie.
    hudRoundLabel: 'ROUND ',
    hudHint: 'Hint',
    panoLoading: 'Loading panorama…',
    panoFocusLost: 'Focus lost — paused',
    spectatorBanner: '👀 You are out — watch the rest of the match',
    spectatorBtnLabel: '👀 Spectating',
    confirmGuess: 'Confirm guess',
    confirmGuessTitle: 'Confirm guess (Space)',
    openMap: 'Open map',
    openMapTitle: 'Open map (M)',
    collapseMapLabel: 'Shrink map',
    alignNorth: 'Align north',
    alignNorthTitle: 'Align north (R)',
    zoomInLabel: 'Zoom in',
    zoomInTitle: 'Zoom in (+)',
    zoomOutLabel: 'Zoom out',
    zoomOutTitle: 'Zoom out (-)',
    fullscreenLabel: 'Fullscreen',
    fullscreenTitle: 'Fullscreen (F)',
    emotesLabel: 'Emotes',
    emotesTitle: 'Emotes (E)',
    walkLabel: 'Keep walking',
    walkForwardLabel: 'Walk forward',
    walkBackLabel: 'Walk back',
    mapStyleToggleTitle: 'Switch between satellite and map',
    mapStyleMap: 'Map',
    mapStyleSatellite: 'Satellite',
    shortcutHint: 'Shortcuts: [Space] guess · [M] map · [E] emotes',

    resultEyebrow: 'Round result',
    resultRoundOf: 'Round {n} of {total}',
    funFactLabel: 'Did you know?',
    nextRoundIn: 'Next round in 00:{seconds}',
    nextRoundNow: 'Next round…',
    nextRoundSoon: 'Next round shortly…',
    advanceRoundBtn: 'Next →',
    royaleRemaining: '{n} still in',

    scoreNoGuess: 'No guess submitted',
    scoreCorrect: 'Correct — {country}',
    scoreWrong: 'Wrong — you: {guess}, correct: {actual}',
    scoreDistance: '{km} km away',
    chipStreak: '{n} streak',
    chipBase: 'Base {n}',
    chipSpeed: '+{n} speed',
    chipStreakBonus: '+{n} streak x{multiplier}',
    chipNoDamage: 'No damage',
    chipHpLeft: '{n} HP left',
    eliminatedTag: 'Eliminated',

    leaderboardEyebrow: 'Final standings',
    overviewMapHeading: 'All rounds at a glance',
    playAgainBtn: 'Play again',
    shareChallengeBtn: 'Share challenge',
    backToMenuBtn: 'Back to menu',
    duelFinished: 'Duel over',
    hpDuelFinished: 'HP duel over',
    countryStreakFinished: 'Country streak over',
    pulsemapDuelFinished: 'PulseMap duel over',
    royaleFinished: 'Battle Royale over',
    royaleWinner: '{name} wins the Battle Royale!',
    hpWinner: '{name} wins the HP duel!',
    championLabel: '🏆 Champion',
    championLabelShort: 'Champion',
    outInRound: 'Out in round {n}',
    pointsShort: '{n} pts',
    correctOfTotal: '{n}/{total} correct',
    hpLeftLabel: 'HP left',
    bestStreakLabel: 'Best streak: {n}',

    toastImageUnavailable: 'This image is no longer available',
    toastGuessFailed: 'Guess could not be confirmed — please check your connection.',
    toastMapExhausted: 'Map exhausted. The game ends after this round.',
    toastGeneratingNext: 'Generating next location…',
    toastNoImagesFound: 'No images found for this map.',
    toastPeerLost: '{name} lost connection — waiting for them to return…',
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
    changeMapPackBtn: 'Karte auswählen',
    selectMapBtn: 'Karte wählen',
    modePoints: 'Punkte-Duell',
    modeHp: 'HP-Duell (6000 HP)',
    modeCountryStreak: 'Country-Streak',
    modeBattleRoyale: 'Battle Royale',
    rulesPoints1: '360°-Foto ansehen',
    rulesPoints2: 'Pin auf Karte setzen',
    rulesPoints3: 'Näher dran = mehr Punkte',
    rulesPoints4: 'Meiste Punkte gewinnt',
    rulesHp1: 'Beide starten mit 6000 HP',
    rulesHp2: 'Jede Runde Ort raten',
    rulesHp3: 'Schlechterer Tipp verliert HP',
    rulesHp4: '0 HP = verloren',
    rulesCountryStreak1: '360°-Foto ansehen',
    rulesCountryStreak2: 'Nur das Land zählt',
    rulesCountryStreak3: 'Klick irgendwo rein reicht',
    rulesCountryStreak4: 'Meiste Länder gewinnt',
    rulesHeatmap1: 'Landesnamen eintippen',
    rulesHeatmap2: 'Karte färbt sich ein',
    rulesHeatmap3: 'Wärmer = näher dran',
    rulesHeatmap4: 'Wenigste Tipps gewinnt',
    rulesBattleRoyale1: '3+ Spieler in einer Lobby',
    rulesBattleRoyale2: 'Raten wie beim Punkte-Duell',
    rulesBattleRoyale3: 'Schlechtester fliegt raus',
    rulesBattleRoyale4: 'Letzte:r übrig gewinnt',

    rankTierBronze: 'Bronze',
    rankTierSilver: 'Silber',
    rankTierGold: 'Gold',
    rankTierGeoMaster: 'Geo-Master',
    rankTierNext: 'noch {count} bis {name}',
    rankTierMax: 'Höchster Rang erreicht',
    achievementsCta: 'Erfolge',
    achievementsModalTitle: 'Erfolge',
    achievementUnlockedToast: 'Erfolg freigeschaltet: {name}',
    achFirstGameName: 'Erste Schritte',
    achFirstGameDesc: 'Spiele deine erste Partie',
    achTenGamesName: 'Stammspieler',
    achTenGamesDesc: 'Spiele 10 Partien',
    achFiftyGamesName: 'Weltenbummler',
    achFiftyGamesDesc: 'Spiele 50 Partien',
    achHundredRoundsName: 'Hundertschaft',
    achHundredRoundsDesc: 'Spiele insgesamt 100 Runden',
    achStreak3Name: 'Drei in Folge',
    achStreak3Desc: 'Spiele 3 Tage in Folge',
    achStreak7Name: 'Eine starke Woche',
    achStreak7Desc: 'Spiele 7 Tage in Folge',
    achStreak30Name: 'Ein starker Monat',
    achStreak30Desc: 'Spiele 30 Tage in Folge',
    achPulsemapAceName: 'Erstschuss',
    achPulsemapAceDesc: 'Löse eine PulseMap-Runde mit nur 1 Tipp',
    achPulsemapVeteranName: 'PulseMap-Veteran',
    achPulsemapVeteranDesc: 'Löse 25 PulseMap-Runden',
    achGeoMasterName: 'Geo-Master',
    achGeoMasterDesc: 'Erreiche den Rang Geo-Master',

    panoramaControlsLabel: 'Panorama-Steuerung',
    modifierFree: 'Frei (Zoom erlaubt)',
    modifierNoZoom: 'Zoom gesperrt',
    mutatorsLabel: 'Mutatoren',
    mutatorFogDesc: 'Panorama startet verschwommen, klart über 15s auf',
    mutatorCompassDesc: 'Blick startet in eine zufällige Richtung',
    mutatorNoPanDesc: 'Panorama fest, kein Umsehen/Zoomen',
    mapsetPanelHeading: 'Karte auswählen',
    mapsetSearchPlaceholder: 'Karte suchen…',
    mapsetTagAll: 'Alle',
    mapsetTagCities: 'Städte',
    mapsetTagCulture: 'Kultur',
    mapsetTagNature: 'Natur',
    mapsetEmpty: 'Keine Karten gefunden.',
    mapsetLocationCount: '{count}+ Orte',
    lobbyStageEmptyHint: 'Wähle unten eine Karte aus',
    readyBtn: 'Bereit',
    notReadyBtn: 'Nicht bereit',
    startBtn: 'Match starten',
    hintReadyToStart: 'Bereit zum Start.',
    hintWaitForPlayer: 'Warte, bis mindestens ein Mitspieler dem Raum beitritt.',
    hintWaitForReady: 'Warte, bis alle Mitspieler bereit sind.',
    hintWaitForHost: 'Warte auf den Host, das Spiel zu starten.',
    hintLoadingMapset: 'Lade Karte…',
    hintSearchingPanoramas: 'Suche 360°-Panoramen… ({found}/{target} gefunden)',
    toastMapsetLoadFailed: 'Karte konnte nicht geladen werden.',
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
    heatmapPingHint: 'Tippe auf ein Land, um dorthin zu pingen',
    toastProxyFallback:
      '⚠ Runde {round}: Anti-Cheat-Proxy nicht erreichbar, ungeschützt gesendet (roher Standort ist diese Runde für andere sichtbar)',
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

    // ---------------------------------------------------------------- Kern-Loop
    // Siehe gleichnamigen Abschnitt im englischen Block oben.
    hudRoundLabel: 'RUNDE ',
    hudHint: 'Hinweis',
    panoLoading: 'Panorama lädt…',
    panoFocusLost: 'Fokus verloren — pausiert',
    spectatorBanner: '👀 Du bist ausgeschieden — schau dir die restliche Partie an',
    spectatorBtnLabel: '👀 Zuschauer-Modus',
    confirmGuess: 'Tipp bestätigen',
    confirmGuessTitle: 'Tipp bestätigen (Leertaste)',
    openMap: 'Karte öffnen',
    openMapTitle: 'Karte öffnen (M)',
    collapseMapLabel: 'Karte verkleinern',
    alignNorth: 'Nach Norden ausrichten',
    alignNorthTitle: 'Nach Norden ausrichten (R)',
    zoomInLabel: 'Vergrößern',
    zoomInTitle: 'Vergrößern (+)',
    zoomOutLabel: 'Verkleinern',
    zoomOutTitle: 'Verkleinern (-)',
    fullscreenLabel: 'Vollbild',
    fullscreenTitle: 'Vollbild (F)',
    emotesLabel: 'Emotes',
    emotesTitle: 'Emotes (E)',
    walkLabel: 'Weiterlaufen',
    walkForwardLabel: 'Weiter laufen',
    walkBackLabel: 'Zurück laufen',
    mapStyleToggleTitle: 'Zwischen Satellit und Karte wechseln',
    mapStyleMap: 'Karte',
    mapStyleSatellite: 'Satellit',
    shortcutHint: 'Tastenkürzel: [Leertaste] tippen · [M] Karte · [E] Emotes',

    resultEyebrow: 'Rundenergebnis',
    resultRoundOf: 'Runde {n} von {total}',
    funFactLabel: 'Wusstest du schon?',
    nextRoundIn: 'Nächste Runde in 00:{seconds}',
    nextRoundNow: 'Nächste Runde…',
    nextRoundSoon: 'Nächste Runde in Kürze…',
    advanceRoundBtn: 'Weiter →',
    royaleRemaining: 'Noch {n} dabei',

    scoreNoGuess: 'Kein Tipp abgegeben',
    scoreCorrect: 'Richtig — {country}',
    scoreWrong: 'Falsch — du: {guess}, richtig: {actual}',
    scoreDistance: '{km} km entfernt',
    chipStreak: '{n}er-Streak',
    chipBase: 'Basis {n}',
    chipSpeed: '+{n} Speed',
    chipStreakBonus: '+{n} Streak x{multiplier}',
    chipNoDamage: 'Kein Schaden',
    chipHpLeft: '{n} HP übrig',
    eliminatedTag: 'Ausgeschieden',

    leaderboardEyebrow: 'Endstand',
    overviewMapHeading: 'Alle Runden im Überblick',
    playAgainBtn: 'Nochmal spielen',
    shareChallengeBtn: 'Challenge teilen',
    backToMenuBtn: 'Zurück zum Menü',
    duelFinished: 'Duell beendet',
    hpDuelFinished: 'HP-Duell beendet',
    countryStreakFinished: 'Country-Streak beendet',
    pulsemapDuelFinished: 'PulseMap-Duell beendet',
    royaleFinished: 'Battle Royale beendet',
    royaleWinner: '{name} gewinnt die Battle Royale!',
    hpWinner: '{name} gewinnt das HP-Duell!',
    championLabel: '🏆 Champion',
    championLabelShort: 'Champion',
    outInRound: 'Raus in Runde {n}',
    pointsShort: '{n} Pkt.',
    correctOfTotal: '{n}/{total} richtig',
    hpLeftLabel: 'HP übrig',
    bestStreakLabel: 'Bester Streak: {n}',

    toastImageUnavailable: 'Dieses Bild ist nicht mehr verfügbar',
    toastGuessFailed: 'Tipp konnte nicht bestätigt werden — bitte Verbindung prüfen.',
    toastMapExhausted: 'Karte erschöpft. Spiel endet nach dieser Runde.',
    toastGeneratingNext: 'Generiere nächste Location…',
    toastNoImagesFound: 'Für diese Karte wurden keine Bilder gefunden.',
    toastPeerLost: '{name} hat die Verbindung verloren — wartet auf Rückkehr…',
  },
};
