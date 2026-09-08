/**
 * Minimaler, selbst geschriebener QR-Code-Generator (Byte-Modus, Fehler-
 * korrektur-Level M, immer Maskenmuster 0). Kein externes CDN-Skript - siehe
 * Umgebungs-Einschraenkungen (agentproxy blockt fremde Hosts), und Room-Links
 * sind ohnehin reiner ASCII-Text, fuer den der einfachste QR-Modus reicht.
 *
 * Alle Tabellenwerte (RS-Block-Struktur pro Version, Alignment-Pattern-
 * Positionen, BCH-Generatorpolynome) wurden NICHT aus dem Gedaechtnis
 * abgetippt, sondern gegen die Referenzimplementierung der Python-
 * "qrcode"-Bibliothek verifiziert (siehe
 * scripts/qrcode-verify.mjs) - drei Test-Strings unterschiedlicher Laenge
 * (Version 1/einzelner Block, Version 3, Version 8/zwei Bloecke) wurden
 * Modul-fuer-Modul mit der Referenzausgabe verglichen, bevor dieser Code
 * in die App uebernommen wurde.
 *
 * Unterstuetzt Versionen 1-15 (bis 412 Byte bei ECC-M) - fuer Raum-Links
 * (Domain + Pfad + #room=CODE) mehr als ausreichend Reserve.
 */

const GF_EXP = new Array(512);
const GF_LOG = new Array(256);
(function initGaloisField() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitives Polynom fuer GF(256), QR-Standard
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

function polyMul(a, b) {
  const result = new Array(a.length + b.length - 1).fill(0);
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      result[i + j] ^= gfMul(a[i], b[j]);
    }
  }
  return result;
}

function rsGeneratorPoly(ecCount) {
  let g = [1];
  for (let i = 0; i < ecCount; i++) g = polyMul(g, [1, GF_EXP[i]]);
  return g;
}

function rsEncode(dataCodewords, ecCount) {
  const generator = rsGeneratorPoly(ecCount);
  const msg = dataCodewords.concat(new Array(ecCount).fill(0));
  for (let i = 0; i < dataCodewords.length; i++) {
    const coef = msg[i];
    if (coef !== 0) {
      for (let j = 0; j < generator.length; j++) msg[i + j] ^= gfMul(generator[j], coef);
    }
  }
  return msg.slice(dataCodewords.length);
}

// RS-Blockstruktur pro Version bei ECC-Level M (gegen qrcode.base.rs_blocks()
// der Python-Referenzbibliothek generiert, siehe Datei-Kommentar oben).
const BLOCK_TABLE_M = {
  1: [{ count: 1, total: 26, data: 16 }],
  2: [{ count: 1, total: 44, data: 28 }],
  3: [{ count: 1, total: 70, data: 44 }],
  4: [{ count: 2, total: 50, data: 32 }],
  5: [{ count: 2, total: 67, data: 43 }],
  6: [{ count: 4, total: 43, data: 27 }],
  7: [{ count: 4, total: 49, data: 31 }],
  8: [
    { count: 2, total: 60, data: 38 },
    { count: 2, total: 61, data: 39 },
  ],
  9: [
    { count: 3, total: 58, data: 36 },
    { count: 2, total: 59, data: 37 },
  ],
  10: [
    { count: 4, total: 69, data: 43 },
    { count: 1, total: 70, data: 44 },
  ],
  11: [
    { count: 1, total: 80, data: 50 },
    { count: 4, total: 81, data: 51 },
  ],
  12: [
    { count: 6, total: 58, data: 36 },
    { count: 2, total: 59, data: 37 },
  ],
  13: [
    { count: 8, total: 59, data: 37 },
    { count: 1, total: 60, data: 38 },
  ],
  14: [
    { count: 4, total: 64, data: 40 },
    { count: 5, total: 65, data: 41 },
  ],
  15: [
    { count: 5, total: 65, data: 41 },
    { count: 5, total: 66, data: 42 },
  ],
};

const ALIGN_POS = {
  1: [],
  2: [6, 18],
  3: [6, 22],
  4: [6, 26],
  5: [6, 30],
  6: [6, 34],
  7: [6, 22, 38],
  8: [6, 24, 42],
  9: [6, 26, 46],
  10: [6, 28, 50],
  11: [6, 30, 54],
  12: [6, 32, 58],
  13: [6, 34, 62],
  14: [6, 26, 46, 66],
  15: [6, 26, 48, 70],
};

const MAX_VERSION = 15;

function totalDataCodewords(version) {
  return BLOCK_TABLE_M[version].reduce((sum, g) => sum + g.count * g.data, 0);
}

function pickVersion(byteLength) {
  for (let v = 1; v <= MAX_VERSION; v++) {
    const countBits = v <= 9 ? 8 : 16;
    const headerBits = 4 + countBits;
    const capacityBits = totalDataCodewords(v) * 8;
    if (headerBits + byteLength * 8 <= capacityBits) return v;
  }
  return null; // Text zu lang fuer Version <= 15 - Aufrufer zeigt dann keinen QR-Code
}

function pushBits(bits, value, len) {
  for (let i = len - 1; i >= 0; i--) bits.push((value >> i) & 1);
}

function buildDataCodewords(bytes, version) {
  const total = totalDataCodewords(version);
  const bits = [];
  pushBits(bits, 0b0100, 4); // Modenzeiger: Byte-Modus
  pushBits(bits, bytes.length, version <= 9 ? 8 : 16);
  for (const b of bytes) pushBits(bits, b, 8);

  const capacityBits = total * 8;
  for (let i = 0; i < 4 && bits.length < capacityBits; i++) bits.push(0);
  while (bits.length % 8 !== 0) bits.push(0);

  const codewords = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    codewords.push(byte);
  }
  const padBytes = [0xec, 0x11];
  let p = 0;
  while (codewords.length < total) codewords.push(padBytes[p++ % 2]);
  return codewords;
}

function interleave(version) {
  return (dataCodewords) => {
    const groups = BLOCK_TABLE_M[version];
    const blocks = [];
    let offset = 0;
    let ecCountPerBlock = null;
    for (const g of groups) {
      const ecCount = g.total - g.data;
      ecCountPerBlock = ecCount;
      for (let i = 0; i < g.count; i++) {
        const dc = dataCodewords.slice(offset, offset + g.data);
        offset += g.data;
        const ec = rsEncode(dc, ecCount);
        blocks.push({ dc, ec });
      }
    }
    const maxDc = Math.max(...blocks.map((b) => b.dc.length));
    const out = [];
    for (let i = 0; i < maxDc; i++) {
      for (const b of blocks) if (i < b.dc.length) out.push(b.dc[i]);
    }
    for (let i = 0; i < ecCountPerBlock; i++) {
      for (const b of blocks) out.push(b.ec[i]);
    }
    return out;
  };
}

// ---------------------------------------------------------------- BCH (Format-/Versionsinfo)

const G15 = 0x537;
const G15_MASK = 0x5412;
const G18 = 0x1f25;

function bchDigit(data) {
  let digit = 0;
  while (data !== 0) {
    digit++;
    data >>>= 1;
  }
  return digit;
}

function bchTypeInfo(data) {
  let d = data << 10;
  while (bchDigit(d) - bchDigit(G15) >= 0) d ^= G15 << (bchDigit(d) - bchDigit(G15));
  return ((data << 10) | d) ^ G15_MASK;
}

function bchTypeNumber(data) {
  let d = data << 12;
  while (bchDigit(d) - bchDigit(G18) >= 0) d ^= G18 << (bchDigit(d) - bchDigit(G18));
  return (data << 12) | d;
}

// ECC-Level-Anzeigebits fuer das Formatinfo-Feld, wie von der QR-Spezifikation
// vorgeschrieben (nicht die Reihenfolge L/M/Q/H, sondern die Bitwerte selbst -
// hier per Python-Referenz auf M=0 bestaetigt).
const EC_LEVEL_M_BITS = 0;

// ---------------------------------------------------------------- Matrix

function buildMatrix(version, finalCodewords) {
  const size = version * 4 + 17;
  const modules = Array.from({ length: size }, () => new Array(size).fill(null));

  function drawFinder(row, col) {
    for (let r = -1; r <= 7; r++) {
      if (row + r <= -1 || size <= row + r) continue;
      for (let c = -1; c <= 7; c++) {
        if (col + c <= -1 || size <= col + c) continue;
        const inRing = (r >= 0 && r <= 6 && (c === 0 || c === 6)) || (c >= 0 && c <= 6 && (r === 0 || r === 6));
        const inCore = r >= 2 && r <= 4 && c >= 2 && c <= 4;
        modules[row + r][col + c] = inRing || inCore;
      }
    }
  }
  drawFinder(0, 0);
  drawFinder(size - 7, 0);
  drawFinder(0, size - 7);

  const pos = ALIGN_POS[version];
  for (const row of pos) {
    for (const col of pos) {
      if (modules[row][col] !== null) continue;
      for (let r = -2; r <= 2; r++) {
        for (let c = -2; c <= 2; c++) {
          modules[row + r][col + c] = r === -2 || r === 2 || c === -2 || c === 2 || (r === 0 && c === 0);
        }
      }
    }
  }

  for (let r = 8; r < size - 8; r++) if (modules[r][6] === null) modules[r][6] = r % 2 === 0;
  for (let c = 8; c < size - 8; c++) if (modules[6][c] === null) modules[6][c] = c % 2 === 0;

  // Formatinfo (ECC-Level M, Maske 0 - fest, siehe Datei-Kommentar oben)
  const formatBits = bchTypeInfo((EC_LEVEL_M_BITS << 3) | 0);
  for (let i = 0; i < 15; i++) {
    const bit = ((formatBits >> i) & 1) === 1;
    if (i < 6) modules[i][8] = bit;
    else if (i < 8) modules[i + 1][8] = bit;
    else modules[size - 15 + i][8] = bit;
  }
  for (let i = 0; i < 15; i++) {
    const bit = ((formatBits >> i) & 1) === 1;
    if (i < 8) modules[8][size - i - 1] = bit;
    else if (i < 9) modules[8][15 - i - 1 + 1] = bit;
    else modules[8][15 - i - 1] = bit;
  }
  modules[size - 8][8] = true; // fester dunkler Modul

  if (version >= 7) {
    const versionBits = bchTypeNumber(version);
    for (let i = 0; i < 18; i++) {
      const bit = ((versionBits >> i) & 1) === 1;
      modules[Math.floor(i / 3)][(i % 3) + size - 8 - 3] = bit;
    }
    for (let i = 0; i < 18; i++) {
      const bit = ((versionBits >> i) & 1) === 1;
      modules[(i % 3) + size - 8 - 3][Math.floor(i / 3)] = bit;
    }
  }


  // Zickzack-Datenplatzierung mit fest Maske 0 ((row+col)%2===0 invertiert).
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  // colStart bleibt die reine Ausgangsfolge (size-1, size-3, ..., 2) - wird
  // sie durch die Timing-Spalten-Verschiebung unten direkt mutiert (statt
  // nur eine lokale "col"-Kopie), wirkt sich das faelschlich auch auf den
  // naechsten col-=2-Schritt der for-Schleife selbst aus: die Spaltenpaare
  // (3,2) und (1,0) wuerden dann nie besucht (per Referenzvergleich gegen
  // die Python-"qrcode"-Bibliothek gefunden, siehe scripts/qrcode-verify.mjs).
  for (let colStart = size - 1; colStart > 0; colStart -= 2) {
    const col = colStart <= 6 ? colStart - 1 : colStart;
    for (;;) {
      for (const c of [col, col - 1]) {
        if (modules[row][c] === null) {
          let dark = byteIndex < finalCodewords.length ? ((finalCodewords[byteIndex] >> bitIndex) & 1) === 1 : false;
          if ((row + c) % 2 === 0) dark = !dark;
          modules[row][c] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || size <= row) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }

  return modules;
}

/**
 * Erzeugt eine QR-Code-Modul-Matrix (Array aus Array aus Boolean, true =
 * dunkles Modul) fuer den gegebenen Text. Gibt null zurueck, wenn der Text
 * selbst fuer die groesste unterstuetzte Version (15, 412 Byte bei ECC-M) zu
 * lang ist - Aufrufer sollte in diesem seltenen Fall auf reinen Text/Link
 * zurueckfallen statt einen QR-Code anzuzeigen.
 */
export function generateQrMatrix(text) {
  const bytes = Array.from(new TextEncoder().encode(text));
  const version = pickVersion(bytes.length);
  if (!version) return null;
  const dataCodewords = buildDataCodewords(bytes, version);
  const finalCodewords = interleave(version)(dataCodewords);
  return buildMatrix(version, finalCodewords);
}

/**
 * Rendert eine Modul-Matrix als eigenstaendiges SVG-Markup (String) - fester
 * heller Modul-Ton auf transparentem Hintergrund, damit die aufrufende Stelle
 * per CSS Vorder-/Hintergrundfarbe frei bestimmen kann. quietZone (Anzahl
 * Module Weissraum-Rand) ist per QR-Spezifikation fuer verlaessliches Scannen
 * empfohlen, Default 4.
 */
export function matrixToSvg(matrix, { quietZone = 4, moduleColor = '#000' } = {}) {
  const size = matrix.length;
  const dim = size + quietZone * 2;
  let path = '';
  for (let r = 0; r < size; r++) {
    for (let c = 0; c < size; c++) {
      if (matrix[r][c]) path += `M${c + quietZone},${r + quietZone}h1v1h-1z`;
    }
  }
  return `<svg viewBox="0 0 ${dim} ${dim}" xmlns="http://www.w3.org/2000/svg" shape-rendering="crispEdges"><rect width="${dim}" height="${dim}" fill="none"/><path d="${path}" fill="${moduleColor}"/></svg>`;
}
