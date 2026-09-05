// The copy-page control (ADR 0176). Two jobs only: put the page's markdown on
// the clipboard, and open/close the menu. The three links beside it are real
// hrefs rendered by overrides/main.html, so nothing here has to guess a URL.
//
// Listeners are DELEGATED rather than bound per element, and re-bound on every
// navigation through Material's `document$` - the documented hook for code that
// must run per page under `navigation.instant`. A single listener on `document`
// also survives instant navigation today (measured), so this is belt-and-braces
// against Material changing how it swaps documents, not a fix for a live bug.
// Binding to `document.body` cannot stack: instant nav replaces the body, so
// the previous listener goes with it.
(function () {
  "use strict";

  var RESTORE_MS = 1600;

  function closeMenus(except) {
    document.querySelectorAll(".hg-copy__menu:not([hidden])").forEach(function (menu) {
      if (menu === except) return;
      menu.hidden = true;
      var more = menu.parentElement && menu.parentElement.querySelector(".hg-copy__more");
      if (more) more.setAttribute("aria-expanded", "false");
    });
  }

  function onClick(e) {
    var go = e.target.closest && e.target.closest(".hg-copy__go");
    if (go) {
      var root = go.closest(".hg-copy");
      var label = go.querySelector(".hg-copy__label") || go;
      var was = label.textContent;
      fetch(root.dataset.hgMd)
        .then(function (r) {
          if (!r.ok) throw new Error(r.status);
          return r.text();
        })
        .then(function (text) {
          return navigator.clipboard.writeText(text);
        })
        .then(function () {
          label.textContent = "Copied";
          root.classList.add("hg-copy--done");
          setTimeout(function () {
            label.textContent = was;
            root.classList.remove("hg-copy--done");
          }, RESTORE_MS);
        })
        .catch(function () {
          // Clipboard blocked, or the .md is not served. Say so rather than
          // flashing "Copied" over nothing - View as Markdown still works.
          label.textContent = "Copy failed";
          setTimeout(function () {
            label.textContent = was;
          }, RESTORE_MS);
        });
      closeMenus();
      return;
    }

    var more = e.target.closest && e.target.closest(".hg-copy__more");
    if (more) {
      var menu = more.parentElement.querySelector(".hg-copy__menu");
      var opening = menu.hidden;
      closeMenus(menu);
      menu.hidden = !opening;
      more.setAttribute("aria-expanded", String(opening));
      return;
    }

    if (!(e.target.closest && e.target.closest(".hg-copy__menu"))) closeMenus();
  }

  function onKey(e) {
    if (e.key === "Escape") closeMenus();
  }

  function bind() {
    document.body.addEventListener("click", onClick);
    document.body.addEventListener("keydown", onKey);
  }

  if (window.document$ && typeof window.document$.subscribe === "function") {
    window.document$.subscribe(bind);
  } else {
    bind();
  }
})();
