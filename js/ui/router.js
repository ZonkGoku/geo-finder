const SCREENS = ['menu', 'lobby', 'hud', 'result', 'leaderboard'];
const TRANSITION_MS = 220;

let pendingCleanup = null;

/**
 * Statt eines harten display:none/block-Wechsels blendet der bisherige
 * Screen sich waehrend des Uebergangs kurz per position:absolute UEBER den
 * neuen (der schon normal in den Fluss einblendet), damit beide Screens
 * kurz gleichzeitig sichtbar sind (siehe .screen.leaving in styles.css) -
 * ein echtes Crossfade statt eines abrupten Umschaltens.
 */
export function showScreen(name) {
  const elements = SCREENS.map((id) => document.getElementById(`screen-${id}`)).filter(Boolean);
  const next = document.getElementById(`screen-${name}`);
  if (!next) return;

  // Eine evtl. noch laufende vorherige Transition sofort abschliessen, statt
  // zwei Screens ueberlappend haengen zu lassen, falls showScreen() erneut
  // aufgerufen wird, bevor der letzte Uebergang fertig war.
  if (pendingCleanup) {
    clearTimeout(pendingCleanup.timer);
    pendingCleanup.el.classList.remove('active', 'leaving');
    pendingCleanup = null;
  }

  const current = elements.find((el) => el.classList.contains('active') && el !== next);

  if (!current) {
    elements.forEach((el) => el.classList.toggle('active', el === next));
    document.dispatchEvent(new CustomEvent('screen:shown', { detail: { name } }));
    return;
  }

  current.classList.add('leaving');
  next.classList.add('active');
  elements.forEach((el) => {
    if (el !== next && el !== current) el.classList.remove('active');
  });
  document.dispatchEvent(new CustomEvent('screen:shown', { detail: { name } }));

  const timer = setTimeout(() => {
    current.classList.remove('active', 'leaving');
    pendingCleanup = null;
  }, TRANSITION_MS);
  pendingCleanup = { el: current, timer };
}
