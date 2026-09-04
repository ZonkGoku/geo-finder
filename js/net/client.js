import { bus, state, freshScoreEntry, HP_START } from '../core/state.js';
import { MSG, makeMessage } from './protocol.js';

// Ein offener WebRTC-DataChannel ("conn.open === true") garantiert NICHT,
// dass ein einzelnes send() auch wirklich ankommt - gerade ueber eine per
// TURN gerelayte Verbindung kann ein Paket stillschweigend verloren gehen,
// ohne dass send() wirft oder 'error'/'close' feuert. Bisher gab es fuer
// SUBMIT_GUESS keinerlei Bestaetigung: ging genau dieses eine Paket
// verloren, wartete die Runde ewig auf einen Tipp, der laengst "gesendet"
// war - ohne jeden Fehler in der Konsole (live gemeldeter Bug: Host konnte
// tippen, der Tipp eines Mitspielers "kam nie an", Timer lief nur runter).
// Der Host bestaetigt jeden empfangenen Tipp per PLAYER_GUESSED-Broadcast
// (der auch an den Absender selbst zurueckgeht) - bleibt diese Bestaetigung
// aus, wird der Tipp erneut gesendet. _handleGuess() auf Host-Seite ist
// bereits idempotent (ignoriert einen bereits gezaehlten peerId), erneutes
// Senden ist also gefahrlos.
const GUESS_RETRY_MS = 1500;
const MAX_GUESS_RETRIES = 6;

// Selbes Prinzip wie preloadImage() in host.js: den Browser die naechste
// Runden-URL schon herunterladen lassen, bevor sie offiziell gebraucht
// wird, damit der Rundenwechsel nicht mehr am Bild-Download haengt.
function preloadImage(url) {
  if (!url || typeof Image === 'undefined') return;
  const img = new Image();
  img.src = url;
}

export class ClientController {
  constructor(peerManager) {
    this.pm = peerManager;
    this._pendingGuessPayload = null;
    this._guessRetryCount = 0;
    this._guessRetryTimer = null;
    // Unsubscribe-Funktionen sammeln, damit destroy() sie beim Verlassen
    // (z. B. ueber "Spiel verlassen") wieder abmelden kann - siehe
    // HostController.destroy() fuer den gleichen Grund.
    this._kicked = false;
    this._unsubscribers = [
      bus.on('net:message', ({ message }) => this._onMessage(message)),
      // Der Host schliesst nach einem KICKED-Versand direkt die Verbindung -
      // das loest hier ebenfalls 'net:host-disconnected' aus. Ohne den
      // _kicked-Guard wuerde die generische "Verbindung zum Host verloren"-
      // Meldung die eben erst gezeigte, konkrete Kick-Begruendung ueberschreiben.
      bus.on('net:host-disconnected', () => {
        if (!this._kicked) bus.emit('ui:host-disconnected');
      }),
    ];
  }

  destroy() {
    clearTimeout(this._guessRetryTimer);
    this._unsubscribers.forEach((unsubscribe) => unsubscribe());
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
    this._pendingGuessPayload = { roundIndex: state.round.index, lat, lng, submittedAtMs: Date.now() };
    this._guessRetryCount = 0;
    this._sendPendingGuess();
  }

  _sendPendingGuess() {
    if (!this._pendingGuessPayload) return;
    this.pm.sendToHost(makeMessage(MSG.SUBMIT_GUESS, this._pendingGuessPayload, state.self.id));
    if (!this.pm.hostConnection?.open) {
      console.warn('[GeoFinder] Verbindung zum Host ist beim Senden des Tipps nicht offen.');
    }
    clearTimeout(this._guessRetryTimer);
    if (this._guessRetryCount >= MAX_GUESS_RETRIES) {
      bus.emit('ui:guess-unconfirmed');
      return;
    }
    this._guessRetryCount++;
    this._guessRetryTimer = setTimeout(() => this._sendPendingGuess(), GUESS_RETRY_MS);
  }

  _clearPendingGuess() {
    this._pendingGuessPayload = null;
    clearTimeout(this._guessRetryTimer);
  }

  // Heatmap-Modus: schickt nur die getippte Laender-ID, der Host bewertet
  // (Distanz/exakter Treffer) - siehe net/host.js _handleHeatmapGuess().
  submitHeatmapGuess(countryId) {
    this.pm.sendToHost(makeMessage(MSG.HEATMAP_GUESS, { roundIndex: state.round.index, countryId }, state.self.id));
  }

  measureClockOffset() {
    const echoTs = Date.now();
    this.pm.sendToHost(makeMessage(MSG.PING, { echoTs }, state.self.id));
  }

  reportTabSwitch() {
    this.pm.sendToHost(makeMessage(MSG.TAB_SWITCH_WARNING, { playerId: state.self.id }, state.self.id));
  }

  sendEmote(emoji) {
    this.pm.sendToHost(makeMessage(MSG.EMOTE, { playerId: state.self.id, emoji }, state.self.id));
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
      case MSG.ROOM_JOIN_REJECTED:
        bus.emit('ui:join-rejected', { reason: message.payload.reason });
        break;
      case MSG.LOBBY_STATE:
        state.settings = message.payload.settings;
        this._applyPlayers(message.payload.players);
        bus.emit('ui:lobby-updated');
        break;
      case MSG.GAME_START:
        state.round.total = message.payload.roundCount;
        state.settings.mode = message.payload.mode;
        state.settings.modifier = message.payload.modifier;
        state.settings.mutators = message.payload.mutators || { fogOfWar: false, brokenCompass: false, noPan: false };
        // Heatmap-spezifische Regeln (nur im Payload vorhanden, wenn
        // mode==='heatmap' - siehe host.js _startHeatmapGame()). Defaults
        // greifen fuer alle anderen Modi, wo diese Felder ungenutzt bleiben.
        state.settings.heatmapLabels = message.payload.heatmapLabels ?? 'on';
        state.settings.heatmapOpponentInfo = message.payload.heatmapOpponentInfo ?? 'all';
        state.settings.heatmapTurnMode = message.payload.heatmapTurnMode ?? 'simultaneous';
        state.scores = new Map();
        state.roundHistory = [];
        state.hp = new Map();
        state.eliminatedAtRound = new Map();
        // Nur die leichten Metadaten - NICHT die volle Standortliste mit
        // echten Koordinaten. Die haelt nur der Host, damit hier niemand
        // per DevTools-Netzwerktab die Antworten im Voraus nachschlagen kann.
        state.pool = {
          id: message.payload.mapSetId,
          name: message.payload.mapSetName,
          source: message.payload.mapSetSource,
          focusBounds: message.payload.focusBounds,
        };
        for (const id of state.players.keys()) {
          state.scores.set(id, freshScoreEntry());
          if (message.payload.mode === 'hp') state.hp.set(id, HP_START);
        }
        bus.emit('ui:game-started');
        break;
      case MSG.ROUND_START:
        // Heatmap-Runden broadcasten denselben ROUND_START wie die Panorama-
        // Modi (gleicher Rundenzaehler/Timer-Mechanismus), aber OHNE
        // panoramaUrl/hint/vaov - das generische ui:round-started wuerde
        // hier renderRoundStart() ausloesen, das unbedingt auf den HUD-
        // Screen wechselt und versucht, ein nicht existierendes Panorama zu
        // laden (genau der live gemeldete Bug: Mitspieler haengt auf
        // "Panorama lädt…" fest). Fuer Heatmap-Runden also das dedizierte
        // ui:heatmap-round-started emittieren, das den eigenen Screen zeigt.
        if (state.settings.mode === 'heatmap') {
          state.round = {
            index: message.payload.roundIndex,
            total: state.round.total,
            startTimestamp: message.payload.startTimestamp,
            timeLimitMs: message.payload.timeLimitMs,
            actual: null,
            guessedPlayerIds: new Set(),
          };
          bus.emit('ui:heatmap-round-started', { roundIndex: message.payload.roundIndex });
          break;
        }
        state.round = {
          index: message.payload.roundIndex,
          total: state.round.total,
          panoramaUrl: message.payload.panoramaUrl,
          startTimestamp: message.payload.startTimestamp,
          timeLimitMs: message.payload.timeLimitMs,
          actual: null,
          hint: message.payload.hint ?? null,
          vaov: message.payload.vaov ?? null,
          guessedPlayerIds: new Set(),
          myGuess: null,
        };
        this._clearPendingGuess(); // eine neue Runde macht einen Retry fuer die alte sinnlos
        bus.emit('ui:round-started');
        break;
      case MSG.PRELOAD_ROUND:
        // Nur die Foto-URL der naechsten Runde, keine Koordinaten/Hinweise -
        // sobald ROUND_START fuer diese Runde tatsaechlich eintrifft, liegt
        // das Bild schon im Browser-Cache statt neu geladen werden zu muessen.
        preloadImage(message.payload.panoramaUrl);
        break;
      case MSG.PLAYER_GUESSED:
        state.round.guessedPlayerIds.add(message.payload.playerId);
        // Bestaetigung, dass der eigene Tipp tatsaechlich angekommen ist -
        // der Host schickt PLAYER_GUESSED an alle, auch an den Absender
        // selbst zurueck. Erst hier den Retry-Timer stoppen, nicht schon
        // beim lokalen Klick (siehe Kommentar oben an MAX_GUESS_RETRIES).
        if (message.payload.playerId === state.self.id) this._clearPendingGuess();
        bus.emit('ui:player-guessed', { peerId: message.payload.playerId });
        break;
      case MSG.ROUND_RESULT: {
        this._clearPendingGuess(); // Runde ist ohnehin vorbei, egal ob die Bestaetigung ankam
        state.round.actual = { lat: message.payload.actualLat, lng: message.payload.actualLng };
        const actualMeta = {
          name: message.payload.actualName ?? null,
          hint: message.payload.actualHint ?? null,
          funFact: message.payload.actualFunFact ?? null,
        };
        state.round.actualMeta = actualMeta;
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
          if (r.hp != null) state.hp.set(r.playerId, r.hp);
        }
        state.roundHistory[message.payload.roundIndex] = {
          actual: state.round.actual,
          actualMeta,
          results: message.payload.results,
        };
        // Battle Royale: neu ausgeschiedene Spieler ins lokale Zustandsbild
        // uebernehmen - der Host haelt die Autoritaet (state.eliminatedAtRound
        // wird ausschliesslich aus diesem vom Host bestimmten Feld befuellt,
        // nie durch eigene Client-Logik).
        for (const playerId of message.payload.eliminatedPlayerIds || []) {
          state.eliminatedAtRound.set(playerId, message.payload.roundIndex);
        }
        bus.emit('ui:round-result', {
          results: message.payload.results,
          actual: state.round.actual,
          actualMeta,
          eliminatedPlayerIds: message.payload.eliminatedPlayerIds || [],
        });
        break;
      }
      case MSG.GAME_OVER:
        bus.emit('ui:game-over', { finalScores: message.payload.finalScores });
        break;
      case MSG.ROUND_BUFFERING:
        bus.emit('ui:round-buffering');
        break;
      case MSG.ROUND_CAP_ADJUSTED:
        state.round.total = message.payload.roundCount;
        bus.emit('ui:round-cap-adjusted', { roundCount: message.payload.roundCount });
        break;
      case MSG.PLAYER_LEFT:
        state.players.delete(message.payload.playerId);
        bus.emit('ui:lobby-updated');
        break;
      case MSG.KICKED:
        this._kicked = true;
        bus.emit('ui:kicked', { reason: message.payload.reason });
        break;
      case MSG.TAB_SWITCH_WARNING:
        bus.emit('ui:tab-switch-warning', { peerId: message.payload.playerId });
        break;
      case MSG.EMOTE:
        bus.emit('ui:emote-received', { peerId: message.payload.playerId, emoji: message.payload.emoji });
        break;
      case MSG.PONG:
        state.clockOffsetMs = Math.round((Date.now() - message.payload.echoTs) / 2);
        break;
      case MSG.HEATMAP_GUESS_RESULT:
        bus.emit('ui:heatmap-guess-result', message.payload);
        break;
      case MSG.HEATMAP_ACTIVITY:
        bus.emit('ui:heatmap-activity', message.payload);
        break;
      case MSG.HEATMAP_TURN_UPDATE:
        bus.emit('ui:heatmap-turn-update', message.payload);
        break;
      case MSG.HEATMAP_WIN: {
        const { winnerPlayerId, targetCountryId, targetCountryName, results } = message.payload;
        for (const r of results) {
          if (!state.scores.has(r.playerId)) state.scores.set(r.playerId, freshScoreEntry());
          const entry = state.scores.get(r.playerId);
          entry.total += r.score;
          entry.perRound[message.payload.roundIndex] = { total: r.score, won: r.won };
        }
        state.roundHistory[message.payload.roundIndex] = { targetCountryId, targetCountryName, results };
        bus.emit('ui:heatmap-round-result', { winnerPlayerId, target: { id: targetCountryId, name: targetCountryName }, results });
        break;
      }
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
