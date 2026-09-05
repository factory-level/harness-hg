/* Sets `data-theme` on <html> BEFORE first paint — every page loads this
 * synchronously in <head>, above the stylesheet.
 *
 * The site and the wiki share one theme choice (one origin, ADR-136): the
 * wiki's Material toggle persists to localStorage as `__palette`, index 0 =
 * slate/dark, index 1 = light — the entry order in mkdocs.yml. A stored
 * choice wins here too; no stored choice falls back to the system
 * preference, and tracks it live (hero.js repaints off the same media
 * query, and its listener registers after this one, so the tokens are
 * already flipped when it re-reads them). */
(function () {
  var mq = matchMedia('(prefers-color-scheme: dark)');
  function stored() {
    try {
      var p = JSON.parse(localStorage.getItem('__palette'));
      if (p && p.index === 0) return 'dark';
      if (p && p.index === 1) return 'light';
    } catch (e) {}
    return null;
  }
  function apply() {
    document.documentElement.dataset.theme =
      stored() || (mq.matches ? 'dark' : 'light');
  }
  apply();
  mq.addEventListener
    ? mq.addEventListener('change', apply)
    : mq.addListener(apply);
})();
