// Runs before the first paint (a classic script in <head>; the CSP forbids inline scripts): puts the
// last chosen theme on <html> so the page never flashes the wrong colours. The app takes over once it
// starts (core/theme.ts). No stored choice, or "system", leaves the attribute off and the OS decides.
// The list of ids must match the Theme type in @notes/shared (scripts/check-theme-contrast.mjs checks it).
(function () {
  try {
    var theme = localStorage.getItem('notes.theme');
    if (/^(light|dark|purple|red|green|blue|darkblue)$/.test(theme))
      document.documentElement.setAttribute('data-theme', theme);
  } catch (e) {
    /* storage unavailable: fall back to the OS setting */
  }
})();
