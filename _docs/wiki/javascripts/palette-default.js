/* Dark is the default, regardless of the operating system's setting.
 *
 * Nexus works this way: `.nx-root` has no system-preference mode, so the
 * product is dark until someone chooses otherwise. Material's palette, with no
 * `media` key on either entry, still falls back to `prefers-color-scheme` when
 * nothing is stored — which shows anyone on a light desktop a palette the
 * product never uses.
 *
 * This only acts on a first visit. Once the reader has touched the toggle,
 * `__palette` is set and their choice is left alone forever.
 */
(function () {
  if (localStorage.getItem("__palette") !== null) return;

  // `__palette_0` is the first entry in mkdocs.yml — scheme: slate.
  var dark = document.getElementById("__palette_0");
  if (!dark || dark.checked) return;

  // Drive Material's own toggle rather than setting the attribute directly, so
  // its observable updates and the choice persists like any other.
  dark.checked = true;
  dark.dispatchEvent(new Event("change", { bubbles: true }));
})();
