// Mapillary-Zugangstoken (kostenlos, siehe https://www.mapillary.com/dashboard/developers).
// Ein Mapillary-"Client Token" ist wie ein Mapbox-Public-Token dafür gedacht,
// im Frontend zu stehen - trotzdem: eigenen Token eintragen, nicht diesen
// Platzhalter deployen, sonst laufen die "needs-token"-Kartenpakete leer.
export const MAPILLARY_ACCESS_TOKEN = 'MLY|27182601354750298|ad303d7f8c54b1f96d54fe1d3552ee6b';

export function isMapillaryConfigured() {
  return Boolean(MAPILLARY_ACCESS_TOKEN) && !MAPILLARY_ACCESS_TOKEN.startsWith('PASTE_');
}

// TURN-Server für WebRTC-Verbindungen zwischen Geräten in unterschiedlichen
// Netzwerken (z. B. Handy im Mobilfunknetz + Laptop im WLAN). Reines STUN
// (der PeerJS-Standard ohne diese Konfiguration) findet nur die öffentliche
// IP/Port-Zuordnung - das reicht bei vielen Heimroutern, scheitert aber an
// symmetrischem NAT oder restriktiven Firewalls (Mobilfunknetze, manche
// Firmennetze). Ein TURN-Server leitet den Datenverkehr in diesem Fall
// einfach durch, als Fallback.
//
// Kostenloses Kontingent (500MB/Monat, keine Kreditkarte) über
// https://www.metered.ca/. Die Liste unten ist die vom Metered-Dashboard
// für diesen Zugang generierte ICE-Server-Konfiguration - mehrere
// Transport-Varianten (UDP/TCP auf Port 80/443, TLS auf 443), damit auch
// Netzwerke funktionieren, die einzelne davon blockieren. Username/Credential
// sind wie der Mapillary-Token oben bewusst fürs Frontend gedacht (siehe
// Metered-eigenes Beispiel: dieselbe Liste direkt im Browser-JS verwendet).
export const TURN_SERVERS = [
  { urls: 'stun:stun.relay.metered.ca:80' },
  { urls: 'turn:global.relay.metered.ca:80', username: '4e817b00839966d351e3778d', credential: 'k+zd+kFXWsKQiBiq' },
  {
    urls: 'turn:global.relay.metered.ca:80?transport=tcp',
    username: '4e817b00839966d351e3778d',
    credential: 'k+zd+kFXWsKQiBiq',
  },
  { urls: 'turn:global.relay.metered.ca:443', username: '4e817b00839966d351e3778d', credential: 'k+zd+kFXWsKQiBiq' },
  {
    urls: 'turns:global.relay.metered.ca:443?transport=tcp',
    username: '4e817b00839966d351e3778d',
    credential: 'k+zd+kFXWsKQiBiq',
  },
];

export function isTurnConfigured() {
  return TURN_SERVERS.length > 0;
}
