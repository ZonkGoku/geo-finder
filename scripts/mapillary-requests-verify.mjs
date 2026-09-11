// node scripts/mapillary-requests-verify.mjs
//
// Prueft die Anfragen-Oekonomie von fetchPanoramaForRegion() gegen einen
// gestubbten fetch(). Die echte Mapillary-API ist hier nicht erreichbar (und
// waere fuer diese Frage auch der falsche Massstab - es geht darum, WIE VIELE
// Anfragen der Code stellt, nicht was Mapillary antwortet).
//
// Hintergrund: vorher gingen pro Regionsversuch immer 1 Listen- plus 8
// Detailabfragen raus, obwohl die erste gueltige genommen wird. Ueber
// MAX_RESOLVE_ATTEMPTS_CAP (150) hochgerechnet war das der groesste Posten
// der API-Last.
const calls = [];
let responder = null;

globalThis.fetch = async (url) => {
  calls.push(String(url));
  const body = responder(String(url));
  if (body instanceof Error) throw body;
  return {
    ok: body.ok !== false,
    status: body.status ?? 200,
    json: async () => body.json,
  };
};

const { fetchPanoramaForRegion } = await import('../js/panorama/mapillary-source.js');

const region = { name: 'Teststadt', lat: 53.55, lng: 9.99 };
const GEOM = { coordinates: [9.991, 53.551] };

let pass = 0;
let fail = 0;
const check = (name, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` - ${detail}` : ''}`);
  ok ? pass++ : fail++;
};
const counts = () => ({
  list: calls.filter((u) => u.includes('/images?')).length,
  detail: calls.filter((u) => !u.includes('/images?')).length,
});

// Jeder Testfall braucht frische IDs: fetchDetailCached() dedupliziert pro
// Modul-Lebensdauer, wiederverwendete IDs wuerden die Zaehlung verfaelschen.
let idSeq = 0;
const freshIds = (n) => Array.from({ length: n }, () => ({ id: `img-${++idSeq}` }));

// ---------------------------------------------------------------- 1
// Listenabfrage liefert alle noetigen Felder -> keine einzige Detailabfrage.
calls.length = 0;
{
  const items = freshIds(20).map((o, i) => ({ ...o, is_pano: i === 7, geometry: GEOM, thumb_2048_url: `u/${o.id}` }));
  responder = () => ({ json: { data: items } });
  const loc = await fetchPanoramaForRegion(region, () => 0.5);
  const c = counts();
  check('reiche Liste: 1 Anfrage gesamt, 0 Detailabfragen', c.list === 1 && c.detail === 0, JSON.stringify(c));
  check('reiche Liste: findet das Pano trotzdem', loc !== null && loc.panoramaUrl.startsWith('u/'));
  check('reiche Liste: nutzt die echte Bildgeometrie', loc?.lat === 53.551, `lat=${loc?.lat}`);
}

// ---------------------------------------------------------------- 2
// Sicherheitsnetz: Felder da, aber ohne geometry -> NICHT direkt verwenden,
// sonst waere der gesuchte Ort still die Regionsmitte statt des Aufnahmeorts.
calls.length = 0;
{
  const items = freshIds(5).map((o) => ({ ...o, is_pano: true, thumb_2048_url: `u/${o.id}` })); // kein geometry
  responder = (url) =>
    url.includes('/images?')
      ? { json: { data: items } }
      : { json: { id: 'x', is_pano: true, geometry: GEOM, thumb_2048_url: 'u/detail' } };
  const loc = await fetchPanoramaForRegion(region, () => 0.5);
  const c = counts();
  check('ohne geometry: faellt auf Detailabfragen zurueck', c.detail > 0, JSON.stringify(c));
  check('ohne geometry: Ort kommt aus dem Detail, nicht aus der Regionsmitte', loc?.lat === 53.551, `lat=${loc?.lat}`);
}

// ---------------------------------------------------------------- 3
// Magere Liste (nur IDs) -> gestaffelte Batches, Abbruch beim ersten Treffer.
calls.length = 0;
{
  // ALLE Kandidaten sind Panos - damit ist unabhaengig von der
  // Shuffle-Reihenfolge schon der erste ein Treffer, und es darf genau ein
  // Batch rausgehen. (Nur items[0] zum Pano zu machen waere kein
  // aussagekraeftiger Test: der Shuffle verschiebt es irgendwohin.)
  const items = freshIds(8);
  responder = (url) => {
    if (url.includes('/images?')) return { json: { data: items } };
    const id = url.split('/').pop().split('?')[0];
    return { json: { id, is_pano: true, geometry: GEOM, thumb_2048_url: `u/${id}` } };
  };
  const loc = await fetchPanoramaForRegion(region, () => 0);
  const c = counts();
  check('magere Liste: genau ein Batch (3) statt 8 Detailabfragen', c.detail === 3, `detail=${c.detail}`);
  check('magere Liste: findet das Pano', loc !== null);
}

// ---------------------------------------------------------------- 4
// Kein Kandidat ist ein Pano -> alle Batches, aber nie mehr als
// MAX_DETAIL_ATTEMPTS insgesamt.
calls.length = 0;
{
  const items = freshIds(40);
  responder = (url) => {
    if (url.includes('/images?')) return { json: { data: items } };
    const id = url.split('/').pop().split('?')[0];
    return { json: { id, is_pano: false, geometry: GEOM, thumb_2048_url: `u/${id}` } };
  };
  const loc = await fetchPanoramaForRegion(region, () => 0);
  const c = counts();
  check('kein Pano: Deckel von 8 Detailabfragen haelt', c.detail <= 8, `detail=${c.detail}`);
  check('kein Pano: liefert null', loc === null);
}

// ---------------------------------------------------------------- 5
// Mapillary lehnt die zusaetzlichen Felder ab -> zweite Listenabfrage mit
// fields=id, danach normaler Detailpfad. Darf NICHT komplett scheitern.
calls.length = 0;
{
  const items = freshIds(4);
  const panoId = items[0].id;
  let listSeen = 0;
  responder = (url) => {
    if (url.includes('/images?')) {
      listSeen += 1;
      if (listSeen === 1) return { ok: false, status: 400, json: { error: { message: 'Tried accessing nonexisting field (is_pano)' } } };
      return { json: { data: items } };
    }
    const id = url.split('/').pop().split('?')[0];
    return { json: { id, is_pano: id === panoId, geometry: GEOM, thumb_2048_url: `u/${id}` } };
  };
  const loc = await fetchPanoramaForRegion(region, () => 0);
  const c = counts();
  check('abgelehnte Felder: zweite Listenabfrage mit fields=id', c.list === 2, JSON.stringify(c));
  check('abgelehnte Felder: Runde loest trotzdem auf', loc !== null);
}

// ---------------------------------------------------------------- 6
// Ein echter Fehler (kein Feld-Problem) muss weiterhin durchschlagen.
calls.length = 0;
{
  responder = () => ({ ok: false, status: 500, json: { error: { message: 'Internal error' } } });
  let threw = false;
  try {
    await fetchPanoramaForRegion(region, () => 0);
  } catch {
    threw = true;
  }
  check('echter Serverfehler wird nicht verschluckt', threw);
  check('echter Serverfehler: kein blinder zweiter Versuch', counts().list === 1, JSON.stringify(counts()));
}

// ---------------------------------------------------------------- 7
// Progressive Vorstufe: thumb_1024_url wird als panoramaUrlFast uebernommen,
// fehlt sie, bleibt der Wert null (dann laedt app.js direkt das grosse Bild).
calls.length = 0;
{
  const withFast = freshIds(3).map((o) => ({
    ...o, is_pano: true, geometry: GEOM,
    thumb_2048_url: `big/${o.id}`, thumb_1024_url: `small/${o.id}`,
  }));
  responder = () => ({ json: { data: withFast } });
  const loc = await fetchPanoramaForRegion(region, () => 0.5);
  check('Vorstufe: panoramaUrlFast aus thumb_1024_url', loc?.panoramaUrlFast?.startsWith('small/'), String(loc?.panoramaUrlFast));
  check('Vorstufe: panoramaUrl bleibt das grosse Bild', loc?.panoramaUrl?.startsWith('big/'), String(loc?.panoramaUrl));
}
calls.length = 0;
{
  const noFast = freshIds(3).map((o) => ({ ...o, is_pano: true, geometry: GEOM, thumb_2048_url: `big/${o.id}` }));
  responder = () => ({ json: { data: noFast } });
  const loc = await fetchPanoramaForRegion(region, () => 0.5);
  check('ohne thumb_1024_url: panoramaUrlFast ist null', loc?.panoramaUrlFast === null, String(loc?.panoramaUrlFast));
  check('ohne thumb_1024_url: Runde loest trotzdem auf', loc !== null);
}

console.log(`\n${pass} pass, ${fail} fail`);
process.exit(fail ? 1 : 0);
