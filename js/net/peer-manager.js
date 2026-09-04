import { bus } from '../core/state.js';
import { TURN_SERVERS } from '../config.js';

const ROOM_PREFIX = 'geofinder-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I/L

// Eigene ICE-Serverliste statt PeerJS' eingebautem Standard - sobald man
// selbst ein `config`-Objekt uebergibt, ERSETZT das den Standard komplett,
// daher hier explizit STUN (findet die oeffentliche IP/Port-Zuordnung) UND
// TURN (leitet Daten durch, wenn reines STUN an symmetrischem NAT oder
// restriktiven Firewalls scheitert - z. B. Handy im Mobilfunknetz + Laptop
// im WLAN) zusammen auflisten. Ohne TURN funktioniert die Verbindung oft nur,
// wenn beide Geraete im selben Netzwerk sind.
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:global.stun.twilio.com:3478' },
  ...TURN_SERVERS,
];
const PEER_OPTIONS = { config: { iceServers: ICE_SERVERS } };

export function generateRoomCode(length = 6) {
  let code = '';
  for (let i = 0; i < length; i++) {
    code += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return code;
}

export class PeerManager {
  constructor() {
    this.peer = null;
    this.connections = new Map(); // peerId -> DataConnection
    this.isHost = false;
    this.roomCode = null;
    this.hostConnection = null; // nur als Client gesetzt
  }

  hostRoom(roomCode) {
    this.isHost = true;
    this.roomCode = roomCode;
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(ROOM_PREFIX + roomCode, PEER_OPTIONS);
      this.peer = peer;

      peer.on('open', (id) => resolve(id));
      peer.on('error', (err) => {
        bus.emit('net:error', err);
        reject(err);
      });
      peer.on('connection', (conn) => this._wireIncomingConnection(conn));
    });
  }

  joinRoom(roomCode) {
    this.isHost = false;
    this.roomCode = roomCode;
    return new Promise((resolve, reject) => {
      const peer = new window.Peer(undefined, PEER_OPTIONS);
      this.peer = peer;

      peer.on('open', () => {
        const conn = peer.connect(ROOM_PREFIX + roomCode, { reliable: true });
        this.hostConnection = conn;
        this._wireOutgoingConnection(conn, resolve, reject);
      });
      peer.on('error', (err) => {
        bus.emit('net:error', err);
        reject(err);
      });
      // Best-effort: ein einzelner Reconnect-Versuch bei Signaling-Abbruch.
      // Kein Retry-Loop und kein Wiederaufbau der DataConnection - schlaegt
      // das fehl, greift der 'close'-Handler der DataConnection unten und
      // meldet 'net:host-disconnected'.
      peer.on('disconnected', () => peer.reconnect());
    });
  }

  _wireIncomingConnection(conn) {
    conn.on('open', () => {
      this.connections.set(conn.peer, conn);
      bus.emit('net:peer-connected', { peerId: conn.peer });
    });
    conn.on('data', (data) => bus.emit('net:message', { peerId: conn.peer, message: data }));
    conn.on('close', () => {
      this.connections.delete(conn.peer);
      bus.emit('net:peer-disconnected', { peerId: conn.peer });
    });
    conn.on('error', (err) => bus.emit('net:error', err));
  }

  _wireOutgoingConnection(conn, resolve, reject) {
    conn.on('open', () => {
      bus.emit('net:connected-to-host');
      resolve(conn);
    });
    conn.on('data', (data) => bus.emit('net:message', { peerId: conn.peer, message: data }));
    conn.on('close', () => bus.emit('net:host-disconnected'));
    conn.on('error', (err) => {
      bus.emit('net:error', err);
      reject(err);
    });
  }

  broadcast(message) {
    for (const conn of this.connections.values()) {
      if (conn.open) conn.send(message);
    }
  }

  sendTo(peerId, message) {
    const conn = this.connections.get(peerId);
    if (conn?.open) conn.send(message);
  }

  sendToHost(message) {
    if (this.hostConnection?.open) this.hostConnection.send(message);
  }

  /**
   * Schliesst NUR die DataConnection zu einem einzelnen Peer (z. B. um
   * jemanden nach wiederholten Verdachtsmomenten aus dem Raum zu werfen),
   * ohne den eigenen Peer/die anderen Verbindungen anzutasten. PeerJS'
   * DataConnection.close() feuert auf BEIDEN Seiten ein 'close'-Event, der
   * betroffene Client erkennt das also von selbst als Verbindungsende.
   */
  closeConnection(peerId) {
    this.connections.get(peerId)?.close();
  }

  destroy() {
    this.peer?.destroy();
  }
}
