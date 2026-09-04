const MUTE_KEY = 'geofinder.muted';

let ctx = null;
let muted = localStorage.getItem(MUTE_KEY) === '1';

function getContext() {
  if (!ctx) {
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    ctx = new AudioContextClass();
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

/** Muss nach einer echten User-Geste aufgerufen werden (Autoplay-Policy). */
export function unlockAudio() {
  if (!muted) getContext();
}

export function isMuted() {
  return muted;
}

export function setMuted(value) {
  muted = value;
  localStorage.setItem(MUTE_KEY, muted ? '1' : '0');
  if (muted) stopRoundAmbience();
}

export function toggleMuted() {
  setMuted(!muted);
  return muted;
}

function tone({ freq, duration, type = 'sine', gain = 0.15, delay = 0, glideTo = null }) {
  if (muted) return;
  try {
    const audioCtx = getContext();
    const start = audioCtx.currentTime + delay;
    const osc = audioCtx.createOscillator();
    const amp = audioCtx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, start);
    if (glideTo) osc.frequency.exponentialRampToValueAtTime(glideTo, start + duration);
    amp.gain.setValueAtTime(0, start);
    amp.gain.linearRampToValueAtTime(gain, start + 0.008);
    amp.gain.exponentialRampToValueAtTime(0.0001, start + duration);
    osc.connect(amp).connect(audioCtx.destination);
    osc.start(start);
    osc.stop(start + duration + 0.02);
  } catch {
    // Web Audio nicht verfuegbar oder noch gesperrt - Sound ist rein kosmetisch
  }
}

export function playClick() {
  tone({ freq: 720, duration: 0.06, type: 'square', gain: 0.08 });
}

export function playPinSet() {
  tone({ freq: 520, duration: 0.09, type: 'sine', gain: 0.14, glideTo: 780 });
}

export function playTick(critical) {
  tone({ freq: critical ? 980 : 700, duration: 0.05, type: 'square', gain: critical ? 0.12 : 0.07 });
}

export function playGuessSubmitted() {
  tone({ freq: 440, duration: 0.1, type: 'triangle', gain: 0.12 });
  tone({ freq: 660, duration: 0.12, type: 'triangle', gain: 0.1, delay: 0.08 });
}

export function playRoundReveal() {
  tone({ freq: 330, duration: 0.15, type: 'sine', gain: 0.1 });
}

/** Kleiner Erfolgs-Jingle fuer sehr gute Treffer. */
export function playSuccess() {
  [523.25, 659.25, 783.99, 1046.5].forEach((freq, i) => {
    tone({ freq, duration: 0.18, type: 'triangle', gain: 0.13, delay: i * 0.07 });
  });
}

export function playStreak() {
  [660, 880].forEach((freq, i) => {
    tone({ freq, duration: 0.12, type: 'sawtooth', gain: 0.08, delay: i * 0.06 });
  });
}

// ---------------------------------------------------------------- Runden-Ambience
// Leises "Wind"-Rauschen waehrend einer laufenden (zeitlimitierten) Runde -
// gefiltertes Rauschen statt einer Audiodatei, damit kein zusaetzliches
// Asset geladen werden muss. setRoundTension() dreht Lautstaerke/Filter-
// Cutoff in den letzten Sekunden hoch ("Pitch"-Eindruck durch hellere
// Frequenzen, nicht durch echtes Pitch-Shifting eines Samples).
let droneNodes = null;

function buildNoiseBuffer(audioCtx) {
  const length = audioCtx.sampleRate * 2; // 2s, loopend
  const buffer = audioCtx.createBuffer(1, length, audioCtx.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

export function startRoundAmbience() {
  if (muted) return;
  stopRoundAmbience();
  try {
    const audioCtx = getContext();
    const source = audioCtx.createBufferSource();
    source.buffer = buildNoiseBuffer(audioCtx);
    source.loop = true;
    const filter = audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(280, audioCtx.currentTime);
    const gain = audioCtx.createGain();
    gain.gain.setValueAtTime(0, audioCtx.currentTime);
    gain.gain.linearRampToValueAtTime(0.03, audioCtx.currentTime + 1.5);
    source.connect(filter).connect(gain).connect(audioCtx.destination);
    source.start();
    droneNodes = { source, filter, gain };
  } catch {
    droneNodes = null; // Web Audio nicht verfuegbar - Ambience ist rein kosmetisch
  }
}

/** intensity: 0 (normal) bis 1 (maximale Anspannung, letzte Sekunden). */
export function setRoundTension(intensity) {
  if (!droneNodes) return;
  try {
    const audioCtx = getContext();
    const t = audioCtx.currentTime;
    const clamped = Math.max(0, Math.min(1, intensity));
    droneNodes.filter.frequency.linearRampToValueAtTime(280 + clamped * 1000, t + 0.4);
    droneNodes.gain.gain.linearRampToValueAtTime(0.03 + clamped * 0.055, t + 0.4);
  } catch {
    // egal - kosmetisch
  }
}

export function stopRoundAmbience() {
  if (!droneNodes) return;
  const nodes = droneNodes;
  droneNodes = null;
  try {
    const audioCtx = getContext();
    const t = audioCtx.currentTime;
    nodes.gain.gain.cancelScheduledValues(t);
    nodes.gain.gain.setValueAtTime(nodes.gain.gain.value, t);
    nodes.gain.gain.linearRampToValueAtTime(0, t + 0.35);
    nodes.source.stop(t + 0.4);
  } catch {
    // egal - kosmetisch
  }
}
