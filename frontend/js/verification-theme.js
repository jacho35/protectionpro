// Match the app's theme preference (localStorage key set by the main app),
// falling back to the OS preference. Runs before paint to avoid a flash.
(function () {
  try {
    var pref = localStorage.getItem('protectionpro-dark-mode');
    var dark = pref === 'true' || (pref === null &&
      window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    if (dark) document.documentElement.classList.add('dark');
  } catch (e) {}
})();
