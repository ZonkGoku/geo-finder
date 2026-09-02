import { bus, state, freshScoreEntry } from '../core/state.js';
import { MSG, makeMessage } from './protocol.js';

export class ClientController {
  constructor(peerManager) {
    this.pm = peerManager;
    bus.on('net:message', ({ message }) => this._onMessage(message));
    bus.on('net:host-disconnected', () => bus.emit('ui:host-disconnected'));
  }

  join(name, color) {
    state.role = 'client';
    state.self.name = name;
    state.self.color = color;
    this.pm.sendToHost(makeMessage(MSG.ROOM_JOIN_REQUEST, { name, color }, this.pm.peer.id));
  }

  setReady(ready) {
    this.pm.sendToHost(makeMessage(MSG.PLAYER_READY, { ready }, state.self.id));
  }

  submitGuess(lat, lng) {
    state.round.myGuess = { lat, lng };
    this.pm.sendToHost(
      makeMessage(MSG.SUBMIT_GUESS, { roundIndex: state.round.index, lat, lng, submittedAtMs: Date.now() }, state.self.id)
    );
  }

  measureClockOffset() {
    const echoTs = Date.now();
    this.pm.sendToHost(makeMessage(MSG.PING, { echoTs }, state.self.id));
  }

  _onMessage(message) {
    switch (message.type) {
      case MSG.ROOM_JOIN_ACCEPTED:
        state.self.id = message.payload.yourPlayerId;
        state.settings = message.payload.settings;
        this._applyPlayers(message.payload.players);
        bus.emit('ui:lobby-joined');
        this.measureClockOffset();
        break;
      case MSG.LOBBY_STATE:
        state.settings = message.payload.settings;
        this._applyPlayers(message.payload.players);
        bus.emit('ui:lobby-updated');
        break;
      case MSG.GAME_START:
        state.round.total = message.payload.roundCount;
        state.scores = new Map();
        state.roundHistory = [];
        for (const id of state.players.keys()) state.scores.set(id, freshScoreEntry());
        bus.emit('ui:game-started');
        break;
      case MSG.ROUND_START:
        state.round = {
          index: message.payload.roundIndex,
          total: state.round.total,
          panoramaUrl: message.payload.panoramaUrl,
          startTimestamp: message.payload.startTimestamp,
          timeLimitMs: message.payload.timeLimitMs,
          actual: null,
          guessedPlayerIds: new Set(),
          myGuess: null,
        };
        bus.emit('ui:round-started');
        break;
      case MSG.PLAYER_GUESSED:
        state.round.guessedPlayerIds.add(message.payload.playerId);
        bus.emit('ui:player-guessed', { peerId: message.payload.playerId });
        break;
      case MSG.ROUND_RESULT:
        state.round.actual = { lat: message.payload.actualLat, lng: message.payload.actualLng };
        for (const r of message.payload.results) {
          if (!state.scores.has(r.playerId)) state.scores.set(r.playerId, freshScoreEntry());
          const entry = state.scores.get(r.playerId);
          entry.total += r.score;
          entry.streak = r.streak;
          entry.bestStreak = Math.max(entry.bestStreak, r.streak);
          entry.perRound[message.payload.roundIndex] = {
            total: r.score,
            base: r.base,
            timeBonus: r.timeBonus,
            streakBonus: r.streakBonus,
            distanceKm: r.distanceKm,
            noGuess: r.noGuess,
          };
        }
        state.roundHistory[message.payload.roundIndex] = {
          actual: state.round.actual,
          results: message.payload.results,
        };
        bus.emit('ui:round-result', { results: message.payload.results, actual: state.round.actual });
        break;
      case MSG.GAME_OVER:
        bus.emit('ui:game-over', { finalScores: message.payload.finalScores });
        break;
      case MSG.PLAYER_LEFT:
        state.players.delete(message.payload.playerId);
        bus.emit('ui:lobby-updated');
        break;
      case MSG.PONG:
        state.clockOffsetMs = Math.round((Date.now() - message.payload.echoTs) / 2);
        break;
      default:
        break;
    }
  }

  _applyPlayers(list) {
    const map = new Map();
    for (const p of list) map.set(p.id, p);
    state.players = map;
  }
}
