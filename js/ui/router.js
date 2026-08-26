const SCREENS = ['menu', 'lobby', 'hud', 'result', 'leaderboard'];

export function showScreen(name) {
  for (const id of SCREENS) {
    const el = document.getElementById(`screen-${id}`);
    if (!el) continue;
    el.classList.toggle('active', id === name);
  }
  document.dispatchEvent(new CustomEvent('screen:shown', { detail: { name } }));
}
