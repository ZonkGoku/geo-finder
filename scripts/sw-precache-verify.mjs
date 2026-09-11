// node scripts/sw-precache-verify.mjs
//
// Prueft, dass APP_SHELL_URLS in sw.js wirklich JEDES JS-Modul unter js/
// enthaelt. Hintergrund: die Liste wird von Hand gepflegt und ist genau
// deshalb schon einmal auseinandergelaufen - beim Audit fehlten 18 von 39
// Modulen (u.a. i18n.js, profile.js, heatmap-map.js), weil sie beim Bauen
// neuer Features schlicht nicht mitgewachsen ist. Folge war ein PWA-Versprechen,
// das die Haelfte der App nicht eingeloest hat (PulseMap lief offline gar nicht).
//
// Prueft beide Richtungen: fehlende Eintraege (Modul da, Liste kennt es nicht)
// UND verwaiste Eintraege (Liste kennt es, Datei existiert nicht mehr) - ein
// toter Pfad wuerde sonst bei jeder Installation still einen cache.add()-Fehler
// loggen, weil die Installation Einzelfehler bewusst nur warnt statt abbricht.
import { readFile, readdir, access } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

async function collectJsModules(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...(await collectJsModules(full)));
    else if (entry.name.endsWith('.js')) found.push(`./${relative(ROOT, full).split(sep).join('/')}`);
  }
  return found;
}

const swSource = await readFile(join(ROOT, 'sw.js'), 'utf8');

// Nur den APP_SHELL_URLS-Block parsen, nicht die ganze Datei - sonst wuerden
// auch Pfade aus Kommentaren/anderen Konstanten mitgezaehlt.
const blockMatch = swSource.match(/const APP_SHELL_URLS = \[([\s\S]*?)\];/);
if (!blockMatch) {
  console.error('FEHLER: APP_SHELL_URLS-Block in sw.js nicht gefunden (umbenannt/umformatiert?).');
  process.exit(1);
}
const listed = new Set([...blockMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1]));

const modules = (await collectJsModules(join(ROOT, 'js'))).sort();
const missing = modules.filter((m) => !listed.has(m));

// Verwaiste Eintraege: alles aus der Liste, das wie ein lokaler Dateipfad
// aussieht (fuehrendes ./) und nicht mehr auf der Platte liegt. './' selbst
// ist der Navigations-Einstieg, kein Datei-Pfad - daher ausgenommen.
const orphans = [];
for (const url of listed) {
  if (url === './' || !url.startsWith('./')) continue;
  try {
    await access(join(ROOT, url));
  } catch {
    orphans.push(url);
  }
}

console.log(`js/-Module gefunden: ${modules.length}`);
console.log(`APP_SHELL_URLS-Eintraege: ${listed.size}`);

if (missing.length) {
  console.error(`\nFEHLEN im Precache (${missing.length}):`);
  for (const m of missing) console.error(`  ${m}`);
}
if (orphans.length) {
  console.error(`\nVERWAISTE Eintraege (Datei existiert nicht mehr) (${orphans.length}):`);
  for (const o of orphans) console.error(`  ${o}`);
}

if (missing.length || orphans.length) {
  console.error('\nsw.js APP_SHELL_URLS anpassen und CACHE_VERSION hochziehen.');
  process.exit(1);
}

console.log('\nOK - Precache-Liste ist vollstaendig und enthaelt keine toten Pfade.');
