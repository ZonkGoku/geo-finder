import { bus, state, resetForNewGame, freshScoreEntry, HP_START } from '../core/state.js';
import { MSG, makeMessage } from './protocol.js';
import {
  scoreGuess,
  computeTimeBonus,
  nextStreak,
  computeStreakBonus,
  scoreCountryGuess,
  nextCountryStreak,
  haversineDistanceKm,
} from '../core/scoring.js';
import { makeSeed, mulberry32 } from '../core/rng.js';
import { resolveRoundLocations, computeMapSetBounds } from '../core/pool-loader.js';
import { ensureCountryData, findCountryAtPointSync } from '../core/country-lookup.js';
import { ensureCountryStore, randomCountry } from '../core/country-store.js';

const HEATMAP_WIN_POINTS = 1000;

const ROUND_RESULT_DISPLAY_MS = 8000;
const LEAVE_GRACE_MS = 15000;
const MAX_PLAYERS = 6;

// Anti-Cheat-Heuristiken. Beides ist ausdruecklich Abschreckung, keine
// harte Absicherung: ein Spieler, der die Antwort auf einem ZWEITEN Geraet
// nachschlaegt, wechselt in diesem Tab nie den Fokus und wird von keiner
// In-Tab-Erkennung je erfasst. Was das hier trotzdem einfaengt: den
// haeufigeren Fall "kurz wegtabben, per Google/Bilderrueckwaertssuche
// nachschauen, sofort zurueck und tippen".
const MAX_TAB_SWITCHES_PER_GAME = 3;
const SUSPICIOUS_GUESS_WINDOW_MS = 2500;

// Waermt den Browser-Cache fuer die naechste Runde vor, waehrend die
// aktuelle noch laeuft - rein lokal im Host-Browser (kein Protokoll-/
// Broadcast-Feld), damit dabei keine zukuenftigen Runden-URLs an Mitspieler
// verschickt werden (das waere ein neues Leck der spaeteren Antworten,
// genau das Problem, das der Anti-Cheat-Fix dieser Session verhindern soll).
function preloadImage(url) {
  if (!url || typeof Image === 'undefined') return;
  const img = new Image();
  img.src = url;
}

export class HostController {
  constructor(peerManager) {
    this.pm = peerManager;
    this.roundLocations = [];
    this.roundTimer = null;
    this.nextRoundTimer = null;
    this.leaveTimers = new Map();
    this.pendingNames = new Map(); // peerId -> {name, color} vor Accept
    this.tabSwitchCounts = new Map(); // peerId -> Anzahl Tab-Wechsel diese Partie (3 = Kick)

    // bus.on() gibt eine Unsubscribe-Funktion zurueck - gesammelt, damit
    // destroy() sie beim Verlassen eines Spiels (z. B. ueber den neuen
    // "Spiel verlassen"-Button, auch mitten in einer laufenden Runde)
    // wieder abmelden kann. Ohne das haetten mehrere Solo-/Host-Durchgaenge
    // in derselben Tab-Session immer mehr tote HostController angesammelt,
    // die trotzdem noch auf jede net:message reagieren.
    this._unsubscribers = [
      bus.on('net:peer-connected', () => {}),
      bus.on('net:peer-disconnected', ({ peerId }) => this._onPeerLost(peerId)),
      bus.on('net:message', ({ peerId, message }) => this._onMessage(peerId, message)),
    ];
  }

  destroy() {
    clearTimeout(this.roundTimer);
    clearTimeout(this.nextRoundTimer);
    for (const timer of this.leaveTimers.values()) clearTimeout(timer);
    this.leaveTimers.clear();
    this._unsubscribers.forEach((unsubscribe) => unsubscribe());
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
      case MSG.HEATMAP_GUESS:
        this._handleHeatmapGuess(peerId, message.payload);
        break;
      case MSG.TAB_SWITCH_WARNING: {
        // an alle ANDEREN weiterleiten - der Absender braucht seine eigene Meldung nicht.
        for (const p of state.players.values()) {
          if (p.id !== peerId) this.pm.sendTo(p.id, makeMessage(MSG.TAB_SWITCH_WARNING, { playerId: peerId }, state.self.id));
        }
        bus.emit('ui:tab-switch-warning', { peerId });

        // Fuer die "verdaechtig schneller Tipp nach Tab-Wechsel"-Pruefung in
        // _handleGuess() - pro Runde neu, siehe _startRound().
        if (state.round.lastSwitchAwayAt) state.round.lastSwitchAwayAt.set(peerId, Date.now());

        const count = (this.tabSwitchCounts.get(peerId) || 0) + 1;
        this.tabSwitchCounts.set(peerId, count);
        if (count >= MAX_TAB_SWITCHES_PER_GAME) {
          this._kickPlayer(peerId, `Zu viele Tab-Wechsel (${count}x) in dieser Partie.`);
        }
        break;
      }
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
    // Der Host durchlaeuft _onMessage() nicht fuer seine eigenen Nachrichten -
    // dieselbe Verdachtspruefung wie fuer Mitspieler gilt trotzdem: eigene
    // Tab-Wechsel zaehlen fuer die "verdaechtig schneller Tipp"-Heuristik
    // genauso. Der 3-Strikes-Kick bleibt bewusst nur fuer Mitspieler (sich
    // selbst als Host zu kicken wuerde die Partie fuer alle sofort beenden).
    if (state.round.lastSwitchAwayAt) state.round.lastSwitchAwayAt.set(state.self.id, Date.now());
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

  /**
   * Entfernt einen einzelnen Mitspieler zwangsweise (3-Strikes-Regel bei
   * wiederholten Tab-Wechseln). Schickt KICKED zuerst, damit der
   * betroffene Client einen konkreten Grund zeigen kann, statt nur die
   * generische "Verbindung zum Host verloren"-Meldung zu sehen, die
   * ohnehin gleich danach durch das Schliessen der Verbindung ausgeloest wird.
   */
  _kickPlayer(peerId, reason) {
    this.pm.sendTo(peerId, makeMessage(MSG.KICKED, { reason }, state.self.id));
    this.pm.closeConnection(peerId);
    clearTimeout(this.leaveTimers.get(peerId));
    this.leaveTimers.delete(peerId);
    state.players.delete(peerId);
    this.tabSwitchCounts.delete(peerId);
    this.pm.broadcast(makeMessage(MSG.PLAYER_LEFT, { playerId: peerId }, state.self.id));
    this._broadcastLobbyState();
    bus.emit('ui:lobby-updated');
    bus.emit('ui:player-kicked', { peerId, reason });
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

  // seed ist optional ueberschreibbar (Tages-Challenge/Challenge-Links geben
  // einen aus Datum bzw. Link abgeleiteten Seed vor, statt einen frischen
  // zufaelligen zu erzeugen) - resolveRoundLocations() ist damit fuer JEDES
  // Spiel schon deterministisch, normale Spiele nutzen einfach weiterhin
  // einen frischen Zufalls-Seed als Default.
  async startGame(mapSet, seed = makeSeed()) {
    // Heatmap-Modus braucht kein Kartenpaket (keine Panoramen) - eigener,
    // deutlich leichterer Ablauf statt durch die Panorama-Rundenauflösung
    // unten zu laufen. mapSet kann hier bewusst null sein (siehe
    // startGameFromLobby() in app.js).
    if (state.settings.mode === 'heatmap') {
      return this._startHeatmapGame(seed);
    }

    // focusBounds hier schon mit anhaengen, damit Host und Mitspieler den
    // gleichen state.pool.focusBounds-Pfad fuer die Minimap nutzen koennen
    // (der Host darf die volle Standortliste ohnehin sehen, sie bleibt
    // trotzdem auf state.pool - nur GAME_START an die Mitspieler laesst sie weg).
    // seed wird mit abgelegt, damit ein Solo-Spieler seine gerade gespielte
    // Partie hinterher per Challenge-Link exakt teilen kann (siehe
    // core/challenge.js + "Challenge teilen" auf dem Leaderboard).
    state.pool = { ...mapSet, focusBounds: computeMapSetBounds(mapSet), seed };
    resetForNewGame();

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
          mutators: state.settings.mutators,
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
      lastSwitchAwayAt: new Map(), // peerId -> Zeitstempel, fuer die Verdachtspruefung in _handleGuess()
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
    preloadImage(this.roundLocations[index + 1]?.panoramaUrl);

    // Mitspielern denselben Vorsprung geben wie dem Host selbst: nur die
    // rohe Foto-URL der NAECHSTEN Runde, keine Koordinaten/Hinweise/Namen -
    // wer das Bild sieht, kennt (wie bei der aktuellen Runde auch) noch
    // nicht dessen tatsaechliche Position. Laedt der Browser das Bild schon
    // waehrend der laufenden Runde vor, steht es bei ROUND_START fuer
    // Runde N+1 sofort aus dem Cache bereit statt neu geladen werden zu
    // muessen (das war der spuerbare Ruckler beim Rundenwechsel).
    const nextLocation = this.roundLocations[index + 1];
    if (nextLocation) {
      this.pm.broadcast(
        makeMessage(MSG.PRELOAD_ROUND, { roundIndex: index + 1, panoramaUrl: nextLocation.panoramaUrl }, state.self.id)
      );
    }

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

    // Heuristik: wer wenige Sekunden nach dem letzten registrierten
    // Tab-Wechsel dieser Runde tippt, hat vermutlich gerade extern (zweiter
    // Tab/Bildersuche) nachgeschaut. Kein Beweis, daher nur den Rundenwert
    // kappen statt den Spieler direkt zu bestrafen - siehe Kommentar an
    // MAX_TAB_SWITCHES_PER_GAME weiter oben zu den Grenzen dieser Pruefung.
    const switchedAwayAt = state.round.lastSwitchAwayAt?.get(peerId);
    const suspicious = switchedAwayAt != null && Date.now() - switchedAwayAt < SUSPICIOUS_GUESS_WINDOW_MS;

    if (!state.round.guesses) state.round.guesses = new Map();
    state.round.guesses.set(peerId, {
      lat: payload.lat,
      lng: payload.lng,
      submittedAtMs: payload.submittedAtMs || Date.now(),
      suspicious,
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
      const flagged = Boolean(guess?.suspicious);
      let { distanceKm, score: baseScore, noGuess } = scoreGuess(guess, actual, state.pool.scaleKm);

      if (!state.scores.has(player.id)) state.scores.set(player.id, freshScoreEntry());
      const scoreEntry = state.scores.get(player.id);

      // Verdaechtiger Tipp (siehe _handleGuess): Distanz/Pin bleiben fuer
      // Transparenz sichtbar, aber Basis-/Zeit-/Streak-Bonus werden gekappt -
      // ein manipulierter Client soll keinen Vorteil aus dem Nachschlagen
      // ziehen, der Pin selbst wird aber nicht einfach unterschlagen.
      const timeBonus =
        !flagged && isDuel && !noGuess
          ? computeTimeBonus(guess.submittedAtMs - state.round.startTimestamp, state.round.timeLimitMs ?? 90000)
          : 0;
      if (flagged) baseScore = 0;
      const streak = flagged ? 0 : nextStreak(scoreEntry.streak, distanceKm);
      const streakBonus = flagged ? 0 : computeStreakBonus(streak);
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
        flagged,
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
        flagged,
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
      const flagged = Boolean(guess?.suspicious);
      const noGuess = !guess;
      const guessedCountry = guess ? findCountryAtPointSync(guess.lat, guess.lng, features) : null;
      let { correct, score } = scoreCountryGuess(guessedCountry, actualCountry);
      if (flagged) {
        correct = false;
        score = 0;
      }

      if (!state.scores.has(player.id)) state.scores.set(player.id, freshScoreEntry());
      const scoreEntry = state.scores.get(player.id);
      const streak = flagged ? 0 : nextCountryStreak(scoreEntry.streak, correct);

      scoreEntry.streak = streak;
      scoreEntry.bestStreak = Math.max(scoreEntry.bestStreak, streak);
      scoreEntry.total += score;
      scoreEntry.perRound[state.round.index] = { total: score, correct, guessedCountry, actualCountry, noGuess, flagged };

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
        flagged,
      });
    }
    return results;
  }

  // ---------------------------------------------------------------- Heatmap-Modus

  async _startHeatmapGame(seed) {
    state.pool = null; // kein Kartenpaket in diesem Modus
    resetForNewGame();
    this._heatmapRand = mulberry32(seed);
    this._heatmapStore = await ensureCountryStore();
    state.round.total = state.settings.roundCount;

    this.pm.broadcast(
      makeMessage(
        MSG.GAME_START,
        {
          roundCount: state.settings.roundCount,
          timeLimitMs: state.settings.timeLimitMs,
          mode: 'heatmap',
          modifier: state.settings.modifier,
          mutators: state.settings.mutators,
          mapSetId: null,
          mapSetName: 'Heatmap',
          mapSetSource: 'heatmap',
          focusBounds: null,
        },
        state.self.id
      )
    );
    bus.emit('ui:game-started');
    this._startHeatmapRound(0);
  }

  _startHeatmapRound(index) {
    const target = randomCountry(this._heatmapStore, this._heatmapRand);
    this._heatmapTarget = target; // NUR host-intern - wird nie gebroadcastet, siehe _handleHeatmapGuess()
    state.round = {
      index,
      total: state.settings.roundCount,
      startTimestamp: Date.now(),
      timeLimitMs: state.settings.timeLimitMs,
      actual: null,
      guessedPlayerIds: new Set(),
      heatmapGuessesByPlayer: new Map(), // peerId -> Set(countryId), verhindert doppelte Wertung desselben Tipps
    };

    this.pm.broadcast(
      makeMessage(
        MSG.ROUND_START,
        { roundIndex: index, startTimestamp: state.round.startTimestamp, timeLimitMs: state.round.timeLimitMs },
        state.self.id
      )
    );
    bus.emit('ui:heatmap-round-started', { roundIndex: index });

    clearTimeout(this.roundTimer);
    if (state.round.timeLimitMs != null) {
      this.roundTimer = setTimeout(() => this._endHeatmapRound(null), state.round.timeLimitMs);
    }
  }

  submitLocalHeatmapGuess(countryId) {
    this._handleHeatmapGuess(state.self.id, { roundIndex: state.round.index, countryId });
  }

  _handleHeatmapGuess(peerId, payload) {
    if (payload.roundIndex !== state.round.index || !this._heatmapTarget) return;
    const country = this._heatmapStore.byId.get(payload.countryId);
    if (!country) return;

    let seen = state.round.heatmapGuessesByPlayer.get(peerId);
    if (!seen) {
      seen = new Set();
      state.round.heatmapGuessesByPlayer.set(peerId, seen);
    }
    if (seen.has(country.id)) return; // schon geraten - keine doppelte Aktivitaet/Wertung fuer denselben Tipp
    seen.add(country.id);

    const distanceKm = haversineDistanceKm(country.lat, country.lng, this._heatmapTarget.lat, this._heatmapTarget.lng);
    const exact = country.id === this._heatmapTarget.id;

    // Privat NUR an den ratenden Spieler zurueck: er kennt sein eigenes
    // getipptes Land bereits, braucht aber die Distanz, um seine EIGENE
    // Karte einzufaerben (siehe Kommentar an MSG.HEATMAP_ACTIVITY unten,
    // warum das nicht einfach gebroadcastet wird).
    this.pm.sendTo(peerId, makeMessage(MSG.HEATMAP_GUESS_RESULT, { countryId: country.id, distanceKm, exact }, state.self.id));
    if (peerId === state.self.id) bus.emit('ui:heatmap-guess-result', { countryId: country.id, distanceKm, exact });

    // Live-Feed fuer alle ANDEREN: nur die Distanz, NIE welches Land
    // getippt wurde - sonst koennten Mitspieler durch reines Mitlesen der
    // Tipps anderer auf das Zielland schliessen, ohne selbst zu raten. Das
    // ist genau der in der Aufgabenstellung gewuenschte Zeitdruck-Effekt,
    // ohne die Antwort zu verraten.
    for (const p of state.players.values()) {
      if (p.id === peerId) continue;
      this.pm.sendTo(p.id, makeMessage(MSG.HEATMAP_ACTIVITY, { playerId: peerId, distanceKm, exact }, state.self.id));
    }
    bus.emit('ui:heatmap-activity', { peerId, distanceKm, exact });

    if (exact) this._endHeatmapRound(peerId);
  }

  /**
   * Beendet die Heatmap-Runde entweder weil jemand exakt getroffen hat
   * (winnerPlayerId gesetzt) oder weil das Zeitlimit ablief (null - niemand
   * gewinnt die Runde, alle bekommen 0 Punkte fuer diese Runde). Anders als
   * der Punkte-Modus ist Heatmap ein reines Wettrennen: kein graduelles
   * "naeher ist besser", nur der exakte Treffer zaehlt.
   */
  _endHeatmapRound(winnerPlayerId) {
    clearTimeout(this.roundTimer);
    const target = this._heatmapTarget;
    if (!target) return;

    const results = [];
    for (const player of state.players.values()) {
      if (!state.scores.has(player.id)) state.scores.set(player.id, freshScoreEntry());
      const scoreEntry = state.scores.get(player.id);
      const won = player.id === winnerPlayerId;
      const timeBonus =
        won && state.round.timeLimitMs != null
          ? computeTimeBonus(Date.now() - state.round.startTimestamp, state.round.timeLimitMs)
          : 0;
      const roundTotal = won ? HEATMAP_WIN_POINTS + timeBonus : 0;

      scoreEntry.total += roundTotal;
      scoreEntry.perRound[state.round.index] = { total: roundTotal, won };
      results.push({ playerId: player.id, won, score: roundTotal });
    }

    state.roundHistory[state.round.index] = { targetCountryId: target.id, targetCountryName: target.name, results };

    this.pm.broadcast(
      makeMessage(
        MSG.HEATMAP_WIN,
        { roundIndex: state.round.index, winnerPlayerId, targetCountryId: target.id, targetCountryName: target.name, results },
        state.self.id
      )
    );
    bus.emit('ui:heatmap-round-result', { winnerPlayerId, target, results });

    this._heatmapTarget = null;
    const isLastRound = state.round.index >= state.settings.roundCount - 1;
    clearTimeout(this.nextRoundTimer);
    this.nextRoundTimer = setTimeout(() => {
      if (isLastRound) this._endGame();
      else this._startHeatmapRound(state.round.index + 1);
    }, ROUND_RESULT_DISPLAY_MS);
  }

  advanceNow() {
    clearTimeout(this.nextRoundTimer);
    if (state.settings.mode === 'heatmap') {
      const isLastRound = state.round.index >= state.settings.roundCount - 1;
      if (isLastRound) this._endGame();
      else this._startHeatmapRound(state.round.index + 1);
      return;
    }
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
