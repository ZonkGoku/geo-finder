#!/usr/bin/env node
// Machbarkeitstest fuer "Weiterlaufen" (Street-View-artige Navigation zwischen
// verbundenen Mapillary-Panoramen), siehe AUDIT_ROADMAP.md-Diskussion.
//
// Prueft NICHT, ob wir irgendein Bild an einem Punkt finden (das macht die
// Produktions-Pipeline in js/panorama/mapillary-source.js schon), sondern ob
// die gefundenen Bilder zu einer ausreichend DICHTEN, ZUSAMMENHAENGENDEN
// Bildsequenz gehoeren, die sich sinnvoll ablaufen liesse:
//
//   1. Radiussuche (dieselben 50m/100-Limit wie in Produktion) um jeden
//      Ankerpunkt eines Kartenpakets.
//   2. Die groesste Bildsequenz (sequence_id) unter den Treffern bestimmen.
//   3. Alle Bild-IDs dieser Sequenz per /image_ids abrufen, Positionen der
//      ersten SEQUENCE_SAMPLE_SIZE Bilder laden.
//   4. Durchschnittlichen Abstand zwischen aufeinanderfolgenden Bildern
//      berechnen (Haversine) - das ist der Kern-Indikator: kleine Abstaende
//      (~5-15m, wie bei echtem Google Street View) fuehlen sich beim Klicken
//      auf "weiterlaufen" fluessig an, grosse Luecken (>50m) wirken wie
//      Teleport statt Laufen.
//
// Nutzung:
//   node scripts/mapillary-walk-feasibility.mjs [mapset-id] [anzahl-anker]
//   node scripts/mapillary-walk-feasibility.mjs berlin 8
//
// Braucht echten Internetzugang zu graph.mapillary.com - lief zum Zeitpunkt
// der Erstellung dieses Skripts NICHT in der Claude-Code-Sandbox (Org-Policy
// blockiert den Host mit 403). Lokal bzw. produktiv sollte es funktionieren,
// sofern js/config.js einen gueltigen MAPILLARY_ACCESS_TOKEN enthaelt.

import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = join(__dirname, '..');

const API_BASE = 'https://graph.mapillary.com';
const SEARCH_RADIUS_M = 50; // identisch zu js/panorama/mapillary-source.js
const LIST_LIMIT = 100;
const SEQUENCE_SAMPLE_SIZE = 25; // wie viele Bilder der laengsten Sequenz wir fuer den Abstand abfragen
const REQUEST_TIMEOUT_MS = 8000;

async function loadToken() {
  const configPath = join(ROOT, 'js', 'config.js');
  const src = await readFile(configPath, 'utf-8');
  const match = src.match(/MAPILLARY_ACCESS_TOKEN\s*=\s*'([^']+)'/);
  if (!match || match[1].startsWith('PASTE_')) {
    throw new Error('Kein gueltiger MAPILLARY_ACCESS_TOKEN in js/config.js gefunden.');
  }
  return match[1];
}

async function fetchJson(url) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: controller.signal });
    const json = await res.json().catch(() => null);
    if (!res.ok) {
      throw new Error(json?.error?.message || `HTTP ${res.status}`);
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

function haversineMeters(a, b) {
  const R = 6371000;
  const toRad = (d) => (d * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const lat1 = toRad(a.lat);
  const lat2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function analyzeAnchor(token, anchor) {
  const listParams = new URLSearchParams({
    access_token: token,
    fields: 'id,sequence_id',
    lat: String(anchor.lat),
    lng: String(anchor.lng),
    radius: String(SEARCH_RADIUS_M),
    limit: String(LIST_LIMIT),
  });

  let listJson;
  try {
    listJson = await fetchJson(`${API_BASE}/images?${listParams.toString()}`);
  } catch (err) {
    return { anchor, error: err.message };
  }

  const images = listJson?.data || [];
  if (images.length === 0) {
    return { anchor, imagesInRadius: 0, sequenceCount: 0, longestSequenceLength: 0, avgStepMeters: null };
  }

  const bySequence = new Map();
  for (const img of images) {
    if (!img.sequence_id) continue;
    if (!bySequence.has(img.sequence_id)) bySequence.set(img.sequence_id, []);
    bySequence.get(img.sequence_id).push(img.id);
  }

  let bestSeqId = null;
  let bestSeqHits = 0;
  for (const [seqId, ids] of bySequence) {
    if (ids.length > bestSeqHits) {
      bestSeqHits = ids.length;
      bestSeqId = seqId;
    }
  }

  const result = {
    anchor,
    imagesInRadius: images.length,
    sequenceCount: bySequence.size,
    longestSequenceHitsInRadius: bestSeqHits,
    longestSequenceLength: null,
    avgStepMeters: null,
  };

  if (!bestSeqId) return result;

  // Volle Sequenz abfragen (kann weit ueber den 50m-Suchradius hinausgehen -
  // das ist der Punkt: zeigt, wie lang der "Weg" um diesen Ankerpunkt ist).
  let seqJson;
  try {
    seqJson = await fetchJson(
      `${API_BASE}/image_ids?sequence_id=${encodeURIComponent(bestSeqId)}`
    );
  } catch (err) {
    result.error = `Sequenz-Abruf fehlgeschlagen: ${err.message}`;
    return result;
  }
  const seqImageIds = (seqJson?.data || []).map((d) => d.id);
  result.longestSequenceLength = seqImageIds.length;

  const sampleIds = seqImageIds.slice(0, SEQUENCE_SAMPLE_SIZE);
  const positions = [];
  for (const id of sampleIds) {
    try {
      const detail = await fetchJson(
        `${API_BASE}/${id}?${new URLSearchParams({ access_token: token, fields: 'id,geometry' }).toString()}`
      );
      const [lng, lat] = detail?.geometry?.coordinates || [];
      if (Number.isFinite(lat) && Number.isFinite(lng)) positions.push({ lat, lng });
    } catch {
      // einzelnes Bild uebersprungen zaehlt nicht als harter Fehler
    }
  }

  if (positions.length >= 2) {
    const steps = [];
    for (let i = 1; i < positions.length; i++) {
      steps.push(haversineMeters(positions[i - 1], positions[i]));
    }
    result.avgStepMeters = steps.reduce((a, b) => a + b, 0) / steps.length;
    result.sampledPositions = positions.length;
  }

  return result;
}

async function main() {
  const mapSetId = process.argv[2] || 'berlin';
  const anchorCount = Number(process.argv[3] || 6);

  const token = await loadToken();
  const indexPath = join(ROOT, 'data', 'map-sets', 'index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf-8'));
  const entry = index.sets.find((s) => s.id === mapSetId);
  if (!entry) {
    console.error(`Unbekanntes Kartenpaket: ${mapSetId}`);
    process.exit(1);
  }
  const detail = JSON.parse(await readFile(join(ROOT, 'data', 'map-sets', entry.file), 'utf-8'));
  const regions = detail.regions || detail.locations || [];
  const anchors = regions.slice(0, anchorCount);

  console.log(`Machbarkeitstest "Weiterlaufen": ${entry.name} (${anchors.length} von ${regions.length} Ankerpunkten)\n`);

  const results = [];
  for (const anchor of anchors) {
    process.stdout.write(`  ${anchor.name} ... `);
    const r = await analyzeAnchor(token, anchor);
    results.push(r);
    if (r.error) {
      console.log(`FEHLER: ${r.error}`);
    } else {
      console.log(
        `${r.imagesInRadius} Bilder / ${r.sequenceCount} Sequenzen im 50m-Radius, ` +
          `laengste Sequenz: ${r.longestSequenceLength ?? '-'} Bilder gesamt, ` +
          `Ø Schrittweite: ${r.avgStepMeters ? r.avgStepMeters.toFixed(1) + 'm' : 'n/a'}`
      );
    }
  }

  const withData = results.filter((r) => !r.error && r.avgStepMeters != null);
  console.log('\n--- Zusammenfassung ---');
  console.log(`Ankerpunkte mit auswertbarer Sequenz: ${withData.length}/${results.length}`);
  if (withData.length > 0) {
    const avgStep = withData.reduce((a, r) => a + r.avgStepMeters, 0) / withData.length;
    const avgSeqLen = withData.reduce((a, r) => a + (r.longestSequenceLength || 0), 0) / withData.length;
    console.log(`Durchschnittliche Schrittweite ueber alle Anker: ${avgStep.toFixed(1)}m`);
    console.log(`Durchschnittliche Sequenzlaenge: ${avgSeqLen.toFixed(0)} Bilder`);
    console.log(
      avgStep <= 15
        ? 'Verdikt: Schrittweite im Google-Street-View-Bereich (~5-15m) - "Weiterlaufen" sollte sich fluessig anfuehlen.'
        : avgStep <= 30
          ? 'Verdikt: Merklich groessere Sprünge als bei Street View, aber noch nutzbar - eher "von Foto zu Foto hüpfen" als echtes Laufen.'
          : 'Verdikt: Zu grosse Abstaende - würde sich wie Teleportieren anfühlen, nicht wie Laufen.'
    );
  } else {
    console.log('Keine auswertbare Sequenz gefunden - Kartenpaket vermutlich ungeeignet fuer "Weiterlaufen".');
  }
}

main().catch((err) => {
  console.error('Machbarkeitstest fehlgeschlagen:', err.message);
  process.exit(1);
});
