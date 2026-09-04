export const MSG = {
  ROOM_JOIN_REQUEST: 'ROOM_JOIN_REQUEST',
  ROOM_JOIN_ACCEPTED: 'ROOM_JOIN_ACCEPTED',
  ROOM_JOIN_REJECTED: 'ROOM_JOIN_REJECTED',
  LOBBY_STATE: 'LOBBY_STATE',
  PLAYER_READY: 'PLAYER_READY',
  GAME_START: 'GAME_START',
  ROUND_START: 'ROUND_START',
  PRELOAD_ROUND: 'PRELOAD_ROUND',
  SUBMIT_GUESS: 'SUBMIT_GUESS',
  PLAYER_GUESSED: 'PLAYER_GUESSED',
  ROUND_RESULT: 'ROUND_RESULT',
  GAME_OVER: 'GAME_OVER',
  PLAYER_LEFT: 'PLAYER_LEFT',
  KICKED: 'KICKED',
  TAB_SWITCH_WARNING: 'TAB_SWITCH_WARNING',
  EMOTE: 'EMOTE',
  PING: 'PING',
  PONG: 'PONG',
  // Heatmap-Modus (Globle-inspiriert, siehe core/country-store.js): Client
  // schickt eine getippte Laender-ID; der Host bleibt auch hier
  // autoritativ (bewertet/erkennt den Treffer selbst) statt einem
  // client-gemeldeten "gewonnen" zu vertrauen, das trivial faelschbar waere.
  HEATMAP_GUESS: 'HEATMAP_GUESS',
  HEATMAP_GUESS_RESULT: 'HEATMAP_GUESS_RESULT', // Host -> NUR der ratende Spieler: eigene Distanz/Farbe
  HEATMAP_ACTIVITY: 'HEATMAP_ACTIVITY', // Host -> alle ANDEREN: nur Distanz, NIE welches Land geraten wurde
  HEATMAP_WIN: 'HEATMAP_WIN', // Host -> alle: Runde vorbei, Zielland + Gewinner werden aufgedeckt
  // Asynchrones Runden-Streaming (siehe net/host.js startGame()): das Spiel
  // startet schon, sobald die ersten Runden fertig sind, waehrend der Rest
  // im Hintergrund weiterlaedt. Reicht das Kartenpaket am Ende trotzdem
  // nicht fuer die urspruenglich gewuenschte Rundenzahl, senkt der Host sie
  // nachtraeglich und informiert alle Mitspieler darueber.
  ROUND_CAP_ADJUSTED: 'ROUND_CAP_ADJUSTED',
  ROUND_BUFFERING: 'ROUND_BUFFERING', // Host -> alle: naechste Runde ist noch nicht fertig geladen, bitte kurz warten
};

export function makeMessage(type, payload, senderId) {
  return { type, senderId, ts: Date.now(), payload };
}
