export const THEME_KEY = 'hii.theme.v1';
export function resolveTheme(preference, systemDark) {
  return preference === 'light' || preference === 'dark' ? preference : systemDark ? 'dark' : 'light';
}
export function installThemeToggle(button) {
  const media = window.matchMedia('(prefers-color-scheme: dark)');
  let preference;
  try { preference = localStorage.getItem(THEME_KEY); } catch {}
  function apply() {
    const theme = resolveTheme(preference, media.matches);
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    if (window.parent !== window) window.parent.postMessage({ type: 'hii-personal-theme', theme }, '*');
    button.textContent = theme === 'dark' ? 'Light mode' : 'Dark mode';
    button.setAttribute('aria-label', 'Switch to ' + (theme === 'dark' ? 'light' : 'dark') + ' mode');
  }
  button.addEventListener('click', () => {
    preference = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    try { localStorage.setItem(THEME_KEY, preference); } catch {}
    apply();
  });
  media.addEventListener('change', apply);
  window.addEventListener('storage', event => { if (event.key === THEME_KEY) { preference = event.newValue; apply(); } });
  apply();
}
