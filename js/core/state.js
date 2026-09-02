export class EventBus {
  constructor() {
    this.listeners = new Map();
  }

  on(event, handler) {
    if (!this.listeners.has(event)) this.listeners.set(event, new Set());
    this.listeners.get(event).add(handler);
    return () => this.off(event, handler);
  }

  off(event, handler) {
    this.listeners.get(event)?.delete(handler);
  }

  emit(event, payload) {
    this.listeners.get(event)?.forEach((handler) => handler(payload));
  }
}

export const bus = new EventBus();

export const state = {
  role: null, // 'host' | 'client'
  self: { id: null, name: '', color: '#f2a93b' },
  roomCode: null,
  players: new Map(), // peerId -> { id, name, color, ready, connected, isHost }
  settings: { roundCount: 5, timeLimitMs: 90000, poolId: 'starter-pool' },
  pool: null, // geladenes locations.json (nur Host braucht Koordinaten)
  round: {
    index: 0,
    total: 0,
    panoramaUrl: null,
    startTimestamp: null,
    timeLimitMs: null,
    actual: null, // { lat, lng } - erst nach Rundenende clientseitig bekannt
    guessedPlayerIds: new Set(),
    myGuess: null,
  },
  scores: new Map(), // peerId -> { total, perRound: [], streak, bestStreak }
  roundHistory: [], // [{ actual: {lat,lng}, results: [...] }] - fuer die Endstand-Uebersichtskarte
  clockOffsetMs: 0,
};

export function freshScoreEntry() {
  return { total: 0, perRound: [], streak: 0, bestStreak: 0 };
}

export function resetForNewGame() {
  state.round = {
    index: 0,
    total: state.settings.roundCount,
    panoramaUrl: null,
    startTimestamp: null,
    timeLimitMs: null,
    actual: null,
    guessedPlayerIds: new Set(),
    myGuess: null,
  };
  state.scores = new Map();
  state.roundHistory = [];
  for (const id of state.players.keys()) {
    state.scores.set(id, freshScoreEntry());
  }
}

export function playerList() {
  return [...state.players.values()];
}
