// Leichtgewichtiger Canvas-Partikeleffekt (kein externes Lib) fuer exakte
// Treffer/Podiumsplaetze - ein einziger, wiederverwendeter Vollbild-Canvas
// statt pro Aufruf ein neues Element zu erzeugen, damit wiederholte Bursts
// (z. B. mehrere Podium-Sekunden) nicht den DOM zumuellen.
let canvas = null;
let ctx2d = null;
let particles = [];
let rafId = null;

function ensureCanvas() {
  if (canvas) return canvas;
  canvas = document.createElement('canvas');
  canvas.className = 'particle-canvas';
  document.body.appendChild(canvas);
  ctx2d = canvas.getContext('2d');
  resize();
  window.addEventListener('resize', resize);
  return canvas;
}

function resize() {
  if (!canvas) return;
  canvas.width = window.innerWidth * window.devicePixelRatio;
  canvas.height = window.innerHeight * window.devicePixelRatio;
  canvas.style.width = `${window.innerWidth}px`;
  canvas.style.height = `${window.innerHeight}px`;
}

function tick() {
  ctx2d.setTransform(window.devicePixelRatio, 0, 0, window.devicePixelRatio, 0, 0);
  ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);

  let alive = false;
  for (const p of particles) {
    if (p.life <= 0) continue;
    alive = true;
    p.vy += p.gravity;
    p.x += p.vx;
    p.y += p.vy;
    p.rotation += p.spin;
    p.life -= 1;

    const fade = Math.min(1, p.life / p.fadeStart);
    ctx2d.save();
    ctx2d.globalAlpha = Math.max(0, fade);
    ctx2d.translate(p.x, p.y);
    ctx2d.rotate(p.rotation);
    ctx2d.fillStyle = p.color;
    if (p.shape === 'circle') {
      ctx2d.beginPath();
      ctx2d.arc(0, 0, p.size / 2, 0, Math.PI * 2);
      ctx2d.fill();
    } else {
      ctx2d.fillRect(-p.size / 2, -p.size / 4, p.size, p.size / 2);
    }
    ctx2d.restore();
  }

  if (alive) {
    rafId = requestAnimationFrame(tick);
  } else {
    particles = [];
    cancelAnimationFrame(rafId);
    rafId = null;
    ctx2d.clearRect(0, 0, window.innerWidth, window.innerHeight);
  }
}

const DEFAULT_COLORS = ['#ff7a33', '#17ecff', '#ff1fb0', '#2fe6d6', '#ffd166'];

/**
 * Loest einen Konfetti-/Partikelburst an einer Bildschirmposition aus.
 * originX/originY in CSS-Pixeln (z. B. Mitte eines Buttons/Podiumsplatzes),
 * Default = Bildschirmmitte oben (fuer Runden-/Endstand-Feiern ohne
 * konkreten Ankerpunkt).
 */
export function burst({ x, y, count = 60, colors = DEFAULT_COLORS, spread = 1 } = {}) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return;
  ensureCanvas();
  const originX = x ?? window.innerWidth / 2;
  const originY = y ?? window.innerHeight * 0.35;

  for (let i = 0; i < count; i++) {
    const angle = Math.random() * Math.PI * 2;
    const speed = (2 + Math.random() * 6) * spread;
    particles.push({
      x: originX,
      y: originY,
      vx: Math.cos(angle) * speed,
      vy: Math.sin(angle) * speed - 3,
      gravity: 0.18,
      size: 5 + Math.random() * 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      shape: Math.random() > 0.5 ? 'circle' : 'rect',
      rotation: Math.random() * Math.PI,
      spin: (Math.random() - 0.5) * 0.3,
      life: 70 + Math.random() * 40,
      fadeStart: 30,
    });
  }

  if (!rafId) rafId = requestAnimationFrame(tick);
}
