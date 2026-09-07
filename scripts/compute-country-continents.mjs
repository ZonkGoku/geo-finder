// Einmalig auszufuehren (node scripts/compute-country-continents.mjs), wenn
// sich data/geo/countries-110m.json aendert. Erzeugt data/geo/country-
// continents.json: Kontinent pro Land-ID, die der Heatmap-Modus fuer den
// "gleicher Kontinent"-Hinweis braucht (siehe core/heatmap-color.js) - eine
// schwaechere Stufe als der direkte Nachbarland-Treffer aus
// compute-country-neighbors.mjs.
//
// Anders als die Nachbarschafts-Erkennung laesst sich ein Kontinent NICHT
// aus den Umriss-Polygonen selbst ableiten (ein Land "weiss" geometrisch
// nicht, zu welchem Kontinent es zaehlt). countries-110m.json enthaelt dazu
// auch kein Attribut (nur "name", siehe unten). Bewusst KEIN externer
// Datensatz von GitHub - dieselbe Begruendung wie im Nachbarschafts-Skript
// (ISO-Alpha-Code-Annahmen passen nicht zu den UN-M49-IDs/Namens-Slugs
// dieses Projekts). Stattdessen eine von Hand gepflegte Namens-Tabelle -
// bei 177 Laendern ueberschaubar, und ein Laufzeit-Check unten sorgt
// dafuer, dass ein spaeter hinzugefuegtes Land nicht STILL ohne
// Kontinent-Zuordnung bleibt (fehlender Eintrag laesst das Skript fehlschlagen
// statt lueckenhafte Daten zu schreiben).
//
// Transkontinentale Faelle (Russland, Tuerkei, Kasachstan, Georgien,
// Armenien, Aserbaidschan, Zypern/Nordzypern) sind fuer einen einzelnen
// Hinweis-Wert nicht eindeutig "richtig" loesbar - hier nach ueberwiegender
// Landmasse/geografischer Konvention eingeordnet (z. B. Tuerkei/Russland als
// "Asia", da der weit groessere Teil der Flaeche dort liegt), nicht nach
// politischer/kultureller Zuordnung. Das ist ein bewusster Kompromiss fuer
// einen weichen Gameplay-Hinweis, keine geopolitische Aussage.
import { readFile, writeFile } from 'node:fs/promises';

const SRC = new URL('../data/geo/countries-110m.json', import.meta.url);
const OUT = new URL('../data/geo/country-continents.json', import.meta.url);

const NAME_TO_CONTINENT = {
  Afghanistan: 'Asia',
  Albania: 'Europe',
  Algeria: 'Africa',
  Angola: 'Africa',
  Antarctica: 'Antarctica',
  Argentina: 'South America',
  Armenia: 'Asia',
  Australia: 'Oceania',
  Austria: 'Europe',
  Azerbaijan: 'Asia',
  Bahamas: 'North America',
  Bangladesh: 'Asia',
  Belarus: 'Europe',
  Belgium: 'Europe',
  Belize: 'North America',
  Benin: 'Africa',
  Bhutan: 'Asia',
  Bolivia: 'South America',
  'Bosnia and Herz.': 'Europe',
  Botswana: 'Africa',
  Brazil: 'South America',
  Brunei: 'Asia',
  Bulgaria: 'Europe',
  'Burkina Faso': 'Africa',
  Burundi: 'Africa',
  Cambodia: 'Asia',
  Cameroon: 'Africa',
  Canada: 'North America',
  'Central African Rep.': 'Africa',
  Chad: 'Africa',
  Chile: 'South America',
  China: 'Asia',
  Colombia: 'South America',
  Congo: 'Africa',
  'Costa Rica': 'North America',
  Croatia: 'Europe',
  Cuba: 'North America',
  Cyprus: 'Europe',
  Czechia: 'Europe',
  "Côte d'Ivoire": 'Africa',
  'Dem. Rep. Congo': 'Africa',
  Denmark: 'Europe',
  Djibouti: 'Africa',
  'Dominican Rep.': 'North America',
  Ecuador: 'South America',
  Egypt: 'Africa',
  'El Salvador': 'North America',
  'Eq. Guinea': 'Africa',
  Eritrea: 'Africa',
  Estonia: 'Europe',
  Ethiopia: 'Africa',
  'Falkland Is.': 'South America',
  Fiji: 'Oceania',
  Finland: 'Europe',
  'Fr. S. Antarctic Lands': 'Antarctica',
  France: 'Europe',
  Gabon: 'Africa',
  Gambia: 'Africa',
  Georgia: 'Asia',
  Germany: 'Europe',
  Ghana: 'Africa',
  Greece: 'Europe',
  Greenland: 'North America',
  Guatemala: 'North America',
  Guinea: 'Africa',
  'Guinea-Bissau': 'Africa',
  Guyana: 'South America',
  Haiti: 'North America',
  Honduras: 'North America',
  Hungary: 'Europe',
  Iceland: 'Europe',
  India: 'Asia',
  Indonesia: 'Asia',
  Iran: 'Asia',
  Iraq: 'Asia',
  Ireland: 'Europe',
  Israel: 'Asia',
  Italy: 'Europe',
  Jamaica: 'North America',
  Japan: 'Asia',
  Jordan: 'Asia',
  Kazakhstan: 'Asia',
  Kenya: 'Africa',
  Kosovo: 'Europe',
  Kuwait: 'Asia',
  Kyrgyzstan: 'Asia',
  Laos: 'Asia',
  Latvia: 'Europe',
  Lebanon: 'Asia',
  Lesotho: 'Africa',
  Liberia: 'Africa',
  Libya: 'Africa',
  Lithuania: 'Europe',
  Luxembourg: 'Europe',
  Macedonia: 'Europe',
  Madagascar: 'Africa',
  Malawi: 'Africa',
  Malaysia: 'Asia',
  Mali: 'Africa',
  Mauritania: 'Africa',
  Mexico: 'North America',
  Moldova: 'Europe',
  Mongolia: 'Asia',
  Montenegro: 'Europe',
  Morocco: 'Africa',
  Mozambique: 'Africa',
  Myanmar: 'Asia',
  'N. Cyprus': 'Europe',
  Namibia: 'Africa',
  Nepal: 'Asia',
  Netherlands: 'Europe',
  'New Caledonia': 'Oceania',
  'New Zealand': 'Oceania',
  Nicaragua: 'North America',
  Niger: 'Africa',
  Nigeria: 'Africa',
  'North Korea': 'Asia',
  Norway: 'Europe',
  Oman: 'Asia',
  Pakistan: 'Asia',
  Palestine: 'Asia',
  Panama: 'North America',
  'Papua New Guinea': 'Oceania',
  Paraguay: 'South America',
  Peru: 'South America',
  Philippines: 'Asia',
  Poland: 'Europe',
  Portugal: 'Europe',
  'Puerto Rico': 'North America',
  Qatar: 'Asia',
  Romania: 'Europe',
  Russia: 'Asia',
  Rwanda: 'Africa',
  'S. Sudan': 'Africa',
  'Saudi Arabia': 'Asia',
  Senegal: 'Africa',
  Serbia: 'Europe',
  'Sierra Leone': 'Africa',
  Slovakia: 'Europe',
  Slovenia: 'Europe',
  'Solomon Is.': 'Oceania',
  Somalia: 'Africa',
  Somaliland: 'Africa',
  'South Africa': 'Africa',
  'South Korea': 'Asia',
  Spain: 'Europe',
  'Sri Lanka': 'Asia',
  Sudan: 'Africa',
  Suriname: 'South America',
  Sweden: 'Europe',
  Switzerland: 'Europe',
  Syria: 'Asia',
  Taiwan: 'Asia',
  Tajikistan: 'Asia',
  Tanzania: 'Africa',
  Thailand: 'Asia',
  'Timor-Leste': 'Asia',
  Togo: 'Africa',
  'Trinidad and Tobago': 'North America',
  Tunisia: 'Africa',
  Turkey: 'Asia',
  Turkmenistan: 'Asia',
  Uganda: 'Africa',
  Ukraine: 'Europe',
  'United Arab Emirates': 'Asia',
  'United Kingdom': 'Europe',
  'United States of America': 'North America',
  Uruguay: 'South America',
  Uzbekistan: 'Asia',
  Vanuatu: 'Oceania',
  Venezuela: 'South America',
  Vietnam: 'Asia',
  'W. Sahara': 'Africa',
  Yemen: 'Asia',
  Zambia: 'Africa',
  Zimbabwe: 'Africa',
  eSwatini: 'Africa',
};

function slug(name) {
  return `name-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
}

function resolveFeatureId(feature) {
  return feature.id != null ? String(feature.id) : slug(feature.properties.name);
}

const geojson = JSON.parse(await readFile(SRC, 'utf8'));

const missing = [];
const result = {};
for (const feature of geojson.features) {
  const name = feature.properties.name;
  const continent = NAME_TO_CONTINENT[name];
  if (!continent) {
    missing.push(name);
    continue;
  }
  result[resolveFeatureId(feature)] = continent;
}

if (missing.length > 0) {
  throw new Error(`Kontinent-Tabelle unvollstaendig, es fehlen: ${missing.join(', ')}`);
}

await writeFile(OUT, JSON.stringify(result), 'utf8');
console.log(`${geojson.features.length} Laender, alle mit Kontinent zugeordnet.`);
console.log(`Geschrieben nach ${OUT.pathname}`);
