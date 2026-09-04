import { bus, state } from './core/state.js';
import { PeerManager, generateRoomCode } from './net/peer-manager.js';
import { HostController } from './net/host.js';
import { ClientController } from './net/client.js';
import { GuessMap } from './map/guess-map.js';
import { ResultMap } from './map/result-map.js';
import { HeatmapMap } from './map/heatmap-map.js';
import { PanoViewer } from './panorama/pano-viewer.js';
import { ensureCountryStore, searchCountries, findCountryByName } from './core/country-store.js';
import { getColorForDistance } from './core/heatmap-color.js';
import { showScreen } from './ui/router.js';
import { showToast } from './ui/toast.js';
import { burst as particleBurst } from './ui/particles.js';
import * as haptics from './ui/haptics.js';
import { loadMapSetIndex, loadMapSetDetail } from './core/pool-loader.js';
import { getHighScore, recordScoreIfBest } from './core/high-scores.js';
import { getPlayerStats, averageScore, recordGamePlayed } from './core/player-stats.js';
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

const PROFILE_KEY = 'geofinder.profile';
const RESULT_DISPLAY_SECONDS = 8;
const ROUND_COUNT_OPTIONS = [3, 5, 10];
const DURATION_OPTIONS = [30000, 60000, 90000, 180000, null];

let peerManager = null;
let controller = null;
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
  return name || 'Spieler';
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
  // data/map-sets/weltweit.json traegt intern noch "id":"starter-pool" (ein
  // Altlast-Name aus einer frueheren Version der Datei) statt "weltweit" wie
  // im Index - ohne diese Korrektur wuerde state.pool.id nicht mit der ID
  // uebereinstimmen, unter der Highscores/Challenge-Links das Paket kennen,
  // und beide Features wuerden fuer "Weltweit (Standard)" leise ins Leere laufen.
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
    banner.textContent = `${lost.name} hat die Verbindung verloren — wartet auf Rückkehr…`;
    banner.classList.remove('hidden');
  } else {
    banner.classList.add('hidden');
  }
}

// ---------------------------------------------------------------- menu

function showMenuError(message) {
  const errorEl = el('menu-error');
  errorEl.textContent = message;
  errorEl.hidden = false;
}

function clearMenuError() {
  el('menu-error').hidden = true;
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
  }
}

async function joinFlow(rawCode) {
  sound.unlockAudio();
  sound.playClick();
  clearMenuError();
  const code = extractRoomCode(rawCode);
  if (!code) {
    showMenuError('Bitte einen gültigen Raum-Code oder Link eingeben.');
    return;
  }
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
  }
}

function extractRoomCode(raw) {
  const trimmed = (raw || '').trim();
  const match = trimmed.match(/room=([A-Za-z0-9]+)/);
  const codePart = match ? match[1] : trimmed;
  return codePart.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function soloFlow() {
  sound.unlockAudio();
  sound.playClick();
  clearMenuError();
  peerManager = createSoloPeerManager();
  controller = new HostController(peerManager);
  controller.registerSelfAsHost(peerManager.peer.id, getName(), state.self.color);
  state.roomCode = null;
  updateChrome('Solo', peerManager.peer.id);
  await enterLobby();
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
      </div>
      <div class="mapset-card-body">
        <span class="mapset-card-badge ${badgeClass}">${badgeText}</span>
        <span class="mapset-card-name">${escapeHtml(entry.name)}</span>
        <span class="mapset-card-desc">${escapeHtml(entry.description)}</span>
      </div>
    `;
    card.addEventListener('click', (e) => {
      if (!isHost || !entry.available) return;
      sound.playClick();
      controller.updateSettings({ mapSetId: entry.id });
      renderMapSetGrid();

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
    el('lobby-stage-name').textContent = 'Heatmap-Modus';
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
  el('lobby-stage-name').textContent = entry.name;
  el('lobby-stage-desc').textContent = entry.description;

  const best = getHighScore(entry.id, state.settings.mode);
  el('lobby-stage-best').classList.toggle('hidden', best == null);
  if (best != null) {
    el('lobby-stage-best-text').textContent = `Persönlicher Bestwert: ${best.toLocaleString('de-DE')} Punkte`;
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

  // Gleitenden Thumb hinter den ausgewaehlten Button positionieren.
  const thumb = row.querySelector('.choice-thumb');
  if (thumb && selectedBtn) {
    thumb.style.opacity = '1';
    thumb.style.transform = `translateX(${selectedBtn.offsetLeft - 3}px)`;
    thumb.style.width = `${selectedBtn.offsetWidth}px`;
  } else if (thumb) {
    thumb.style.opacity = '0';
  }
}

function renderMutators() {
  const isHost = state.role === 'host';
  const mutators = state.settings.mutators || {};
  el('mutator-list').querySelectorAll('.mutator-chip').forEach((chip) => {
    chip.classList.toggle('selected', Boolean(mutators[chip.dataset.mutator]));
    chip.disabled = !isHost;
  });
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

  el('lobby-heading').textContent = isSolo ? 'Solo-Einstellungen' : 'Warten auf Mitspieler';
  el('lobby-share-row').classList.toggle('hidden', isSolo);
  el('lobby-room-code-row').classList.toggle('hidden', isSolo);
  el('lobby-players-panel').classList.toggle('hidden', isSolo);

  if (!isSolo) {
    el('lobby-room-code').textContent = state.roomCode || '—';
    const shareLink = `${location.origin}${location.pathname}#room=${state.roomCode}`;
    el('lobby-share-link').textContent = shareLink;

    el('lobby-player-count').textContent = String(players.length);
    const listEl = el('lobby-player-list');
    listEl.innerHTML = '';
    for (const p of players) {
      const row = document.createElement('div');
      row.className = 'player-row';
      const initial = (p.name || '?').trim().charAt(0).toUpperCase();
      const statusClass = !p.connected ? 'status-offline' : p.ready ? 'status-ready' : 'status-wait';
      const statusText = !p.connected ? 'getrennt' : p.ready ? 'Bereit' : 'wartet…';
      row.innerHTML = `
        <div class="avatar" style="background:${p.color};">${initial}</div>
        <div class="player-name">${escapeHtml(p.name)} ${p.isHost ? '<span class="host-tag">Host</span>' : ''}</div>
        <div class="status-pill ${statusClass}">${statusText}</div>
      `;
      listEl.appendChild(row);
    }
  }

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
  el('lobby-mapset-panel').classList.toggle('hidden', isHeatmap);
  el('heatmap-mode-note').classList.toggle('hidden', !isHeatmap);
  el('heatmap-settings-group').classList.toggle('hidden', !isHeatmap);
  el('panorama-controls-group').classList.toggle('hidden', isHeatmap);
  el('battle-royale-mode-note').classList.toggle('hidden', !isBattleRoyale);
  // Die Rundenzahl ergibt sich in diesem Modus automatisch aus der
  // Spielerzahl (siehe net/host.js startGame()) - der Runden-Wahlschalter
  // waere hier nur irrefuehrend.
  el('choice-rounds').closest('.setting-group').classList.toggle('hidden', isBattleRoyale);
  if (isHeatmap) {
    renderChoiceRow('choice-heatmap-labels', state.settings.heatmapLabels);
    renderChoiceRow('choice-heatmap-opponent-info', state.settings.heatmapOpponentInfo);
    renderChoiceRow('choice-heatmap-turn-mode', state.settings.heatmapTurnMode);
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
      ? 'Bereit zum Start.'
      : others.length === 0
        ? 'Warte, bis mindestens ein Mitspieler dem Raum beitritt.'
        : 'Warte, bis alle Mitspieler bereit sind.';
  } else {
    readyBtn.hidden = false;
    startBtn.hidden = true;
    const me = state.players.get(state.self.id);
    readyBtn.textContent = me?.ready ? 'Nicht bereit' : 'Bereit';
    hint.textContent = 'Warte auf den Host, das Spiel zu starten.';
  }

  updateConnectionBanner();
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
  el('lobby-load-progress-label').textContent = `Suche 360°-Panoramen… (${found}/${target} gefunden)`;
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
    hint.textContent = 'Lade Kartenpaket…';
    const detail = await getMapSetDetail(state.settings.mapSetId);
    activeMapSetDetail = detail;
    await controller.startGame(detail, seed);
  } catch (err) {
    console.error(err);
    hint.textContent = previousHint;
    hideLoadProgress();
    startBtn.disabled = false;
    showToast('Kartenpaket konnte nicht geladen werden.');
  }
}

function wireLobbyControls() {
  el('copy-link-btn').addEventListener('click', async () => {
    sound.playClick();
    const text = el('lobby-share-link').textContent;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Link kopiert');
    } catch {
      showToast('Kopieren nicht möglich — bitte manuell markieren');
    }
  });

  el('btn-ready-toggle').addEventListener('click', () => {
    sound.playClick();
    const me = state.players.get(state.self.id);
    controller.setReady(!me?.ready);
  });

  attachRipple(el('btn-start-game'));
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
  wireChoiceRow('choice-mode', 'mode', (v) => v);
  wireChoiceRow('choice-modifier', 'modifier', (v) => v);
  wireChoiceRow('choice-heatmap-labels', 'heatmapLabels', (v) => v);
  wireChoiceRow('choice-heatmap-opponent-info', 'heatmapOpponentInfo', (v) => v);
  wireChoiceRow('choice-heatmap-turn-mode', 'heatmapTurnMode', (v) => v);

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
}

// ---------------------------------------------------------------- hud

// Zeigt jeweils den Stil, in den ein Klick wechseln WUERDE (wie z.B. bei
// Google Maps ueblich), nicht den gerade aktiven.
function updateMapStyleLabel(labelId, currentStyle) {
  el(labelId).textContent = currentStyle === 'satellite' ? 'Karte' : 'Satellit';
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

function renderHpBars() {
  const container = el('hp-bars');
  if (state.settings.mode !== 'hp') {
    container.classList.add('hidden');
    return;
  }
  container.classList.remove('hidden');
  container.innerHTML = '';
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

let heatmapMap = null;
let countryStore = null;
let heatmapTimerInterval = null;
let heatmapGuessedThisRound = new Set(); // countryId - verhindert wiederholtes Antippen desselben Vorschlags
let heatmapSuggestionIndex = -1;
let heatmapOwnGuesses = []; // [{name, distanceKm}] - fuer das Top-3-Panel, pro Runde neu
let heatmapOpponentRecordKm = null; // heatmapOpponentInfo==='best': bisher bester GEGNER-Wert dieser Runde
let heatmapActiveTurnPlayerId = null; // heatmapTurnMode==='turns': wer gerade dran ist, sonst null

async function ensureHeatmapWidgets() {
  const labels = state.settings.heatmapLabels !== 'off';
  if (!heatmapMap) heatmapMap = new HeatmapMap(el('heatmap-map-container'), { labels });
  else heatmapMap.setLabels(labels); // Einstellung kann sich zwischen zwei Partien in derselben Session geaendert haben
  if (!countryStore) countryStore = await ensureCountryStore();
  heatmapMap.setCountries(countryStore.countries);
}

function heatmapPlayerName(peerId) {
  return state.players.get(peerId)?.name || 'Ein Mitspieler';
}

function clearHeatmapTimer() {
  clearInterval(heatmapTimerInterval);
  heatmapTimerInterval = null;
}

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
    if (remainingMs <= 0) clearHeatmapTimer();
  };
  clearHeatmapTimer();
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
        `<li><span class="rank">${i + 1}.</span> ${escapeHtml(g.name)} <span class="dist">${Math.round(g.distanceKm).toLocaleString('de-DE')} km</span></li>`
    )
    .join('');
}

/** heatmapOpponentInfo==='best': aktualisiert das pulsierende "Gegner-Rekord"-Widget. */
function renderHeatmapOpponentRecord(recordKm) {
  heatmapOpponentRecordKm = recordKm;
  const widget = el('heatmap-opponent-record');
  widget.classList.remove('hidden');
  el('heatmap-opponent-record-text').textContent = `Gegner-Rekord: ${Math.round(recordKm).toLocaleString('de-DE')} km`;
}

/** heatmapTurnMode==='turns': sperrt/entsperrt das Suchfeld je nachdem, wer dran ist. */
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
    status.textContent = `Warten auf ${heatmapPlayerName(activePlayerId)}…`;
  }
}

function heatmapActivityLine(text, tone = '') {
  const feed = el('heatmap-activity-feed');
  const line = document.createElement('div');
  line.className = `heatmap-activity-line${tone ? ` ${tone}` : ''}`;
  line.textContent = text;
  feed.prepend(line);
  // Feed nicht unbegrenzt wachsen lassen - alte Zeilen sind fuer den
  // Zeitdruck-Effekt ohnehin irrelevant, sobald genug neue nachgekommen sind.
  while (feed.children.length > 12) feed.removeChild(feed.lastChild);
}

function renderHeatmapGuessResult({ countryId, distanceKm, exact }) {
  heatmapMap?.colorCountry(countryId, getColorForDistance(distanceKm, exact));
  const country = countryStore?.byId.get(countryId);
  const name = country?.name ?? countryId;
  if (exact) {
    heatmapActivityLine(`Volltreffer! ${name} war richtig.`, 'exact');
  } else {
    heatmapActivityLine(`${name}: ${Math.round(distanceKm).toLocaleString('de-DE')} km entfernt`);
  }
  heatmapOwnGuesses.push({ name, distanceKm });
  renderHeatmapTop3();
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
  const { peerId, distanceKm, exact } = payload;
  if (peerId === state.self.id) return; // eigene Tipps kommen ueber ui:heatmap-guess-result mit Details
  const name = heatmapPlayerName(peerId);
  if (exact) heatmapActivityLine(`${name} hat das Zielland gefunden!`, 'exact');
  else heatmapActivityLine(`${name} tippt … (${Math.round(distanceKm).toLocaleString('de-DE')} km entfernt)`, 'peer');
}

function renderHeatmapRoundResult({ winnerPlayerId, target }) {
  clearHeatmapTimer();
  el('heatmap-search-input').disabled = true;
  el('heatmap-suggestions').classList.add('hidden');
  heatmapMap?.colorCountry(target.id, getColorForDistance(0, true));

  const banner = el('heatmap-result-banner');
  const title = el('heatmap-result-title');
  const sub = el('heatmap-result-sub');
  if (winnerPlayerId) {
    const won = winnerPlayerId === state.self.id;
    title.textContent = won ? 'Du hast es gefunden!' : `${heatmapPlayerName(winnerPlayerId)} war am schnellsten!`;
    if (won) {
      particleBurst({ colors: ['#39ff8f', '#17ecff', '#ff1fb0'] });
      haptics.tapStrong();
    }
  } else {
    title.textContent = 'Die Zeit ist abgelaufen.';
  }
  sub.textContent = `Gesuchtes Land: ${target.name}`;
  banner.classList.remove('hidden');
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
        `<button type="button" class="heatmap-suggestion${heatmapGuessedThisRound.has(c.id) ? ' guessed' : ''}" data-country-id="${escapeHtml(c.id)}" data-index="${i}">${escapeHtml(c.name)}</button>`
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
  if (state.role === 'host') controller.submitLocalHeatmapGuess(countryId);
  else controller.submitHeatmapGuess(countryId);
  el('heatmap-search-input').value = '';
  el('heatmap-suggestions').classList.add('hidden');
}

function wireHeatmapControls() {
  const input = el('heatmap-search-input');
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
      }
    } else if (e.key === 'Escape') {
      box.classList.add('hidden');
    }
  });
  el('heatmap-suggestions').addEventListener('click', (e) => {
    const btn = e.target.closest('.heatmap-suggestion');
    if (btn) handleHeatmapGuessPick(btn.dataset.countryId);
  });
}

const PANO_FADE_MS = 180;
const GUESS_BTN_DEFAULT_LABEL = 'Tipp best&auml;tigen';

// PanoViewer.load() destroys and recreates the whole Pannellum/WebGL
// instance every round (the library has no "swap image in place" API for a
// single-scene viewer) - that abrupt teardown was the visible "flackern"
// between rounds. Cant avoid the destroy/recreate itself, but a short fade-
// to-black-and-back around it turns the flash into a deliberate transition.
// Combined with PRELOAD_ROUND (net/host.js + net/client.js), the actual
// pannellum.viewer() call below almost always resolves from an already-
// cached image, so onLoad fires near-instantly and the fade is the only
// perceptible delay left.
function transitionPanorama() {
  const container = el('pano-container');
  const mutators = state.settings.mutators || {};
  container.classList.add('pano-fade-out');
  // Fog of War: startet stark verschwommen und klart ueber PANO_FOG_CLEAR_MS
  // per CSS-Transition sichtbar auf, statt sofort gestochen scharf zu sein.
  container.classList.toggle('pano-foggy', Boolean(mutators.fogOfWar));
  setTimeout(() => {
    el('pano-loading').classList.remove('hidden');
    panoViewer.load(state.round.panoramaUrl, {
      vaov: state.round.vaov,
      modifier: state.settings.modifier,
      mutators,
      onLoad: () => {
        el('pano-loading').classList.add('hidden');
        container.classList.remove('pano-fade-out');
        if (mutators.fogOfWar) {
          // Reflow erzwingen, damit der Browser den unscharfen Startzustand
          // tatsaechlich rendert, bevor die lange Clear-Up-Transition beginnt.
          container.getBoundingClientRect();
          requestAnimationFrame(() => container.classList.remove('pano-foggy'));
        }
      },
    });
  }, PANO_FADE_MS);
}

function renderRoundStart() {
  showScreen('hud');
  ensureHudWidgets();
  hintRevealed = false;

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
    confirmBtn.textContent = '👀 Zuschauer-Modus';
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
  const collapseMap = () => {
    sound.playClick();
    el('minimap').classList.remove('expanded');
    el('minimap-wrap').classList.remove('expanded');
    el('minimap').style.transform = '';
  };
  el('minimap-open-btn').addEventListener('click', expandMap);
  el('minimap-close-btn').addEventListener('click', collapseMap);
  el('minimap-style-toggle').addEventListener('click', () => {
    sound.playClick();
    const style = guessMap.toggleTileStyle();
    updateMapStyleLabel('minimap-style-label', style);
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
      el('emote-wheel').classList.add('hidden');
    });
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
    elEl.textContent = to.toLocaleString('de-DE');
    return;
  }
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    elEl.textContent = Math.round(from + (to - from) * eased).toLocaleString('de-DE');
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderRoundResult({ results, actual, actualMeta, eliminatedPlayerIds = [] }) {
  clearInterval(hudTimerInterval);
  sound.stopRoundAmbience();
  showScreen('result');
  el('result-next-hint').classList.remove('buffering');

  el('result-round-index').textContent = String(state.round.index + 1);
  el('result-round-total').textContent = String(state.round.total);

  const isBattleRoyale = state.settings.mode === 'battle-royale';
  const remainingEl = el('royale-remaining');
  if (isBattleRoyale) {
    const remaining = [...state.players.values()].filter((p) => !state.eliminatedAtRound.has(p.id)).length;
    remainingEl.textContent = `${remaining} Spieler verbleiben`;
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
  listEl.innerHTML = '';
  let myBestScore = 0;
  for (const r of sorted) {
    const player = state.players.get(r.playerId);
    if (r.playerId === state.self.id) myBestScore = r.score;
    const card = document.createElement('div');
    const justEliminated = eliminatedPlayerIds.includes(r.playerId);
    card.className = justEliminated ? 'score-card eliminated' : 'score-card';
    let meta;
    let barWidth;
    const chips = [];
    if (isCountryMode) {
      meta = r.noGuess
        ? 'Kein Tipp abgegeben'
        : r.correct
          ? `Richtig — ${escapeHtml(r.actualCountry)}`
          : `Falsch — du: ${escapeHtml(r.guessedCountry || '—')}, richtig: ${escapeHtml(r.actualCountry || '—')}`;
      barWidth = r.correct ? 100 : 4;
      if (r.streak > 0) chips.push({ cls: 'streak', html: `&#128293; ${r.streak}er-Streak` });
    } else {
      meta = r.noGuess ? 'Kein Tipp abgegeben' : `${r.distanceKm.toFixed(1)} km entfernt`;
      barWidth = Math.max(2, (r.score / 5000) * 100);
      if (!r.noGuess) chips.push({ cls: '', html: `Basis ${r.base.toLocaleString('de-DE')}` });
      if (r.timeBonus > 0) chips.push({ cls: 'bonus', html: `&#9889; +${r.timeBonus} Speed` });
      if (r.streakBonus > 0) chips.push({ cls: 'streak', html: `&#128293; +${r.streakBonus} Streak x${r.streak}` });
      if (r.hp != null) {
        chips.push({
          cls: r.hpDamage > 0 ? '' : 'streak',
          html: `${r.hpDamage > 0 ? `-${r.hpDamage} HP` : 'Kein Schaden'} · ${r.hp} HP übrig`,
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
        <span class="score-name"><span class="avatar" style="width:22px;height:22px;font-size:0.7rem;background:${player?.color || '#8c99b8'};">${(player?.name || '?').charAt(0).toUpperCase()}</span>${escapeHtml(player?.name || 'Spieler')}${justEliminated ? '<span class="score-card-eliminated-tag">Ausgeschieden</span>' : ''}</span>
        <span class="score-points">0</span>
      </div>
      <div class="score-meta">${meta}</div>
      <div class="score-bar"><i style="--target-width:${barWidth}%; background:${player?.color || 'var(--accent)'};"></i></div>
      ${chips.length ? `<div class="score-breakdown">${chipsHtml}</div>` : ''}
    `;
    listEl.appendChild(card);
    const pointsEl = card.querySelector('.score-points');
    const reduceMotion = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    setTimeout(() => animateCounter(pointsEl, 0, r.score), reduceMotion ? 0 : 1600);
  }

  renderHpBars();

  const myResult = results.find((r) => r.playerId === state.self.id);
  if (isCountryMode) {
    if (myResult?.correct) sound.playSuccess();
    else sound.playRoundReveal();
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
      particleBurst({ colors: ['#ff7a33', '#17ecff', '#ff1fb0', '#39ff8f'] });
      haptics.tapStrong();
    } else if (myResult?.hpDamage > 0) {
      haptics.tapStrong();
    } else {
      haptics.tapMedium();
    }
  }
  // Battle Royale: eigenes Ausscheiden ueberschreibt das normale Feedback
  // oben mit einem deutlich spuerbaren Impact statt eines Erfolgs-Tons.
  if (eliminatedPlayerIds.includes(state.self.id)) {
    haptics.tapStrong();
  }

  const isHost = state.role === 'host';
  el('btn-advance-round').hidden = !isHost;

  updateConnectionBanner();

  clearInterval(resultCountdownInterval);
  let remaining = RESULT_DISPLAY_SECONDS;
  const hintEl = el('result-next-hint');
  const tick = () => {
    hintEl.textContent = remaining > 0 ? `Nächste Runde in 00:${String(remaining).padStart(2, '0')}` : 'Nächste Runde…';
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
          ? `${Math.round(entry.total / 1000)}/${entry.perRound.length} richtig`
          : state.settings.mode === 'battle-royale'
            ? entry.eliminatedAtRound == null
              ? '🏆 Champion'
              : `Raus in Runde ${entry.eliminatedAtRound + 1}`
            : `${entry.total.toLocaleString('de-DE')} Pkt.`;
    step.innerHTML = `
      <div class="avatar" style="background:${player?.color || '#8c99b8'};">${initial}</div>
      <div class="podium-name">${escapeHtml(player?.name || 'Spieler')}</div>
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
      if (state.challenge?.type === 'daily') recordDailyResult(ownEntry.total);
    }
  }

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
    heading.textContent = 'Country-Streak beendet';
  } else if (state.settings.mode === 'heatmap') {
    heading.textContent = 'Heatmap-Duell beendet';
  } else if (isBattleRoyale) {
    const champion = sorted.find((e) => e.eliminatedAtRound == null);
    const championName = state.players.get(champion?.playerId)?.name;
    heading.textContent = champion ? `${championName} gewinnt die Battle Royale!` : 'Battle Royale beendet';
  } else {
    heading.textContent = 'Duell beendet';
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
      totalLabel = `<div class="num">${entry.hp ?? 0}</div><div class="lbl">HP übrig</div>`;
    } else if (isCountryMode) {
      const correctCount = Math.round(entry.total / 1000);
      totalLabel = `<div class="num">${correctCount}/${entry.perRound.length}</div><div class="lbl">Bester Streak: ${entry.bestStreak ?? 0}</div>`;
    } else if (isBattleRoyale) {
      totalLabel =
        entry.eliminatedAtRound == null
          ? `<div class="num">🏆</div><div class="lbl">Champion</div>`
          : `<div class="num">R${entry.eliminatedAtRound + 1}</div><div class="lbl">Ausgeschieden</div>`;
    } else {
      totalLabel = `<div class="num">${entry.total.toLocaleString('de-DE')}</div><div class="lbl">Punkte</div>`;
    }
    row.innerHTML = `
      <div class="rank-num">${String(idx + 1).padStart(2, '0')}</div>
      <div>
        <div class="board-name">${escapeHtml(player?.name || 'Spieler')}</div>
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
  el('btn-host').addEventListener('click', hostFlow);
  el('btn-solo').addEventListener('click', soloFlow);

  el('btn-join-toggle').addEventListener('click', () => {
    sound.unlockAudio();
    sound.playClick();
    el('join-panel').classList.toggle('hidden');
    if (!el('join-panel').classList.contains('hidden')) el('join-code-input').focus();
  });

  el('btn-join-confirm').addEventListener('click', () => joinFlow(el('join-code-input').value));
  el('join-code-input').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') joinFlow(el('join-code-input').value);
  });

  attachRipple(el('btn-daily-challenge'));
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

function resetToMenu() {
  clearInterval(hudTimerInterval);
  clearInterval(resultCountdownInterval);
  sound.stopRoundAmbience();
  hideStateOverlay();
  el('connection-banner').classList.add('hidden');
  panoViewer?.destroy();
  panoViewer = null;
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
  el('join-panel').classList.remove('hidden');
  el('join-code-input').value = match[1].toUpperCase();
  if (!state.self.name) el('player-name-input').focus();
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
        : 'Dieses Kartenpaket ist nicht mehr verfügbar.'
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
    showToast(`Du hast die heutige Challenge schon gespielt: ${already.score.toLocaleString('de-DE')} Punkte. Morgen gibt's neue Orte.`);
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
    sub.textContent = `Heute gespielt: ${result.score.toLocaleString('de-DE')} Punkte · morgen neue Orte`;
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
  el('stat-avg-score').textContent = averageScore(stats).toLocaleString('de-DE');
  el('stat-best-score').textContent = stats.bestGameScore.toLocaleString('de-DE');
}

function wireBusEvents() {
  bus.on('ui:lobby-updated', renderLobby);
  bus.on('ui:lobby-joined', () => {
    enterLobby();
  });
  bus.on('ui:game-started', () => {
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
  bus.on('ui:map-resolving', renderLoadProgress);
  bus.on('ui:map-resolve-failed', () => {
    hideLoadProgress();
    showToast('Für dieses Kartenpaket wurden keine Bilder gefunden.');
    renderLobby();
  });
  bus.on('ui:round-buffering', () => {
    clearInterval(resultCountdownInterval);
    const hint = el('result-next-hint');
    hint.textContent = 'Generiere nächste Location…';
    hint.classList.add('buffering');
    el('btn-advance-round').hidden = true;
  });
  bus.on('ui:round-cap-adjusted', ({ roundCount }) => {
    showToast('Kartenpaket erschöpft. Spiel endet nach dieser Runde.');
    el('hud-round-total').textContent = String(roundCount).padStart(2, '0');
    renderRoundProgress();
  });
  bus.on('ui:round-started', renderRoundStart);
  bus.on('ui:player-guessed', ({ peerId }) => {
    renderPeerStatus();
    if (peerId !== state.self.id) {
      const name = state.players.get(peerId)?.name || 'Ein Mitspieler';
      showToast(`${name} hat getippt!`);
    }
  });
  bus.on('ui:round-result', renderRoundResult);
  bus.on('ui:game-over', renderLeaderboard);
  bus.on('ui:tab-switch-warning', ({ peerId }) => {
    if (peerId === state.self.id) return;
    const name = state.players.get(peerId)?.name || 'Ein Mitspieler';
    showToast(`⚠ ${name} hat den Tab gewechselt`);
  });
  bus.on('ui:emote-received', ({ peerId, emoji }) => {
    if (peerId === state.self.id) return;
    spawnEmote(emoji);
  });
  bus.on('ui:join-rejected', ({ reason }) => {
    resetToMenu();
    showMenuError(reason || 'Beitritt abgelehnt.');
  });
  bus.on('ui:host-disconnected', () => {
    showStateOverlay({
      title: 'Verbindung zum Host verloren',
      message: 'Die Partie kann ohne den Host nicht fortgesetzt werden. Deine bisherigen Ergebnisse sind aber nicht verloren, du kannst jederzeit ein neues Duell starten.',
      actionLabel: 'Zurück zum Menü',
      onAction: resetToMenu,
    });
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
    const name = state.players.get(peerId)?.name || 'Ein Mitspieler';
    showToast(`${name} wurde entfernt: ${reason}`);
  });
  bus.on('net:error', (err) => {
    console.error('Netzwerkfehler', err);
  });
  bus.on('ui:guess-unconfirmed', () => {
    showToast('Tipp konnte nicht bestätigt werden — bitte Verbindung prüfen.');
  });
}

function registerServiceWorker() {
  if (!('serviceWorker' in navigator)) return;
  // file:// oder ein Dev-Server ohne HTTPS/localhost wuerden hier ohnehin
  // ablehnen - der catch() faengt das ab, statt den Boot zu stoeren.
  navigator.serviceWorker.register('./sw.js').catch((err) => console.warn('Service Worker nicht registriert:', err.message));
}

async function boot() {
  registerServiceWorker();
  initProfileUI();
  initThemeToggle();
  initSoundToggle();
  initLeaveGameButton();
  initBrandHomeLink();
  initVisibilityWatch();
  wireMenuControls();
  wireLobbyControls();
  wireHudControls();
  wireHeatmapControls();
  wireResultControls();
  wireLeaderboardControls();
  wireBusEvents();
  renderDailyChallengeCard();
  renderMenuStats();
  handleDeepLink();
  ensureMapSetIndex().catch((err) => console.error('Kartenpaket-Index konnte nicht geladen werden', err));
}

boot();
