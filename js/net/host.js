import { bus, state, resetForNewGame } from '../core/state.js';
import { MSG, makeMessage } from './protocol.js';
import { scoreGuess } from '../core/scoring.js';
import { pickUniqueLocations, makeSeed } from '../core/rng.js';

const ROUND_RESULT_DISPLAY_MS = 8000;
const LEAVE_GRACE_MS = 15000;

export class HostController {
  constructor(peerManager) {
    this.pm = peerManager;
    this.roundLocations = [];
    this.roundTimer = null;
    this.nextRoundTimer = null;
    this.leaveTimers = new Map();
    this.pendingNames = new Map(); // peerId -> {name, color} vor Accept

    bus.on('net:peer-connected', () => {});
    bus.on('net:peer-disconnected', ({ peerId }) => this._onPeerLost(peerId));
    bus.on('net:message', ({ peerId, message }) => this._onMessage(peerId, message));
  }

  registerSelfAsHost(hostId, name, color) {
    state.self.id = hostId;
    state.self.name = name;
    state.self.color = color;
    state.role = 'host';
    state.players.set(hostId, { id: hostId, name, color, ready: true, connected: true, isHost: true });
  }

  _onMessage(peerId, message) {
    switch (message.type) {
      case MSG.ROOM_JOIN_REQUEST:
        this._handleJoin(peerId, message.payload);
        break;
      case MSG.PLAYER_READY:
        this._handleReady(peerId, message.payload);
        break;
      case MSG.SUBMIT_GUESS:
        this._handleGuess(peerId, message.payload);
        break;
      case MSG.PING:
        this.pm.sendTo(peerId, makeMessage(MSG.PONG, { echoTs: message.payload.echoTs }, state.self.id));
        break;
      default:
        break;
    }
  }

  _handleJoin(peerId, payload) {
    clearTimeout(this.leaveTimers.get(peerId));
    this.leaveTimers.delete(peerId);

    const existing = state.players.get(peerId);
    if (existing) {
      existing.connected = true;
      existing.name = payload.name || existing.name;
    } else {
      state.players.set(peerId, {
        id: peerId,
        name: payload.name || 'Spieler',
        color: payload.color || '#47d6c5',
        ready: false,
        connected: true,
        isHost: false,
      });
      if (!state.scores.has(peerId)) state.scores.set(peerId, { total: 0, perRound: [] });
    }

    this.pm.sendTo(
      peerId,
      makeMessage(
        MSG.ROOM_JOIN_ACCEPTED,
        { yourPlayerId: peerId, settings: state.settings, players: serializePlayers() },
        state.self.id
      )
    );
    this._broadcastLobbyState();
    bus.emit('ui:lobby-updated');
  }

  _handleReady(peerId, payload) {
    const player = state.players.get(peerId);
    if (!player) return;
    player.ready = !!payload.ready;
    this._broadcastLobbyState();
    bus.emit('ui:lobby-updated');
  }

  _onPeerLost(peerId) {
    const player = state.players.get(peerId);
    if (!player) return;
    player.connected = false;
    this._broadcastLobbyState();
    bus.emit('ui:lobby-updated');

    const timer = setTimeout(() => {
      state.players.delete(peerId);
      this.pm.broadcast(makeMessage(MSG.PLAYER_LEFT, { playerId: peerId }, state.self.id));
      this._broadcastLobbyState();
      bus.emit('ui:lobby-updated');
    }, LEAVE_GRACE_MS);
    this.leaveTimers.set(peerId, timer);
  }

  _broadcastLobbyState() {
    this.pm.broadcast(
      makeMessage(MSG.LOBBY_STATE, { players: serializePlayers(), settings: state.settings }, state.self.id)
    );
  }

  updateSettings(partial) {
    Object.assign(state.settings, partial);
    this._broadcastLobbyState();
  }

  startGame(pool) {
    state.pool = pool;
    resetForNewGame();
    const seed = makeSeed();
    this.roundLocations = pickUniqueLocations(pool.locations, state.settings.roundCount, seed);
    state.round.total = this.roundLocations.length;

    this.pm.broadcast(
      makeMessage(
        MSG.GAME_START,
        { roundCount: this.roundLocations.length, timeLimitMs: state.settings.timeLimitMs },
        state.self.id
      )
    );
    bus.emit('ui:game-started');
    this._startRound(0);
  }

  _startRound(index) {
    const location = this.roundLocations[index];
    state.round = {
      index,
      total: this.roundLocations.length,
      panoramaUrl: location.panoramaUrl,
      startTimestamp: Date.now(),
      timeLimitMs: state.settings.timeLimitMs,
      actual: { lat: location.lat, lng: location.lng },
      guessedPlayerIds: new Set(),
      myGuess: null,
    };

    this.pm.broadcast(
      makeMessage(
        MSG.ROUND_START,
        {
          roundIndex: index,
          panoramaUrl: location.panoramaUrl,
          startTimestamp: state.round.startTimestamp,
          timeLimitMs: state.round.timeLimitMs,
        },
        state.self.id
      )
    );
    bus.emit('ui:round-started');

    clearTimeout(this.roundTimer);
    this.roundTimer = setTimeout(() => this._endRound(), state.round.timeLimitMs);
  }

  submitLocalGuess(lat, lng) {
    this._handleGuess(state.self.id, { roundIndex: state.round.index, lat, lng, submittedAtMs: Date.now() });
  }

  _handleGuess(peerId, payload) {
    if (payload.roundIndex !== state.round.index) return;
    if (state.round.guessedPlayerIds.has(peerId)) return;

    if (!state.round.guesses) state.round.guesses = new Map();
    state.round.guesses.set(peerId, { lat: payload.lat, lng: payload.lng });
    state.round.guessedPlayerIds.add(peerId);

    this.pm.broadcast(makeMessage(MSG.PLAYER_GUESSED, { playerId: peerId }, state.self.id));
    bus.emit('ui:player-guessed', { peerId });

    const connectedIds = [...state.players.values()].filter((p) => p.connected).map((p) => p.id);
    const allGuessed = connectedIds.every((id) => state.round.guessedPlayerIds.has(id));
    if (allGuessed) this._endRound();
  }

  _endRound() {
    clearTimeout(this.roundTimer);
    const actual = state.round.actual;
    const guesses = state.round.guesses || new Map();
    const results = [];

    for (const player of state.players.values()) {
      const guess = guesses.get(player.id) || null;
      const { distanceKm, score, noGuess } = scoreGuess(guess, actual, state.pool.scaleKm);
      results.push({ playerId: player.id, lat: guess?.lat ?? null, lng: guess?.lng ?? null, distanceKm, score, noGuess });

      if (!state.scores.has(player.id)) state.scores.set(player.id, { total: 0, perRound: [] });
      const scoreEntry = state.scores.get(player.id);
      scoreEntry.total += score;
      scoreEntry.perRound[state.round.index] = score;
    }

    this.pm.broadcast(
      makeMessage(
        MSG.ROUND_RESULT,
        { roundIndex: state.round.index, actualLat: actual.lat, actualLng: actual.lng, results },
        state.self.id
      )
    );
    bus.emit('ui:round-result', { results, actual });

    const isLastRound = state.round.index >= this.roundLocations.length - 1;
    clearTimeout(this.nextRoundTimer);
    this.nextRoundTimer = setTimeout(() => {
      if (isLastRound) this._endGame();
      else this._startRound(state.round.index + 1);
    }, ROUND_RESULT_DISPLAY_MS);
  }

  advanceNow() {
    clearTimeout(this.nextRoundTimer);
    const isLastRound = state.round.index >= this.roundLocations.length - 1;
    if (isLastRound) this._endGame();
    else this._startRound(state.round.index + 1);
  }

  _endGame() {
    const finalScores = [...state.scores.entries()].map(([playerId, s]) => ({
      playerId,
      total: s.total,
      perRound: s.perRound,
    }));
    this.pm.broadcast(makeMessage(MSG.GAME_OVER, { finalScores }, state.self.id));
    bus.emit('ui:game-over', { finalScores });
  }
}

function serializePlayers() {
  return [...state.players.values()].map((p) => ({ ...p }));
}
