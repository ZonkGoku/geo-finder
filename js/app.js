import { bus, state } from './core/state.js';
import { PeerManager, generateRoomCode } from './net/peer-manager.js';
import { HostController } from './net/host.js';
import { ClientController } from './net/client.js';
import { GuessMap } from './map/guess-map.js';
import { ResultMap } from './map/result-map.js';
import { HeatmapMap } from './map/heatmap-map.js';
import { PanoViewer } from './panorama/pano-viewer.js';
import { fetchSequenceImageIds, findNeighborImageId, fetchPanoramaById } from './panorama/mapillary-source.js';
import { generateQrMatrix, matrixToSvg } from './ui/qrcode.js';
import { ensureCountryStore, searchCountries, findCountryByName } from './core/country-store.js';
import { getColorForDistance, getDistanceLevel } from './core/heatmap-color.js';
import { proximityLabel } from './core/heatmap-proximity.js';
import { showScreen } from './ui/router.js';
import { showToast } from './ui/toast.js';
import { burst as particleBurst } from './ui/particles.js';
import * as haptics from './ui/haptics.js';
import { loadMapSetIndex, loadMapSetDetail } from './core/pool-loader.js';
import { getHighScore, recordScoreIfBest } from './core/high-scores.js';
import { getPlayerStats, averageScore, recordGamePlayed } from './core/player-stats.js';
import { recordDailyPlay, getAggregatedStats, getProfile } from './core/profile.js';
import { getRankTier } from './core/rank-tier.js';
import { checkAchievements, getAchievementsWithStatus } from './core/achievements.js';
import {
  getHeatmapStats,
  averageAttempts,
  topDropOffRound,
  recordHeatmapGameStarted,
  recordHeatmapSolve,
  recordHeatmapGameCompleted,
  recordHeatmapDropOff,
} from './core/heatmap-stats.js';
import {
  DAILY_CHALLENGE_MAPSET_ID,
  DAILY_CHALLENGE_SETTINGS,
  dailySeed,
  getDailyResult,
  recordDailyResult,
  encodeChallengeLink,
  decodeChallengeLink,
} from './core/challenge.js';
import * as sound from './audio/sound.js';
import { t, getLang, setLang, onLangChange, applyTranslations, countryDisplayName } from './core/i18n.js';
import { logTiming } from './core/debug-timing.js';

const PROFILE_KEY = 'geofinder.profile';
const RESULT_DISPLAY_SECONDS = 8;
const ROUND_COUNT_OPTIONS = [3, 5, 10];
const DURATION_OPTIONS = [30000, 60000, 90000, 180000, null];

let peerManager = null;
let controller = null;
// Schuetzt hostFlow()/joinFlow()/soloFlow() vor doppelter Ausfuehrung - ohne
// dieses Flag erzeugte ein Doppel-Tap auf Mobile (oder Enter+Klick auf
// "Verbinden" kurz hintereinander) ZWEI parallele PeerManager/Controller-
// Instanzen, die beide eine eigene WebRTC-Verbindung zum Host aufbauten. Der
// Host sah dadurch zwei Spieler-Eintraege vom selben Geraet - der aeltere
// blieb als verwaiste Verbindung auf "wartet..." haengen, weil die UI danach
// nur noch an der zuletzt erzeugten Instanz haengt. Siehe Nutzer-Report
// "bin nun zwei mal in einer session im spiel".
let menuActionInFlight = false;
let mapSetIndex = [];
let mapSetDetailCache = new Map(); // id -> resolved detail JSON
let activeMapSetDetail = null; // detail used for the game currently running
let guessMap = null;
let resultMap = null;
let overviewMap = null;
let panoViewer = null;
let hudTimerInterval = null;
let resultCountdownInterval = null;
let hintRevealed = false;
let lastTabSwitchSentAt = 0;
let mapSetFilterTag = 'alle';
let mapSetSearchTerm = '';

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- profile

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return { name: '', color: '#ff7a33' };
    return JSON.parse(raw);
  } catch {
    return { name: '', color: '#ff7a33' };
  }
}

function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: state.self.name, color: state.self.color }));
}

function initProfileUI() {
  const profile = loadProfile();
  state.self.name = profile.name || '';
  state.self.color = profile.color || '#ff7a33';

  el('player-name-input').value = state.self.name;
  el('player-name-input').addEventListener('input', (e) => {
    state.self.name = e.target.value;
    saveProfile();
  });

  const swatches = [...document.querySelectorAll('.swatch')];
  swatches.forEach((sw) => {
    if (sw.dataset.color === state.self.color) sw.classList.add('selected');
    else sw.classList.remove('selected');
    // initProfileUI() laeuft nur einmal beim Boot, das Anhaengen hier kann
    // sich also nicht bei jedem Render aufstapeln.
    attachHoverSound(sw);
    sw.addEventListener('click', () => {
      sound.playClick();
      swatches.forEach((s) => s.classList.remove('selected'));
      sw.classList.add('selected');
      state.self.color = sw.dataset.color;
      saveProfile();
    });
  });
}

function getName() {
  const name = state.self.name.trim();
  return name || t('defaultPlayerName');
}

// ---------------------------------------------------------------- theme toggle

const THEME_KEY = 'geofinder-theme';

function initThemeToggle() {
  const btn = el('btn-theme-toggle');
  const darkIcon = el('theme-icon-dark');
  const lightIcon = el('theme-icon-light');
  const sync = () => {
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    // .hidden=bool reflektiert bei <svg>-Elementen in manchen Browsern nicht
    // zuverlaessig auf das DOM-Attribut - toggleAttribute() umgeht das.
    darkIcon.toggleAttribute('hidden', isLight);
    lightIcon.toggleAttribute('hidden', !isLight);
    btn.title = isLight ? 'Zu Dunkelmodus wechseln' : 'Zu Hellmodus wechseln';
  };
  sync();
  btn.addEventListener('click', () => {
    sound.playClick();
    const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
    document.documentElement.setAttribute('data-theme', next);
    try {
      localStorage.setItem(THEME_KEY, next);
    } catch {
      /* Storage nicht verfuegbar (z. B. privater Modus) - Wahl gilt nur fuer diese Sitzung. */
    }
    sync();
  });
}

// ---------------------------------------------------------------- Sprache

function initLangToggle() {
  const btn = el('lang-toggle');
  const label = el('lang-toggle-label');
  // Zeigt die SPRACHE, zu der ein Klick wechseln wuerde (nicht die aktuell
  // aktive) - dieselbe Konvention wie viele Sprach-Umschalter ("DE" heisst
  // "zu Deutsch wechseln", nicht "Deutsch ist aktiv").
  const sync = () => {
    label.textContent = getLang() === 'de' ? 'EN' : 'DE';
    btn.title = getLang() === 'de' ? 'Switch to English' : 'Zu Deutsch wechseln';
  };
  sync();
  btn.addEventListener('click', () => {
    sound.playClick();
    setLang(getLang() === 'de' ? 'en' : 'de');
  });
  onLangChange(() => {
    sync();
    applyTranslations();
    // Dynamisch (nicht per data-i18n) erzeugte Texte, die gerade sichtbar
    // sein koennten, muessen bei einem Sprachwechsel live nachgezogen werden -
    // ausserhalb der Lobby ist renderLobby() ein guenstiger No-Op auf
    // verstecktem Markup, kein Sonderfall noetig.
    if (state.role) renderLobby();
    refreshDynamicI18n();
  });
}

// ---------------------------------------------------------------- sound toggle

// Bislang gab es nur auf dem Leaderboard einen Weg zurueck ins Menue -
// dieser Button in der Chrome-Leiste ist ueberall sichtbar, wo .device
// aktiv ist (Lobby/HUD/Ergebnis/Leaderboard), und erlaubt jederzeit einen
// Abbruch. resetToMenu() raeumt PeerManager/Controller aureichend auf -
// fuer den Host bedeutet das Verlassen fuer Mitspieler denselben
// "Host getrennt"-Zustand, den es bei einem echten Verbindungsabbruch auch
// schon gibt (bus.on('ui:host-disconnected', ...)).
function initLeaveGameButton() {
  el('btn-leave-game').addEventListener('click', () => {
    if (!state.role) {
      resetToMenu();
      return;
    }
    if (confirm('Spiel wirklich verlassen und zurück zum Menü?')) {
      sound.playClick();
      resetToMenu();
    }
  });
}

// Logo als Router-Link zurueck ins Hauptmenue. Anders als der bestehende
// #btn-leave-game (der IMMER fragt, sobald man ueberhaupt in Lobby/Spiel
// ist), soll das Logo nur mitten in einer laufenden Runde (#screen-hud
// aktiv) warnen - aus der Lobby (Spiel noch nicht gestartet) geht es ohne
// Rueckfrage direkt zurueck, weil dort noch kein Fortschritt existiert, der
// verloren gehen koennte.
function isRoundInProgress() {
  return (
    document.getElementById('screen-hud').classList.contains('active') ||
    document.getElementById('screen-heatmap').classList.contains('active')
  );
}

function showConfirmLeaveModal() {
  el('confirm-leave-modal').classList.remove('hidden');
}

function hideConfirmLeaveModal() {
  el('confirm-leave-modal').classList.add('hidden');
}

// ---------------------------------------------------------------- join modal

function showJoinModal(prefillCode) {
  el('join-modal-error').classList.add('hidden');
  const input = el('join-code-input');
  if (prefillCode) input.value = prefillCode;
  el('join-modal').classList.remove('hidden');
  input.focus();
}

function hideJoinModal() {
  el('join-modal').classList.add('hidden');
}

function initJoinModal() {
  el('btn-join-confirm').addEventListener('click', () => joinFlow(el('join-code-input').value));
  el('join-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFlow(el('join-code-input').value);
  });
  el('join-modal-cancel').addEventListener('click', () => {
    sound.playClick();
    hideJoinModal();
  });
  el('join-modal').addEventListener('click', (e) => {
    if (e.target.id === 'join-modal') hideJoinModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('join-modal').classList.contains('hidden')) hideJoinModal();
  });
}

// ---------------------------------------------------------------- Kartenpaket-Modal

function showMapSetModal() {
  el('mapset-modal').classList.remove('hidden');
  el('mapset-search-input').focus();
}

function hideMapSetModal() {
  el('mapset-modal').classList.add('hidden');
}

function initMapSetModal() {
  el('btn-change-mappack').addEventListener('click', () => {
    sound.playClick();
    showMapSetModal();
  });
  el('mapset-modal-close').addEventListener('click', () => {
    sound.playClick();
    hideMapSetModal();
  });
  el('mapset-modal').addEventListener('click', (e) => {
    if (e.target.id === 'mapset-modal') hideMapSetModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('mapset-modal').classList.contains('hidden')) hideMapSetModal();
  });
}

// ---------------------------------------------------------------- "Weitere Regeln"-Klappe

function initRulesAccordion() {
  const accordion = el('rules-accordion');
  const toggle = el('rules-accordion-toggle');
  toggle.addEventListener('click', () => {
    sound.playClick();
    const collapsed = accordion.classList.toggle('collapsed');
    toggle.setAttribute('aria-expanded', String(!collapsed));
  });
}

// ---------------------------------------------------------------- Preset-Schnellauswahl

// Jedes Preset patcht mehrere Einstellungen auf einmal - "Modus" bleibt
// bewusst bei allen dreien 'points', da die Presets laut Vorgabe nur
// Runden/Dauer variieren sollen ("5 rounds/90s/Points Duel" usw.), nicht den
// Spielmodus selbst durcheinanderwuerfeln.
const PRESETS = {
  classic: { roundCount: 5, timeLimitMs: 90000, mode: 'points' },
  speed: { roundCount: 3, timeLimitMs: 30000, mode: 'points' },
  marathon: { roundCount: 10, timeLimitMs: 180000, mode: 'points' },
};

function wirePresets() {
  el('preset-row').querySelectorAll('.preset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (state.role !== 'host') return;
      sound.playClick();
      controller.updateSettings(PRESETS[chip.dataset.preset]);
      renderLobby();
    });
  });
}

// Markiert das Preset als "aktiv", dessen Werte GENAU zu den aktuellen
// Einstellungen passen - reiner Anzeige-Abgleich, kein eigener State (siehe
// Kommentar an #preset-row in index.html).
function renderPresetRow() {
  const s = state.settings;
  el('preset-row').querySelectorAll('.preset-chip').forEach((chip) => {
    const p = PRESETS[chip.dataset.preset];
    const matches = p.roundCount === s.roundCount && p.timeLimitMs === s.timeLimitMs && p.mode === s.mode;
    chip.classList.toggle('active', matches);
  });
}

// #mode-summary (siehe index.html) zeigt fuer den gewaehlten Modus ein
// 2x2-Kachelraster - Icon + 3-5 Woerter pro Kachel statt eines Fliesstext-
// Satzes, IMMER sichtbar (kein Klick/Modal noetig). War zuerst ein einzelner
// Satz, dann ein Satz+Button-zu-Modal - Nutzer-Vorgabe war ausdruecklich
// "statt der Beschreibung einfach kleine Kacheln", also ersetzt #mode-summary
// jetzt direkt die Beschreibung selbst statt sie hinter einem Klick zu
// verstecken. rulesKeys/ruleIcons decken alle 5 Modi ab (vorher gab es nur
// fuer 2 der 5 Modi ueberhaupt eine Erklaerung).
const MODE_SUMMARY = {
  points: {
    rulesKeys: ['rulesPoints1', 'rulesPoints2', 'rulesPoints3', 'rulesPoints4'],
    ruleIcons: ['📸', '📍', '📏', '🏆'],
  },
  hp: {
    rulesKeys: ['rulesHp1', 'rulesHp2', 'rulesHp3', 'rulesHp4'],
    ruleIcons: ['❤️', '📍', '💔', '☠️'],
  },
  'country-streak': {
    rulesKeys: ['rulesCountryStreak1', 'rulesCountryStreak2', 'rulesCountryStreak3', 'rulesCountryStreak4'],
    ruleIcons: ['📸', '🌍', '✅', '🏆'],
  },
  heatmap: {
    rulesKeys: ['rulesHeatmap1', 'rulesHeatmap2', 'rulesHeatmap3', 'rulesHeatmap4'],
    ruleIcons: ['⌨️', '🌡️', '🔥', '🏆'],
  },
  'battle-royale': {
    rulesKeys: ['rulesBattleRoyale1', 'rulesBattleRoyale2', 'rulesBattleRoyale3', 'rulesBattleRoyale4'],
    ruleIcons: ['👥', '📍', '❌', '👑'],
  },
};

function renderModeSummary() {
  const summary = MODE_SUMMARY[state.settings.mode];
  if (!summary) return;
  el('mode-summary').innerHTML = summary.rulesKeys
    .map(
      (key, i) => `
        <div class="mode-rules-tile">
          <span class="mode-rules-tile-icon" aria-hidden="true">${summary.ruleIcons[i]}</span>
          <span class="mode-rules-tile-text">${escapeHtml(t(key))}</span>
        </div>
      `
    )
    .join('');
}

// ---------------------------------------------------------------- QR-Modal

function showQrModal(link) {
  const wrap = el('qr-code-wrap');
  wrap.innerHTML = '';
  wrap.classList.remove('qr-error');
  const matrix = generateQrMatrix(link);
  if (!matrix) {
    // Extrem lange Links (weit ueber der 412-Byte-Grenze von Version 15,
    // siehe js/ui/qrcode.js) sind praktisch ausgeschlossen bei einem Origin+
    // 6-stelligem Raum-Code, aber ein sauberer Fallback statt eines leeren
    // Quadrats ist trotzdem billig.
    wrap.classList.add('qr-error');
    wrap.textContent = t('qrModalUnavailable');
  } else {
    wrap.innerHTML = matrixToSvg(matrix, { moduleColor: '#14181f' });
  }
  el('qr-modal').classList.remove('hidden');
}

function hideQrModal() {
  el('qr-modal').classList.add('hidden');
}

function initQrModal() {
  el('btn-show-qr').addEventListener('click', () => {
    sound.playClick();
    showQrModal(el('lobby-share-link').textContent);
  });
  el('qr-modal-close').addEventListener('click', () => {
    sound.playClick();
    hideQrModal();
  });
  el('qr-modal').addEventListener('click', (e) => {
    if (e.target.id === 'qr-modal') hideQrModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('qr-modal').classList.contains('hidden')) hideQrModal();
  });
}

// ---------------------------------------------------------------- Einladungskarte / Copy-Feedback

let copyFeedbackTimer = null;

// playerCount===1: nur der Host selbst ist da - Schritte 1+2 (Link kopieren/
// teilen) sind das, was jetzt zu tun ist, Schritt 3 wartet noch.
// playerCount>1: mindestens ein Mitspieler ist beigetreten - 1+2 gelten als
// erledigt (sonst waere niemand da), Schritt 3 (Match starten) ist dran.
function renderOnboardingBanner(playerCount) {
  const step1 = el('onboarding-step-1');
  const step2 = el('onboarding-step-2');
  const step3 = el('onboarding-step-3');
  const hasJoined = playerCount > 1;

  step1.classList.toggle('done', hasJoined);
  step1.classList.toggle('active', !hasJoined);
  step2.classList.toggle('done', hasJoined);
  step2.classList.toggle('active', !hasJoined);
  step3.classList.toggle('done', false);
  step3.classList.toggle('active', hasJoined);

  el('lobby-onboarding-subtext').textContent = hasJoined ? t('onboardingSubtextReady') : t('onboardingSubtextInvite');
}

function initInviteCard() {
  el('copy-link-btn').addEventListener('click', async () => {
    sound.playClick();
    const text = el('lobby-share-link').textContent;
    const btn = el('copy-link-btn');
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      showToast(t('toastCopyFailed') + ': ' + text);
      return;
    }
    btn.classList.add('copied');
    btn.querySelector('.invite-copy-icon-default').hidden = true;
    btn.querySelector('.invite-copy-icon-done').hidden = false;
    el('copy-link-btn-label').textContent = t('copyLinkBtnCopied');
    clearTimeout(copyFeedbackTimer);
    copyFeedbackTimer = setTimeout(() => {
      btn.classList.remove('copied');
      btn.querySelector('.invite-copy-icon-default').hidden = false;
      btn.querySelector('.invite-copy-icon-done').hidden = true;
      el('copy-link-btn-label').textContent = t('copyLinkBtn');
    }, 1600);
  });
}

function initBrandHomeLink() {
  const goHome = () => {
    if (isRoundInProgress()) {
      showConfirmLeaveModal();
      return;
    }
    sound.playClick();
    resetToMenu();
  };
  el('brand-home-link').addEventListener('click', goHome);
  el('brand-home-link-hero').addEventListener('click', goHome);
  el('brand-home-link-chrome').addEventListener('click', goHome);

  el('confirm-leave-cancel').addEventListener('click', () => {
    sound.playClick();
    hideConfirmLeaveModal();
  });
  el('confirm-leave-confirm').addEventListener('click', () => {
    sound.playClick();
    hideConfirmLeaveModal();
    resetToMenu();
  });
  el('confirm-leave-modal').addEventListener('click', (e) => {
    if (e.target.id === 'confirm-leave-modal') hideConfirmLeaveModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('confirm-leave-modal').classList.contains('hidden')) hideConfirmLeaveModal();
  });
}

function initSoundToggle() {
  const btn = el('btn-sound-toggle');
  const onIcon = el('sound-icon-on');
  const offIcon = el('sound-icon-off');
  const sync = () => {
    const muted = sound.isMuted();
    // siehe initThemeToggle(): .hidden=bool reflektiert bei <svg> nicht
    // zuverlaessig auf das DOM-Attribut.
    onIcon.toggleAttribute('hidden', muted);
    offIcon.toggleAttribute('hidden', !muted);
  };
  sync();
  btn.addEventListener('click', () => {
    sound.unlockAudio();
    sound.toggleMuted();
    sync();
  });
}

// ---------------------------------------------------------------- map sets

async function ensureMapSetIndex() {
  if (mapSetIndex.length === 0) mapSetIndex = await loadMapSetIndex();
  return mapSetIndex;
}

async function getMapSetDetail(id) {
  if (mapSetDetailCache.has(id)) return mapSetDetailCache.get(id);
  const entry = mapSetIndex.find((s) => s.id === id);
  if (!entry) throw new Error(`Unbekanntes Kartenpaket: ${id}`);
  const rawDetail = await loadMapSetDetail(entry);
  // Absicherung falls die interne "id" einer Kartenpaket-Datei mal vom
  // Index abweicht - sonst wuerde state.pool.id nicht mit der ID
  // uebereinstimmen, unter der Highscores/Challenge-Links das Paket kennen,
  // und beide Features wuerden fuer dieses Paket leise ins Leere laufen.
  const detail = rawDetail.id === entry.id ? rawDetail : { ...rawDetail, id: entry.id };
  mapSetDetailCache.set(id, detail);
  return detail;
}

// ---------------------------------------------------------------- state overlay / connection banner

function showStateOverlay({ title, message, actionLabel, onAction }) {
  el('state-overlay-title').textContent = title;
  el('state-overlay-message').textContent = message;
  const actionBtn = el('state-overlay-action');
  if (actionLabel) {
    actionBtn.hidden = false;
    actionBtn.textContent = actionLabel;
    actionBtn.onclick = () => {
      hideStateOverlay();
      onAction?.();
    };
  } else {
    actionBtn.hidden = true;
    actionBtn.onclick = null;
  }
  el('state-overlay').classList.remove('hidden');
}

function hideStateOverlay() {
  el('state-overlay').classList.add('hidden');
}

function updateConnectionBanner() {
  const banner = el('connection-banner');
  const onGameScreen = document.getElementById('screen-hud').classList.contains('active') ||
    document.getElementById('screen-result').classList.contains('active') ||
    document.getElementById('screen-heatmap').classList.contains('active');
  if (!onGameScreen) {
    banner.classList.add('hidden');
    return;
  }
  const lost = [...state.players.values()].find((p) => !p.isHost && !p.connected);
  if (lost) {
    banner.textContent = t('toastPeerLost', { name: lost.name });
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ---------------------------------------------------------------- menu

// Fehler landen im Beitreten-Modal, solange es offen ist (ungueltiger Code,
// Verbindung fehlgeschlagen), sonst im generischen Menuefehler-Feld (z. B.
// hostFlow()-Fehler, oder ein Beitritts-Fehler NACHDEM resetToMenu() das
// Modal schon geschlossen hat - dann faellt der Nutzer ohnehin schon auf dem
// Hauptmenue an, wo #menu-error sichtbar ist).
function showMenuError(message) {
  const joinModal = el('join-modal');
  if (!joinModal.classList.contains('hidden')) {
    const errorEl = el('join-modal-error');
    errorEl.textContent = message;
    errorEl.classList.remove('hidden');
    return;
  }
  const errorEl = el('menu-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearMenuError() {
  el('menu-error').hidden = true;
  el('join-modal-error').classList.add('hidden');
}

function createSoloPeerManager() {
  return {
    peer: { id: 'solo-' + Math.random().toString(36).slice(2, 8) },
    connections: new Map(),
    broadcast() {},
    sendTo() {},
    sendToHost() {},
    destroy() {},
  };
}

async function hostFlow() {
  if (menuActionInFlight) return;
  menuActionInFlight = true;
  sound.unlockAudio();
  sound.playClick();
  clearMenuError();
  const roomCode = generateRoomCode();
  peerManager = new PeerManager();
  updateChrome('Verbinde…', null);
  try {
    const hostId = await peerManager.hostRoom(roomCode);
    controller = new HostController(peerManager);
    controller.registerSelfAsHost(hostId, getName(), state.self.color);
    state.roomCode = roomCode;
    location.hash = `room=${roomCode}`;
    updateChrome('Host', hostId);
    await enterLobby();
  } catch (err) {
    console.error(err);
    showMenuError('Verbindung fehlgeschlagen. Prüfe deine Internetverbindung und versuche es erneut.');
    updateChrome('Nicht verbunden', null);
  } finally {
    menuActionInFlight = false;
  }
}

const RECONNECT_MAX_ATTEMPTS = 4;
const RECONNECT_INTERVAL_MS = 3000; // 4 Versuche a 3s ueberdecken die 15s LEAVE_GRACE_MS des Hosts mit etwas Puffer
let reconnectToken = 0; // siehe attemptReconnect() - verhindert ueberlappende Retry-Ketten

function showHostLostOverlay() {
  showStateOverlay({
    title: t('hostLostTitle'),
    message: t('hostLostMessage'),
    actionLabel: t('hostLostAction'),
    onAction: resetToMenu,
  });
}

/** Versucht automatisch neu zu verbinden, solange der Host den Spieler-Slot
 * noch reserviert (LEAVE_GRACE_MS in net/host.js). Nur aus der Lobby heraus
 * aufgerufen (siehe Aufrufstelle) - dort ist ein frischer ROOM_JOIN_REQUEST
 * unproblematisch, weil noch keine Runde laeuft, deren Stand verloren gehen
 * koennte. reconnectToken schuetzt vor zwei ueberlappenden Retry-Ketten,
 * falls waehrend eines laufenden Versuchs erneut 'ui:host-disconnected'
 * feuert (z.B. der Reconnect selbst schlaegt sofort wieder fehl). */
async function attemptReconnect() {
  const myToken = ++reconnectToken;
  const roomCode = state.roomCode;
  const name = state.self.name;
  const color = state.self.color;
  if (!roomCode) {
    showHostLostOverlay();
    return;
  }

  for (let attempt = 1; attempt <= RECONNECT_MAX_ATTEMPTS; attempt++) {
    if (myToken !== reconnectToken) return; // ueberholt durch einen neueren Versuch/Nutzer-Aktion
    showStateOverlay({
      title: t('reconnectingTitle'),
      message: t('reconnectingMessage', { attempt, max: RECONNECT_MAX_ATTEMPTS }),
      actionLabel: t('reconnectingCancelAction'),
      onAction: () => {
        reconnectToken++; // laufende Kette stoppen
        resetToMenu();
      },
    });
    try {
      controller?.destroy?.();
      peerManager?.destroy();
      peerManager = new PeerManager();
      await peerManager.joinRoom(roomCode);
      if (myToken !== reconnectToken) return;
      controller = new ClientController(peerManager);
      controller.join(name, color);
      hideStateOverlay();
      showToast(t('reconnectSuccessToast'));
      return;
    } catch {
      if (myToken !== reconnectToken) return;
      if (attempt < RECONNECT_MAX_ATTEMPTS) await new Promise((resolve) => setTimeout(resolve, RECONNECT_INTERVAL_MS));
    }
  }
  if (myToken === reconnectToken) showHostLostOverlay();
}

async function joinFlow(rawCode) {
  if (menuActionInFlight) return;
  const code = extractRoomCode(rawCode);
  if (!code) {
    showMenuError('Bitte einen gültigen Raum-Code oder Link eingeben.');
    return;
  }
  menuActionInFlight = true;
  sound.unlockAudio();
  sound.playClick();
  clearMenuError();
  peerManager = new PeerManager();
  updateChrome('Verbinde…', null);
  try {
    await peerManager.joinRoom(code);
    controller = new ClientController(peerManager);
    controller.join(getName(), state.self.color);
    state.roomCode = code;
    updateChrome('Client', peerManager.peer.id);
  } catch (err) {
    console.error(err);
    showMenuError('Raum nicht erreichbar. Prüfe den Code oder frage nach einem neuen Link.');
    updateChrome('Nicht verbunden', null);
  } finally {
    menuActionInFlight = false;
  }
}

function extractRoomCode(raw) {
  const trimmed = (raw || '').trim();
  const match = trimmed.match(/room=([A-Za-z0-9]+)/);
  const codePart = match ? match[1] : trimmed;
  return codePart.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function soloFlow() {
  if (menuActionInFlight) return;
  menuActionInFlight = true;
  try {
    sound.unlockAudio();
    sound.playClick();
    clearMenuError();
    peerManager = createSoloPeerManager();
    controller = new HostController(peerManager);
    controller.registerSelfAsHost(peerManager.peer.id, getName(), state.self.color);
    state.roomCode = null;
    updateChrome('Solo', peerManager.peer.id);
    await enterLobby();
  } finally {
    menuActionInFlight = false;
  }
}

function updateChrome(statusText, peerId) {
  el('chrome-status').textContent = statusText;
  el('chrome-peer-id').textContent = peerId ? peerId.replace(/^geofinder-/, '') : '—';
}

// ---------------------------------------------------------------- lobby

async function enterLobby() {
  // Screen zuerst sichtbar machen, DANACH rendern: renderChoiceRow() misst
  // offsetLeft/offsetWidth der Buttons fuer den gleitenden Thumb - auf einem
  // noch display:none-Screen liefert das immer 0.
  showScreen('lobby');
  renderLobby();
  // Die Lobby darf nicht mehr auf den Kartenpaket-Index warten, bevor
  // ueberhaupt irgendetwas angezeigt wird ("laedt teils nicht" bei
  // langsamer Verbindung) - stattdessen sofort Platzhalter zeigen und die
  // echten Karten nachreichen, sobald der Fetch durch ist. boot() stoesst
  // ensureMapSetIndex() ausserdem schon beim Seitenaufruf im Hintergrund an,
  // in der Praxis ist die Liste hier also meistens schon da.
  if (mapSetIndex.length === 0) {
    renderMapSetSkeletons();
    await ensureMapSetIndex();
  }
  renderMapSetGrid();
}

// Fallback pro Kategorie, falls ein Kartenpaket unten keine eigene ID hat
// (z.B. neue Pakete, die noch nicht individuell verdrahtet wurden).
const MAPSET_CATEGORY_ICONS = {
  staedte: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21V9l5-4v16M13 21V5l5 3v13M4 21h16M9 12h.01M9 16h.01M13 9h.01M13 13h.01M13 17h.01"/></svg>',
  kultur: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 21h16M5 21V9M9 21V9M15 21V9M19 21V9M3 9l9-5 9 5M4 9h16"/></svg>',
  natur: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 20l6-10 4 6 2-3 6 7H3z"/><circle cx="17" cy="6" r="2"/></svg>',
  default: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.7 4 6 4 9s-1.5 6.3-4 9c-2.5-2.7-4-6-4-9s1.5-6.3 4-9z"/></svg>',
};
// Nutzerfeedback: die zufaelligen Picsum-Fotos "passen ueberhaupt nicht"
// zum jeweiligen Kartenpaket (z.B. eine Frau im Wald fuer "Hamburg
// Special"). Kein Bild-API liefert ohne Account/Kosten verlaesslich
// thematisch passende Fotos - stattdessen bekommt jetzt JEDES Kartenpaket
// sein eigenes, handgezeichnetes Symbol statt sich nur die 4
// Kategorie-Icons zu teilen.
const MAPSET_ICONS = {
  weltweit: MAPSET_CATEGORY_ICONS.default,
  hamburg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="5" r="2"/><path d="M12 7v13M7 13a5 5 0 0 0 10 0M5 13h4m6 0h4"/></svg>',
  'hamburg-hafen': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M4 16l1.5-5h13L20 16"/><path d="M8 11V6h8v5"/><path d="M2 20c1.5-2 3-2 4.5 0s3 2 4.5 0 3-2 4.5 0 3 2 4.5 0"/></svg>',
  'hamburg-alster': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M11 3v10"/><path d="M11 4l6 7h-6z" fill="currentColor" stroke="none"/><path d="M2 19c1.5-1.5 3-1.5 4.5 0s3 1.5 4.5 0 3-1.5 4.5 0 3 1.5 4.5 0"/></svg>',
  'hamburg-szene': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 18V5l11-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="17" cy="16" r="3"/></svg>',
  landmarks: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2l3.5 6h-7z" fill="currentColor" stroke="none"/><path d="M9 8h6v12H9z"/><path d="M6 20h12"/></svg>',
  capitals: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M12 7l1.4 3 3.3.3-2.5 2.3.8 3.3-3-1.8-3 1.8.8-3.3-2.5-2.3 3.3-.3z" fill="currentColor" stroke="none"/></svg>',
  berlin: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 21V9"/><circle cx="12" cy="6.5" r="3"/><path d="M9 21h6M8 17h8"/></svg>',
  paris: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 2l4 9h-2.7l1.7 5.5h-2L14 22h-4l1-5.5h-2L10.7 11H8z"/><path d="M6 22h12"/></svg>',
  munich: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M7 21V9a2 2 0 0 1 4 0v1"/><path d="M13 21V9a2 2 0 0 1 4 0v1"/><circle cx="9" cy="6" r="1.4" fill="currentColor" stroke="none"/><circle cx="15" cy="6" r="1.4" fill="currentColor" stroke="none"/><path d="M4 21h16"/></svg>',
  london: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><rect x="9" y="7" width="6" height="12"/><circle cx="12" cy="10" r="1.7"/><path d="M9 7l3-3 3 3M6 19h12"/></svg>',
  'new-york': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2c1.6 1.6 1.6 3.2 0 4.8S10.4 8.4 12 10"/><path d="M12 10v11"/><path d="M8 21h8M9.5 14.5h5"/></svg>',
  'asian-megacities': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 2v2"/><path d="M4 8h16M6.5 8L8 6h8l1.5 2"/><path d="M5 13h14M6.5 13L8 11h8l1.5 2"/><path d="M8 21v-8h8v8"/><path d="M4 21h16"/></svg>',
  unesco: MAPSET_CATEGORY_ICONS.kultur,
  stadiums: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><ellipse cx="12" cy="14" rx="9" ry="5"/><ellipse cx="12" cy="14" rx="5" ry="2.6"/><path d="M4 10l-1.2-4M20 10l1.2-4"/></svg>',
  'ruins-castles': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 21V10h3V7h2v3h2V6h2v4h2V7h2v3h3v11z"/><path d="M4 21h16"/></svg>',
  bridges: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M2 17c3-4 17-4 20 0"/><path d="M7 6v11M17 6v11"/><path d="M7 9l5 3 5-3"/><path d="M2 21h20"/></svg>',
  extreme: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M3 20l6-10 4 6 2-3 6 7H3z"/><path d="M18 4v4M16 6h4M16.6 4.6l2.8 2.8M19.4 4.6l-2.8 2.8"/></svg>',
  coastal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="12" cy="7" r="2.5"/><path d="M2 14c2-2 4-2 6 0s4 2 6 0 4-2 6 0M2 19c2-2 4-2 6 0s4 2 6 0 4-2 6 0"/></svg>',
  'country-roads': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M9 21C6 13 12 13 9 5"/><path d="M15 21c-3-8 3-8 0-16"/><path d="M12 4v2M12 9v2M12 14v2M12 19v2"/></svg>',
  'national-parks': '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 2l4 6h-2.5l3.5 5h-3l3 6H7l3-6H7l3.5-5H8z"/><path d="M12 19v3"/></svg>',
  islands: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 21V10"/><path d="M12 10c-2-3-6-3-7-1 2.5 1.2 4.5 0 7 1zm0 0c2-3 6-3 7-1-2.5 1.2-4.5 0-7 1zm0 0c-1-3 0-6 2-7-1 2-1 4-2 7z"/><ellipse cx="12" cy="21" rx="9" ry="2"/></svg>',
};
const MAPSET_PLAY_ICON = '<svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>';

function getFilteredMapSets() {
  const term = mapSetSearchTerm.trim().toLowerCase();
  return mapSetIndex.filter((entry) => {
    if (entry.hidden) return false;
    const matchesTag = mapSetFilterTag === 'alle' || entry.tag === mapSetFilterTag;
    const matchesTerm = !term || entry.name.toLowerCase().includes(term) || entry.description.toLowerCase().includes(term);
    return matchesTag && matchesTerm;
  });
}

function renderMapSetSkeletons(count = 6) {
  const grid = el('mapset-grid');
  el('mapset-empty').classList.add('hidden');
  grid.innerHTML = '';
  for (let i = 0; i < count; i++) {
    const card = document.createElement('div');
    card.className = 'mapset-card mapset-skeleton';
    card.innerHTML = `
      <div class="mapset-card-cover"></div>
      <div class="mapset-card-body">
        <span class="skeleton-line" style="width:38%"></span>
        <span class="skeleton-line" style="width:78%"></span>
        <span class="skeleton-line" style="width:55%"></span>
      </div>
    `;
    grid.appendChild(card);
  }
}

function renderMapSetGrid() {
  const grid = el('mapset-grid');
  grid.innerHTML = '';
  const isHost = state.role === 'host';
  const filtered = getFilteredMapSets();
  el('mapset-empty').classList.toggle('hidden', filtered.length > 0);

  for (const entry of filtered) {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = `mapset-card${entry.id === state.settings.mapSetId ? ' selected' : ''}`;
    card.disabled = !isHost || !entry.available;
    const badgeClass = entry.available ? 'ready' : 'needs-token';
    const badgeText = entry.available ? 'Bereit' : 'Token nötig';
    const coverClass = entry.tag ? `cover-${entry.tag}` : 'cover-default';
    const icon = MAPSET_ICONS[entry.id] || MAPSET_CATEGORY_ICONS[entry.tag] || MAPSET_CATEGORY_ICONS.default;
    card.innerHTML = `
      <div class="mapset-card-cover ${coverClass}">
        <span class="mapset-card-icon">${icon}</span>
        <div class="mapset-card-play">${MAPSET_PLAY_ICON}</div>
        <span class="mapset-card-select-label">${escapeHtml(t('selectMapBtn'))}</span>
      </div>
      <div class="mapset-card-body">
        <div class="mapset-card-badge-row">
          <span class="mapset-card-badge ${badgeClass}">${badgeText}</span>
          ${entry.locationCount ? `<span class="mapset-card-variety">${escapeHtml(t('mapsetLocationCount', { count: entry.locationCount }))}</span>` : ''}
        </div>
        <span class="mapset-card-name">${escapeHtml(entry.name)}</span>
        <span class="mapset-card-desc">${escapeHtml(entry.description)}</span>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (!isHost || !entry.available) return;
      sound.playClick();
      controller.updateSettings({ mapSetId: entry.id });
      renderMapSetGrid();
      hideMapSetModal();

      // Klick aufs Cover-Bild (wo der Play-Pfeil sitzt) startet direkt -
      // vorher war der Pfeil rein dekorativ und tat nichts eigenes.
      if (e.target.closest('.mapset-card-cover')) {
        if (!canStartGame()) {
          showToast('Warte, bis alle Mitspieler bereit sind, bevor das Spiel gestartet werden kann.');
        } else if (confirm(`Jetzt mit „${entry.name}“ starten?`)) {
          startGameFromLobby();
        }
      }
    });
    grid.appendChild(card);
  }
  renderLobbyStage();
  syncWalkBetaVisibility();
}

// "Die Buehne" - rechte Spalte der Desktop-Lobby. Zeigt eine grosse Vorschau
// des aktuell gewaehlten Kartenpakets samt persoenlichem Highscore (siehe
// core/high-scores.js), statt dass die halbe Lobby leer bleibt. Wird von
// renderMapSetGrid() nach jedem Neuzeichnen mit-aufgerufen, damit sie mit
// der Kartenpaket-Auswahl (state.settings.mapSetId) immer synchron bleibt.
const HEATMAP_STAGE_ICON =
  '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/></svg>';

function renderLobbyStage() {
  const empty = el('lobby-stage-empty');
  const content = el('lobby-stage-content');

  // Heatmap-Modus braucht kein Kartenpaket - die Buehne zeigt hier
  // stattdessen kurz, worum es in diesem Modus geht. Bleibt bewusst
  // sichtbar (statt wie die Kartenpaket-Auswahl ausgeblendet), weil der
  // Start-Button (#btn-start-game) strukturell IN dieser Buehne sitzt.
  if (state.settings.mode === 'heatmap') {
    empty.classList.add('hidden');
    content.classList.remove('hidden');
    el('lobby-stage-art').className = 'lobby-stage-art cover-default';
    el('lobby-stage-icon').innerHTML = HEATMAP_STAGE_ICON;
    el('lobby-stage-badge').className = 'mapset-card-badge ready';
    el('lobby-stage-badge').textContent = 'Bereit';
    el('lobby-stage-variety').classList.add('hidden');
    el('lobby-stage-name').textContent = 'PulseMap-Modus';
    el('lobby-stage-desc').textContent = 'Tippe Landesnamen, statt auf der Karte zu klicken - die Welt färbt sich nach Entfernung zum gesuchten Land ein. Wer zuerst richtig liegt, gewinnt die Runde.';
    el('lobby-stage-best').classList.add('hidden');
    return;
  }

  const entry = mapSetIndex.find((e) => e.id === state.settings.mapSetId);
  if (!entry) {
    empty.classList.remove('hidden');
    content.classList.add('hidden');
    return;
  }
  empty.classList.add('hidden');
  content.classList.remove('hidden');

  const coverClass = entry.tag ? `cover-${entry.tag}` : 'cover-default';
  const icon = MAPSET_ICONS[entry.id] || MAPSET_CATEGORY_ICONS[entry.tag] || MAPSET_CATEGORY_ICONS.default;
  el('lobby-stage-art').className = `lobby-stage-art ${coverClass}`;
  el('lobby-stage-icon').innerHTML = icon;

  const badge = el('lobby-stage-badge');
  badge.className = `mapset-card-badge ${entry.available ? 'ready' : 'needs-token'}`;
  badge.textContent = entry.available ? 'Bereit' : 'Token nötig';
  const variety = el('lobby-stage-variety');
  variety.classList.toggle('hidden', !entry.locationCount);
  if (entry.locationCount) variety.textContent = t('mapsetLocationCount', { count: entry.locationCount });
  el('lobby-stage-name').textContent = entry.name;
  el('lobby-stage-desc').textContent = entry.description;

  const best = getHighScore(entry.id, state.settings.mode);
  el('lobby-stage-best').classList.toggle('hidden', best == null);
  if (best != null) {
    el('lobby-stage-best-text').textContent = `Persönlicher Bestwert: ${best.toLocaleString(numberLocale())} Punkte`;
  }
}

function renderChoiceRow(rowId, currentValue) {
  const row = el(rowId);
  const isHost = state.role === 'host';
  let selectedBtn = null;
  row.querySelectorAll('button').forEach((btn) => {
    const raw = btn.dataset.value;
    const value = raw === 'null' ? null : Number.isNaN(Number(raw)) ? raw : Number(raw);
    const isSelected = value === currentValue;
    btn.classList.toggle('selected', isSelected);
    btn.disabled = !isHost;
    if (isSelected) selectedBtn = btn;
  });

  // Gleitenden Thumb hinter den ausgewaehlten Button positionieren. translateY
  // + dynamische Hoehe (statt nur translateX + fixer 100%-Hoehe per CSS) sind
  // noetig, seit #choice-mode ein 2-spaltiges CSS-Grid ist (Bugfix: 5 Modus-
  // Buttons ueberlappten sich vorher in einer einzeiligen Flex-Reihe, siehe
  // .choice-row#choice-mode in styles.css) - bei den weiterhin einzeiligen
  // Flex-Reihen bleibt offsetTop fuer jeden Button gleich, translateY ist
  // dort also ein Null-Op.
  const thumb = row.querySelector('.choice-thumb');
  if (thumb && selectedBtn) {
    thumb.style.opacity = '1';
    thumb.style.transform = `translate(${selectedBtn.offsetLeft - 3}px, ${selectedBtn.offsetTop - 3}px)`;
    thumb.style.width = `${selectedBtn.offsetWidth}px`;
    thumb.style.height = `${selectedBtn.offsetHeight}px`;
  } else if (thumb) {
    thumb.style.opacity = '0';
  }
}

// Nur diese Kartenpakete haben (laut Diskussion/Machbarkeitstest-Skript,
// siehe scripts/mapillary-walk-feasibility.mjs) dicht genug verbundene
// Mapillary-Bildsequenzen, damit "Weiterlaufen" nicht staendig nach 1-2
// Schritten in eine Sackgasse laeuft - dieselben Pakete, die schon beim
// Location-Pool-Ausbau als "dichte Stadt-Pakete" identifiziert wurden.
const WALK_BETA_MAPSETS = ['berlin', 'hamburg', 'paris', 'london', 'new-york'];

function renderMutators() {
  const isHost = state.role === 'host';
  const mutators = state.settings.mutators || {};
  el('mutator-list').querySelectorAll('.mutator-chip').forEach((chip) => {
    const active = Boolean(mutators[chip.dataset.mutator]);
    chip.classList.toggle('selected', active);
    chip.setAttribute('aria-checked', String(active));
    chip.disabled = !isHost;
  });

  const walkToggle = el('walk-beta-toggle');
  const walkActive = Boolean(mutators.walkBeta);
  walkToggle.classList.toggle('selected', walkActive);
  walkToggle.setAttribute('aria-checked', String(walkActive));
  walkToggle.disabled = !isHost;
}

// Eigene Funktion statt nur Teil von renderMutators()/renderLobby(): die
// Sichtbarkeit haengt vom AKTUELLEN Kartenpaket ab, das aber auch alleine per
// renderMapSetGrid() (Klick auf eine Kartenpaket-Karte) wechseln kann, ohne
// dass danach ein volles renderLobby() laeuft - ohne diesen zweiten Aufrufer
// bliebe die Gruppe nach einem Kartenpaket-Wechsel auf ihrem alten
// Sichtbarkeitsstand haengen.
function syncWalkBetaVisibility() {
  const isHeatmap = state.settings.mode === 'heatmap';
  el('walk-beta-group').classList.toggle('hidden', isHeatmap || !WALK_BETA_MAPSETS.includes(state.settings.mapSetId));
}

function renderLobby() {
  const isHost = state.role === 'host';
  const isSolo = !state.roomCode;
  const players = [...state.players.values()];

  // Battle Royale eliminiert Spieler - solo (nur man selbst) gibt es
  // niemanden zum Ausscheiden. Direkt zurueck auf Punkte-Duell statt eine
  // ungueltige Auswahl anzuzeigen; solo ist der Host immer sich selbst, die
  // Aenderung ist also rein lokal (kein controller.updateSettings() noetig).
  if (isSolo && state.settings.mode === 'battle-royale') {
    state.settings.mode = 'points';
  }

  el('lobby-heading').textContent = isSolo ? t('lobbyHeadingSolo') : t('lobbyHeadingWaiting');
  el('lobby-invite-card').classList.toggle('hidden', isSolo);
  el('lobby-room-code-row').classList.toggle('hidden', isSolo);
  el('lobby-players-panel').classList.toggle('hidden', isSolo);
  el('lobby-onboarding').classList.toggle('hidden', isSolo);
  el('lobby-onboarding-subtext').classList.toggle('hidden', isSolo);

  if (!isSolo) {
    el('lobby-room-code').textContent = state.roomCode || '—';
    const shareLink = `${location.origin}${location.pathname}#room=${state.roomCode}`;
    el('lobby-share-link').textContent = shareLink;
    renderOnboardingBanner(players.length);

    el('lobby-player-count').textContent = String(players.length);
    const listEl = el('lobby-player-list');
    listEl.innerHTML = '';
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const initial = (p.name || '?').trim().charAt(0).toUpperCase();
      const statusClass = !p.connected ? 'status-offline' : p.ready ? 'status-ready' : 'status-wait';
      const statusText = !p.connected ? t('statusDisconnected') : p.ready ? t('statusReady') : t('statusWaiting');
      row.innerHTML = `
        <div class="avatar" style="background:${p.color};">${initial}</div>
        <div class="player-name">${escapeHtml(p.name)} ${p.isHost ? `<span class="host-tag">${escapeHtml(t('hostTag'))}</span>` : ''}</div>
        <div class="status-pill ${statusClass}">${escapeHtml(statusText)}</div>
      `;
      listEl.appendChild(row);
    }
  }

  renderPresetRow();
  renderChoiceRow('choice-rounds', state.settings.roundCount);
  renderChoiceRow('choice-duration', state.settings.timeLimitMs);
  renderChoiceRow('choice-mode', state.settings.mode);
  renderChoiceRow('choice-modifier', state.settings.modifier);
  renderMutators();

  // Battle Royale nur anbieten, wenn ueberhaupt jemand ausscheiden koennte.
  document.querySelector('#choice-mode button[data-value="battle-royale"]')?.classList.toggle('hidden', isSolo);

  // Heatmap-Modus braucht kein Kartenpaket (keine Panoramen) und keine
  // Panorama-Steuerung - stattdessen eigene Regeln (Labels/Gegner-Info/
  // Spielablauf) und ein kurzer Hinweistext statt der Kartenpaket-Auswahl.
  const isHeatmap = state.settings.mode === 'heatmap';
  const isBattleRoyale = state.settings.mode === 'battle-royale';
  // Kartenpaket-Auswahl lebt jetzt in einem eigenen Modal (#mapset-modal,
  // siehe showMapSetModal()) statt einem permanenten Panel unter der Lobby -
  // im Heatmap-Modus (keine Panoramen, kein Kartenpaket noetig) einfach den
  // Aufruf-Button ausblenden statt eines ganzen Panels.
  el('btn-change-mappack').classList.toggle('hidden', isHeatmap);
  el('heatmap-settings-group').classList.toggle('hidden', !isHeatmap);
  el('panorama-controls-group').classList.toggle('hidden', isHeatmap);
  // Fog of War/Broken Compass/No-Pan sind reine Panorama-Mutatoren (steuern
  // Sichtbarkeit/Blickrichtung/Bewegungsfreiheit im 360°-Viewer) - im
  // kartenbasierten PulseMap-Modus gibt es keinen Panorama-Viewer, die
  // gesamte "Mutatoren"-Gruppe waere dort nur verwirrende, wirkungslose UI.
  el('mutator-settings-group').classList.toggle('hidden', isHeatmap);
  syncWalkBetaVisibility();
  renderModeSummary();
  // PRESETS (siehe dort) setzen alle stillschweigend mode:'points' -
  // ausserhalb von Punkte-Duell waere ein Preset-Klick ein unbemerkter
  // Moduswechsel. Schnellstart daher nur zeigen, wenn Punkte-Duell aktiv ist.
  el('preset-group').classList.toggle('hidden', state.settings.mode !== 'points');
  // Die Rundenzahl ergibt sich in diesem Modus automatisch aus der
  // Spielerzahl (siehe net/host.js startGame()) - der Runden-Wahlschalter
  // waere hier nur irrefuehrend.
  el('choice-rounds').closest('.setting-group').classList.toggle('hidden', isBattleRoyale);
  if (isHeatmap) {
    renderChoiceRow('choice-heatmap-labels', state.settings.heatmapLabels);
    renderChoiceRow('choice-heatmap-opponent-info', state.settings.heatmapOpponentInfo);
    renderChoiceRow('choice-heatmap-turn-mode', state.settings.heatmapTurnMode);
    renderChoiceRow('choice-heatmap-continent-hint', state.settings.heatmapContinentHint);
    el('heatmap-turnmode-note').textContent = t(HEATMAP_TURNMODE_NOTE_KEYS[state.settings.heatmapTurnMode] || '');
    renderLobbyStage();
  } else if (mapSetIndex.length) {
    renderMapSetGrid();
  }

  const readyBtn = el('btn-ready-toggle');
  const startBtn = el('btn-start-game');
  const hint = el('lobby-hint');

  if (isSolo) {
    readyBtn.hidden = true;
    startBtn.hidden = false;
    startBtn.disabled = false;
    hint.textContent = '';
  } else if (isHost) {
    readyBtn.hidden = true;
    startBtn.hidden = false;
    const others = players.filter((p) => !p.isHost);
    const allOthersReady = others.length > 0 && others.every((p) => p.ready && p.connected);
    startBtn.disabled = !allOthersReady;
    hint.textContent = allOthersReady
      ? t('hintReadyToStart')
      : others.length === 0
        ? t('hintWaitForPlayer')
        : t('hintWaitForReady');
  } else {
    readyBtn.hidden = false;
    startBtn.hidden = true;
    const me = state.players.get(state.self.id);
    readyBtn.textContent = me?.ready ? t('notReadyBtn') : t('readyBtn');
    hint.textContent = t('hintWaitForHost');
  }
  syncMobileLobbyCta(readyBtn, startBtn);

  updateConnectionBanner();
}

// Spiegelt Text/Sichtbarkeit/Disabled-Status von #btn-ready-toggle bzw.
// #btn-start-game (je nachdem, welcher gerade sichtbar ist) auf die
// zuverlaessig eingerastete Mobile-Kopie ausserhalb von .device (siehe
// Kommentar dort in index.html/styles.css). Klick-Weiterleitung selbst
// steht einmalig in wireLobbyControls().
function syncMobileLobbyCta(readyBtn, startBtn) {
  const mobileCta = el('mobile-lobby-cta');
  const active = !startBtn.hidden ? startBtn : !readyBtn.hidden ? readyBtn : null;
  mobileCta.classList.toggle('hidden', !active);
  if (!active) return;
  mobileCta.textContent = active.textContent.trim();
  mobileCta.disabled = active.disabled;
}

// Gleiche Bedingung wie fuer #btn-start-game in renderLobby() - der
// Direktstart per Kartenpaket-Cover-Klick darf nicht strenger/laxer sein
// als der normale "Match starten"-Button.
function canStartGame() {
  const isSolo = !state.roomCode;
  if (isSolo) return true;
  const others = [...state.players.values()].filter((p) => !p.isHost);
  return others.length > 0 && others.every((p) => p.ready && p.connected);
}

// seed ist optional - ohne wird (wie bisher) ein frischer Zufalls-Seed im
// HostController erzeugt. Tages-Challenge/Challenge-Links reichen hier
// stattdessen einen aus Datum bzw. Link abgeleiteten Seed durch, damit
// dieselbe Funktion fuer alle drei Startarten wiederverwendet werden kann.
// Live-Fortschritt waehrend HostController.startGame() die ersten Runden
// streamt (siehe net/host.js) - ersetzt den frueheren statischen "Kartenpaket
// wird geladen…"-Text durch eine echte Fortschrittsanzeige, die sich fuellt,
// sobald neue Runden eintreffen, und verschwindet, sobald das Spiel startet
// (der Rest laedt dann unsichtbar im Hintergrund weiter).
function renderLoadProgress({ found, target } = {}) {
  if (found == null || target == null) return;
  // Der Host laedt nach dem Spielstart im Hintergrund weiter (siehe
  // _continueStreamingRounds() in host.js) und feuert dabei WEITER
  // ui:map-resolving - das soll die Lobby-UI, die der Spieler laengst
  // verlassen hat, nicht mehr wieder einblenden.
  if (!document.getElementById('screen-lobby').classList.contains('active')) return;
  el('lobby-hint').textContent = '';
  const bar = el('lobby-load-progress');
  bar.classList.remove('hidden');
  const pct = target > 0 ? Math.min(100, Math.round((found / target) * 100)) : 0;
  el('lobby-load-progress-fill').style.width = `${pct}%`;
  el('lobby-load-progress-label').textContent = t('hintSearchingPanoramas', { found, target });
}

function hideLoadProgress() {
  el('lobby-load-progress').classList.add('hidden');
}

async function startGameFromLobby(seed) {
  sound.playClick();
  const startBtn = el('btn-start-game');
  startBtn.disabled = true;
  const hint = el('lobby-hint');
  const previousHint = hint.textContent;
  try {
    if (state.settings.mode === 'heatmap') {
      // Heatmap-Modus braucht kein Kartenpaket - siehe HostController.startGame()/_startHeatmapGame().
      await controller.startGame(null, seed);
      return;
    }
    hint.textContent = t('hintLoadingMapset');
    const detail = await getMapSetDetail(state.settings.mapSetId);
    activeMapSetDetail = detail;
    await controller.startGame(detail, seed);
  } catch (err) {
    console.error(err);
    hint.textContent = previousHint;
    hideLoadProgress();
    startBtn.disabled = false;
    showToast(t('toastMapsetLoadFailed'));
  }
}

function wireLobbyControls() {
  attachHoverSound(el('btn-ready-toggle'));
  el('btn-ready-toggle').addEventListener('click', () => {
    sound.playClick();
    const me = state.players.get(state.self.id);
    controller.setReady(!me?.ready);
  });

  // Mobile Sticky-Bottom-Kopie (siehe syncMobileLobbyCta()) leitet einfach an
  // den gerade sichtbaren echten Button weiter, statt Klick-Logik zu duplizieren.
  el('mobile-lobby-cta').addEventListener('click', () => {
    const startBtn = el('btn-start-game');
    (startBtn.hidden ? el('btn-ready-toggle') : startBtn).click();
  });

  attachRipple(el('btn-start-game'));
  attachHoverSound(el('btn-start-game'));
  // NICHT direkt startGameFromLobby als Listener registrieren: addEventListener
  // ruft Handler mit dem Klick-Event als erstem Argument auf, das landete sonst
  // ungewollt im optionalen seed-Parameter. mulberry32(seed) macht "seed >>> 0"
  // (ToUint32) - fuer ein Objekt ist das immer NaN >>> 0 = 0, jedes normal
  // gestartete Spiel (Tages-Challenge/Challenge-Link reichen ihren Seed separat
  // an anderer Stelle durch) landete also bei genau demselben Seed 0 statt bei
  // einem echten Zufalls-Seed - der gemeldete Bug "Heatmap startet jedes Mal mit
  // demselben Land": mulberry32(0) ist deterministisch, jede Partie zog dieselbe
  // "zufaellige" Sequenz.
  el('btn-start-game').addEventListener('click', () => startGameFromLobby());

  const wireChoiceRow = (rowId, settingKey, parse) => {
    el(rowId).querySelectorAll('button').forEach((btn) => {
      attachRipple(btn);
      attachHoverSound(btn);
      btn.addEventListener('click', () => {
        if (state.role !== 'host') return;
        sound.playClick();
        const value = parse(btn.dataset.value);
        controller.updateSettings({ [settingKey]: value });
        renderLobby();
      });
    });
  };
  wireChoiceRow('choice-rounds', 'roundCount', (v) => Number(v));
  wireChoiceRow('choice-duration', 'timeLimitMs', (v) => (v === 'null' ? null : Number(v)));

  // Eigene Wireing statt wireChoiceRow(): der Moduswechsel selbst braucht
  // einen Seiteneffekt auf eine ANDERE Einstellung (siehe
  // applyHeatmapModeDefaults() oben) - "unbegrenzte Zeit" als Default beim
  // Wechsel INS PulseMap hinein (Nutzer-Feedback), nicht nur die
  // heatmap-eigenen Einstellungen wie heatmapOpponentInfo (dessen Default
  // schon in state.js selbst auf 'best' steht, da nie von anderen Modi
  // genutzt).
  el('choice-mode').querySelectorAll('button').forEach((btn) => {
    attachRipple(btn);
    attachHoverSound(btn);
    btn.addEventListener('click', () => {
      if (state.role !== 'host') return;
      sound.playClick();
      const newMode = btn.dataset.value;
      const patch = { mode: newMode };
      if (newMode === 'heatmap' && state.settings.mode !== 'heatmap') {
        patch.timeLimitMs = null;
      }
      controller.updateSettings(patch);
      renderLobby();
    });
  });
  wireChoiceRow('choice-modifier', 'modifier', (v) => v);
  wireChoiceRow('choice-heatmap-labels', 'heatmapLabels', (v) => v);
  wireChoiceRow('choice-heatmap-opponent-info', 'heatmapOpponentInfo', (v) => v);
  wireChoiceRow('choice-heatmap-turn-mode', 'heatmapTurnMode', (v) => v);
  wireChoiceRow('choice-heatmap-continent-hint', 'heatmapContinentHint', (v) => v);

  el('mutator-list').querySelectorAll('.mutator-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      if (state.role !== 'host') return;
      sound.playClick();
      const key = chip.dataset.mutator;
      const current = state.settings.mutators || {};
      // updateSettings() macht ein flaches Object.assign - ein verschachteltes
      // Feld muss also komplett (nicht nur der eine Schluessel) mitgeschickt
      // werden, sonst gingen die anderen zwei Mutatoren beim Umschalten verloren.
      controller.updateSettings({ mutators: { ...current, [key]: !current[key] } });
      renderLobby();
    });
  });

  el('walk-beta-toggle').addEventListener('click', () => {
    if (state.role !== 'host') return;
    sound.playClick();
    const current = state.settings.mutators || {};
    controller.updateSettings({ mutators: { ...current, walkBeta: !current.walkBeta } });
    renderLobby();
  });

  el('mapset-search-input').addEventListener('input', (e) => {
    mapSetSearchTerm = e.target.value;
    renderMapSetGrid();
  });
  el('mapset-chips').querySelectorAll('.mapset-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      sound.playClick();
      mapSetFilterTag = chip.dataset.tag;
      el('mapset-chips').querySelectorAll('.mapset-chip').forEach((c) => c.classList.toggle('selected', c === chip));
      renderMapSetGrid();
    });
  });

  initSettingsAccordion();
}

/** Mobile-Accordion fuer die Lobby-Einstellungsgruppen (Runden/Dauer/Modus/
 * Panorama-Steuerung/Mutatoren, sowie im PulseMap-Modus als ein Block die
 * vier heatmap-eigenen Einstellungen) - vorher waren auf Mobile ALLE Gruppen
 * permanent ausgeklappt, die Lobby wurde dadurch mehrere Bildschirmhoehen
 * lang, bevor ueberhaupt "Match starten" in Sicht kam (Audit-Punkt
 * "kompaktes Accordion/Grid"). Rein CSS-getriebenes Ein-/Ausklappen per
 * .collapsed-Klasse (siehe styles.css) - hier nur der Klick-Toggle und der
 * EINMALIGE Default-Zustand beim ersten Lobby-Eintritt. Bewusst NICHT in
 * renderLobby() (das bei jeder Einstellungsaenderung erneut laeuft) gesetzt,
 * sonst wuerde eine gerade vom Spieler aufgeklappte Gruppe beim naechsten
 * Tipp in einer ANDEREN Gruppe wieder eingeklappt. */
// Betrifft seit der Wizard-Umstrukturierung nur noch die zwei direkten
// Kind-Gruppen von #lobby-settings-panel (Presets, Modus) - Runden/Dauer/
// Panorama/Mutatoren stecken jetzt in #rules-accordion, das selbst schon per
// Default eingeklappt ist (siehe initRulesAccordion()). Kein zusaetzliches
// Auto-Einklappen der Presets/Modus-Gruppe mehr auf Mobile (frueher hier
// noetig, um die Seitenhoehe zu begrenzen - der urspruengliche Grund dafuer
// ist mit der Regel-Klappe + dem Kartenpaket-Modal (statt einer immer
// sichtbaren Liste) bereits geloest). Der manuelle Klick-zum-Einklappen-
// Mechanismus selbst bleibt fuer diese zwei Gruppen erhalten.
function initSettingsAccordion() {
  const groups = el('lobby-settings-panel').querySelectorAll(':scope > .setting-group');
  groups.forEach((group) => {
    group.querySelectorAll(':scope > .setting-group-label').forEach((label) => {
      label.addEventListener('click', () => {
        sound.playClick();
        group.classList.toggle('collapsed');
      });
    });
  });
}

// ---------------------------------------------------------------- hud

// Zeigt jeweils den Stil, in den ein Klick wechseln WUERDE (wie z.B. bei
// Google Maps ueblich), nicht den gerade aktiven.
function updateMapStyleLabel(labelId, currentStyle) {
  const label = el(labelId);
  // Stil am Element hinterlegen, damit refreshDynamicI18n() das Label nach
  // einem Sprachwechsel neu beschriften kann, ohne die Karte selbst zu kennen.
  label.dataset.style = currentStyle;
  label.textContent = currentStyle === 'satellite' ? t('mapStyleMap') : t('mapStyleSatellite');
}

// Battle Royale: ausgeschiedene Spieler sind reine Zuschauer - der Host
// ignoriert ihre Tipps ohnehin (siehe net/host.js _handleGuess()), das UI
// laesst sie erst gar nicht tippen.
function isSelfEliminated() {
  return state.settings.mode === 'battle-royale' && state.eliminatedAtRound.has(state.self.id);
}

function ensureHudWidgets() {
  if (!panoViewer) panoViewer = new PanoViewer('pano-container');
  if (!guessMap) {
    guessMap = new GuessMap(el('guess-map-container'), () => {
      if (isSelfEliminated()) return;
      sound.playPinSet();
      haptics.tapLight();
      const btn = el('btn-confirm-guess');
      btn.disabled = false;
      btn.classList.add('ready');
    });
    updateMapStyleLabel('minimap-style-label', guessMap.tiles.style);
  }
}

function renderRoundProgress() {
  const container = el('round-progress');
  container.innerHTML = '';
  for (let i = 0; i < state.round.total; i++) {
    const seg = document.createElement('div');
    seg.className = 'round-progress-seg';
    if (i < state.round.index) seg.classList.add('filled');
    else if (i === state.round.index) seg.classList.add('current');
    seg.innerHTML = '<i></i>';
    container.appendChild(seg);
  }
}

// Zuletzt GERENDERTER eigener HP-Wert. renderHpBars() baut die Leisten jedes
// Mal komplett neu aus state.hp auf und kann den Verlust deshalb nicht aus dem
// DOM ablesen - ohne dieses Gedaechtnis gaebe es kein Ereignis, an dem sich
// "gerade Schaden bekommen" festmachen liesse. null = noch nichts gerendert
// (erste Runde), dann ist der Wert ein Startwert und kein Verlust.
let lastOwnHp = null;

function renderHpBars() {
  const container = el('hp-bars');
  if (state.settings.mode !== 'hp') {
    container.classList.add('hidden');
    lastOwnHp = null;
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '';

  const ownHp = state.hp.get(state.self.id) ?? 6000;
  if (lastOwnHp !== null && ownHp < lastOwnHp) {
    shakeScreen();
    haptics.tapStrong();
  }
  lastOwnHp = ownHp;

  for (const p of state.players.values()) {
    const hp = state.hp.get(p.id) ?? 6000;
    const row = document.createElement('div');
    row.className = 'hp-bar-row';
    row.innerHTML = `
      <span class="hp-bar-name">${escapeHtml(p.name)}</span>
      <span class="hp-bar-track"><span class="hp-bar-fill" style="width:${(hp / 6000) * 100}%; background:${hp <= 0 ? 'var(--danger)' : ''}"></span></span>
      <span class="hp-bar-value">${hp}</span>
    `;
    container.appendChild(row);
  }
}

// ---------------------------------------------------------------- Heatmap-Modus

// Kurzer Erklaertext unter dem Spielablauf-Wahlschalter (siehe renderLobby())
// - drei aehnlich klingende "Gleichzeitig"/"Abwechselnd"-Optionen brauchen
// eine Zeile Kontext, welches Sieg-Kriterium jeweils gilt. Text kommt aus
// core/i18n.js, damit er mit der UI-Sprache mitwechselt.
const HEATMAP_TURNMODE_NOTE_KEYS = {
  efficiency: 'turnModeNoteEfficiency',
  simultaneous: 'turnModeNoteRace',
  turns: 'turnModeNoteTurns',
};

/**
 * Kurzlebiger expandierender Ring an einer Bildschirmposition ("Radar-Ping")
 * fuer den exakten Treffer - ein simples DOM-Element statt Canvas-Partikeln
 * (siehe ui/particles.js burst() fuer den begleitenden Konfetti-Effekt),
 * weil ein einzelner CSS-animierter Kreis dafuer voellig ausreicht. Raeumt
 * sich nach der Animation selbst wieder auf (animationend), damit sich bei
 * mehreren Runden keine Leichen im DOM ansammeln.
 */
function spawnRadarPing(x, y) {
  if (x == null || y == null) return;
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const ping = document.createElement('div');
  ping.className = 'radar-ping';
  ping.style.left = `${x}px`;
  ping.style.top = `${y}px`;
  document.body.appendChild(ping);
  ping.addEventListener('animationend', () => ping.remove(), { once: true });
}

/** Battle-Royale-Elimination-Vignette (siehe .elimination-flash in
 * styles.css) - statisches, immer im DOM vorhandenes Overlay statt eines
 * pro-Aufruf erzeugten Elements wie spawnRadarPing(), weil es immer
 * denselben vollflaechigen Bereich abdeckt. Reflow-Trigger-Muster wie
 * .guess-pulse/.pop an anderer Stelle, damit zwei Eliminations-Events kurz
 * hintereinander (bei mehreren Gleichstand-Verlierern derselben Runde) die
 * Animation jeweils neu von vorne starten. */
function spawnEliminationFlash() {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  const flash = el('elimination-flash');
  flash.classList.remove('active');
  void flash.offsetWidth;
  flash.classList.add('active');
}

/** Aufprall-Erschuetterung (siehe .shake-hit in styles.css). hard=true fuer
 * die eigene Elimination, sonst ein normaler Treffer.
 *
 * Zielt auf dem HUD auf .pano, damit nur das Bild wackelt und die Anzeigen
 * darueber ruhig stehen bleiben. Auf allen anderen Screens (die Elimination
 * wird z. B. erst im Rundenergebnis gezeigt, wo .pano gar nicht sichtbar ist)
 * uebernimmt .device als sichtbarer Rahmen - ohne diese Fallunterscheidung
 * wuerde dort ein unsichtbares Element wackeln.
 *
 * Reflow-Trigger-Muster wie bei spawnEliminationFlash()/.guess-pulse, damit
 * zwei Treffer kurz hintereinander die Animation jeweils neu starten. */
function shakeScreen({ hard = false } = {}) {
  const onHud = el('screen-hud').classList.contains('active');
  const target = document.querySelector(onHud ? '.pano' : '.device');
  if (!target) return;
  target.classList.remove('shake-hit', 'shake-hard');
  void target.offsetWidth;
  target.classList.add('shake-hit');
  if (hard) target.classList.add('shake-hard');
  target.addEventListener(
    'animationend',
    () => target.classList.remove('shake-hit', 'shake-hard'),
    { once: true }
  );
}

function shakeHeatmapSearchBox() {
  const box = el('heatmap-search-box');
  box.classList.remove('shake');
  // Reflow erzwingen, damit die Animation bei zwei Fehleingaben direkt
  // hintereinander erneut von vorne startet, statt (weil dieselbe Klasse ja
  // schon gesetzt war) einfach gar nicht neu zu triggern.
  void box.offsetWidth;
  box.classList.add('shake');
}

let heatmapMap = null;
let countryStore = null;
let heatmapTimerInterval = null;
let heatmapGuessedThisRound = new Set(); // countryId - verhindert wiederholtes Antippen desselben Vorschlags
let heatmapSuggestionIndex = -1;
let heatmapOwnGuesses = []; // [{name, distanceKm}] - fuer das Top-3-Panel, pro Runde neu
let heatmapOpponentRecordKm = null; // heatmapOpponentInfo==='best': bisher bester GEGNER-Wert dieser Runde
let heatmapActiveTurnPlayerId = null; // heatmapTurnMode==='turns': wer gerade dran ist, sonst null
let heatmapDisplayedScore = 0; // fuer den animierten Hochzaehl-Effekt in renderHeatmapScore() - der zuletzt AUF DEM SCREEN gezeigte Wert, nicht zwingend state.scores' aktueller Wert waehrend die Animation noch laeuft

async function ensureHeatmapWidgets() {
  const labels = state.settings.heatmapLabels !== 'off';
  if (!heatmapMap) heatmapMap = new HeatmapMap(el('heatmap-map-container'), { labels });
  else heatmapMap.setLabels(labels); // Einstellung kann sich zwischen zwei Partien in derselben Session geaendert haben
  if (!countryStore) countryStore = await ensureCountryStore();
  // displayName statt hartcodiertem nameDe an heatmap-map.js uebergeben -
  // die Kartenbeschriftung soll mit der UI-Sprache mitwechseln, aber
  // heatmap-map.js selbst bleibt bewusst i18n-unabhaengig (reines
  // Kartenmodul, siehe dortiger Kommentar).
  heatmapMap.setCountries(countryStore.countries.map((c) => ({ ...c, displayName: countryDisplayName(c) })));
}

function heatmapPlayerName(peerId) {
  return state.players.get(peerId)?.name || t('defaultOpponentName');
}

function clearHeatmapTimer() {
  clearInterval(heatmapTimerInterval);
  heatmapTimerInterval = null;
  // Einziger Choke-Point: wird sowohl bei natuerlichem Rundenende (Timer
  // laeuft ab, siehe update() unten) als auch bei vorzeitigem Ende (Treffer,
  // siehe renderHeatmapRoundResult()) aufgerufen - Ambience stoppt so in
  // beiden Faellen zuverlaessig, ohne den Aufruf doppelt pflegen zu muessen.
  sound.stopRoundAmbience();
}

// War fuer PulseMap gar nicht angeschlossen, obwohl startRoundAmbience()/
// setRoundTension() bereits vollstaendig fuer den klassischen Panorama-HUD-
// Timer existieren (siehe dort) - PulseMap-Runden hatten dadurch nie
// Zeitdruck-Ambience. Identisches Muster, nur an renderHeatmapTimer() statt
// am HUD-Timer angeschlossen.
const HEATMAP_TENSION_WINDOW_S = 10;

function renderHeatmapTimer() {
  const el2 = el('heatmap-timer');
  if (state.round.timeLimitMs == null) {
    el2.textContent = '';
    return;
  }
  const update = () => {
    const remainingMs = state.round.startTimestamp + state.round.timeLimitMs - Date.now();
    const remainingS = Math.max(0, Math.ceil(remainingMs / 1000));
    el2.textContent = `${remainingS}s`;
    const tension = 1 - Math.max(0, Math.min(HEATMAP_TENSION_WINDOW_S, remainingMs / 1000)) / HEATMAP_TENSION_WINDOW_S;
    sound.setRoundTension(tension);
    if (remainingMs <= 0) clearHeatmapTimer();
  };
  // Reihenfolge wichtig: clearHeatmapTimer() stoppt jetzt auch die Ambience
  // (siehe dortiger Kommentar) - muss also VOR startRoundAmbience() laufen,
  // sonst wuerde die gerade gestartete Ambience durch den Aufraeum-Schritt
  // sofort wieder abgewuergt.
  clearHeatmapTimer();
  sound.startRoundAmbience();
  update();
  heatmapTimerInterval = setInterval(update, 250);
}

async function renderHeatmapRoundStart() {
  showScreen('heatmap');
  await ensureHeatmapWidgets();
  heatmapMap.reset();
  heatmapMap.invalidate();
  heatmapGuessedThisRound = new Set();
  heatmapSuggestionIndex = -1;
  heatmapOwnGuesses = [];
  heatmapOpponentRecordKm = null;
  heatmapActiveTurnPlayerId = null;
  if (state.round.index === 0) {
    recordHeatmapGameStarted();
    heatmapDisplayedScore = 0;
  }
  renderHeatmapScore({ animate: false });

  el('heatmap-round-index').textContent = String(state.round.index + 1).padStart(2, '0');
  el('heatmap-round-total').textContent = String(state.round.total).padStart(2, '0');
  el('heatmap-activity-feed').innerHTML = '';
  el('heatmap-result-banner').classList.add('hidden');
  el('heatmap-top3-panel').classList.add('hidden');
  el('heatmap-top3-list').innerHTML = '';
  el('heatmap-opponent-record').classList.add('hidden');
  el('heatmap-turn-status').classList.add('hidden');
  el('heatmap-search-box').classList.remove('locked');
  const input = el('heatmap-search-input');
  input.value = '';
  input.disabled = false;
  el('heatmap-suggestions').classList.add('hidden');
  renderHeatmapGuessCounter({ pop: false });
  renderHeatmapTimer();
  requestAnimationFrame(() => input.focus());
}

function renderHeatmapTop3() {
  const list = el('heatmap-top3-list');
  const panel = el('heatmap-top3-panel');
  if (heatmapOwnGuesses.length === 0) {
    panel.classList.add('hidden');
    return;
  }
  panel.classList.remove('hidden');
  const top3 = [...heatmapOwnGuesses].sort((a, b) => a.distanceKm - b.distanceKm).slice(0, 3);
  list.innerHTML = top3
    .map(
      (g, i) =>
        `<li><span class="rank">${i + 1}.</span><span class="name">${escapeHtml(g.name)}</span><span class="dist">${Math.round(g.distanceKm).toLocaleString(numberLocale())} km</span>${g.proximity === 'neighbor' ? `<span class="proximity-badge neighbor">${escapeHtml(t('neighborBadge'))}</span>` : ''}</li>`
    )
    .join('');
}

/** heatmapOpponentInfo==='best': aktualisiert das pulsierende "Gegner-Rekord"-Widget. */
function renderHeatmapOpponentRecord(recordKm) {
  heatmapOpponentRecordKm = recordKm;
  const widget = el('heatmap-opponent-record');
  widget.classList.remove('hidden');
  el('heatmap-opponent-record-text').textContent = `Gegner-Rekord: ${Math.round(recordKm).toLocaleString(numberLocale())} km`;
}

/** heatmapTurnMode==='turns': sperrt/entsperrt das Suchfeld je nachdem, wer dran ist. */
// heatmapTurnMode==='efficiency': der lokale Spieler hat exakt getroffen,
// die Runde laeuft aber fuer die anderen weiter (siehe HEATMAP_SOLVED_WAITING
// in protocol.js). Sperrt das Suchfeld wie im Taktik-Modus (dasselbe
// #heatmap-turn-status-Element, hier nur mit anderem Text) statt eines
// eigenen neuen UI-Elements.
function renderHeatmapSolvedWaiting({ attempts }) {
  el('heatmap-search-input').disabled = true;
  el('heatmap-search-box').classList.add('locked');
  const status = el('heatmap-turn-status');
  status.classList.remove('hidden');
  status.textContent = t('solvedWaiting', { attempts, attemptsUnit: t(attempts === 1 ? 'attemptUnitOne' : 'attemptUnitMany') });
}

function renderHeatmapTurnUpdate({ activePlayerId }) {
  heatmapActiveTurnPlayerId = activePlayerId;
  const isMyTurn = activePlayerId === state.self.id;
  const input = el('heatmap-search-input');
  const status = el('heatmap-turn-status');
  input.disabled = !isMyTurn;
  el('heatmap-search-box').classList.toggle('locked', !isMyTurn);
  if (isMyTurn) {
    status.classList.add('hidden');
    if (document.activeElement !== input) input.focus();
  } else {
    status.classList.remove('hidden');
    status.textContent = t('turnStatusWaiting', { name: heatmapPlayerName(activePlayerId) });
  }
}

// War ein dauerhaft anwachsender Log unten rechts (bis zu 12, dann 6
// Zeilen) - Nutzerfeedback: wirkte "zu prominent und gross", stapelte sich
// vor die Karte statt als kurze Statusmeldung zu wirken. Jetzt einzelne,
// selbst-ausblendende Toasts oben rechts (siehe .heatmap-activity-feed in
// styles.css) statt eines dauerhaften Stapels.
const HEATMAP_TOAST_MAX_VISIBLE = 3;
const HEATMAP_TOAST_DISMISS_MS = 2600;
const HEATMAP_TOAST_DISMISS_MS_EXACT = 3600; // exakte Treffer duerfen etwas laenger sichtbar bleiben

function heatmapActivityLine(text, tone = '') {
  const feed = el('heatmap-activity-feed');
  const line = document.createElement('div');
  line.className = `heatmap-activity-line${tone ? ` ${tone}` : ''}`;
  line.textContent = text;
  feed.prepend(line);
  while (feed.children.length > HEATMAP_TOAST_MAX_VISIBLE) feed.removeChild(feed.lastChild);

  const dismissMs = tone === 'exact' ? HEATMAP_TOAST_DISMISS_MS_EXACT : HEATMAP_TOAST_DISMISS_MS;
  setTimeout(() => {
    line.classList.add('leaving');
    line.addEventListener('transitionend', () => line.remove(), { once: true });
  }, dismissMs);
}

function renderHeatmapGuessResult({ countryId, distanceKm, exact, proximity }) {
  heatmapMap?.colorCountry(countryId, getColorForDistance(distanceKm, exact), proximity);
  const country = countryStore?.byId.get(countryId);
  const name = country ? countryDisplayName(country) : countryId;
  if (exact) {
    heatmapActivityLine(`Volltreffer! ${name} war richtig.`, 'exact');
  } else if (proximity === 'neighbor') {
    heatmapActivityLine(`${name}: ${proximityLabel('neighbor')} (${Math.round(distanceKm).toLocaleString(numberLocale())} km)`, 'neighbor');
  } else if (proximity === 'continent') {
    heatmapActivityLine(`${name}: ${proximityLabel('continent')}, aber noch ${Math.round(distanceKm).toLocaleString(numberLocale())} km entfernt`);
  } else {
    heatmapActivityLine(`${name}: ${Math.round(distanceKm).toLocaleString(numberLocale())} km entfernt`);
  }
  heatmapOwnGuesses.push({ name, distanceKm, proximity });
  renderHeatmapTop3();
  renderHeatmapGuessCounter({ pop: true });
}

/** Kleines Glass-Badge neben dem Suchfeld: zaehlt die eigenen Tipps der
 * aktuellen Runde (heatmapOwnGuesses, siehe renderHeatmapGuessResult() oben).
 * Nur fuer den Heatmap-Modus relevant - #heatmap-guess-counter existiert nur
 * in #screen-heatmap, in keinem anderen Spielmodus, wird also von Punkte-/
 * HP-Duell/Battle-Royale nie beruehrt. pop:true triggert den kurzen
 * Scale-Pop (siehe .heatmap-guess-counter-value.pop in styles.css) bei jedem
 * neuen Tipp - reset (Rundenstart) soll dagegen lautlos auf 0 zurueckspringen. */
function renderHeatmapGuessCounter({ pop = false } = {}) {
  const value = el('heatmap-guess-counter-value');
  const unit = el('heatmap-guess-counter-unit');
  const count = heatmapOwnGuesses.length;
  value.textContent = String(count);
  unit.textContent = t(count === 1 ? 'attemptUnitOne' : 'attemptUnitMany');
  if (pop) {
    value.classList.remove('pop');
    void value.offsetWidth; // Reflow erzwingen, siehe shakeHeatmapSearchBox()/guess-pulse fuer dasselbe Muster
    value.classList.add('pop');
  }
}

// Payload-Form haengt von heatmapOpponentInfo ab (siehe net/host.js
// _handleHeatmapGuess()): 'all' liefert {peerId, distanceKm, exact} pro
// Tipp, 'best' liefert nur bei einer Verbesserung {recordKm, exact} ohne
// peerId. 'blind' sendet gar keine ui:heatmap-activity-Events.
function renderHeatmapActivity(payload) {
  if ('recordKm' in payload) {
    if (payload.exact) {
      heatmapActivityLine('Ein Gegner hat das Zielland gefunden!', 'exact');
    } else {
      renderHeatmapOpponentRecord(payload.recordKm);
    }
    return;
  }
  const { peerId, distanceKm, exact, proximity } = payload;
  if (peerId === state.self.id) return; // eigene Tipps kommen ueber ui:heatmap-guess-result mit Details
  const name = heatmapPlayerName(peerId);
  if (exact) heatmapActivityLine(`${name} hat das Zielland gefunden!`, 'exact');
  else if (proximity === 'neighbor') heatmapActivityLine(`${name} tippt … Nachbarland! (${Math.round(distanceKm).toLocaleString(numberLocale())} km)`, 'peer neighbor');
  else heatmapActivityLine(`${name} tippt … (${Math.round(distanceKm).toLocaleString(numberLocale())} km entfernt)`, 'peer');
}

/** Live-Punktestand-Badge im Header (#heatmap-score-badge, nur innerhalb von
 * #screen-heatmap im Markup vorhanden - siehe dortiger Kommentar in
 * styles.css zur Isolation). state.scores wird auf Host UND Client bei jedem
 * MSG.HEATMAP_WIN identisch aktualisiert (siehe net/host.js
 * _finishHeatmapRound() bzw. net/client.js), .total ist also auf beiden
 * Seiten zuverlaessig der aktuelle Gesamtstand.
 * animate:false (Rundenstart) setzt den Wert nur lautlos, animate:true
 * (nach einem Rundenergebnis) zaehlt sichtbar von alt auf neu hoch und
 * triggert den gruenen Scale-Pop (.heatmap-score-value.pop, styles.css) -
 * bei unveraendertem Wert (0 Punkte in dieser Runde) bleibt beides aus,
 * ein Hochzaehlen von X auf X waere nur unnoetiges visuelles Rauschen. */
function renderHeatmapScore({ animate = false } = {}) {
  const valueEl = el('heatmap-score-value');
  const target = state.scores.get(state.self.id)?.total ?? 0;
  if (!animate || target === heatmapDisplayedScore) {
    heatmapDisplayedScore = target;
    valueEl.textContent = String(target);
    return;
  }
  const from = heatmapDisplayedScore;
  const delta = target - from;
  const durationMs = 500;
  const startedAt = performance.now();
  valueEl.classList.remove('pop');
  void valueEl.offsetWidth; // Reflow erzwingen, siehe .guess-pulse/.pop fuer dasselbe Muster an anderer Stelle
  valueEl.classList.add('pop');
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / durationMs);
    const eased = 1 - (1 - progress) ** 3; // ease-out-cubic - schnell los, sanft eingebremst
    valueEl.textContent = String(Math.round(from + delta * eased));
    if (progress < 1) requestAnimationFrame(step);
    else heatmapDisplayedScore = target;
  };
  requestAnimationFrame(step);
}

function renderHeatmapRoundResult({ winnerPlayerId, target, results }) {
  clearHeatmapTimer();
  el('heatmap-search-input').disabled = true;
  el('heatmap-suggestions').classList.add('hidden');
  heatmapMap?.colorCountry(target.id, getColorForDistance(0, true), 'exact');

  const banner = el('heatmap-result-banner');
  const title = el('heatmap-result-title');
  const sub = el('heatmap-result-sub');
  const targetCountry = countryStore?.byId.get(target.id);
  const attemptsUnit = (n) => t(n === 1 ? 'attemptUnitOne' : 'attemptUnitMany');

  if (state.settings.heatmapTurnMode === 'efficiency') {
    // Sieg = wenigste Zuege (siehe net/host.js _endHeatmapEfficiencyRound()) -
    // winnerPlayerId allein reicht hier nicht, weil bei einem echten
    // Gleichstand MEHRERE Spieler gleichzeitig "won" sein koennen (nur der
    // Tempo-Bonus geht an eine einzelne Person) - massgeblich ist der eigene
    // Eintrag in results.
    const mine = results?.find((r) => r.playerId === state.self.id);
    const won = mine?.won ?? false;
    title.classList.toggle('won', won);
    if (!mine || mine.attempts == null) {
      title.textContent = t('resultNotFound');
    } else if (won) {
      title.textContent = t(mine.bonus ? 'resultBestScoreBonus' : 'resultBestScore', {
        attempts: mine.attempts,
        attemptsUnit: attemptsUnit(mine.attempts),
      });
    } else {
      const bestAttempts = Math.min(...results.filter((r) => r.attempts != null).map((r) => r.attempts));
      title.textContent = t('resultSolvedNotBest', { attempts: mine.attempts, attemptsUnit: attemptsUnit(mine.attempts), best: bestAttempts });
    }
    if (won) {
      recordHeatmapSolve(mine.attempts);
      const anchor = targetCountry && heatmapMap ? heatmapMap.containerPointFor(targetCountry.lat, targetCountry.lng) : {};
      particleBurst({ ...anchor, colors: ['#39ff8f', '#17ecff', '#ff1fb0'] });
      spawnRadarPing(anchor.x, anchor.y);
      haptics.tapStrong();
    }
  } else if (winnerPlayerId) {
    const won = winnerPlayerId === state.self.id;
    title.textContent = won ? t('resultExact') : t('resultFastest', { name: heatmapPlayerName(winnerPlayerId) });
    title.classList.toggle('won', won);
    if (won) {
      recordHeatmapSolve(heatmapOwnGuesses.length);
      // Ursprung am Zielland selbst statt Bildschirmmitte, wenn dessen
      // Position bekannt ist (countryStore ist zu diesem Zeitpunkt immer
      // schon geladen, siehe ensureHeatmapWidgets()) - "geht vom Land aus"
      // statt eines generischen Vollbild-Effekts.
      const anchor = targetCountry && heatmapMap ? heatmapMap.containerPointFor(targetCountry.lat, targetCountry.lng) : {};
      particleBurst({ ...anchor, colors: ['#39ff8f', '#17ecff', '#ff1fb0'] });
      spawnRadarPing(anchor.x, anchor.y);
      haptics.tapStrong();
    }
  } else {
    title.textContent = t('resultTimeUp');
    title.classList.remove('won');
  }
  sub.textContent = t('resultTargetLabel', { name: targetCountry ? countryDisplayName(targetCountry) : target.name });
  banner.classList.remove('hidden');

  // Nur anzeigen, wenn diese Runde ueberhaupt eigene Tipps hatte - ein
  // leeres Quadrat-Raster (z.B. bei Zeitablauf ohne einen einzigen Tipp)
  // waere ein sinnloser Share.
  el('heatmap-share-btn').classList.toggle('hidden', heatmapOwnGuesses.length === 0);
  renderHeatmapScore({ animate: true });
}

// Farbquadrate wie beim Wordle-Share: dieselbe Distanz-Skala wie die
// Kartenfaerbung (getDistanceLevel(), core/heatmap-color.js), nur als Emoji
// statt Fuellfarbe - verraet nichts ueber das Zielland selbst, nur den
// eigenen Rateverlauf, genau wie Wordles gruene/gelbe Kaestchen nie den
// gesuchten Begriff zeigen.
const HEATMAP_SHARE_EMOJI = { exact: '🟩', near: '🟥', mid: '🟧', far: '🟨', cold: '🟦' };

function buildHeatmapShareText() {
  const squares = heatmapOwnGuesses
    .map((g) => HEATMAP_SHARE_EMOJI[getDistanceLevel(g.distanceKm, g.proximity === 'exact')])
    .join('');
  const solved = heatmapOwnGuesses.some((g) => g.proximity === 'exact');
  const attemptsLabel = solved
    ? `${heatmapOwnGuesses.length} ${heatmapOwnGuesses.length === 1 ? 'Tipp' : 'Tipps'} bis zum Treffer`
    : 'nicht gefunden';
  return [
    `PulseMap – Runde ${state.round.index + 1}/${state.round.total}`,
    `${squares} (${attemptsLabel})`,
    `${location.origin}${location.pathname}`,
  ].join('\n');
}

function renderHeatmapSuggestions(query) {
  const box = el('heatmap-suggestions');
  heatmapSuggestionIndex = -1;
  if (!countryStore || !query.trim()) {
    box.classList.add('hidden');
    box.innerHTML = '';
    return;
  }
  const matches = searchCountries(countryStore, query, 8);
  box.classList.toggle('hidden', matches.length === 0);
  box.innerHTML = matches
    .map(
      (c, i) =>
        `<button type="button" class="heatmap-suggestion${heatmapGuessedThisRound.has(c.id) ? ' guessed' : ''}" data-country-id="${escapeHtml(c.id)}" data-index="${i}">${escapeHtml(countryDisplayName(c))}</button>`
    )
    .join('');
}

function handleHeatmapGuessPick(countryId) {
  // UI sollte das Suchfeld hierfuer schon gesperrt haben (renderHeatmapTurnUpdate) -
  // dieser Guard ist nur die zweite Verteidigungslinie, autoritativ blockt
  // ohnehin der Host selbst (siehe _handleHeatmapGuess() in host.js).
  if (heatmapActiveTurnPlayerId != null && heatmapActiveTurnPlayerId !== state.self.id) return;
  if (!countryId || heatmapGuessedThisRound.has(countryId)) return;
  heatmapGuessedThisRound.add(countryId);
  sound.playClick();
  heatmapMap?.focusOnCountry(countryId);
  if (state.role === 'host') controller.submitLocalHeatmapGuess(countryId);
  else controller.submitHeatmapGuess(countryId);
  el('heatmap-search-input').value = '';
  el('heatmap-suggestions').classList.add('hidden');
}

// Bottom-Sheet-Suchfeld auf Mobile (siehe .heatmap-search-panel in
// styles.css) haelt sich ueber der virtuellen Tastatur: iOS Safari
// veraendert bei geoeffneter Tastatur NICHT die Layout-Viewport-Hoehe (nur
// die VisualViewport-Hoehe schrumpft), ein reines CSS bottom:0 wuerde die
// Leiste dort also hinter der Tastatur verstecken. --heatmap-keyboard-inset
// wird als CSS-Variable gesetzt und in der bottom-Berechnung addiert.
function initHeatmapSearchViewportOffset() {
  if (!window.visualViewport) return; // aeltere Browser: bleibt bei env(safe-area-inset-bottom) allein
  const panel = el('heatmap-search-panel');
  if (!panel) return;
  const update = () => {
    const vv = window.visualViewport;
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    panel.style.setProperty('--heatmap-keyboard-inset', `${Math.round(inset)}px`);
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
  update();
}

// Gleiches Problem/gleiche Loesung wie initHeatmapSearchViewportOffset() oben:
// #mapset-modal wird auf Mobile zum Bottom-Sheet (siehe styles.css,
// @media max-width:768px), dessen Suchfeld beim Fokussieren sonst hinter der
// virtuellen Tastatur verschwinden wuerde, weil iOS Safari die Layout-
// Viewport-Hoehe beim Tastatur-Einblenden NICHT veraendert. Bewusst als
// eigene Funktion (nicht wiederverwendet) - eigene CSS-Variable, eigenes
// Panel-Element, keine gemeinsame Abhaengigkeit.
function initMapsetModalViewportOffset() {
  if (!window.visualViewport) return;
  const modal = el('mapset-modal');
  if (!modal) return;
  const update = () => {
    const vv = window.visualViewport;
    const inset = Math.max(0, window.innerHeight - vv.height - vv.offsetTop);
    modal.style.setProperty('--mapset-keyboard-inset', `${Math.round(inset)}px`);
  };
  window.visualViewport.addEventListener('resize', update);
  window.visualViewport.addEventListener('scroll', update);
  update();
}

function wireHeatmapControls() {
  const input = el('heatmap-search-input');
  // Mobile Bottom-Sheet: .expanded (siehe styles.css) laesst die
  // Vorschlagsliste hoeher wachsen, waehrend aktiv getippt wird - unfokussiert
  // bleibt sie kompakt, damit moeglichst viel Karte sichtbar bleibt. Auf
  // Desktop ohne Wirkung (die Regel existiert nur in der Mobile-Media-Query).
  input.addEventListener('focus', () => el('heatmap-search-panel').classList.add('expanded'));
  input.addEventListener('blur', () => el('heatmap-search-panel').classList.remove('expanded'));
  input.addEventListener('input', () => renderHeatmapSuggestions(input.value));
  input.addEventListener('keydown', (e) => {
    const box = el('heatmap-suggestions');
    const items = [...box.querySelectorAll('.heatmap-suggestion')];
    if (e.key === 'ArrowDown' && items.length) {
      e.preventDefault();
      heatmapSuggestionIndex = Math.min(heatmapSuggestionIndex + 1, items.length - 1);
      items.forEach((it, i) => it.classList.toggle('active', i === heatmapSuggestionIndex));
    } else if (e.key === 'ArrowUp' && items.length) {
      e.preventDefault();
      heatmapSuggestionIndex = Math.max(heatmapSuggestionIndex - 1, 0);
      items.forEach((it, i) => it.classList.toggle('active', i === heatmapSuggestionIndex));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const target = items[heatmapSuggestionIndex] || items[0];
      if (target) handleHeatmapGuessPick(target.dataset.countryId);
      else {
        // Exakter Name eingetippt, ohne aus der Vorschlagsliste zu waehlen.
        const match = findCountryByName(countryStore, input.value);
        if (match) handleHeatmapGuessPick(match.id);
        else if (input.value.trim()) shakeHeatmapSearchBox(); // unbekanntes/falsch geschriebenes Land
      }
    } else if (e.key === 'Escape') {
      box.classList.add('hidden');
    }
  });
  el('heatmap-suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('.heatmap-suggestion');
    if (btn) handleHeatmapGuessPick(btn.dataset.countryId);
  });

  el('heatmap-share-btn').addEventListener('click', async () => {
    sound.playClick();
    const text = buildHeatmapShareText();
    try {
      await navigator.clipboard.writeText(text);
      showToast(t('toastResultCopied'));
    } catch {
      showToast(t('toastCopyFailed') + ': ' + text);
    }
  });

  wireHeatmapPingWheel();
}

// Minimap-Emoji-Pings (siehe MSG.HEATMAP_PING in protocol.js): zwei Klicks
// statt einem wie beim klassischen Emote-Wheel (Emoji waehlen, DANN ein Land
// antippen) - dazwischen liegt ein expliziter "Ping-Auswahl"-Zustand
// (heatmapPingEmoji gesetzt), waehrend dem ein Kartenklick nicht wie sonst
// ignoriert wird, sondern HeatmapMap.enablePingPicker() abfaengt.
let heatmapPingEmoji = null;

function startHeatmapPingPick(emoji) {
  heatmapPingEmoji = emoji;
  el('heatmap-emote-wheel').classList.add('hidden');
  el('heatmap-ping-hint').classList.remove('hidden');
  el('heatmap-map-container').classList.add('picking');
  heatmapMap?.enablePingPicker((countryId) => {
    controller?.sendHeatmapPing(emoji, countryId);
    heatmapMap?.pingCountry(countryId, emoji);
    // Bestaetigt das Treffen eines Landes auf der Karte - auf Mobile sieht man
    // den Ping selbst oft erst, wenn der Finger wieder weg ist.
    haptics.tapLight();
    cancelHeatmapPingPick();
  });
}

function cancelHeatmapPingPick() {
  if (!heatmapPingEmoji) return;
  heatmapPingEmoji = null;
  el('heatmap-ping-hint').classList.add('hidden');
  el('heatmap-map-container').classList.remove('picking');
  heatmapMap?.disablePingPicker();
}

function wireHeatmapPingWheel() {
  el('btn-heatmap-emote-toggle').addEventListener('click', () => {
    sound.playClick();
    if (heatmapPingEmoji) {
      cancelHeatmapPingPick();
      return;
    }
    el('heatmap-emote-wheel').classList.toggle('hidden');
  });
  el('heatmap-emote-wheel').querySelectorAll('.emote-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.playClick();
      startHeatmapPingPick(btn.dataset.emoji);
    });
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && heatmapPingEmoji) cancelHeatmapPingPick();
  });
}

const GUESS_BTN_DEFAULT_LABEL = 'Tipp best&auml;tigen';

// Der Rundenwechsel laeuft ueber den Doppelpuffer in PanoViewer: das alte
// Bild bleibt stehen, bis das neue geladen ist, dann wird von Bild zu Bild
// ueberblendet. Zusammen mit PRELOAD_ROUND (net/host.js + net/client.js)
// liegt das naechste Bild meist schon im Browser-Cache, der Wechsel ist dann
// nur noch die Ueberblendung selbst.
// Der Ladehinweis erscheint erst nach einer kurzen Verzoegerung. Seit dem
// Doppelpuffer steht waehrenddessen noch das alte Bild, und bei einem
// vorgewaermten Panorama (PRELOAD_ROUND) ist der Wechsel so schnell, dass ein
// sofort gezeigter Spinner nur kurz aufblitzen wuerde - das liest sich als
// Ruckler, obwohl gerade gar nichts hakt.
const PANO_SPINNER_DELAY_MS = 400;

function showPanoLoadingDelayed() {
  return setTimeout(() => el('pano-loading').classList.remove('hidden'), PANO_SPINNER_DELAY_MS);
}

function hidePanoLoading(timer) {
  clearTimeout(timer);
  el('pano-loading').classList.add('hidden');
}

function transitionPanorama() {
  const container = el('pano-container');
  const mutators = state.settings.mutators || {};
  // Das fruehere Ausblenden-auf-Leere plus PANO_FADE_MS-Wartezeit entfaellt:
  // der Doppelpuffer im PanoViewer laesst das alte Bild stehen, bis das neue
  // fertig ist, und blendet dann direkt von Bild zu Bild ueber.
  container.classList.toggle('pano-foggy', Boolean(mutators.fogOfWar));
  const spinnerTimer = showPanoLoadingDelayed();
  // Misst NUR den Bild-Download plus Pannellum-Aufbau, nicht die vorherige
  // Mapillary-Suche - genau die Trennung, die "laedt ewig" braucht.
  const panoStartedAt = performance.now();
  const roundIndex = state.round.index;
  const sharpUrl = state.round.panoramaUrl;
  // Progressiv laden, wenn eine kleinere Vorstufe vorliegt (nur beim Host,
  // siehe panoramaUrlFast in net/host.js): die Runde startet mit einem
  // Viertel der Pixel und schaerft danach nach. Ein Viertel der Pixel ist
  // immer frueher da - das wirkt unabhaengig davon, wo im Netz die Zeit
  // genau verloren geht. Die Nachschaerfung laeuft ueber den Doppelpuffer
  // im PanoViewer, ist also ein Ueberblenden und kein sichtbarer Neuaufbau.
  const fastUrl = state.round.panoramaUrlFast;
  const useProgressive = Boolean(fastUrl) && fastUrl !== sharpUrl;

  const finishFogIfNeeded = () => {
    if (!mutators.fogOfWar) return;
    // Reflow erzwingen, damit der Browser den unscharfen Startzustand
    // tatsaechlich rendert, bevor die lange Clear-Up-Transition beginnt.
    container.getBoundingClientRect();
    requestAnimationFrame(() => container.classList.remove('pano-foggy'));
  };

  panoViewer.load(useProgressive ? fastUrl : sharpUrl, {
    vaov: state.round.vaov,
    modifier: state.settings.modifier,
    mutators,
    onLoad: () => {
      logTiming(
        `Panorama Runde ${roundIndex + 1} geladen${useProgressive ? ' (Vorstufe)' : ''}`,
        performance.now() - panoStartedAt
      );
      hidePanoLoading(spinnerTimer);
      finishFogIfNeeded();
      if (!useProgressive) return;

      // Nachschaerfen im Hintergrund. Der Rundenindex wird mitgeprueft: bei
      // einem schnellen Rundenwechsel (oder "Weiterlaufen") darf ein spaet
      // eintreffendes scharfes Bild nicht ueber das inzwischen aktuelle
      // Panorama gelegt werden.
      const sharpStartedAt = performance.now();
      const upgrade = new Image();
      upgrade.onload = () => {
        if (state.round?.index !== roundIndex || state.round?.panoramaUrl !== sharpUrl) return;
        logTiming(`Panorama Runde ${roundIndex + 1} nachgeschaerft`, performance.now() - sharpStartedAt);
        panoViewer.load(sharpUrl, {
          vaov: state.round.vaov,
          modifier: state.settings.modifier,
          mutators,
          // Der Spieler hat sich zu diesem Zeitpunkt meist schon umgesehen -
          // die Nachschaerfung darf seine Blickrichtung nicht zuruecksetzen.
          preserveView: true,
        });
      };
      // Fehler still schlucken: die Vorstufe steht bereits, ein
      // fehlgeschlagenes Nachschaerfen ist kein Spielproblem.
      upgrade.onerror = () => {};
      upgrade.src = sharpUrl;
    },
  });
}

// "Weiterlaufen"-Beta: siehe state.round.walkMeta (net/host.js _startRound())
// und WALK_BETA_MAPSETS oben. Re-Entrancy-Guard nach demselben Muster wie
// menuActionInFlight - ohne ihn wuerde schnelles Mehrfachklicken auf
// "Weiter" mehrere ueberlappende Mapillary-Abrufe lostreten, die in falscher
// Reihenfolge zurueckkommen koennen und dann den Sequenz-Zeiger durcheinanderbringen.
let walkStepInFlight = false;

function syncWalkControls() {
  const wrap = el('pano-walk-controls');
  wrap.classList.toggle('hidden', !state.round.walkMeta);
}

async function handleWalkStep(direction) {
  const walkMeta = state.round.walkMeta;
  if (!walkMeta || walkStepInFlight) return;
  walkStepInFlight = true;
  sound.playClick();
  const forwardBtn = el('btn-walk-forward');
  const backBtn = el('btn-walk-back');
  forwardBtn.disabled = true;
  backBtn.disabled = true;

  try {
    if (!walkMeta.sequenceImageIds) {
      walkMeta.sequenceImageIds = await fetchSequenceImageIds(walkMeta.sequenceId);
    }
    const neighborId = findNeighborImageId(walkMeta.sequenceImageIds, walkMeta.imageId, direction);
    if (!neighborId) {
      showToast('Ende der Sequenz erreicht');
      return;
    }
    const location = await fetchPanoramaById(neighborId, { name: '', lat: 0, lng: 0 });
    if (!location) {
      showToast(t('toastImageUnavailable'));
      return;
    }
    walkMeta.imageId = neighborId;
    // Bewusst NUR die lokal angezeigte Panorama-URL - state.round.actual
    // (die tatsaechliche Zielkoordinate fuer die Wertung) bleibt unveraendert
    // der urspruengliche Spawn-Punkt der Runde, genau wie beim "Move"-Modus
    // im echten GeoGuessr: der Pin sitzt weiter am Startpunkt, egal wie weit
    // man laeuft.
    state.round.panoramaUrl = location.panoramaUrl;
    await new Promise((resolve) => {
      const spinnerTimer = showPanoLoadingDelayed();
      panoViewer.load(location.panoramaUrl, {
        modifier: state.settings.modifier,
        mutators: state.settings.mutators,
        onLoad: () => {
          hidePanoLoading(spinnerTimer);
          resolve();
        },
      });
    });
  } catch (err) {
    console.error('Weiterlaufen fehlgeschlagen:', err);
    showToast('Weiterlaufen fehlgeschlagen');
  } finally {
    walkStepInFlight = false;
    forwardBtn.disabled = false;
    backBtn.disabled = false;
  }
}

const SHORTCUT_HINT_KEY = 'geofinder.shortcutHintSeen';

/** Einmaliger Hinweis auf die Tastenkuerzel - ungenutzte Shortcuts sind keine.
 * Bewusst nur einmal pro Geraet und nur dort, wo es ueberhaupt eine Tastatur
 * gibt (hover:hover + pointer:fine schliesst Touch-Geraete aus), und ueber den
 * bestehenden Toast statt eines eigenen Overlays - eine Legende, die man
 * wegklicken muss, waere zum Rundenstart genau die falsche Ablenkung. */
function maybeShowShortcutHint() {
  if (!window.matchMedia?.('(hover:hover) and (pointer:fine)').matches) return;
  try {
    if (localStorage.getItem(SHORTCUT_HINT_KEY) === '1') return;
    localStorage.setItem(SHORTCUT_HINT_KEY, '1');
  } catch {
    return; // Privater Modus o.ae. - dann lieber gar kein Hinweis als bei jeder Runde einer.
  }
  showToast(t('shortcutHint'), 5200);
}

function renderRoundStart() {
  showScreen('hud');
  ensureHudWidgets();
  hintRevealed = false;
  maybeShowShortcutHint();

  el('hud-round-index').textContent = String(state.round.index + 1).padStart(2, '0');
  el('hud-round-total').textContent = String(state.round.total).padStart(2, '0');
  el('pano-credit').textContent = state.pool?.source === 'mapillary'
    ? 'Foto: Mapillary-Mitwirkende'
    : 'Foto: Matthew Petroff · CC BY-SA 4.0';

  const scopeEl = el('minimap-scope');
  // 'weltweit' ist die feste ID des Standardpakets (siehe getMapSetDetail()
  // in app.js, das die intern abweichende "starter-pool"-ID aus
  // weltweit.json auf die Index-ID normalisiert) - fuer dieses eine Paket
  // bleibt das "Modus: ..."-Label bewusst ausgeblendet, es ist schliesslich
  // der Normalfall und keine besondere Auswahl.
  const isDefaultPool = !state.pool || state.pool.id === 'weltweit';
  scopeEl.textContent = isDefaultPool ? '' : `Modus: ${state.pool.name}`;
  scopeEl.classList.toggle('hidden', isDefaultPool);

  renderRoundProgress();
  renderHpBars();

  // Hinweistext kommt direkt vom Host per ROUND_START (state.round.hint) -
  // NICHT mehr aus einer lokal vorgehaltenen Standortliste, damit Mitspieler
  // nicht per DevTools-Netzwerktab alle Antworten im Voraus nachschlagen
  // koennen (siehe net/host.js).
  const hintBtn = el('btn-hint-toggle');
  const hintBanner = el('hint-banner');
  hintBanner.classList.add('hidden');
  if (state.round.hint) {
    hintBtn.hidden = false;
    hintBtn.textContent = 'Hinweis';
  } else {
    hintBtn.hidden = true;
  }

  const mutators = state.settings.mutators || {};
  const zoomLocked = state.settings.modifier === 'no-zoom' || mutators.noPan;
  el('btn-zoom-in').classList.toggle('hidden', zoomLocked);
  el('btn-zoom-out').classList.toggle('hidden', zoomLocked);
  // "Broken Compass": der Kompass-Button setzt sonst auf eine konstante
  // Referenzrichtung zurueck - unter dem Mutator ist diese Referenz pro
  // Runde zufaellig (siehe PanoViewer.load()), der Button waere also
  // irrefuehrend und wird ausgeblendet.
  el('btn-compass').classList.toggle('hidden', Boolean(mutators.brokenCompass));
  syncWalkControls();

  transitionPanorama();

  guessMap.reset();
  if (state.round.index === 0) {
    guessMap.focusOnLocations(state.pool?.focusBounds);
  }
  el('minimap').classList.remove('expanded');
  const confirmBtn = el('btn-confirm-guess');
  confirmBtn.classList.remove('ready', 'locked');
  const eliminated = isSelfEliminated();
  el('spectator-banner').classList.toggle('hidden', !eliminated);
  if (eliminated) {
    // Bleibt fuer den Rest der Partie disabled - der Zuschauer-Zustand endet
    // nie wieder "mitten in der Runde", anders als das normale disabled=true,
    // das der Klick auf die Minimap gleich wieder aufhebt.
    confirmBtn.disabled = true;
    confirmBtn.textContent = t('spectatorBtnLabel');
  } else {
    confirmBtn.disabled = true;
    confirmBtn.innerHTML = GUESS_BTN_DEFAULT_LABEL;
  }

  renderPeerStatus();
  updateConnectionBanner();

  clearInterval(hudTimerInterval);
  const timerEl = el('hud-timer');
  const timerBox = timerEl.closest('.timer');
  sound.stopRoundAmbience();
  if (state.round.timeLimitMs == null) {
    timerEl.textContent = '∞';
    timerBox.classList.remove('critical');
  } else {
    sound.startRoundAmbience();
    let tickedCriticalSecond = null;
    // "Puls" der Ambience in den letzten 10s: Intensitaet steigt linear von
    // 0 (10s uebrig) auf 1 (0s uebrig) - siehe setRoundTension() in sound.js.
    const TENSION_WINDOW_S = 10;
    const tick = () => {
      const remainingMs = state.round.startTimestamp + state.round.timeLimitMs - Date.now();
      const clamped = Math.max(0, remainingMs);
      const totalSeconds = Math.ceil(clamped / 1000);
      const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
      const ss = String(totalSeconds % 60).padStart(2, '0');
      timerEl.textContent = `${mm}:${ss}`;
      const critical = totalSeconds <= 15;
      timerBox.classList.toggle('critical', critical);
      if (critical && totalSeconds > 0 && tickedCriticalSecond !== totalSeconds) {
        tickedCriticalSecond = totalSeconds;
        sound.playTick(totalSeconds <= 3);
        // Haptik bewusst NUR in den letzten 3 Sekunden, nicht ueber das ganze
        // 15s-Kritisch-Fenster: 15 Vibrationen hintereinander waeren
        // aufdringlich und kosten auf Mobile spuerbar Akku. Die drei letzten
        // Sekunden sind der Moment, in dem man das Geraet nicht mehr ansieht,
        // weil man auf die Karte tippt - genau da traegt Haptik etwas bei,
        // was der Ton allein nicht leistet (Stummschaltung, laute Umgebung).
        if (totalSeconds <= 3) haptics.tapLight();
      }
      const tension = 1 - Math.max(0, Math.min(TENSION_WINDOW_S, clamped / 1000)) / TENSION_WINDOW_S;
      sound.setRoundTension(tension);
      if (clamped <= 0) {
        clearInterval(hudTimerInterval);
        sound.stopRoundAmbience();
      }
    };
    tick();
    hudTimerInterval = setInterval(tick, 250);
  }

  requestAnimationFrame(() => guessMap.invalidate());
}

function renderPeerStatus() {
  const container = el('hud-peer-status');
  container.innerHTML = '';
  for (const p of state.players.values()) {
    const dot = document.createElement('div');
    const eliminated = state.eliminatedAtRound.has(p.id);
    const guessed = state.round.guessedPlayerIds.has(p.id);
    const offline = !p.connected;
    dot.className = `peer-dot${guessed ? '' : ' pending'}${offline ? ' offline' : ''}${eliminated ? ' eliminated' : ''}`;
    dot.innerHTML = `<i style="background:${guessed ? p.color : ''}"></i><span class="peer-dot-name">${escapeHtml(p.name)}</span>`;
    container.appendChild(dot);
  }
}

function wireHudControls() {
  // #minimap-wrap bekommt dieselbe .expanded-Klasse wie #minimap: auf Mobile
  // (siehe CSS @media max-width:768px) verwandelt sich .minimap-wrap dadurch
  // von seiner kleinen rechts-unten-Box in ein Vollbild-/Bottom-Sheet-Overlay
  // - .minimap selbst bleibt bewusst der Groessen-Transition-Owner (siehe
  // Kommentar bei .minimap{ transition:width,height }), .minimap-wrap liefert
  // nur den Vollbild-Rahmen drumherum.
  const expandMap = () => {
    sound.playClick();
    el('minimap').classList.add('expanded');
    el('minimap-wrap').classList.add('expanded');
    guessMap?.invalidate();
    setTimeout(() => guessMap?.invalidate(), 340);
  };
  // playSound=false fuer die beiden "beilaeufigen" Schliess-Wege (Klick
  // ausserhalb, Escape) - anders als ein bewusster Klick auf das X ist das
  // meist ein Klick, der eigentlich etwas anderem galt (z. B. das Panorama
  // umschauen), ein Klickgeraeusch dabei waere aufdringlich/verwirrend.
  const collapseMap = (playSound = true) => {
    if (!el('minimap').classList.contains('expanded')) return;
    if (playSound) sound.playClick();
    el('minimap').classList.remove('expanded');
    el('minimap-wrap').classList.remove('expanded');
    el('minimap').style.transform = '';
  };
  el('minimap-open-btn').addEventListener('click', expandMap);
  el('minimap-close-btn').addEventListener('click', () => collapseMap());
  el('minimap-style-toggle').addEventListener('click', () => {
    sound.playClick();
    const style = guessMap.toggleTileStyle();
    updateMapStyleLabel('minimap-style-label', style);
  });

  // Standard-Overlay-Verhalten (wie bei jedem Modal/Popover): ausgeklappte
  // Karte schliesst sich auch bei einem Klick ausserhalb oder per Escape,
  // nicht nur ueber den expliziten X-Button/Wisch-Geste. Bubble-Phase-Klick
  // auf document statt z. B. auf dem Panorama-Hintergrund, damit WIRKLICH
  // jeder Klick ausserhalb zaehlt (auch auf HUD-Buttons/den Rundenzaehler),
  // nicht nur einer auf die sichtbare Kartenfläche.
  document.addEventListener('click', (e) => {
    if (!el('minimap').classList.contains('expanded')) return;
    if (el('minimap-wrap').contains(e.target)) return;
    collapseMap(false);
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') collapseMap();
  });

  // Wisch-nach-unten-zum-Schliessen fuer die Mobile-Bottom-Sheet-Minimap:
  // nur der schmale Griff-Balken oben reagiert (nicht die ganze Karte, sonst
  // wuerde jeder Kartenpan/-drag versehentlich das Sheet schliessen). Reines
  // Touch-Tracking ohne Bibliothek - Finger-Y minus Start-Y als translateY,
  // bei > 90px oder schneller Wisch-Geste (Distanz/Zeit) schliessen, sonst
  // zurueckfedern (CSS-Transition macht das, sobald der Inline-Transform
  // wieder entfernt wird).
  const dragHandle = el('minimap-drag-handle');
  let dragStartY = null;
  let dragStartT = 0;
  dragHandle.addEventListener('touchstart', (e) => {
    if (!el('minimap').classList.contains('expanded')) return;
    dragStartY = e.touches[0].clientY;
    dragStartT = Date.now();
    el('minimap').style.transition = 'none';
  }, { passive: true });
  dragHandle.addEventListener('touchmove', (e) => {
    if (dragStartY == null) return;
    const dy = Math.max(0, e.touches[0].clientY - dragStartY);
    el('minimap').style.transform = `translateY(${dy}px)`;
  }, { passive: true });
  dragHandle.addEventListener('touchend', (e) => {
    if (dragStartY == null) return;
    const dy = Math.max(0, (e.changedTouches[0]?.clientY ?? dragStartY) - dragStartY);
    const dt = Date.now() - dragStartT;
    el('minimap').style.transition = '';
    dragStartY = null;
    if (dy > 90 || (dy > 30 && dt < 200)) {
      collapseMap();
    } else {
      el('minimap').style.transform = '';
    }
  });

  el('btn-confirm-guess').addEventListener('click', () => {
    const guess = guessMap.getGuess();
    if (!guess) return;
    sound.playGuessSubmitted();
    // Der Tipp ist unwiderruflich - deutlicher als das tapLight() beim blossen
    // Setzen des Pins, damit sich "gesetzt" und "abgeschickt" unterscheiden.
    haptics.tapMedium();
    if (state.role === 'host') controller.submitLocalGuess(guess.lat, guess.lng);
    else controller.submitGuess(guess.lat, guess.lng);
    const btn = el('btn-confirm-guess');
    btn.disabled = true;
    btn.classList.remove('ready');
    // Sofortiges "Locked"-Feedback statt nur grau/inaktiv zu werden - das
    // Ergebnis kommt erst, wenn alle getippt haben oder der Timer ablaeuft,
    // bis dahin soll sichtbar sein, dass der Tipp WIRKLICH raus ist.
    btn.classList.add('locked');
    btn.innerHTML = '<span class="btn-spinner" aria-hidden="true"></span> Tipp abgegeben';
    showToast('Tipp abgegeben');
  });

  el('btn-hint-toggle').addEventListener('click', () => {
    sound.playClick();
    if (!state.round.hint) return;
    hintRevealed = !hintRevealed;
    const banner = el('hint-banner');
    banner.textContent = `💡 ${state.round.hint}`;
    banner.classList.toggle('hidden', !hintRevealed);
  });

  el('btn-compass').addEventListener('click', () => {
    sound.playClick();
    panoViewer?.resetNorth();
  });
  el('btn-zoom-in').addEventListener('click', () => {
    sound.playClick();
    panoViewer?.zoomIn();
  });
  el('btn-zoom-out').addEventListener('click', () => {
    sound.playClick();
    panoViewer?.zoomOut();
  });
  el('btn-fullscreen').addEventListener('click', () => {
    sound.playClick();
    panoViewer?.toggleFullscreen();
  });

  el('btn-walk-forward').addEventListener('click', () => handleWalkStep('forward'));
  el('btn-walk-back').addEventListener('click', () => handleWalkStep('backward'));

  // Erschwert zumindest die triviale Rechtsklick-Bildersuche auf dem Panorama.
  el('pano-container').addEventListener('contextmenu', (e) => e.preventDefault());

  el('btn-emote-toggle').addEventListener('click', () => {
    sound.playClick();
    el('emote-wheel').classList.toggle('hidden');
  });
  el('emote-wheel').querySelectorAll('.emote-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const emoji = btn.dataset.emoji;
      controller?.sendEmote(emoji);
      spawnEmote(emoji);
      haptics.tapLight();
      el('emote-wheel').classList.add('hidden');
    });
  });

  // ---------------------------------------------------------------- Shortcuts
  // Bis hierhin gab es keine einzige Spiel-Tastenkombination: jede Aktion war
  // ein Mausweg quer ueber den (seit dem Vollbild-Umbau bis zu 2560px breiten)
  // Bildschirm, bei laufendem Rundentimer.
  //
  // Loest bewusst die vorhandenen Buttons per .click() aus, statt die Aktionen
  // hier zu wiederholen - so bleiben Klick- und Tastenweg garantiert identisch
  // (inkl. Sound/Disabled-Zustand) und koennen nicht auseinanderlaufen.
  // Ausnahme M: expandMap/collapseMap sind lokale Closures dieser Funktion,
  // fuer die es keinen einzelnen Button gibt (oeffnen und schliessen sind
  // zwei verschiedene).
  document.addEventListener('keydown', (e) => {
    // Modifier-Kombis gehoeren dem Browser/Betriebssystem (Cmd+R, Ctrl+F ...).
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    // Harte Eingabefeld-Sperre. Ohne sie wuerde ein Leerzeichen im Spielernamen
    // oder in der PulseMap-Laendersuche einen Tipp abschicken - der teuerste
    // denkbare Fehlausloeser, weil ein Tipp unwiderruflich ist.
    const target = e.target;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) return;
    if (!el('screen-hud').classList.contains('active')) return;

    switch (e.key.toLowerCase()) {
      case ' ': {
        // preventDefault zwingend: Space wuerde sonst zusaetzlich scrollen.
        e.preventDefault();
        const btn = el('btn-confirm-guess');
        // Kein Pin gesetzt oder bereits getippt -> Button ist disabled, und
        // .click() auf einen disabled Button ist von sich aus wirkungslos.
        // Ausgeschiedene Zuschauer sind damit ebenfalls automatisch gesperrt.
        if (!btn.disabled) btn.click();
        break;
      }
      case 'm':
        el('minimap').classList.contains('expanded') ? collapseMap() : expandMap();
        break;
      case 'e':
        el('btn-emote-toggle').click();
        break;
      case 'r':
        el('btn-compass').click();
        break;
      case 'f':
        el('btn-fullscreen').click();
        break;
      // '=' ist auf DE- wie US-Layout dieselbe Taste wie '+', nur ohne Shift.
      case '+':
      case '=':
        el('btn-zoom-in').click();
        break;
      case '-':
        el('btn-zoom-out').click();
        break;
    }
  });
}

function spawnEmote(emoji) {
  const layer = el('emote-layer');
  const bubble = document.createElement('div');
  bubble.className = 'emote-float';
  bubble.textContent = emoji;
  bubble.style.left = `${20 + Math.random() * 60}%`;
  layer.appendChild(bubble);
  setTimeout(() => bubble.remove(), 2300);
}

// ---------------------------------------------------------------- anti-cheat

function initVisibilityWatch() {
  const reportSwitch = () => {
    const onActiveRound = el('screen-hud').classList.contains('active');
    if (!onActiveRound || !controller) return;
    const now = Date.now();
    if (now - lastTabSwitchSentAt < 3000) return; // Spam-Schutz
    lastTabSwitchSentAt = now;
    controller.reportTabSwitch();
  };

  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reportSwitch();
  });

  // window.blur/focus faengt zusaetzlich Faelle, die nicht immer
  // document.hidden ausloesen (z. B. DevTools/ein anderes Fenster in den
  // Vordergrund holen), UND dimmt lokal sofort das eigene Panorama - rein
  // kosmetisch, kein zusaetzlicher Netzwerk-Effekt fuer sich allein.
  window.addEventListener('blur', () => {
    reportSwitch();
    el('pano-focus-blackout').classList.add('active');
  });
  window.addEventListener('focus', () => {
    el('pano-focus-blackout').classList.remove('active');
  });
}

// ---------------------------------------------------------------- result

function animateCounter(elEl, from, to, duration = 700) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    elEl.textContent = to.toLocaleString(numberLocale());
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    elEl.textContent = Math.round(from + (to - from) * eased).toLocaleString(numberLocale());
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderRoundResult({ results, actual, actualMeta, eliminatedPlayerIds = [] }) {
  clearInterval(hudTimerInterval);
  sound.stopRoundAmbience();
  showScreen('result');
  el('result-next-hint').classList.remove('buffering');

  const resultHeading = el('result-heading');
  resultHeading.dataset.roundN = String(state.round.index + 1);
  resultHeading.dataset.roundTotal = String(state.round.total);
  resultHeading.textContent = t('resultRoundOf', {
    n: resultHeading.dataset.roundN,
    total: resultHeading.dataset.roundTotal,
  });

  const isBattleRoyale = state.settings.mode === 'battle-royale';
  const remainingEl = el('royale-remaining');
  if (isBattleRoyale) {
    const remaining = [...state.players.values()].filter((p) => !state.eliminatedAtRound.has(p.id)).length;
    remainingEl.textContent = t('royaleRemaining', { n: remaining });
    remainingEl.classList.remove('hidden');
  } else {
    remainingEl.classList.add('hidden');
  }

  if (!resultMap) resultMap = new ResultMap(el('result-map-container'));
  updateMapStyleLabel('result-map-style-label', resultMap.tiles.style);
  requestAnimationFrame(() => {
    resultMap.invalidate();
    resultMap.render(actual, results, state.players, state.self.id);
  });

  // funFact kommt jetzt direkt vom Host im ROUND_RESULT (actualMeta) statt
  // aus einer lokal vorgehaltenen Standortliste - siehe net/host.js.
  const funFactEl = el('result-fun-fact');
  if (actualMeta?.funFact) {
    el('result-fun-fact-text').textContent = actualMeta.funFact;
    funFactEl.classList.remove('hidden');
  } else {
    funFactEl.classList.add('hidden');
  }

  const isCountryMode = state.settings.mode === 'country-streak';
  const sorted = [...results].sort((a, b) => b.score - a.score);
  const listEl = el('result-score-list');
  // FLIP-Animation fuer Rangwechsel zwischen Runden (Audit Quick-Win #5):
  // First - Positionen der noch-alten Karten VOR dem Neuaufbau merken, per
  // playerId statt Index (die Sortierung selbst aendert sich ja gerade).
  // Erste Runde: previousRects bleibt leer, es gibt nichts zu animieren.
  const previousRects = new Map();
  listEl.querySelectorAll('.score-card').forEach((card) => {
    if (card.dataset.playerId) previousRects.set(card.dataset.playerId, card.getBoundingClientRect());
  });
  listEl.innerHTML = '';
  let myBestScore = 0;
  const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  for (const r of sorted) {
    const player = state.players.get(r.playerId);
    if (r.playerId === state.self.id) myBestScore = r.score;
    const card = document.createElement('div');
    card.dataset.playerId = r.playerId;
    const justEliminated = eliminatedPlayerIds.includes(r.playerId);
    card.className = justEliminated ? 'score-card eliminated' : 'score-card';
    let meta;
    let barWidth;
    const chips = [];
    if (isCountryMode) {
      meta = r.noGuess
        ? t('scoreNoGuess')
        : r.correct
          ? t('scoreCorrect', { country: escapeHtml(r.actualCountry) })
          : t('scoreWrong', {
              guess: escapeHtml(r.guessedCountry || '—'),
              actual: escapeHtml(r.actualCountry || '—'),
            });
      barWidth = r.correct ? 100 : 4;
      if (r.streak > 0) chips.push({ cls: 'streak', html: `&#128293; ${t('chipStreak', { n: r.streak })}` });
    } else {
      meta = r.noGuess ? t('scoreNoGuess') : t('scoreDistance', { km: r.distanceKm.toFixed(1) });
      barWidth = Math.max(2, (r.score / 5000) * 100);
      if (!r.noGuess) chips.push({ cls: '', html: t('chipBase', { n: formatNumber(r.base) }) });
      if (r.timeBonus > 0) chips.push({ cls: 'bonus', html: `&#9889; ${t('chipSpeed', { n: r.timeBonus })}` });
      if (r.streakBonus > 0)
        chips.push({ cls: 'streak', html: `&#128293; ${t('chipStreakBonus', { n: r.streakBonus, multiplier: r.streak })}` });
      if (r.hp != null) {
        chips.push({
          cls: r.hpDamage > 0 ? '' : 'streak',
          html: `${r.hpDamage > 0 ? `-${r.hpDamage} HP` : t('chipNoDamage')} · ${t('chipHpLeft', { n: r.hp })}`,
        });
      }
    }
    // Getaktete Enthüllung (Field-Instrument-Konzept): Distanz steht sofort,
    // Punktzahl + Balken ziehen ab 1.6s hoch, Bonus-Chips folgen gestaffelt.
    const chipsHtml = chips
      .map((c, i) => `<span class="score-chip ${c.cls}" style="--reveal-delay:${(2.4 + i * 0.3).toFixed(1)}s">${c.html}</span>`)
      .join('');
    card.innerHTML = `
      <div class="score-card-top">
        <span class="score-name"><span class="avatar" style="width:22px;height:22px;font-size:0.7rem;background:${player?.color || '#8c99b8'};">${(player?.name || '?').charAt(0).toUpperCase()}</span>${escapeHtml(player?.name || t('defaultPlayerName'))}${justEliminated ? `<span class="score-card-eliminated-tag">${t('eliminatedTag')}</span>` : ''}</span>
        <span class="score-points">0</span>
      </div>
      <div class="score-meta">${meta}</div>
      <div class="score-bar"><i style="--target-width:${barWidth}%; background:${player?.color || 'var(--accent)'};"></i></div>
      ${chips.length ? `<div class="score-breakdown">${chipsHtml}</div>` : ''}
    `;
    listEl.appendChild(card);
    const pointsEl = card.querySelector('.score-points');
    setTimeout(() => animateCounter(pointsEl, 0, r.score), reduceMotion ? 0 : 1600);
  }

  // FLIP Schritt 2 (Last/Invert/Play): neue Positionen messen, per Transform
  // sofort optisch an die GEMERKTE alte Position zurueckversetzen (Invert),
  // dann im naechsten Frame zur echten Transition auf transform:none
  // wechseln (Play) - der Browser rendert dadurch einen fluessigen Gleit-
  // statt eines harten Sprungs, obwohl die DOM-Reihenfolge schon final ist.
  // Karten ohne previousRects-Eintrag (erste Runde) bleiben unangetastet.
  if (!reduceMotion) {
    requestAnimationFrame(() => {
      listEl.querySelectorAll('.score-card').forEach((card) => {
        const prev = previousRects.get(card.dataset.playerId);
        if (!prev) return;
        const next = card.getBoundingClientRect();
        const deltaY = prev.top - next.top;
        if (Math.abs(deltaY) < 1) return;
        card.style.transition = 'none';
        card.style.transform = `translateY(${deltaY}px)`;
        requestAnimationFrame(() => {
          card.style.transition = 'transform 0.45s cubic-bezier(0.2, 0.8, 0.2, 1)';
          card.style.transform = '';
        });
      });
    });
  }

  renderHpBars();

  const myResult = results.find((r) => r.playerId === state.self.id);
  // Konfetti + Radar-Ping als fester Kombi-Effekt fuer jeden "grossen"
  // Rundensieg-Moment, ueber alle klassischen Modi hinweg - vorher bekam
  // nur PulseMap diese Kombination, klassische Modi nur die Partikel (oder
  // im Country-Streak-Fall gar keinen Partikeleffekt). spawnRadarPing()
  // ohne konkreten Welt-Ankerpunkt (anders als bei PulseMap, wo das Zielland
  // eine natuerliche Position liefert) faellt hier auf denselben
  // Default-Ursprung wie particleBurst() selbst zurueck (Bildschirmmitte,
  // leicht oberhalb der Mitte), Audit Quick-Win #2.
  const celebrate = (colors) => {
    particleBurst({ colors });
    spawnRadarPing(window.innerWidth / 2, window.innerHeight * 0.35);
  };
  if (isCountryMode) {
    if (myResult?.correct) {
      sound.playSuccess();
      celebrate(['#ff7a33', '#17ecff', '#ff1fb0', '#39ff8f']);
    } else {
      sound.playRoundReveal();
    }
    if (myResult?.correct && myResult.streak >= 2) sound.playStreak();
    haptics.tapMedium();
  } else {
    if (myBestScore > 4000) sound.playSuccess();
    else sound.playRoundReveal();
    if (myResult?.streakBonus > 0) sound.playStreak();
    // Volltreffer-Feiermoment: Konfetti + starkes Haptik-Feedback bei einem
    // sehr nahen Tipp (<5km) statt nur beim theoretischen Punktemaximum -
    // ein 4999-von-5000-Punkte-Tipp UND ein technisch perfekter Tipp fuehlen
    // sich beide wie "extrem nah" an, sollen also beide feiern.
    if (!myResult?.noGuess && myResult?.distanceKm != null && myResult.distanceKm < 5) {
      celebrate(['#ff7a33', '#17ecff', '#ff1fb0', '#39ff8f']);
      haptics.tapStrong();
    } else if (myResult?.hpDamage > 0) {
      haptics.tapStrong();
    } else {
      haptics.tapMedium();
    }
  }
  // Battle Royale: eigenes Ausscheiden ueberschreibt das normale Feedback
  // oben mit einem deutlich spuerbaren Impact statt eines Erfolgs-Tons -
  // eigener duesterer Sound (statt playSuccess()/playStreak()) + rote
  // Vignette statt nur der Haptik allein (Audit Quick-Win #1: der bisher
  // dramatischste Moment ohne eigenes Signal).
  if (eliminatedPlayerIds.includes(state.self.id)) {
    sound.playElimination();
    spawnEliminationFlash();
    shakeScreen({ hard: true });
    haptics.tapStrong();
  }

  const isHost = state.role === 'host';
  el('btn-advance-round').hidden = !isHost;

  updateConnectionBanner();

  clearInterval(resultCountdownInterval);
  let remaining = RESULT_DISPLAY_SECONDS;
  const hintEl = el('result-next-hint');
  const tick = () => {
    hintEl.textContent =
      remaining > 0
        ? t('nextRoundIn', { seconds: String(remaining).padStart(2, '0') })
        : t('nextRoundNow');
    remaining -= 1;
    if (remaining < 0) clearInterval(resultCountdownInterval);
  };
  tick();
  resultCountdownInterval = setInterval(tick, 1000);
}

function wireResultControls() {
  el('btn-advance-round').addEventListener('click', () => {
    sound.playClick();
    if (state.role === 'host') controller.advanceNow();
  });
  el('result-map-style-toggle').addEventListener('click', () => {
    if (!resultMap) return;
    sound.playClick();
    updateMapStyleLabel('result-map-style-label', resultMap.toggleTileStyle());
  });
}

// ---------------------------------------------------------------- leaderboard

function renderPodium(sorted) {
  const podiumEl = el('podium');
  podiumEl.innerHTML = '';
  if (sorted.length < 2) {
    podiumEl.classList.add('hidden');
    return;
  }
  podiumEl.classList.remove('hidden');
  const order = [1, 0, 2].filter((i) => sorted[i]);
  order.forEach((idx, visualPos) => {
    const entry = sorted[idx];
    const player = state.players.get(entry.playerId);
    const step = document.createElement('div');
    step.className = `podium-step rank-${idx + 1}`;
    step.style.animationDelay = `${visualPos * 100}ms`;
    const initial = (player?.name || '?').charAt(0).toUpperCase();
    const scoreLabel =
      state.settings.mode === 'hp'
        ? `${entry.hp ?? 0} HP`
        : state.settings.mode === 'country-streak'
          ? t('correctOfTotal', { n: Math.round(entry.total / 1000), total: entry.perRound.length })
          : state.settings.mode === 'battle-royale'
            ? entry.eliminatedAtRound == null
              ? t('championLabel')
              : t('outInRound', { n: entry.eliminatedAtRound + 1 })
            : t('pointsShort', { n: formatNumber(entry.total) });
    step.innerHTML = `
      <div class="avatar" style="background:${player?.color || '#8c99b8'};">${initial}</div>
      <div class="podium-name">${escapeHtml(player?.name || t('defaultPlayerName'))}</div>
      <div class="podium-score">${scoreLabel}</div>
      <div class="podium-block">${idx + 1}</div>
    `;
    podiumEl.appendChild(step);
  });
}

function renderOverviewMap() {
  const wrap = el('overview-map-wrap');
  // Heatmap-Runden haben kein {actual:{lat,lng}} (siehe roundHistory-Eintrag
  // in host.js _endHeatmapRound()) - die "Alle Runden im Ueberblick"-Karte
  // erwartet Guess-Pins/Linien, die es in diesem Modus konzeptionell gar
  // nicht gibt, und wuerde sonst nur leer angezeigt.
  const rounds = state.settings.mode === 'heatmap' ? [] : state.roundHistory.filter(Boolean);
  if (rounds.length === 0) {
    wrap.classList.add('hidden');
    return;
  }
  wrap.classList.remove('hidden');
  if (!overviewMap) overviewMap = new ResultMap(el('overview-map-container'));
  updateMapStyleLabel('overview-map-style-label', overviewMap.tiles.style);
  requestAnimationFrame(() => {
    overviewMap.invalidate();
    overviewMap.renderOverview(rounds, state.players, state.self.id);
  });
}

function renderLeaderboard({ finalScores }) {
  clearInterval(resultCountdownInterval);
  showScreen('leaderboard');

  if (state.pool?.id) {
    const ownEntry = finalScores.find((e) => e.playerId === state.self.id);
    if (ownEntry) {
      recordScoreIfBest(state.pool.id, state.settings.mode, ownEntry.total);
      recordGamePlayed(ownEntry.total, state.round.total);
      recordDailyPlay();
      if (state.challenge?.type === 'daily') recordDailyResult(ownEntry.total);
    }
  } else if (state.settings.mode === 'heatmap') {
    // Erreicht die Leaderboard-Ansicht ueberhaupt, heisst: die Partie ist
    // regulaer zu Ende gelaufen (letzte Runde vorbei), kein Abbruch - siehe
    // recordHeatmapDropOff() in resetToMenu() fuer den Gegenfall.
    recordHeatmapGameCompleted();
    recordDailyPlay();
  }
  announceNewAchievements();

  // Challenge-Link teilen ist bewusst nur fuer Solo-Partien: der geteilte
  // Link startet direkt eine neue Solo-Session beim Empfaenger, ein
  // laufender Mehrspieler-Raum passt da konzeptionell nicht rein.
  el('btn-share-challenge').hidden = !!state.roomCode || !state.pool?.id;

  const isHpMode = state.settings.mode === 'hp';
  const isCountryMode = state.settings.mode === 'country-streak';
  const isBattleRoyale = state.settings.mode === 'battle-royale';
  const sorted = [...finalScores].sort((a, b) => {
    if (isHpMode) return (b.hp ?? 0) - (a.hp ?? 0) || b.total - a.total;
    if (isCountryMode) return b.total - a.total || (b.bestStreak ?? 0) - (a.bestStreak ?? 0);
    // Battle Royale: Rang kommt aus der Ueberlebensreihenfolge, nicht aus
    // der Punktsumme (Ueberlebende sammeln zwangslaeufig mehr Runden lang
    // Punkte als frueh Ausgeschiedene - eliminatedAtRound==null (Champion)
    // zaehlt hier als "unendlich spaet ausgeschieden").
    if (isBattleRoyale) return (b.eliminatedAtRound ?? Infinity) - (a.eliminatedAtRound ?? Infinity);
    return b.total - a.total;
  });
  renderPodium(sorted);

  // Podium-Konfetti: nur bei echten Mehrspieler-Partien (renderPodium selbst
  // blendet das Podium bei <2 Spielern aus - Solo hat kein "Rang", das
  // feiernswert waere) und nur, wenn der eigene Rang tatsaechlich unter den
  // ersten drei liegt.
  const ownRank = sorted.findIndex((e) => e.playerId === state.self.id);
  if (sorted.length >= 2 && ownRank >= 0 && ownRank < 3) {
    setTimeout(() => particleBurst({ count: 90, spread: 1.3 }), 400);
    haptics.tapStrong();
  }

  const heading = document.querySelector('#screen-leaderboard h2');
  if (state.challenge?.type === 'daily') {
    heading.textContent = 'Tages-Challenge abgeschlossen!';
  } else if (state.challenge?.type === 'link') {
    heading.textContent = 'Challenge abgeschlossen!';
  } else if (isHpMode) {
    const survivor = sorted.find((e) => (e.hp ?? 0) > 0);
    const survivorName = state.players.get(survivor?.playerId)?.name;
    heading.textContent = survivor && sorted.some((e) => (e.hp ?? 0) <= 0)
      ? `${survivorName} gewinnt das HP-Duell!`
      : 'HP-Duell beendet';
  } else if (isCountryMode) {
    setBoardHeading(heading, 'countryStreakFinished');
  } else if (state.settings.mode === 'heatmap') {
    setBoardHeading(heading, 'pulsemapDuelFinished');
  } else if (isBattleRoyale) {
    const champion = sorted.find((e) => e.eliminatedAtRound == null);
    const championName = state.players.get(champion?.playerId)?.name;
    if (champion) setBoardHeading(heading, 'royaleWinner', championName);
    else setBoardHeading(heading, 'royaleFinished');
  } else {
    setBoardHeading(heading, 'duelFinished');
  }

  const listEl = el('board-list');
  listEl.innerHTML = '';
  sorted.forEach((entry, idx) => {
    const player = state.players.get(entry.playerId);
    const row = document.createElement('div');
    row.className = `board-row${idx === 0 ? ' rank-1' : ''}`;
    const chips = isCountryMode
      ? entry.perRound
          .map((r, i) => `<span class="round-pill">R${i + 1} <b>${r?.correct ? '✓' : '✗'}</b></span>`)
          .join('')
      : entry.perRound.map((r, i) => `<span class="round-pill">R${i + 1} <b>${r?.total ?? 0}</b></span>`).join('');
    let totalLabel;
    if (isHpMode) {
      totalLabel = `<div class="num">${entry.hp ?? 0}</div><div class="lbl">${t('hpLeftLabel')}</div>`;
    } else if (isCountryMode) {
      const correctCount = Math.round(entry.total / 1000);
      totalLabel = `<div class="num">${correctCount}/${entry.perRound.length}</div><div class="lbl">${t('bestStreakLabel', { n: entry.bestStreak ?? 0 })}</div>`;
    } else if (isBattleRoyale) {
      totalLabel =
        entry.eliminatedAtRound == null
          ? `<div class="num">🏆</div><div class="lbl">${t('championLabelShort')}</div>`
          : `<div class="num">R${entry.eliminatedAtRound + 1}</div><div class="lbl">${t('eliminatedTag')}</div>`;
    } else {
      totalLabel = `<div class="num">${formatNumber(entry.total)}</div><div class="lbl">${t('scoreLabel')}</div>`;
    }
    row.innerHTML = `
      <div class="rank-num">${String(idx + 1).padStart(2, '0')}</div>
      <div>
        <div class="board-name">${escapeHtml(player?.name || t('defaultPlayerName'))}</div>
        <div class="board-chips">${chips}</div>
      </div>
      <div class="board-total">${totalLabel}</div>
    `;
    listEl.appendChild(row);
  });

  renderOverviewMap();
  el('btn-play-again').hidden = state.role !== 'host';
}

function wireLeaderboardControls() {
  el('overview-map-style-toggle').addEventListener('click', () => {
    if (!overviewMap) return;
    sound.playClick();
    updateMapStyleLabel('overview-map-style-label', overviewMap.toggleTileStyle());
  });
  el('btn-play-again').addEventListener('click', async () => {
    sound.playClick();
    const isSolo = !state.roomCode;
    if (isSolo) {
      // Ohne dieses Zuruecksetzen wuerde "Nochmal spielen" nach einer
      // Tages-Challenge/einem Challenge-Link die neue, frei-zufaellige
      // Partie faelschlich als denselben Challenge-Typ werten und versuchen,
      // den Tages-Rekord mit einem nicht vergleichbaren Ergebnis zu ueberschreiben.
      state.challenge = null;
      await startGameFromLobby();
      return;
    }
    for (const p of state.players.values()) {
      if (!p.isHost) p.ready = false;
    }
    controller.updateSettings({});
    await enterLobby();
  });

  el('btn-back-to-menu').addEventListener('click', () => {
    sound.playClick();
    resetToMenu();
  });
}

// ---------------------------------------------------------------- menu wiring

function wireMenuControls() {
  attachRipple(el('btn-host'));
  attachRipple(el('btn-join-toggle'));
  attachRipple(el('btn-solo'));
  attachHoverSound(el('btn-host'));
  attachHoverSound(el('btn-join-toggle'));
  attachHoverSound(el('btn-solo'));
  el('btn-host').addEventListener('click', hostFlow);
  el('btn-solo').addEventListener('click', soloFlow);

  el('btn-join-toggle').addEventListener('click', () => {
    sound.unlockAudio();
    sound.playClick();
    showJoinModal();
  });

  attachRipple(el('btn-daily-challenge'));
  attachHoverSound(el('btn-daily-challenge'));
  el('btn-daily-challenge').addEventListener('click', () => {
    sound.unlockAudio();
    sound.playClick();
    startDailyChallenge();
  });

  el('btn-share-challenge').addEventListener('click', async () => {
    sound.playClick();
    const encoded = encodeChallengeLink({
      seed: state.pool.seed,
      mapSetId: state.pool.id,
      roundCount: state.round.total,
      timeLimitMs: state.settings.timeLimitMs,
      mode: state.settings.mode,
      modifier: state.settings.modifier,
    });
    const link = `${location.origin}${location.pathname}#challenge=${encoded}`;
    try {
      await navigator.clipboard.writeText(link);
      showToast('Challenge-Link kopiert — dein Freund bekommt exakt dieselben Orte.');
    } catch {
      showToast('Kopieren nicht möglich — bitte manuell markieren: ' + link);
    }
  });
}

const GAME_CAROUSEL_INTERVAL_MS = 6000;
let gameCarouselTimer = null;
let gameCarouselIndex = 0;

/** Homepage-Karussell rechts im Hauptmenue (ersetzt den frueheren statischen
 * Panorama-Teaser) - zeigt PulseMap/360°-Explorer/Battle-Royale mit je einem
 * "Direkt starten"-Button, der den Modus vorwaehlt und direkt in die
 * Solo-Lobby springt (soloFlow()). */
function wireGameCarousel() {
  const root = el('game-carousel');
  if (!root) return;
  const slides = [...root.querySelectorAll('.game-carousel-slide')];
  const dots = [...root.querySelectorAll('.game-carousel-dot')];
  if (slides.length === 0) return;
  const prefersReducedMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

  function showSlide(index) {
    gameCarouselIndex = (index + slides.length) % slides.length;
    slides.forEach((s, i) => s.classList.toggle('active', i === gameCarouselIndex));
    dots.forEach((d, i) => {
      d.classList.toggle('active', i === gameCarouselIndex);
      d.setAttribute('aria-selected', i === gameCarouselIndex ? 'true' : 'false');
    });
  }

  function restartAutoAdvance() {
    clearInterval(gameCarouselTimer);
    if (prefersReducedMotion) return; // manuelle Navigation (Pfeile/Punkte) bleibt trotzdem moeglich
    gameCarouselTimer = setInterval(() => showSlide(gameCarouselIndex + 1), GAME_CAROUSEL_INTERVAL_MS);
  }

  el('game-carousel-prev').addEventListener('click', () => { showSlide(gameCarouselIndex - 1); restartAutoAdvance(); });
  el('game-carousel-next').addEventListener('click', () => { showSlide(gameCarouselIndex + 1); restartAutoAdvance(); });
  dots.forEach((d, i) => d.addEventListener('click', () => { showSlide(i); restartAutoAdvance(); }));

  // Auto-Advance pausiert bei Hover/Fokus - ein waehrenddessen wegspringendes
  // Slide waere schlecht, gerade wenn man den "Direkt starten"-Button anvisiert.
  root.addEventListener('mouseenter', () => clearInterval(gameCarouselTimer));
  root.addEventListener('mouseleave', restartAutoAdvance);
  root.addEventListener('focusin', () => clearInterval(gameCarouselTimer));
  root.addEventListener('focusout', restartAutoAdvance);

  root.querySelectorAll('.game-carousel-cta').forEach((btn) => {
    btn.addEventListener('click', () => {
      sound.unlockAudio();
      sound.playClick();
      const mode = btn.dataset.mode;
      state.settings.mode = mode;
      // Gleicher PulseMap-Default wie beim Moduswechsel in der Lobby (siehe
      // choice-mode-Wiring in wireLobbyControls()) - "Direkt starten" soll
      // dieselbe unbegrenzte Zeit als Vorgabe bekommen, nicht die zuletzt
      // fuer einen anderen Modus gewaehlte Rundendauer.
      if (mode === 'heatmap') state.settings.timeLimitMs = null;
      soloFlow();
    });
  });

  restartAutoAdvance();
}

function resetToMenu() {
  // Abbruch-Tracking: nur wenn #screen-heatmap gerade aktiv ist (also noch
  // eine Runde lief) - von der Leaderboard-Ansicht aus "zurueck zum Menue"
  // ist KEIN Abbruch, das ist ein regulaer beendetes Spiel (siehe
  // recordHeatmapGameCompleted() in renderLeaderboard()).
  if (state.settings.mode === 'heatmap' && el('screen-heatmap').classList.contains('active')) {
    recordHeatmapDropOff(state.round.index);
  }
  clearInterval(hudTimerInterval);
  clearInterval(resultCountdownInterval);
  // clearHeatmapTimer() statt nur clearInterval(heatmapTimerInterval): das
  // eigenstaendige Heatmap-Rundentimer-Intervall (renderHeatmapTimer(),
  // 250ms-Tick fuer Countdown+Tension-Audio) wurde hier bisher NICHT
  // aufgeraeumt - verliess man eine zeitlimitierte PulseMap-Runde vorzeitig
  // ueber "Spiel verlassen", lief der Timer im Hintergrund weiter (bis die
  // inzwischen stale Zeitdifferenz von selbst ablief), inklusive unnoetiger
  // Tension-Audio-Updates auf ein verstecktes Element. Audit-Fund 1.1.
  clearHeatmapTimer();
  sound.stopRoundAmbience();
  hideStateOverlay();
  hideJoinModal();
  el('connection-banner').classList.add('hidden');
  panoViewer?.destroy();
  panoViewer = null;
  // Analog zu panoViewer: heatmapMap war bisher ein Page-Lifetime-Singleton,
  // der beim Zurueck-zum-Menue nie zerstoert wurde - der zugrundeliegende
  // Leaflet-Kartenkontext blieb im Hintergrund bestehen, obwohl der Screen
  // gar nicht mehr sichtbar ist. HeatmapMap.destroy() (neu) ruft Leaflets
  // eigenes map.remove() auf, das seine DOM-Listener/Tile-Referenzen
  // vollstaendig freigibt - ensureHeatmapWidgets() erstellt beim naechsten
  // Partie-Start dann einfach eine frische Instanz.
  heatmapMap?.destroy();
  heatmapMap = null;
  // Raeumt pendente Runden-/Leave-Timer und Bus-Listener auf - wichtig seit
  // "Spiel verlassen" auch mitten in einer laufenden Runde moeglich ist,
  // sonst wuerde z. B. ein noch laufender Rundentimer spaeter auf einen
  // bereits zerstoerten PeerManager broadcasten.
  controller?.destroy?.();
  controller = null;
  activeMapSetDetail = null;
  peerManager?.destroy();
  peerManager = null;
  state.role = null;
  state.roomCode = null;
  state.players = new Map();
  state.scores = new Map();
  state.roundHistory = [];
  state.hp = new Map();
  state.pool = null;
  state.challenge = null;
  history.replaceState(null, '', location.pathname + location.search);
  updateChrome('Nicht verbunden', null);
  showScreen('menu');
  renderDailyChallengeCard();
  renderMenuStats();
  renderHeatmapMenuStats();
  renderProfileSummary();
}

// Klick-Impact-Ripple fuer die neuen Neo-Brutalism-CTAs (.cta-mega,
// .action-card): rein visuell, blockiert/ersetzt keinen bestehenden
// Click-Handler, da nur ein zusaetzlicher Listener registriert wird.
function attachRipple(button) {
  if (!button) return;
  button.addEventListener('click', (e) => {
    const rect = button.getBoundingClientRect();
    const size = Math.max(rect.width, rect.height) * 2;
    const x = (e.clientX ?? rect.left + rect.width / 2) - rect.left - size / 2;
    const y = (e.clientY ?? rect.top + rect.height / 2) - rect.top - size / 2;
    const ripple = document.createElement('span');
    ripple.className = 'btn-ripple';
    ripple.style.width = ripple.style.height = `${size}px`;
    ripple.style.left = `${x}px`;
    ripple.style.top = `${y}px`;
    button.appendChild(ripple);
    ripple.addEventListener('animationend', () => ripple.remove());
  });
}

// Leises Hover-Sound-Feedback (sound.playHover(), Audit Quick-Win #4) -
// mouseenter statt mouseover: bubbelt nicht und feuert genau einmal beim
// tatsaechlichen Betreten des Elements, kein Debouncing noetig (anders als
// bei delegiertem mouseover auf einem Container).
function attachHoverSound(button) {
  if (!button) return;
  button.addEventListener('mouseenter', () => sound.playHover());
}

// Zahlenformat folgt der UI-Sprache statt einem hart verdrahteten 'de-DE' -
// in einer englischen Oberflaeche wirkten deutsche Tausenderpunkte
// ("12.345 pts") schlicht wie ein Tippfehler.
// Ueberschrift des Endstands: Key (und ggf. Spielername) am Element
// hinterlegen statt nur den fertigen Text zu setzen - sonst bliebe die
// Ueberschrift bei einem Sprachwechsel in der alten Sprache stehen, weil sie
// aus JS kommt und applyTranslations() sie nicht kennt.
function setBoardHeading(heading, key, name) {
  heading.dataset.i18nKey = key;
  if (name) heading.dataset.i18nName = name;
  else delete heading.dataset.i18nName;
  heading.textContent = name ? t(key, { name }) : t(key);
}

// Zieht die dynamisch (nicht per data-i18n) gesetzten Texte des Kern-Loops
// nach einem Sprachwechsel nach. Alles Noetige steht in data-Attributen am
// jeweiligen Element, damit das hier ohne Zugriff auf den Spielzustand geht -
// der ist nach einem Spielende naemlich schon wieder leer.
function refreshDynamicI18n() {
  const resultHeading = el('result-heading');
  if (resultHeading?.dataset.roundN) {
    resultHeading.textContent = t('resultRoundOf', {
      n: resultHeading.dataset.roundN,
      total: resultHeading.dataset.roundTotal,
    });
  }
  const boardHeading = el('board-heading');
  if (boardHeading?.dataset.i18nKey) {
    const name = boardHeading.dataset.i18nName;
    boardHeading.textContent = name
      ? t(boardHeading.dataset.i18nKey, { name })
      : t(boardHeading.dataset.i18nKey);
  }
  for (const id of ['minimap-style-label', 'result-map-style-label', 'overview-map-style-label']) {
    const label = el(id);
    if (label?.dataset.style) updateMapStyleLabel(id, label.dataset.style);
  }
}

function numberLocale() {
  return getLang() === 'de' ? 'de-DE' : 'en-US';
}

function formatNumber(value) {
  return Number(value).toLocaleString(numberLocale());
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str ?? '';
  return div.innerHTML;
}

// ---------------------------------------------------------------- boot

function handleDeepLink() {
  const challengeMatch = location.hash.match(/challenge=([^&]+)/);
  if (challengeMatch) {
    startChallengeFromLink(challengeMatch[1]);
    return;
  }
  const match = location.hash.match(/room=([A-Za-z0-9]+)/);
  if (!match) return;
  const code = match[1].toUpperCase();
  autoJoinFromDeepLink(code);
}

// Direkter Beitritts-Link: sofort verbinden statt erst das Hauptmenue mit
// vorausgefuelltem Modal zu zeigen - getName() liefert immer einen nutzbaren
// Namen (gespeicherter oder Default), ein Gast muss also nichts eingeben,
// bevor es losgeht (siehe joinFlow()/getName()). joinFlow() selbst wartet
// den Verbindungsversuch (Erfolg wie Fehlschlag) vollstaendig ab, bevor sein
// Promise aufloest - das await hier ist also entweder schon "Client-
// Controller registriert, ROOM_JOIN_ACCEPTED kommt gleich per WebRTC nach"
// oder "Fehler bereits per showMenuError() gemeldet" (landet mangels
// offenem Beitreten-Modal automatisch im #menu-error-Feld).
async function autoJoinFromDeepLink(code) {
  showStateOverlay({ title: t('connectingToRoom'), message: '' });
  await joinFlow(code);
  hideStateOverlay();
}

// Startet direkt eine Solo-Session mit den im Link kodierten Einstellungen
// (siehe core/challenge.js) statt der normalen Menue->Lobby->Klick-Kette -
// derselbe Seed liefert ueber resolveRoundLocations() garantiert dieselben
// Runden wie beim urspruenglichen Ersteller des Links.
async function startChallengeFromLink(raw) {
  const decoded = decodeChallengeLink(raw);
  // Hash sofort entfernen, damit ein Reload/erneuter Aufruf derselben Seite
  // nicht denselben Link ungewollt ein zweites Mal automatisch startet.
  history.replaceState(null, '', location.pathname + location.search);
  if (!decoded) {
    showToast('Dieser Challenge-Link ist ungültig oder beschädigt.');
    return;
  }
  await ensureMapSetIndex();
  const entry = mapSetIndex.find((e) => e.id === decoded.mapSetId);
  if (!entry || !entry.available) {
    showToast(
      entry
        ? `„${entry.name}“ braucht einen eigenen Mapillary-Zugangstoken, um diese Challenge zu spielen.`
        : 'Diese Karte ist nicht mehr verfügbar.'
    );
    return;
  }
  await soloFlow();
  controller.updateSettings({
    mapSetId: decoded.mapSetId,
    roundCount: decoded.roundCount,
    timeLimitMs: decoded.timeLimitMs,
    mode: decoded.mode,
    modifier: decoded.modifier,
    mutators: { fogOfWar: false, brokenCompass: false, noPan: false },
  });
  state.challenge = { type: 'link', seed: decoded.seed };
  renderLobby();
  await startGameFromLobby(decoded.seed);
}

// Tages-Challenge: fester Kartenpaket + feste Einstellungen (siehe
// DAILY_CHALLENGE_SETTINGS) mit einem aus dem aktuellen UTC-Datum
// abgeleiteten Seed, damit weltweit alle Spieler an einem Tag exakt
// dieselben Orte bekommen. Zaehlt pro Tag nur einmal (siehe getDailyResult).
async function startDailyChallenge() {
  const already = getDailyResult();
  if (already) {
    showToast(`Du hast die heutige Challenge schon gespielt: ${already.score.toLocaleString(numberLocale())} Punkte. Morgen gibt's neue Orte.`);
    return;
  }
  await ensureMapSetIndex();
  const entry = mapSetIndex.find((e) => e.id === DAILY_CHALLENGE_MAPSET_ID);
  if (!entry || !entry.available) {
    showToast('Die Tages-Challenge ist gerade nicht verfügbar.');
    return;
  }
  await soloFlow();
  const seed = dailySeed();
  controller.updateSettings({ mapSetId: DAILY_CHALLENGE_MAPSET_ID, ...DAILY_CHALLENGE_SETTINGS });
  state.challenge = { type: 'daily', seed };
  renderLobby();
  await startGameFromLobby(seed);
}

// Aktualisiert die Tages-Challenge-Kachel im Hauptmenue (Status: noch nicht
// gespielt / heutiges Ergebnis) - aufgerufen beim Boot und jedes Mal, wenn
// resetToMenu() zurueck zum Menue fuehrt, damit ein gerade gespieltes
// Ergebnis sofort sichtbar ist.
function renderDailyChallengeCard() {
  const card = el('btn-daily-challenge');
  const sub = el('daily-challenge-sub');
  const result = getDailyResult();
  if (result) {
    card.classList.add('done');
    sub.textContent = `Heute gespielt: ${result.score.toLocaleString(numberLocale())} Punkte · morgen neue Orte`;
  } else {
    card.classList.remove('done');
    sub.textContent = 'Jeden Tag dieselben Orte für alle';
  }
}

// Fuellt das kleine Statistik-Panel im Hauptmenue aus core/player-stats.js -
// bleibt ausgeblendet, solange noch keine einzige Partie gespielt wurde.
function renderMenuStats() {
  const stats = getPlayerStats();
  const panel = el('menu-stats-panel');
  panel.classList.toggle('hidden', stats.gamesPlayed === 0);
  if (stats.gamesPlayed === 0) return;
  el('stat-games-played').textContent = String(stats.gamesPlayed);
  el('stat-avg-score').textContent = averageScore(stats).toLocaleString(numberLocale());
  el('stat-best-score').textContent = stats.bestGameScore.toLocaleString(numberLocale());
}

function renderHeatmapMenuStats() {
  const stats = getHeatmapStats();
  const panel = el('heatmap-stats-panel');
  panel.classList.toggle('hidden', stats.roundsSolved === 0);
  if (stats.roundsSolved > 0) {
    el('heatmap-stat-solved').textContent = String(stats.roundsSolved);
    el('heatmap-stat-avg-attempts').textContent = String(averageAttempts(stats));
    el('heatmap-stat-best-attempts').textContent = String(stats.bestAttempts);
  }

  const dropOff = topDropOffRound(stats);
  const hint = el('heatmap-dropoff-hint');
  // Erst ab ein paar Datenpunkten anzeigen - bei nur einem einzigen
  // Abbruch waere "meistens in Runde X" nur Zufall, keine echte Tendenz.
  hint.classList.toggle('hidden', !dropOff || dropOff.count < 3);
  if (dropOff && dropOff.count >= 3) {
    hint.textContent = `Du steigst am häufigsten in Runde ${dropOff.roundNumber} aus (${Math.round(dropOff.share * 100)}% deiner Abbrüche).`;
  }
}

// Modus-uebergreifende Fortschrittsanzeige (Rang-Tier + Daily-Streak, siehe
// core/rank-tier.js/core/profile.js) - anders als renderMenuStats()/
// renderHeatmapMenuStats() oben nicht an einen einzelnen Modus gebunden,
// deshalb ein eigenes Panel statt in eines der beiden bestehenden gequetscht.
function renderProfileSummary() {
  const aggregated = getAggregatedStats();
  const panel = el('profile-summary-panel');
  panel.classList.toggle('hidden', aggregated.totalGamesPlayed === 0);
  if (aggregated.totalGamesPlayed === 0) return;

  const tier = getRankTier(aggregated.totalGamesPlayed);
  el('rank-badge').className = `rank-badge rank-${tier.id}`;
  el('rank-badge-icon').textContent = tier.icon;
  el('rank-badge-name').textContent = t(tier.nameKey);
  el('rank-badge-next').textContent = tier.next ? t('rankTierNext', { count: tier.next.gamesNeeded, name: t(tier.next.nameKey) }) : t('rankTierMax');

  const streak = getProfile().dailyStreak;
  const streakBadge = el('streak-badge');
  streakBadge.hidden = streak.current < 2; // ab 1 Tag noch keine "Straehne" - erst ab dem zweiten Tag in Folge sichtbar
  el('streak-badge-count').textContent = String(streak.current);
}

// ---------------------------------------------------------------- Erfolge

function renderAchievementsModal() {
  const grid = el('achievements-grid');
  grid.innerHTML = getAchievementsWithStatus()
    .map(
      (a) => `
        <div class="achievement-tile${a.unlocked ? ' unlocked' : ''}">
          <span class="achievement-tile-icon" aria-hidden="true">${a.unlocked ? a.icon : '🔒'}</span>
          <span class="achievement-tile-name">${escapeHtml(t(a.nameKey))}</span>
          <span class="achievement-tile-desc">${escapeHtml(t(a.descKey))}</span>
        </div>
      `
    )
    .join('');
}

function showAchievementsModal() {
  renderAchievementsModal();
  el('achievements-modal').classList.remove('hidden');
}

function hideAchievementsModal() {
  el('achievements-modal').classList.add('hidden');
}

function initAchievementsModal() {
  el('achievements-cta').addEventListener('click', () => {
    sound.playClick();
    showAchievementsModal();
  });
  el('achievements-modal-close').addEventListener('click', () => {
    sound.playClick();
    hideAchievementsModal();
  });
  el('achievements-modal').addEventListener('click', (e) => {
    if (e.target.id === 'achievements-modal') hideAchievementsModal();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el('achievements-modal').classList.contains('hidden')) hideAchievementsModal();
  });
}

/** Nach jeder beendeten Partie aufrufen (siehe renderLeaderboard()) -
 * zeigt fuer jedes neu freigeschaltete Achievement einen eigenen Toast,
 * leicht zeitversetzt (statt alle auf einmal uebereinander), falls
 * mehrere in derselben Partie gleichzeitig faellig wurden (z.B. "erste
 * Partie" + "3-Tage-Straehne" am selben Tag). */
function announceNewAchievements() {
  const unlocked = checkAchievements();
  unlocked.forEach((a, i) => {
    setTimeout(() => showToast(`${a.icon} ${t('achievementUnlockedToast', { name: t(a.nameKey) })}`, 4000), i * 1200);
  });
}

function wireBusEvents() {
  bus.on('ui:lobby-updated', renderLobby);
  bus.on('ui:lobby-joined', () => {
    enterLobby();
  });
  bus.on('ui:game-started', () => {
    // Zaehlt separat vom automatischen Seitenaufruf-Tracking (siehe Skript-
    // Tag in index.html), wie oft tatsaechlich eine Partie gestartet wurde -
    // aussagekraeftiger als reine Seitenaufrufe fuer "wurde das Spiel
    // wirklich gespielt". window.goatcounter fehlt lokal/offline (Skript
    // blockiert oder noch nicht geladen) - optional verketten statt hart
    // vorauszusetzen.
    window.goatcounter?.count({ path: `game-started-${state.settings.mode}`, event: true });
    // Mitspieler (nicht der Host) fragen hier bewusst NICHT mehr die volle
    // Kartenpaket-Datei ab - das war eine Sicherheitsluecke: die Datei
    // enthaelt die echten Koordinaten aller moeglichen Standorte, im
    // DevTools-Netzwerktab fuer jeden sichtbar. Was fuers HUD noetig ist
    // (Name/Quelle/Bounding-Box, Hinweistext, Fun-Fact) kommt jetzt direkt
    // vom Host per GAME_START/ROUND_START/ROUND_RESULT (siehe net/host.js).
    // Heatmap-Modus hat kein Kartenpaket/keine Panoramen - eigener Screen.
    if (state.settings.mode !== 'heatmap') showScreen('hud');
    hideLoadProgress();
  });
  bus.on('ui:heatmap-round-started', renderHeatmapRoundStart);
  bus.on('ui:heatmap-guess-result', renderHeatmapGuessResult);
  bus.on('ui:heatmap-activity', renderHeatmapActivity);
  bus.on('ui:heatmap-round-result', renderHeatmapRoundResult);
  bus.on('ui:heatmap-turn-update', renderHeatmapTurnUpdate);
  bus.on('ui:heatmap-solved-waiting', renderHeatmapSolvedWaiting);
  bus.on('ui:map-resolving', renderLoadProgress);
  bus.on('ui:map-resolve-failed', () => {
    hideLoadProgress();
    showToast(t('toastNoImagesFound'));
    renderLobby();
  });
  bus.on('ui:round-buffering', () => {
    clearInterval(resultCountdownInterval);
    const hint = el('result-next-hint');
    hint.textContent = t('toastGeneratingNext');
    hint.classList.add('buffering');
    el('btn-advance-round').hidden = true;
  });
  bus.on('ui:round-cap-adjusted', ({ roundCount }) => {
    showToast(t('toastMapExhausted'));
    el('hud-round-total').textContent = String(roundCount).padStart(2, '0');
    renderRoundProgress();
  });
  bus.on('ui:round-started', renderRoundStart);
  bus.on('ui:player-guessed', ({ peerId }) => {
    renderPeerStatus();
    if (peerId !== state.self.id) {
      const name = state.players.get(peerId)?.name || t('defaultOpponentName');
      showToast(`${name} hat getippt!`);
    }
  });
  bus.on('ui:round-result', renderRoundResult);
  bus.on('ui:game-over', renderLeaderboard);
  bus.on('ui:tab-switch-warning', ({ peerId }) => {
    if (peerId === state.self.id) return;
    const name = state.players.get(peerId)?.name || t('defaultOpponentName');
    showToast(`⚠ ${name} hat den Tab gewechselt`);
  });
  bus.on('ui:emote-received', ({ peerId, emoji }) => {
    if (peerId === state.self.id) return;
    spawnEmote(emoji);
  });
  // Sichtbares Gegenstueck zum stillen Fallback, den resolveProxiedPanoramaUrl()
  // in net/host.js frueher hatte (Live-Report: Mitspieler konnte trotz Proxy
  // noch die rohe Mapillary-URL im Network-Tab sehen) - der Host bekommt
  // jetzt einen Hinweis, WENN das fuer eine Runde passiert ist, statt es nie
  // zu erfahren. Nur host-lokal (net:proxy-fallback wird nie gebroadcastet),
  // bei Mitspielern feuert dieser Listener also nie.
  bus.on('net:proxy-fallback', ({ roundIndex }) => {
    showToast(t('toastProxyFallback', { round: (roundIndex ?? 0) + 1 }), 6000);
  });
  bus.on('ui:heatmap-ping-received', ({ playerId, emoji, countryId }) => {
    if (playerId === state.self.id) return; // eigener Ping zeigt sich schon lokal in startHeatmapPingPick()
    heatmapMap?.pingCountry(countryId, emoji);
    // Fremder Ping ist eine Mitteilung eines Mitspielers - schwaecher als das
    // eigene Setzen (tapLight dort), aber nicht stumm: sonst geht er unter,
    // waehrend man gerade die Laendersuche tippt.
    haptics.tapLight();
  });
  bus.on('ui:join-rejected', ({ reason }) => {
    resetToMenu();
    showMenuError(reason || 'Beitritt abgelehnt.');
  });
  // Nur im Lobby-Zustand automatisch neu verbinden versuchen (Audit-Fund
  // 1.2): der Host reserviert einen getrennten Spieler-Slot bereits fuer
  // LEAVE_GRACE_MS (siehe net/host.js _onPeerLost()) - bisher nutzte das
  // aber niemand, ein kurzer Netzwechsel (Handy WLAN<->Mobilfunk) landete
  // sofort im Sackgassen-"Verbindung verloren"-Screen, obwohl der Host noch
  // gewartet haette. Bewusst NICHT waehrend einer laufenden Runde: das
  // Protokoll kennt keinen "mitten in der Partie wieder einsteigen"-Zustand
  // (_handleJoin() in host.js behandelt jeden Beitritt als frischen Lobby-
  // Beitritt, ohne Runden-/Punktestand mitzuschicken) - ein automatischer
  // Reconnect wuerde den Spieler dort nur in einer veralteten Lobby-Ansicht
  // stranden, waehrend das eigentliche Spiel anderswo weiterlaeuft. Ein
  // ehrlicher sofortiger "Verbindung verloren"-Hinweis ist dort das
  // kleinere Uebel, bis das Protokoll einen echten Rundenstand-Resume kennt.
  bus.on('ui:host-disconnected', () => {
    const stillInLobby = document.getElementById('screen-lobby')?.classList.contains('active');
    if (stillInLobby && state.role === 'client') attemptReconnect();
    else showHostLostOverlay();
  });
  bus.on('ui:kicked', ({ reason }) => {
    showStateOverlay({
      title: 'Aus der Partie entfernt',
      message: reason || 'Der Host hat dich aus der Partie entfernt.',
      actionLabel: 'Zurück zum Menü',
      onAction: resetToMenu,
    });
  });
  bus.on('ui:player-kicked', ({ peerId, reason }) => {
    if (peerId === state.self.id) return; // eigener Kick laeuft ueber ui:kicked
    const name = state.players.get(peerId)?.name || t('defaultOpponentName');
    showToast(`${name} wurde entfernt: ${reason}`);
  });
  bus.on('net:error', (err) => {
    console.error('Netzwerkfehler', err);
  });
  bus.on('ui:guess-unconfirmed', () => {
    showToast(t('toastGuessFailed'));
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// oder ein Dev-Server ohne HTTPS/localhost wuerden hier ohnehin
  // ablehnen - der catch() faengt das ab, statt den Boot zu stoeren.
  navigator.serviceWorker
    .register('./sw.js')
    .then((reg) => {
      // Browser pruefen von sich aus nur passiv/gedrosselt auf ein neues
      // sw.js (je nach Browser bis zu 24h) - live erlebt: ein bereits
      // deployter Fix blieb dadurch fuer wiederkehrende Spieler unsichtbar,
      // bis sie zufaellig/durch manuelles Cache-Leeren einen frischen
      // Registrierungs-Zyklus ausloesten. update() stoesst die Pruefung
      // jetzt bei JEDEM Seitenaufruf sofort selbst an, statt auf den
      // Browser-Timer zu warten.
      reg.update().catch(() => {});
      // skipWaiting()/clients.claim() im SW sorgen zwar dafuer, dass ein neu
      // gefundener Service Worker sofort uebernimmt - der bereits im Browser
      // ausgefuehrte JS-Code DIESER Seite laeuft davon unberuehrt weiter, bis
      // tatsaechlich neu geladen wird (das kann kein Code nachtraeglich
      // "hot-patchen"). controllerchange feuert genau in diesem Moment - ein
      // sichtbarer Hinweis statt eines stillen Zustands, in dem man
      // unbemerkt mit veraltetem Code weiterspielt.
      let announced = false;
      navigator.serviceWorker.addEventListener('controllerchange', () => {
        if (announced) return;
        announced = true;
        showToast('Neue Version verfügbar — bitte einmal neu laden.', 8000);
      });
    })
    .catch((err) => console.warn('Service Worker nicht registriert:', err.message));
}

async function boot() {
  registerServiceWorker();
  applyTranslations();
  // Auch einmal initial, nicht nur bei jedem Sprachwechsel: die
  // Ausgangsbeschriftungen der dynamischen Elemente stehen deutsch im Markup
  // (Ergebnis- und Endstand-Ueberschrift) und waeren sonst bis zum ersten
  // Render in der falschen Sprache.
  refreshDynamicI18n();
  initLangToggle();
  initProfileUI();
  initThemeToggle();
  initSoundToggle();
  initLeaveGameButton();
  initBrandHomeLink();
  initJoinModal();
  initQrModal();
  initAchievementsModal();
  initInviteCard();
  initMapSetModal();
  initRulesAccordion();
  wirePresets();
  initVisibilityWatch();
  wireMenuControls();
  wireGameCarousel();
  wireLobbyControls();
  wireHudControls();
  wireHeatmapControls();
  initHeatmapSearchViewportOffset();
  initMapsetModalViewportOffset();
  wireResultControls();
  wireLeaderboardControls();
  wireBusEvents();
  renderDailyChallengeCard();
  renderMenuStats();
  renderHeatmapMenuStats();
  renderProfileSummary();
  handleDeepLink();
  ensureMapSetIndex().catch((err) => console.error('Kartenpaket-Index konnte nicht geladen werden', err));
}

boot();
