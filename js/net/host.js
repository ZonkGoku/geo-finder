import { bus, state, resetForNewGame, freshScoreEntry, HP_START } from '../core/state.js';
import { MSG, makeMessage } from './protocol.js';
import {
  scoreGuess,
  computeTimeBonus,
  nextStreak,
  computeStreakBonus,
  scoreCountryGuess,
  nextCountryStreak,
} from '../core/scoring.js';
import { makeSeed } from '../core/rng.js';
import { resolveRoundLocations, computeMapSetBounds } from '../core/pool-loader.js';
import { ensureCountryData, findCountryAtPointSync } from '../core/country-lookup.js';

const ROUND_RESULT_DISPLAY_MS = 8000;
const LEAVE_GRACE_MS = 15000;
const MAX_PLAYERS = 6;

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
      case MSG.TAB_SWITCH_WARNING:
        // an alle ANDEREN weiterleiten - der Absender braucht seine eigene Meldung nicht.
        for (const p of state.players.values()) {
          if (p.id !== peerId) this.pm.sendTo(p.id, makeMessage(MSG.TAB_SWITCH_WARNING, { playerId: peerId }, state.self.id));
        }
        bus.emit('ui:tab-switch-warning', { peerId });
        break;
      case MSG.EMOTE:
        for (const p of state.players.values()) {
          if (p.id !== peerId) {
            this.pm.sendTo(p.id, makeMessage(MSG.EMOTE, { playerId: peerId, emoji: message.payload.emoji }, state.self.id));
          }
        }
        bus.emit('ui:emote-received', { peerId, emoji: message.payload.emoji });
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
    if (!existing && state.players.size >= MAX_PLAYERS) {
      this.pm.sendTo(
        peerId,
        makeMessage(MSG.ROOM_JOIN_REJECTED, { reason: `Der Raum ist voll (max. ${MAX_PLAYERS} Spieler).` }, state.self.id)
      );
      return;
    }

    if (existing) {
      existing.connected = true;
      existing.name = payload.name || existing.name;
    } else {
      state.players.set(peerId, {
        id: peerId,
        name: payload.name || 'Spieler',
        color: payload.color || '#2fe6d6',
        ready: false,
        connected: true,
        isHost: false,
      });
      if (!state.scores.has(peerId)) state.scores.set(peerId, freshScoreEntry());
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

  reportTabSwitch() {
    this.pm.broadcast(makeMessage(MSG.TAB_SWITCH_WARNING, { playerId: state.self.id }, state.self.id));
    bus.emit('ui:tab-switch-warning', { peerId: state.self.id });
  }

  sendEmote(emoji) {
    this.pm.broadcast(makeMessage(MSG.EMOTE, { playerId: state.self.id, emoji }, state.self.id));
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

  async startGame(mapSet) {
    // focusBounds hier schon mit anhaengen, damit Host und Mitspieler den
    // gleichen state.pool.focusBounds-Pfad fuer die Minimap nutzen koennen
    // (der Host darf die volle Standortliste ohnehin sehen, sie bleibt
    // trotzdem auf state.pool - nur GAME_START an die Mitspieler laesst sie weg).
    state.pool = { ...mapSet, focusBounds: computeMapSetBounds(mapSet) };
    resetForNewGame();
    const seed = makeSeed();

    if (state.settings.mode === 'country-streak') {
      this.countryFeatures = await ensureCountryData();
    }

    bus.emit('ui:map-resolving');
    const resolved = await resolveRoundLocations(mapSet, state.settings.roundCount, seed);
    if (resolved.length === 0) {
      bus.emit('ui:map-resolve-failed');
      return;
    }
    this.roundLocations = resolved;
    state.round.total = this.roundLocations.length;

    // Nur Name/Quelle/grobe Bounding-Box gehen an die Mitspieler - NICHT die
    // vollstaendige Standortliste mit echten Koordinaten. Die haelt nur der
    // Host (in mapSet/state.pool), damit niemand per DevTools-Netzwerktab
    // die Antworten aller Runden im Voraus nachschlagen kann.
    this.pm.broadcast(
      makeMessage(
        MSG.GAME_START,
        {
          roundCount: this.roundLocations.length,
          timeLimitMs: state.settings.timeLimitMs,
          mode: state.settings.mode,
          modifier: state.settings.modifier,
          mapSetId: mapSet.id,
          mapSetName: mapSet.name,
          mapSetSource: mapSet.source,
          focusBounds: computeMapSetBounds(mapSet),
        },
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
      hint: location.hint ?? null,
      vaov: location.vaov ?? null,
      guessedPlayerIds: new Set(),
      myGuess: null,
    };

    // hint/vaov sind bewusst die einzigen Vorab-Informationen zum aktuellen
    // Ort - die Koordinaten selbst (state.round.actual) bleiben bis zum
    // Rundenende ausschliesslich beim Host.
    this.pm.broadcast(
      makeMessage(
        MSG.ROUND_START,
        {
          roundIndex: index,
          panoramaUrl: location.panoramaUrl,
          startTimestamp: state.round.startTimestamp,
          timeLimitMs: state.round.timeLimitMs,
          hint: location.hint ?? null,
          vaov: location.vaov ?? null,
        },
        state.self.id
      )
    );
    bus.emit('ui:round-started');

    clearTimeout(this.roundTimer);
    // timeLimitMs === null bedeutet "unbegrenzt" - dann beendet nur
    // "alle haben getippt" die Runde, kein Timeout.
    if (state.round.timeLimitMs != null) {
      this.roundTimer = setTimeout(() => this._endRound(), state.round.timeLimitMs);
    }
  }

  submitLocalGuess(lat, lng) {
    this._handleGuess(state.self.id, { roundIndex: state.round.index, lat, lng, submittedAtMs: Date.now() });
  }

  _handleGuess(peerId, payload) {
    if (payload.roundIndex !== state.round.index) return;
    if (state.round.guessedPlayerIds.has(peerId)) return;

    if (!state.round.guesses) state.round.guesses = new Map();
    state.round.guesses.set(peerId, {
      lat: payload.lat,
      lng: payload.lng,
      submittedAtMs: payload.submittedAtMs || Date.now(),
    });
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
    const mode = state.settings.mode;

    const results =
      mode === 'country-streak' ? this._scoreCountryRound(actual, guesses) : this._scorePointsRound(actual, guesses);

    let eliminatedPlayerId = null;
    if (mode === 'hp') {
      const bestScore = Math.max(...results.map((r) => r.base));
      for (const result of results) {
        const damage = Math.max(0, bestScore - result.base);
        const currentHp = state.hp.get(result.playerId) ?? HP_START;
        const nextHp = Math.max(0, currentHp - damage);
        state.hp.set(result.playerId, nextHp);
        result.hp = nextHp;
        result.hpDamage = damage;
        if (nextHp <= 0) eliminatedPlayerId = result.playerId;
      }
    }

    const resolvedLocation = this.roundLocations[state.round.index] || {};
    const actualMeta = {
      name: resolvedLocation.name ?? null,
      hint: resolvedLocation.hint ?? null,
      funFact: resolvedLocation.funFact ?? null,
    };

    state.roundHistory[state.round.index] = { actual, actualMeta, results };

    this.pm.broadcast(
      makeMessage(
        MSG.ROUND_RESULT,
        {
          roundIndex: state.round.index,
          actualLat: actual.lat,
          actualLng: actual.lng,
          actualName: actualMeta.name,
          actualHint: actualMeta.hint,
          actualFunFact: actualMeta.funFact,
          results,
        },
        state.self.id
      )
    );
    bus.emit('ui:round-result', { results, actual, actualMeta });

    const isLastRound = state.round.index >= this.roundLocations.length - 1;
    clearTimeout(this.nextRoundTimer);
    this.nextRoundTimer = setTimeout(() => {
      if (isLastRound || eliminatedPlayerId) this._endGame();
      else this._startRound(state.round.index + 1);
    }, ROUND_RESULT_DISPLAY_MS);
  }

  _scorePointsRound(actual, guesses) {
    const isDuel = [...state.players.values()].filter((p) => p.connected).length > 1;
    const results = [];

    for (const player of state.players.values()) {
      const guess = guesses.get(player.id) || null;
      const { distanceKm, score: baseScore, noGuess } = scoreGuess(guess, actual, state.pool.scaleKm);

      if (!state.scores.has(player.id)) state.scores.set(player.id, freshScoreEntry());
      const scoreEntry = state.scores.get(player.id);

      const timeBonus =
        isDuel && !noGuess
          ? computeTimeBonus(guess.submittedAtMs - state.round.startTimestamp, state.round.timeLimitMs ?? 90000)
          : 0;
      const streak = nextStreak(scoreEntry.streak, distanceKm);
      const streakBonus = computeStreakBonus(streak);
      const roundTotal = baseScore + timeBonus + streakBonus;

      scoreEntry.streak = streak;
      scoreEntry.bestStreak = Math.max(scoreEntry.bestStreak, streak);
      scoreEntry.total += roundTotal;
      scoreEntry.perRound[state.round.index] = {
        total: roundTotal,
        base: baseScore,
        timeBonus,
        streakBonus,
        distanceKm,
        noGuess,
      };

      results.push({
        playerId: player.id,
        lat: guess?.lat ?? null,
        lng: guess?.lng ?? null,
        distanceKm,
        noGuess,
        base: baseScore,
        timeBonus,
        streakBonus,
        score: roundTotal,
        streak,
      });
    }
    return results;
  }

  _scoreCountryRound(actual, guesses) {
    const features = this.countryFeatures;
    const actualCountry = findCountryAtPointSync(actual.lat, actual.lng, features);
    const results = [];

    for (const player of state.players.values()) {
      const guess = guesses.get(player.id) || null;
      const noGuess = !guess;
      const guessedCountry = guess ? findCountryAtPointSync(guess.lat, guess.lng, features) : null;
      const { correct, score } = scoreCountryGuess(guessedCountry, actualCountry);

      if (!state.scores.has(player.id)) state.scores.set(player.id, freshScoreEntry());
      const scoreEntry = state.scores.get(player.id);
      const streak = nextCountryStreak(scoreEntry.streak, correct);

      scoreEntry.streak = streak;
      scoreEntry.bestStreak = Math.max(scoreEntry.bestStreak, streak);
      scoreEntry.total += score;
      scoreEntry.perRound[state.round.index] = { total: score, correct, guessedCountry, actualCountry, noGuess };

      results.push({
        playerId: player.id,
        lat: guess?.lat ?? null,
        lng: guess?.lng ?? null,
        noGuess,
        correct,
        guessedCountry,
        actualCountry,
        base: score,
        timeBonus: 0,
        streakBonus: 0,
        score,
        streak,
      });
    }
    return results;
  }

  advanceNow() {
    clearTimeout(this.nextRoundTimer);
    const isLastRound = state.round.index >= this.roundLocations.length - 1;
    const eliminated = state.settings.mode === 'hp' && [...state.hp.values()].some((hp) => hp <= 0);
    if (isLastRound || eliminated) this._endGame();
    else this._startRound(state.round.index + 1);
  }

  _endGame() {
    const finalScores = [...state.scores.entries()].map(([playerId, s]) => ({
      playerId,
      total: s.total,
      perRound: s.perRound,
      bestStreak: s.bestStreak,
      hp: state.hp.get(playerId) ?? null,
    }));
    this.pm.broadcast(makeMessage(MSG.GAME_OVER, { finalScores }, state.self.id));
    bus.emit('ui:game-over', { finalScores });
  }
}

function serializePlayers() {
  return [...state.players.values()].map((p) => ({ ...p }));
}
