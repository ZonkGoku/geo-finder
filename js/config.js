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
// (der PeerJS-Standard ohne diese Liste) findet nur die öffentliche
// IP/Port-Zuordnung - das reicht bei vielen Heimroutern, scheitert aber an
// symmetrischem NAT oder restriktiven Firewalls (Mobilfunknetze, manche
// Firmennetze). Ein TURN-Server leitet den Datenverkehr in diesem Fall
// einfach durch, als Fallback.
//
// Kostenloses Kontingent z. B. bei https://www.metered.ca/tools/openrelay/
// (kein Server-Betrieb nötig, kein Guthaben/Kreditkarte für die Gratisstufe):
// Account anlegen -> Dashboard -> "TURN Credentials" -> die dort
// angezeigten Server-URLs, Username und Credential hier eintragen.
export const TURN_SERVERS = [
  // { urls: 'turn:PASTE_HOST:80', username: 'PASTE_USERNAME', credential: 'PASTE_CREDENTIAL' },
];

export function isTurnConfigured() {
  return TURN_SERVERS.length > 0 && !TURN_SERVERS.some((s) => String(s.username || '').startsWith('PASTE_'));
}
