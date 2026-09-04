import { bus, state } from './core/state.js';
import { PeerManager, generateRoomCode } from './net/peer-manager.js';
import { HostController } from './net/host.js';
import { ClientController } from './net/client.js';
import { GuessMap } from './map/guess-map.js';
import { ResultMap } from './map/result-map.js';
import { PanoViewer } from './panorama/pano-viewer.js';
import { showScreen } from './ui/router.js';
import { showToast } from './ui/toast.js';
import { loadMapSetIndex, loadMapSetDetail } from './core/pool-loader.js';
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
  const detail = await loadMapSetDetail(entry);
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
    document.getElementById('screen-result').classList.contains('active');
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
  await ensureMapSetIndex();
  // Screen zuerst sichtbar machen, DANACH rendern: renderChoiceRow() misst
  // offsetLeft/offsetWidth der Buttons fuer den gleitenden Thumb - auf einem
  // noch display:none-Screen liefert das immer 0.
  showScreen('lobby');
  renderMapSetGrid();
  renderLobby();
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

function renderLobby() {
  const isHost = state.role === 'host';
  const isSolo = !state.roomCode;
  const players = [...state.players.values()];

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
  if (mapSetIndex.length) renderMapSetGrid();

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

async function startGameFromLobby() {
  sound.playClick();
  const startBtn = el('btn-start-game');
  startBtn.disabled = true;
  const hint = el('lobby-hint');
  const previousHint = hint.textContent;
  try {
    hint.textContent = 'Lade Kartenpaket…';
    const detail = await getMapSetDetail(state.settings.mapSetId);
    activeMapSetDetail = detail;
    await controller.startGame(detail);
  } catch (err) {
    console.error(err);
    hint.textContent = previousHint;
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
  el('btn-start-game').addEventListener('click', startGameFromLobby);

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

function ensureHudWidgets() {
  if (!panoViewer) panoViewer = new PanoViewer('pano-container');
  if (!guessMap) {
    guessMap = new GuessMap(el('guess-map-container'), () => {
      sound.playPinSet();
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
  container.classList.add('pano-fade-out');
  setTimeout(() => {
    el('pano-loading').classList.remove('hidden');
    panoViewer.load(state.round.panoramaUrl, {
      vaov: state.round.vaov,
      modifier: state.settings.modifier,
      onLoad: () => {
        el('pano-loading').classList.add('hidden');
        container.classList.remove('pano-fade-out');
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
  const isDefaultPool = !state.pool || state.pool.id === 'starter-pool';
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

  const zoomLocked = state.settings.modifier === 'no-zoom';
  el('btn-zoom-in').classList.toggle('hidden', zoomLocked);
  el('btn-zoom-out').classList.toggle('hidden', zoomLocked);

  transitionPanorama();

  guessMap.reset();
  if (state.round.index === 0) {
    guessMap.focusOnLocations(state.pool?.focusBounds);
  }
  el('minimap').classList.remove('expanded');
  const confirmBtn = el('btn-confirm-guess');
  confirmBtn.disabled = true;
  confirmBtn.classList.remove('ready', 'locked');
  confirmBtn.innerHTML = GUESS_BTN_DEFAULT_LABEL;

  renderPeerStatus();
  updateConnectionBanner();

  clearInterval(hudTimerInterval);
  const timerEl = el('hud-timer');
  const timerBox = timerEl.closest('.timer');
  if (state.round.timeLimitMs == null) {
    timerEl.textContent = '∞';
    timerBox.classList.remove('critical');
  } else {
    let tickedCriticalSecond = null;
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
      if (clamped <= 0) clearInterval(hudTimerInterval);
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
    const guessed = state.round.guessedPlayerIds.has(p.id);
    const offline = !p.connected;
    dot.className = `peer-dot${guessed ? '' : ' pending'}${offline ? ' offline' : ''}`;
    dot.innerHTML = `<i style="background:${guessed ? p.color : ''}"></i>${escapeHtml(p.name)}`;
    container.appendChild(dot);
  }
}

function wireHudControls() {
  const expandMap = () => {
    sound.playClick();
    el('minimap').classList.add('expanded');
    guessMap?.invalidate();
    setTimeout(() => guessMap?.invalidate(), 340);
  };
  const collapseMap = () => {
    sound.playClick();
    el('minimap').classList.remove('expanded');
  };
  el('minimap-open-btn').addEventListener('click', expandMap);
  el('minimap-close-btn').addEventListener('click', collapseMap);
  el('minimap-style-toggle').addEventListener('click', () => {
    sound.playClick();
    const style = guessMap.toggleTileStyle();
    updateMapStyleLabel('minimap-style-label', style);
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
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) return;
    const onActiveRound = document.getElementById('screen-hud').classList.contains('active');
    if (!onActiveRound || !controller) return;
    const now = Date.now();
    if (now - lastTabSwitchSentAt < 3000) return; // Spam-Schutz
    lastTabSwitchSentAt = now;
    controller.reportTabSwitch();
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

function renderRoundResult({ results, actual, actualMeta }) {
  clearInterval(hudTimerInterval);
  showScreen('result');

  el('result-round-index').textContent = String(state.round.index + 1);
  el('result-round-total').textContent = String(state.round.total);

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
    card.className = 'score-card';
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
        <span class="score-name"><span class="avatar" style="width:22px;height:22px;font-size:0.7rem;background:${player?.color || '#8c99b8'};">${(player?.name || '?').charAt(0).toUpperCase()}</span>${escapeHtml(player?.name || 'Spieler')}</span>
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
  } else {
    if (myBestScore > 4000) sound.playSuccess();
    else sound.playRoundReveal();
    if (myResult?.streakBonus > 0) sound.playStreak();
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
  const rounds = state.roundHistory.filter(Boolean);
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

  const isHpMode = state.settings.mode === 'hp';
  const isCountryMode = state.settings.mode === 'country-streak';
  const sorted = [...finalScores].sort((a, b) => {
    if (isHpMode) return (b.hp ?? 0) - (a.hp ?? 0) || b.total - a.total;
    if (isCountryMode) return b.total - a.total || (b.bestStreak ?? 0) - (a.bestStreak ?? 0);
    return b.total - a.total;
  });
  renderPodium(sorted);

  const heading = document.querySelector('#screen-leaderboard h2');
  if (isHpMode) {
    const survivor = sorted.find((e) => (e.hp ?? 0) > 0);
    const survivorName = state.players.get(survivor?.playerId)?.name;
    heading.textContent = survivor && sorted.some((e) => (e.hp ?? 0) <= 0)
      ? `${survivorName} gewinnt das HP-Duell!`
      : 'HP-Duell beendet';
  } else if (isCountryMode) {
    heading.textContent = 'Country-Streak beendet';
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
}

function resetToMenu() {
  clearInterval(hudTimerInterval);
  clearInterval(resultCountdownInterval);
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
  history.replaceState(null, '', location.pathname + location.search);
  updateChrome('Nicht verbunden', null);
  showScreen('menu');
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
  const match = location.hash.match(/room=([A-Za-z0-9]+)/);
  if (!match) return;
  el('join-panel').classList.remove('hidden');
  el('join-code-input').value = match[1].toUpperCase();
  if (!state.self.name) el('player-name-input').focus();
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
    showScreen('hud');
  });
  bus.on('ui:map-resolving', () => showToast('Kartenpaket wird geladen…'));
  bus.on('ui:map-resolve-failed', () => {
    showToast('Für dieses Kartenpaket wurden keine Bilder gefunden.');
    renderLobby();
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
  bus.on('net:error', (err) => {
    console.error('Netzwerkfehler', err);
  });
  bus.on('ui:guess-unconfirmed', () => {
    showToast('Tipp konnte nicht bestätigt werden — bitte Verbindung prüfen.');
  });
}

async function boot() {
  initProfileUI();
  initThemeToggle();
  initSoundToggle();
  initLeaveGameButton();
  initVisibilityWatch();
  wireMenuControls();
  wireLobbyControls();
  wireHudControls();
  wireResultControls();
  wireLeaderboardControls();
  wireBusEvents();
  handleDeepLink();
  ensureMapSetIndex().catch((err) => console.error('Kartenpaket-Index konnte nicht geladen werden', err));
}

boot();
