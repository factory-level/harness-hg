// Make the header's site-name text link home, like the logo beside it.
// Material renders the title as a plain <span>; `extra.homepage` in
// mkdocs.yml retargets only the logo anchor. Reusing the logo's href keeps
// the two in lockstep — one config knob, not two.
(function () {
  var logo = document.querySelector(".md-header .md-logo");
  var title = document.querySelector(".md-header__topic:first-child .md-ellipsis");
  if (!logo || !title) return;
  var link = document.createElement("a");
  link.href = logo.getAttribute("href");
  link.style.color = "inherit";
  link.style.textDecoration = "none";
  title.parentNode.insertBefore(link, title);
  link.appendChild(title);
})();
