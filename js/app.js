import { bus, state } from './core/state.js';
import { PeerManager, generateRoomCode } from './net/peer-manager.js';
import { HostController } from './net/host.js';
import { ClientController } from './net/client.js';
import { GuessMap } from './map/guess-map.js';
import { ResultMap } from './map/result-map.js';
import { PanoViewer } from './panorama/pano-viewer.js';
import { showScreen } from './ui/router.js';
import { showToast } from './ui/toast.js';

const PROFILE_KEY = 'geofinder.profile';
const RESULT_DISPLAY_SECONDS = 8;

let peerManager = null;
let controller = null;
let pool = null;
let guessMap = null;
let resultMap = null;
let panoViewer = null;
let hudTimerInterval = null;
let resultCountdownInterval = null;

const el = (id) => document.getElementById(id);

// ---------------------------------------------------------------- profile

function loadProfile() {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return { name: '', color: '#f2a93b' };
    return JSON.parse(raw);
  } catch {
    return { name: '', color: '#f2a93b' };
  }
}

function saveProfile() {
  localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: state.self.name, color: state.self.color }));
}

function initProfileUI() {
  const profile = loadProfile();
  state.self.name = profile.name || '';
  state.self.color = profile.color || '#f2a93b';

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

// ---------------------------------------------------------------- pool

async function loadPool() {
  if (pool) return pool;
  const res = await fetch('./data/locations.json');
  pool = await res.json();
  return pool;
}

function findLocationByCoords(lat, lng) {
  if (!pool) return null;
  return pool.locations.find((loc) => Math.abs(loc.lat - lat) < 0.001 && Math.abs(loc.lng - lng) < 0.001) || null;
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
    renderLobby();
    showScreen('lobby');
  } catch (err) {
    console.error(err);
    showMenuError('Verbindung fehlgeschlagen. Prüfe deine Internetverbindung und versuche es erneut.');
    updateChrome('Nicht verbunden', null);
  }
}

async function joinFlow(rawCode) {
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
  clearMenuError();
  peerManager = createSoloPeerManager();
  controller = new HostController(peerManager);
  controller.registerSelfAsHost(peerManager.peer.id, getName(), state.self.color);
  state.roomCode = null;
  updateChrome('Solo', peerManager.peer.id);
  const loadedPool = await loadPool();
  controller.startGame(loadedPool);
}

function updateChrome(statusText, peerId) {
  el('chrome-status').textContent = statusText;
  el('chrome-peer-id').textContent = peerId ? peerId.replace(/^geofinder-/, '') : '—';
}

// ---------------------------------------------------------------- lobby

function renderLobby() {
  const isHost = state.role === 'host';
  const players = [...state.players.values()];

  el('lobby-room-code').textContent = state.roomCode || '—';
  const shareLink = state.roomCode
    ? `${location.origin}${location.pathname}#room=${state.roomCode}`
    : '—';
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

  el('setting-rounds-value').textContent = String(state.settings.roundCount);
  el('setting-time-value').textContent = `${Math.round(state.settings.timeLimitMs / 1000)}s`;
  el('lobby-pool-name').textContent = pool?.name || 'Startpaket';

  const panel = el('lobby-settings-panel');
  panel.querySelectorAll('.stepper button').forEach((b) => {
    b.style.display = isHost ? '' : 'none';
  });

  const readyBtn = el('btn-ready-toggle');
  const startBtn = el('btn-start-game');
  const hint = el('lobby-hint');

  if (isHost) {
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
}

function wireLobbyControls() {
  el('copy-link-btn').addEventListener('click', async () => {
    const text = el('lobby-share-link').textContent;
    try {
      await navigator.clipboard.writeText(text);
      showToast('Link kopiert');
    } catch {
      showToast('Kopieren nicht möglich — bitte manuell markieren');
    }
  });

  el('btn-ready-toggle').addEventListener('click', () => {
    const me = state.players.get(state.self.id);
    controller.setReady(!me?.ready);
  });

  el('btn-start-game').addEventListener('click', async () => {
    const loadedPool = await loadPool();
    controller.startGame(loadedPool);
  });

  el('lobby-settings-panel').querySelectorAll('.stepper button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.role !== 'host') return;
      const dir = Number(btn.dataset.dir);
      const kind = btn.dataset.step;
      if (kind === 'rounds') {
        const next = Math.min(10, Math.max(3, state.settings.roundCount + dir));
        controller.updateSettings({ roundCount: next });
      } else if (kind === 'time') {
        const next = Math.min(180000, Math.max(30000, state.settings.timeLimitMs + dir * 15000));
        controller.updateSettings({ timeLimitMs: next });
      }
      renderLobby();
    });
  });
}

// ---------------------------------------------------------------- hud

function ensureHudWidgets() {
  if (!panoViewer) panoViewer = new PanoViewer('pano-container');
  if (!guessMap) {
    guessMap = new GuessMap(el('guess-map-container'), () => {
      el('btn-confirm-guess').disabled = false;
    });
  }
}

function renderRoundStart() {
  showScreen('hud');
  ensureHudWidgets();

  el('hud-round-index').textContent = String(state.round.index + 1).padStart(2, '0');
  el('hud-round-total').textContent = String(state.round.total).padStart(2, '0');
  el('pano-credit').textContent = 'Foto: Matthew Petroff · CC BY-SA 4.0';

  panoViewer.load(state.round.panoramaUrl);

  guessMap.reset();
  el('minimap').classList.remove('expanded');
  el('btn-confirm-guess').disabled = true;

  renderPeerStatus();

  clearInterval(hudTimerInterval);
  const timerEl = el('hud-timer');
  const timerBox = timerEl.closest('.timer');
  const tick = () => {
    const remainingMs = state.round.startTimestamp + state.round.timeLimitMs - Date.now();
    const clamped = Math.max(0, remainingMs);
    const totalSeconds = Math.ceil(clamped / 1000);
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    timerEl.textContent = `${mm}:${ss}`;
    timerBox.classList.toggle('critical', totalSeconds <= 10);
    if (clamped <= 0) clearInterval(hudTimerInterval);
  };
  tick();
  hudTimerInterval = setInterval(tick, 250);

  requestAnimationFrame(() => guessMap.invalidate());
}

function renderPeerStatus() {
  const container = el('hud-peer-status');
  container.innerHTML = '';
  for (const p of state.players.values()) {
    const dot = document.createElement('div');
    const guessed = state.round.guessedPlayerIds.has(p.id);
    dot.className = `peer-dot${guessed ? '' : ' pending'}`;
    dot.innerHTML = `<i style="background:${guessed ? p.color : ''}"></i>${escapeHtml(p.name)}`;
    container.appendChild(dot);
  }
}

function wireHudControls() {
  el('minimap-label').addEventListener('click', () => {
    const mm = el('minimap');
    mm.classList.toggle('expanded');
    guessMap?.invalidate();
    setTimeout(() => guessMap?.invalidate(), 240);
  });

  el('btn-confirm-guess').addEventListener('click', () => {
    const guess = guessMap.getGuess();
    if (!guess) return;
    if (state.role === 'host') controller.submitLocalGuess(guess.lat, guess.lng);
    else controller.submitGuess(guess.lat, guess.lng);
    el('btn-confirm-guess').disabled = true;
    showToast('Tipp abgegeben');
  });
}

// ---------------------------------------------------------------- result

function renderRoundResult({ results, actual }) {
  clearInterval(hudTimerInterval);
  showScreen('result');

  el('result-round-index').textContent = String(state.round.index + 1);
  el('result-round-total').textContent = String(state.round.total);

  if (!resultMap) resultMap = new ResultMap(el('result-map-container'));
  requestAnimationFrame(() => {
    resultMap.invalidate();
    resultMap.render(actual, results, state.players);
  });

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const listEl = el('result-score-list');
  listEl.innerHTML = '';
  for (const r of sorted) {
    const player = state.players.get(r.playerId);
    const card = document.createElement('div');
    card.className = 'score-card';
    const meta = r.noGuess ? 'Kein Tipp abgegeben' : `${r.distanceKm.toFixed(1)} km entfernt`;
    const barWidth = Math.max(2, (r.score / 5000) * 100);
    card.innerHTML = `
      <div class="score-card-top">
        <span class="score-name"><span class="avatar" style="width:22px;height:22px;font-size:0.7rem;background:${player?.color || '#8c99b8'};">${(player?.name || '?').charAt(0).toUpperCase()}</span>${escapeHtml(player?.name || 'Spieler')}</span>
        <span class="score-points">${r.score.toLocaleString('de-DE')}</span>
      </div>
      <div class="score-meta">${meta}</div>
      <div class="score-bar"><i style="width:${barWidth}%; background:${player?.color || 'var(--accent)'};"></i></div>
    `;
    listEl.appendChild(card);
  }

  const isHost = state.role === 'host';
  el('btn-advance-round').hidden = !isHost;

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
    if (state.role === 'host') controller.advanceNow();
  });
}

// ---------------------------------------------------------------- leaderboard

function renderLeaderboard({ finalScores }) {
  clearInterval(resultCountdownInterval);
  showScreen('leaderboard');

  const sorted = [...finalScores].sort((a, b) => b.total - a.total);
  const listEl = el('board-list');
  listEl.innerHTML = '';
  sorted.forEach((entry, idx) => {
    const player = state.players.get(entry.playerId);
    const row = document.createElement('div');
    row.className = `board-row${idx === 0 ? ' rank-1' : ''}`;
    const chips = entry.perRound
      .map((score, i) => `<span class="round-pill">R${i + 1} <b>${score ?? 0}</b></span>`)
      .join('');
    row.innerHTML = `
      <div class="rank-num">${String(idx + 1).padStart(2, '0')}</div>
      <div>
        <div class="board-name">${escapeHtml(player?.name || 'Spieler')}</div>
        <div class="board-chips">${chips}</div>
      </div>
      <div class="board-total"><div class="num">${entry.total.toLocaleString('de-DE')}</div><div class="lbl">Punkte</div></div>
    `;
    listEl.appendChild(row);
  });

  el('btn-play-again').hidden = state.role !== 'host';
}

function wireLeaderboardControls() {
  el('btn-play-again').addEventListener('click', async () => {
    const loadedPool = await loadPool();
    const isSolo = !state.roomCode;
    if (isSolo) {
      controller.startGame(loadedPool);
      return;
    }
    for (const p of state.players.values()) {
      if (!p.isHost) p.ready = false;
    }
    controller.updateSettings({});
    renderLobby();
    showScreen('lobby');
  });

  el('btn-back-to-menu').addEventListener('click', resetToMenu);
}

// ---------------------------------------------------------------- menu wiring

function wireMenuControls() {
  el('btn-host').addEventListener('click', hostFlow);
  el('btn-solo').addEventListener('click', soloFlow);

  el('btn-join-toggle').addEventListener('click', () => {
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
  panoViewer?.destroy();
  panoViewer = null;
  controller = null;
  peerManager?.destroy();
  peerManager = null;
  state.role = null;
  state.roomCode = null;
  state.players = new Map();
  state.scores = new Map();
  history.replaceState(null, '', location.pathname + location.search);
  updateChrome('Nicht verbunden', null);
  showScreen('menu');
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
    renderLobby();
    showScreen('lobby');
  });
  bus.on('ui:game-started', () => showScreen('hud'));
  bus.on('ui:round-started', renderRoundStart);
  bus.on('ui:player-guessed', renderPeerStatus);
  bus.on('ui:round-result', renderRoundResult);
  bus.on('ui:game-over', renderLeaderboard);
  bus.on('ui:host-disconnected', () => {
    showToast('Verbindung zum Host verloren');
    resetToMenu();
  });
  bus.on('net:error', (err) => {
    console.error('Netzwerkfehler', err);
  });
}

async function boot() {
  initProfileUI();
  wireMenuControls();
  wireLobbyControls();
  wireHudControls();
  wireResultControls();
  wireLeaderboardControls();
  wireBusEvents();
  handleDeepLink();
  loadPool().catch((err) => console.error('Location-Pool konnte nicht geladen werden', err));
}

boot();
