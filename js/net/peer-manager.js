import { bus } from '../core/state.js';

const ROOM_PREFIX = 'geofinder-';
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789'; // ohne 0/O, 1/I/L

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
      const peer = new window.Peer(ROOM_PREFIX + roomCode);
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
      const peer = new window.Peer();
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

  destroy() {
    this.peer?.destroy();
  }
}
