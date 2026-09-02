// Mapillary-Zugangstoken (kostenlos, siehe https://www.mapillary.com/dashboard/developers).
// Ein Mapillary-"Client Token" ist wie ein Mapbox-Public-Token dafür gedacht,
// im Frontend zu stehen - trotzdem: eigenen Token eintragen, nicht diesen
// Platzhalter deployen, sonst laufen die "needs-token"-Kartenpakete leer.
export const MAPILLARY_ACCESS_TOKEN = 'PASTE_YOUR_MAPILLARY_CLIENT_TOKEN_HERE';

export function isMapillaryConfigured() {
  return Boolean(MAPILLARY_ACCESS_TOKEN) && !MAPILLARY_ACCESS_TOKEN.startsWith('PASTE_');
}
