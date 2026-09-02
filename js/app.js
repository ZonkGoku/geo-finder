import { bus, state } from './core/state.js';
import { PeerManager, generateRoomCode } from './net/peer-manager.js';
import { HostController } from './net/host.js';
import { ClientController } from './net/client.js';
import { GuessMap } from './map/guess-map.js';
import { ResultMap } from './map/result-map.js';
import { PanoViewer } from './panorama/pano-viewer.js';
import { showScreen } from './ui/router.js';
import { showToast } from './ui/toast.js';
import * as sound from './audio/sound.js';

const PROFILE_KEY = 'geofinder.profile';
const RESULT_DISPLAY_SECONDS = 8;

let peerManager = null;
let controller = null;
let pool = null;
let guessMap = null;
let resultMap = null;
let overviewMap = null;
let panoViewer = null;
let hudTimerInterval = null;
let resultCountdownInterval = null;
let hintRevealed = false;

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

// ---------------------------------------------------------------- sound toggle

function initSoundToggle() {
  const btn = el('btn-sound-toggle');
  const onIcon = el('sound-icon-on');
  const offIcon = el('sound-icon-off');
  const sync = () => {
    const muted = sound.isMuted();
    onIcon.hidden = muted;
    offIcon.hidden = !muted;
  };
  sync();
  btn.addEventListener('click', () => {
    sound.unlockAudio();
    sound.toggleMuted();
    sync();
  });
}

// ---------------------------------------------------------------- pool

async function loadPool() {
  if (pool) return pool;
  const res = await fetch('./data/locations.json');
  pool = await res.json();
  return pool;
}

function findLocationByCoords(lat, lng) {
  if (!pool || lat == null || lng == null) return null;
  return pool.locations.find((loc) => Math.abs(loc.lat - lat) < 0.001 && Math.abs(loc.lng - lng) < 0.001) || null;
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
    renderLobby();
    showScreen('lobby');
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

  updateConnectionBanner();
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

  el('btn-start-game').addEventListener('click', async () => {
    sound.playClick();
    const loadedPool = await loadPool();
    controller.startGame(loadedPool);
  });

  el('lobby-settings-panel').querySelectorAll('.stepper button').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (state.role !== 'host') return;
      sound.playClick();
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
      sound.playPinSet();
      const btn = el('btn-confirm-guess');
      btn.disabled = false;
      btn.classList.add('ready');
    });
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

function renderRoundStart() {
  showScreen('hud');
  ensureHudWidgets();
  hintRevealed = false;

  el('hud-round-index').textContent = String(state.round.index + 1).padStart(2, '0');
  el('hud-round-total').textContent = String(state.round.total).padStart(2, '0');
  el('pano-credit').textContent = 'Foto: Matthew Petroff · CC BY-SA 4.0';
  renderRoundProgress();

  const location = pool?.locations.find((loc) => loc.panoramaUrl === state.round.panoramaUrl);
  const hintBtn = el('btn-hint-toggle');
  const hintBanner = el('hint-banner');
  hintBanner.classList.add('hidden');
  if (location?.hint) {
    hintBtn.hidden = false;
    hintBtn.textContent = 'Hinweis';
  } else {
    hintBtn.hidden = true;
  }

  panoViewer.load(state.round.panoramaUrl, { vaov: location?.vaov });

  guessMap.reset();
  el('minimap').classList.remove('expanded');
  const confirmBtn = el('btn-confirm-guess');
  confirmBtn.disabled = true;
  confirmBtn.classList.remove('ready');

  renderPeerStatus();
  updateConnectionBanner();

  clearInterval(hudTimerInterval);
  const timerEl = el('hud-timer');
  const timerBox = timerEl.closest('.timer');
  let tickedCriticalSecond = null;
  const tick = () => {
    const remainingMs = state.round.startTimestamp + state.round.timeLimitMs - Date.now();
    const clamped = Math.max(0, remainingMs);
    const totalSeconds = Math.ceil(clamped / 1000);
    const mm = String(Math.floor(totalSeconds / 60)).padStart(2, '0');
    const ss = String(totalSeconds % 60).padStart(2, '0');
    timerEl.textContent = `${mm}:${ss}`;
    const critical = totalSeconds <= 10;
    timerBox.classList.toggle('critical', critical);
    if (critical && totalSeconds > 0 && tickedCriticalSecond !== totalSeconds) {
      tickedCriticalSecond = totalSeconds;
      sound.playTick(totalSeconds <= 3);
    }
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
    const offline = !p.connected;
    dot.className = `peer-dot${guessed ? '' : ' pending'}${offline ? ' offline' : ''}`;
    dot.innerHTML = `<i style="background:${guessed ? p.color : ''}"></i>${escapeHtml(p.name)}`;
    container.appendChild(dot);
  }
}

function wireHudControls() {
  el('minimap-label').addEventListener('click', () => {
    sound.playClick();
    const mm = el('minimap');
    mm.classList.toggle('expanded');
    guessMap?.invalidate();
    setTimeout(() => guessMap?.invalidate(), 340);
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
    showToast('Tipp abgegeben');
  });

  el('btn-hint-toggle').addEventListener('click', () => {
    sound.playClick();
    const location = pool?.locations.find((loc) => loc.panoramaUrl === state.round.panoramaUrl);
    if (!location?.hint) return;
    hintRevealed = !hintRevealed;
    const banner = el('hint-banner');
    banner.textContent = `💡 ${location.hint}`;
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
}

// ---------------------------------------------------------------- result

function animateCounter(elEl, from, to, duration = 700) {
  const start = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - start) / duration);
    const eased = 1 - (1 - progress) ** 3;
    elEl.textContent = Math.round(from + (to - from) * eased).toLocaleString('de-DE');
    if (progress < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

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

  const location = findLocationByCoords(actual.lat, actual.lng);
  const funFactEl = el('result-fun-fact');
  if (location?.funFact) {
    el('result-fun-fact-text').textContent = location.funFact;
    funFactEl.classList.remove('hidden');
  } else {
    funFactEl.classList.add('hidden');
  }

  const sorted = [...results].sort((a, b) => b.score - a.score);
  const listEl = el('result-score-list');
  listEl.innerHTML = '';
  let myBestScore = 0;
  for (const r of sorted) {
    const player = state.players.get(r.playerId);
    if (r.playerId === state.self.id) myBestScore = r.score;
    const card = document.createElement('div');
    card.className = 'score-card';
    const meta = r.noGuess ? 'Kein Tipp abgegeben' : `${r.distanceKm.toFixed(1)} km entfernt`;
    const barWidth = Math.max(2, (r.score / 5000) * 100);
    const chips = [];
    if (!r.noGuess) chips.push(`<span class="score-chip">Basis ${r.base.toLocaleString('de-DE')}</span>`);
    if (r.timeBonus > 0) chips.push(`<span class="score-chip bonus">&#9889; +${r.timeBonus} Speed</span>`);
    if (r.streakBonus > 0) chips.push(`<span class="score-chip streak">&#128293; +${r.streakBonus} Streak x${r.streak}</span>`);
    card.innerHTML = `
      <div class="score-card-top">
        <span class="score-name"><span class="avatar" style="width:22px;height:22px;font-size:0.7rem;background:${player?.color || '#8c99b8'};">${(player?.name || '?').charAt(0).toUpperCase()}</span>${escapeHtml(player?.name || 'Spieler')}</span>
        <span class="score-points" data-final="${r.score}">0</span>
      </div>
      <div class="score-meta">${meta}</div>
      <div class="score-bar"><i style="width:0%; background:${player?.color || 'var(--accent)'};"></i></div>
      ${chips.length ? `<div class="score-breakdown">${chips.join('')}</div>` : ''}
    `;
    listEl.appendChild(card);
    const pointsEl = card.querySelector('.score-points');
    const barEl = card.querySelector('.score-bar i');
    requestAnimationFrame(() => {
      animateCounter(pointsEl, 0, r.score);
      barEl.style.transition = 'width 700ms ease';
      requestAnimationFrame(() => {
        barEl.style.width = `${barWidth}%`;
      });
    });
  }

  if (myBestScore > 4000) sound.playSuccess();
  else sound.playRoundReveal();
  const myStreakResult = results.find((r) => r.playerId === state.self.id);
  if (myStreakResult?.streakBonus > 0) sound.playStreak();

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
  // Reihenfolge fuers Layout: 2. Platz links, 1. Platz Mitte (hoechster Block), 3. Platz rechts.
  const order = [1, 0, 2].filter((i) => sorted[i]);
  order.forEach((idx, visualPos) => {
    const entry = sorted[idx];
    const player = state.players.get(entry.playerId);
    const step = document.createElement('div');
    step.className = `podium-step rank-${idx + 1}`;
    step.style.animationDelay = `${visualPos * 100}ms`;
    const initial = (player?.name || '?').charAt(0).toUpperCase();
    step.innerHTML = `
      <div class="avatar" style="background:${player?.color || '#8c99b8'};">${initial}</div>
      <div class="podium-name">${escapeHtml(player?.name || 'Spieler')}</div>
      <div class="podium-score">${entry.total.toLocaleString('de-DE')}</div>
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
  requestAnimationFrame(() => {
    overviewMap.invalidate();
    const combinedResults = rounds.flatMap((r) => r.results);
    // Fuer die Uebersicht wird das letzte Runden-Ziel als Bounds-Anker genutzt,
    // aber alle Ziele + Tipps aller Runden werden eingezeichnet.
    overviewMap.render(rounds[rounds.length - 1].actual, combinedResults, state.players);
    for (const round of rounds.slice(0, -1)) {
      const targetIcon = window.L.divIcon({
        className: '',
        html: '<span class="map-pin map-pin--target"></span>',
        iconSize: [14, 14],
        iconAnchor: [7, 14],
      });
      window.L.marker([round.actual.lat, round.actual.lng], { icon: targetIcon }).addTo(overviewMap.layerGroup);
    }
    const allBounds = rounds.flatMap((r) => [
      [r.actual.lat, r.actual.lng],
      ...r.results.filter((res) => res.lat != null).map((res) => [res.lat, res.lng]),
    ]);
    if (allBounds.length > 1) overviewMap.map.fitBounds(allBounds, { padding: [30, 30] });
  });
}

function renderLeaderboard({ finalScores }) {
  clearInterval(resultCountdownInterval);
  showScreen('leaderboard');

  const sorted = [...finalScores].sort((a, b) => b.total - a.total);
  renderPodium(sorted);

  const listEl = el('board-list');
  listEl.innerHTML = '';
  sorted.forEach((entry, idx) => {
    const player = state.players.get(entry.playerId);
    const row = document.createElement('div');
    row.className = `board-row${idx === 0 ? ' rank-1' : ''}`;
    const chips = entry.perRound
      .map((r, i) => `<span class="round-pill">R${i + 1} <b>${r?.total ?? 0}</b></span>`)
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

  renderOverviewMap();
  el('btn-play-again').hidden = state.role !== 'host';
}

function wireLeaderboardControls() {
  el('btn-play-again').addEventListener('click', async () => {
    sound.playClick();
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

  el('btn-back-to-menu').addEventListener('click', () => {
    sound.playClick();
    resetToMenu();
  });
}

// ---------------------------------------------------------------- menu wiring

function wireMenuControls() {
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
  controller = null;
  peerManager?.destroy();
  peerManager = null;
  state.role = null;
  state.roomCode = null;
  state.players = new Map();
  state.scores = new Map();
  state.roundHistory = [];
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
  bus.on('ui:player-guessed', ({ peerId }) => {
    renderPeerStatus();
    if (peerId !== state.self.id) showToast('Gegenspieler hat getippt!');
  });
  bus.on('ui:round-result', renderRoundResult);
  bus.on('ui:game-over', renderLeaderboard);
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
}

async function boot() {
  initProfileUI();
  initSoundToggle();
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
