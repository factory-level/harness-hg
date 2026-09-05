// The hero: one mark, one rolling command, and the shapes that command draws.
//
// Everything here is an ENHANCEMENT. Without this file the page still renders
// and still makes its whole argument — the claim, the note, the links and the
// status are ordinary markup, visible by default. Nothing is hidden waiting
// for script to reveal it. What is lost is the demonstration, which is why
// the demonstration is aria-hidden and duplicated in static text.
//
// The commands describe the CLI's TARGET surface (ADR-70). `hg deploy`
// is a specification as much as a demonstration; nothing launches until the
// binary makes it true.
(function () {
  'use strict';

  var reduce = matchMedia('(prefers-reduced-motion: reduce)');

  // The phone board. Matches the CSS rule that brings the canvas back below
  // 760px, gate for gate — if these two disagree, the page either draws into a
  // hidden box or shows an empty one.
  var PHONE = matchMedia('(max-width: 760px) and (min-height: 840px)');

  // Where the two surviving objects sit on the portrait board: a diagonal,
  // subject high and left, the thing it acts on low and right. Percentages, as
  // everywhere else, so the existing --zw tier scales them with the wires.
  // Measured, not chosen: at [30,32]/[70,79] the second object overhung the
  // board's bottom edge by 4px on a 390x844 phone, and pulling it up alone put
  // its corner into the first object's. Both moved outward instead — a longer
  // diagonal, which is also the arrangement that reads as two things joined
  // rather than two things stacked.
  //
  // The second anchor then came back in, 78 → 76, when the objects took the
  // client's dimensions; and again, 72,76 → 70,75, when the >=11px clearance
  // that change claimed was re-measured and found to be 9.6px at 390x844 and
  // 8.5px at the narrowest viewport this board reaches. Two different edges
  // were being missed, which is why one number could not fix it:
  //
  //   y 76 → 75  the BOTTOM edge. Scene 6's reserved profile is 128px tall and
  //              stands lowest; a point of board height is ~2.6px there.
  //   x 72 → 70  the RIGHT edge, and only on a narrow phone. Scene 4's
  //              communication readout is the widest object on the board at
  //              185px, and at x:72 on a 360px screen it cleared by 8.5px —
  //              a limit the height of the board can do nothing about.
  //
  // Measured after, worst case per viewport, across all four phone pairs:
  // 14.2px at 390x844, 14.9 at 393x852, 15.9 at 430x932, 13.8 at 360x840.
  // The closest two objects ever come to each other is 4.0px (the profile and
  // the readout, at 360x840) — tight, and the price of a board that has to
  // hold a 148px card and a 185px readout side by side at all.
  var PHONE_AT = [[28, 28], [70, 75]];

  // The palette lives in styles.css and is read from it. These are the
  // fallbacks for the one case where it cannot be: a stylesheet that failed to
  // load, where a mark drawn in nothing is worse than a mark drawn in the
  // colour it was going to be anyway. They are the LIGHT values, because light
  // is the default ground.
  //
  // SPEC is passed to contour-sphere.js as `lightInk` — the light the membrane
  // gathers on the side it is pulled toward — and its polarity INVERTS with the
  // ground. On the dark ground the gathered light is lighter than the ink
  // (#F5B98C / #FFE3D0). On the light ground light cannot read as light, so it
  // reads as DENSITY instead and the spec goes DARKER than the ink.
  var INK = '#B36A33';
  var SPEC = '#85491D';

  function readPalette() {
    var cs = getComputedStyle(document.documentElement);
    var a = (cs.getPropertyValue('--mark-ink') || '').trim();
    var s = (cs.getPropertyValue('--mark-spec') || '').trim();
    if (a) INK = a;
    if (s) SPEC = s;
  }

  // MediaQueryList.addEventListener is the modern spelling; addListener is the
  // one Safari shipped for years. Both, or the board never restacks on rotate.
  function onMQ(mq, fn) {
    if (mq.addEventListener) mq.addEventListener('change', fn);
    else if (mq.addListener) mq.addListener(fn);
  }

  // The mark's ink is read once at startup, but the ground can change under an
  // open page: flipping the OS colour scheme swaps every token in the sheet and
  // would otherwise leave the sphere marching in the other theme's apricot.
  // Re-read on the flip; the next frame picks the new values up on its own.
  var DARK = matchMedia('(prefers-color-scheme: dark)');

  // ------------------------------------------------------------ the scenes
  //
  // The verb changes rarely and the target rolls beneath it: three deploys,
  // two upgrades, one restore. Each scene lists what that command puts on the
  // Fleet canvas, using the eight kinds of the canvas object system.
  //
  //   profile   an agent profile      tall card, owner's bar, lifted
  //   tool      a tool it ships       wide plaque, owner's bar, tight radius
  //   reserved  a reserved profile    recessed container holding link tiles
  //   person    a human               circle, blue ring, name outside
  //   group     a cohort              pill, blue ring, avatar stack
  //   dist      a distribution        fanned hand of profiles, name below
  //   comm      a communication       clipped readout, inbound or outbound
  //   sticky    something a person wrote   paper, tilted, italic
  //
  // `at` is [x, y] as a percentage of the canvas; the object is centred on it,
  // and a connector's endpoints are the same two numbers. `wires` indexes into
  // `objects` — [0, 1, 'ships with'] joins the first to the second and writes
  // the verb on the paper between them.
  //
  // `own` picks the ownership colour. It is never status: an agent that is
  // healthy carries no colour beyond its owner's bar, and the status bead
  // stays neutral grey on every object that has one.
  // The x coordinates are an EVEN DISTRIBUTION across the full-width board,
  // computed from each object's measured rendered width rather than chosen:
  // internal gaps equal, edge margins at 0.7x an internal gap.
  //
  // They have been re-tuned three times, and the last one is the cheap one:
  // every kind took the client's dimensions, so the same formula run over the
  // new widths moved no anchor by more than 2 points. The changes largely
  // cancel — the tool loses 30px, the comm gains 13, the profile gains 4.
  //
  // Before that: ADR-128 widened the band and left these where a
  // ~30% narrower board had put them, which parked everything in the middle
  // third. The first correction pushed each anchor OUTWARD, which is the wrong
  // instinct entirely: displacing objects toward the edges does not fill a
  // board, it splits the scene into a left object and a right cluster with a
  // canyon between them. Measured, that grew the largest void in
  // `marketing-suite` from 372px to 449px — 40% of the board as one hole.
  //
  // Coverage is capped near 50% whatever happens: three objects ~190px wide
  // cannot fill 1120px. What is controllable is whether the other half is ONE
  // hole or even breathing room, and only even spacing buys the second.
  //
  // Height is still the scarce axis — a profile is 128px tall in a board that
  // is 238px at 1366x768 — so the vertical values carry the composition and
  // are deliberately NOT evenly spaced.
  var SCENES = [
    { verb: 'deploy', target: 'social-media',
      objects: [
        { kind: 'profile', name: 'Social Media', icon: 'mkt-engagement', desc: 'Drafts and ships campaign posts.',
          foot: 'Agent · healthy', at: [23, 42] },
        { kind: 'tool', name: 'Content Board', meta: 'Tool · Social Media',
          at: [48, 21] },
        { kind: 'comm', dir: 'out', event: 'campaign.published', count: '2 registered',
          regs: [['Analytics warehouse', 'ingest.warehouse.internal'],
                 ['Partner feed', 'feeds.partner.example']], at: [76, 65] }
      ],
      wires: [[0, 1, 'ships'], [0, 2, 'emits to']] },

    { verb: 'deploy', target: 'support-triage',
      objects: [
        { kind: 'profile', name: 'Support Triage', icon: 'customer-service', desc: 'Routes and answers inbound tickets.',
          foot: 'Agent · healthy', at: [24, 41] },
        { kind: 'tool', name: 'Ledger DB', meta: 'Tool · Support Triage',
          at: [52, 20] },
        { kind: 'tool', name: 'Runbooks', meta: 'Tool · Support Triage',
          at: [52, 66] },
        { kind: 'sticky', text: 'eu-west-1 backlog again — read the runbook before paging anyone.',
          at: [78, 43] }
      ],
      wires: [[0, 1, 'ships'], [0, 2, 'ships']] },

    { verb: 'deploy', target: 'marketing-suite',
      objects: [
        { kind: 'dist', name: 'Marketing suite', meta: '4 profiles · marketing',
          fans: ['MM', 'CS', 'BV', 'SR'], front: 'Social Reply', at: [24, 41] },
        { kind: 'group', name: 'Marketing team', meta: 'Group of people · 3',
          faces: ['MO', 'TN', 'CR'], at: [53, 22] },
        { kind: 'person', initials: 'HN', face: 'hannah', name: 'Hannah', meta: 'Person · approver',
          at: [79, 69] }
      ],
      wires: [[0, 1, 'called by'], [0, 2, 'approves']] },

    { verb: 'upgrade', target: 'support-triage',
      objects: [
        { kind: 'profile', name: 'Support Triage', icon: 'customer-service', desc: 'Routes and answers inbound tickets.',
          foot: 'Agent · v2.4.1', at: [23, 42] },
        { kind: 'comm', dir: 'in', event: 'ticket.escalated', count: '2 registered',
          regs: [['Zendesk trigger', 'helpdesk.zendesk.com'],
                 ['Segment track', 'api.segment.io']], at: [52, 29] },
        { kind: 'person', initials: 'JR', face: 'jared', name: 'Jared', meta: 'Person · approver',
          at: [79, 69] }
      ],
      wires: [[1, 0, 'called by'], [0, 2, 'approves']] },

    { verb: 'upgrade', target: 'billing-reconcile',
      objects: [
        { kind: 'profile', name: 'Billing Reconcile', icon: 'finance-manager', desc: 'Matches ledger entries nightly.',
          foot: 'Agent · v3.0.2', at: [23, 42] },
        { kind: 'tool', name: 'Ledger DB', meta: 'Tool · Billing Reconcile',
          at: [50, 20] },
        { kind: 'reserved', name: 'Billing SRE', meta: 'Reserved · 4 links',
          own: 'staff', tiles: [['Auth', 1], ['Queue', 1], ['Storage', 0], ['Audit', 0]],
          at: [77, 63] }
      ],
      wires: [[0, 1, 'ships'], [0, 2, 'runs on']] },

    { verb: 'restore', target: 'ledger-db',
      objects: [
        { kind: 'tool', name: 'Ledger DB', meta: 'Tool · restore verified', at: [24, 29] },
        { kind: 'reserved', name: 'Billing SRE', meta: 'Reserved · 4 links',
          own: 'staff', tiles: [['Auth', 1], ['Queue', 1], ['Storage', 1], ['Audit', 0]],
          at: [51, 60] },
        { kind: 'sticky', text: 'Restore rehearsed on the replacement server, not just the backup.',
          alt: true, at: [78, 31] }
      ],
      wires: [[0, 1, 'runs on']] }
  ];

  var OWN = { marketing: 'var(--own-marketing)', staff: 'var(--own-staff)' };

  var HOLD = 2900;   // how long a scene stands still
  var ROLL = 420;    // must match --ease timing in the .is-rolling rules

  ready(function () {
    readPalette();
    // Registered BEFORE the spheres mount, so on a theme flip the ink is
    // refreshed before anything that repaints with it runs.
    onMQ(DARK, readPalette);
    // Every [data-sphere] on the page — the closing section's large mark on
    // the homepage, and whatever a feature page carries. Each runs its own
    // loop, and each loop's IntersectionObserver parks it while the mark is
    // off screen, so two mounts never both burn frames.
    [].forEach.call(document.querySelectorAll('[data-sphere]'), mountSphere);
    mountDemo();
    mountMenus();
  });

  // The Features <details> menu. Without script it opens and closes on click
  // and Enter, which is already a working menu; this adds the two behaviours
  // a disclosure cannot express on its own — Escape closes and returns focus,
  // and a click anywhere else closes.
  function mountMenus() {
    var menus = document.querySelectorAll('[data-dd]');
    if (!menus.length) return;
    document.addEventListener('keydown', function (e) {
      if (e.key !== 'Escape') return;
      [].forEach.call(menus, function (m) {
        if (m.open) { m.open = false; m.querySelector('summary').focus(); }
      });
    });
    document.addEventListener('pointerdown', function (e) {
      [].forEach.call(menus, function (m) {
        if (m.open && !m.contains(e.target)) m.open = false;
      });
    });
  }

  // ------------------------------------------------------ the phone subset
  //
  // Objects 0 and 1 of every scene are its subject and the one thing it acts
  // on, and every scene has a wire between them — so the phone shows a true
  // subset of the same claim rather than a smaller version of all of it. The
  // objects keep their real size; only how many of them there are changes.
  function fit(scene) {
    if (!PHONE.matches) return scene;
    var objects = scene.objects.slice(0, PHONE_AT.length).map(function (o, n) {
      var copy = {};
      for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) copy[k] = o[k];
      copy.at = PHONE_AT[n];
      return copy;
    });
    return {
      verb: scene.verb,
      target: scene.target,
      objects: objects,
      wires: (scene.wires || []).filter(function (w) {
        return w[0] < objects.length && w[1] < objects.length;
      })
    };
  }

  // ====================================================== the rolling command

  // The command line and the canvas are siblings in the hero, not one block —
  // the command sits in the claim column and the canvas spans the full width
  // beneath it — so these are looked up from the document rather than from a
  // shared wrapper.
  function mountDemo() {
    var cmd = document.querySelector('[data-cmd]');
    var verbSlot = document.querySelector('[data-verb]');
    var targetSlot = document.querySelector('[data-target]');
    var objectsEl = document.querySelector('[data-objects]');
    var wiresEl = document.querySelector('[data-wires]');
    if (!verbSlot || !targetSlot || !objectsEl) return;

    var i = 0;
    var timer = null;
    var paused = false;

    // First scene is written directly — no roll into an empty slot.
    setWord(verbSlot, SCENES[0].verb);
    setWord(targetSlot, SCENES[0].target);
    drawScene(objectsEl, wiresEl, fit(SCENES[0]));

    // Crossing the phone threshold changes how many objects the current scene
    // has, so it is redrawn in place. This is bound even under reduced motion:
    // that path is still holding scene one, and rotating a phone must not
    // leave it holding an arrangement built for the other orientation.
    onMQ(PHONE, function () { drawScene(objectsEl, wiresEl, fit(SCENES[i])); });

    // A connector's trim is the only thing on this board measured in pixels,
    // so it is the only thing a resize invalidates: the board's height is a
    // vh clamp and its width follows the shell, and both change the anisotropy
    // the arrowheads are drawn against. Registered ABOVE the reduced-motion
    // return — that path still has a scene on the board, and its connectors
    // have to keep their endpoints when the window changes.
    var pending = 0;
    window.addEventListener('resize', function () {
      if (pending) return;
      pending = requestAnimationFrame(function () {
        pending = 0;
        layoutWires(objectsEl);
      });
    });

    // Reduced motion gets scene one and nothing further. It is a complete,
    // truthful example of the command; it simply does not cycle.
    if (reduce.matches) return;

    function advance() {
      if (paused) return schedule();
      var prev = SCENES[i];
      i = (i + 1) % SCENES.length;
      var next = SCENES[i];

      // The verb only animates on the scenes where it actually changes.
      if (next.verb !== prev.verb) roll(verbSlot, next.verb);
      roll(targetSlot, next.target);

      // The board clears, then the new one lands — the command changes first,
      // and what it draws follows it.
      leaveScene(objectsEl, wiresEl);
      setTimeout(function () {
        if (wiresEl) wiresEl.classList.remove('is-leaving');
        drawScene(objectsEl, wiresEl, fit(next));
      }, 280);

      schedule();
    }

    function schedule() {
      clearTimeout(timer);
      timer = setTimeout(advance, HOLD);
    }

    // The stop, as a real control. Hovering the command line already paused
    // the cycle, but a pointer is not a mechanism: a keyboard-only reader and
    // every phone had nothing, and this rewrites itself every 2.9 seconds for
    // as long as the page is open. Built here rather than in the markup
    // because without this file there is no cycle to stop.
    var held = false;   // the button's state, which outlives a pointer leaving
    var toggle = cycleButton();
    if (cmd && cmd.parentNode) cmd.parentNode.appendChild(toggle);

    function setHeld(v) {
      held = v;
      paused = v;
      toggle.setAttribute('aria-pressed', v ? 'true' : 'false');
      toggle.classList.toggle('is-paused', v);
      toggle.querySelector('[data-cycle-label]').textContent =
        v ? 'Resume the demonstration' : 'Pause the demonstration';
    }

    toggle.addEventListener('click', function () { setHeld(!held); });

    // Hovering the command line stops the cycle, so a reader can finish the
    // one they are looking at. Scoped to the LINE and not to the canvas: the
    // canvas is a full-width band across the middle of the screen, and a
    // cursor left parked anywhere on it would freeze the hero with no way to
    // tell why. Leaving must not resume a cycle the BUTTON stopped, which is
    // what `held` is for.
    if (cmd) {
      cmd.addEventListener('pointerenter', function () { paused = true; });
      cmd.addEventListener('pointerleave', function () { paused = held; });
    }

    // A background tab should not burn frames or race ahead.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) clearTimeout(timer);
      else schedule();
    });

    schedule();
  }

  // Two glyphs, one drawn at a time, both at the page's single 1.5 stroke
  // weight. The name is a real string in the accessibility tree rather than a
  // title attribute, and it changes with the state it describes.
  function cycleButton() {
    var ns = 'http://www.w3.org/2000/svg';
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'cyc';
    b.setAttribute('aria-pressed', 'false');

    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('viewBox', '0 0 16 16');
    svg.setAttribute('width', '15');
    svg.setAttribute('height', '15');
    svg.setAttribute('fill', 'none');
    svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5');
    svg.setAttribute('stroke-linecap', 'round');
    svg.setAttribute('stroke-linejoin', 'round');
    svg.setAttribute('aria-hidden', 'true');

    var pause = document.createElementNS(ns, 'path');
    pause.setAttribute('class', 'cyc__pause');
    pause.setAttribute('d', 'M6 4v8M10 4v8');

    var play = document.createElementNS(ns, 'path');
    play.setAttribute('class', 'cyc__play');
    play.setAttribute('d', 'M5.8 3.9 12.2 8l-6.4 4.1Z');

    svg.appendChild(pause);
    svg.appendChild(play);
    b.appendChild(svg);

    var label = el('span', 'visually-hidden', 'Pause the demonstration');
    label.setAttribute('data-cycle-label', '');
    b.appendChild(label);

    return b;
  }

  function setWord(slot, text) {
    slot.textContent = '';
    slot.appendChild(span('roll__now', text));
  }

  // The outgoing word leaves upward, the incoming arrives from below. Both are
  // transform + opacity only: the slot's width is fixed in `ch` (verb) or is
  // the last thing on the line (target), so nothing reflows either way.
  function roll(slot, text) {
    var now = slot.querySelector('.roll__now');
    var next = span('roll__next', text);
    slot.appendChild(next);
    slot.classList.add('is-rolling');

    setTimeout(function () {
      slot.classList.remove('is-rolling');
      if (now) now.remove();
      next.className = 'roll__now';
    }, ROLL);
  }

  // -------------------------------------------------------------- the shapes

  // ------------------------------------------------------- the eight kinds
  //
  // One builder per kind. Each returns the object's inner markup; the shared
  // wrapper carries the position, the stagger index and the pop.

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
  }

  // The brand mark, as concentric rings — the same figure contour-sphere.js
  // marches. Only the agent profile carries it: "it is the only one you
  // operate", and everything it ships inherits its colour.
  function markSvg(size, rings) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', size);
    svg.setAttribute('height', size);
    svg.setAttribute('viewBox', '0 0 52 52');
    svg.setAttribute('class', 'obj__mark');
    rings.forEach(function (r) {
      var c = document.createElementNS(ns, 'circle');
      c.setAttribute('cx', r[0]); c.setAttribute('cy', r[1]); c.setAttribute('r', r[2]);
      c.setAttribute('fill', r[4] ? 'currentColor' : 'none');
      if (!r[4]) { c.setAttribute('stroke', 'currentColor'); c.setAttribute('stroke-width', '1.5'); }
      c.setAttribute('opacity', r[3]);
      svg.appendChild(c);
    });
    return svg;
  }

  function iconSvg(d) {
    var ns = 'http://www.w3.org/2000/svg';
    var svg = document.createElementNS(ns, 'svg');
    svg.setAttribute('width', '13'); svg.setAttribute('height', '13');
    svg.setAttribute('viewBox', '0 0 24 24');
    svg.setAttribute('fill', 'none'); svg.setAttribute('stroke', 'currentColor');
    svg.setAttribute('stroke-width', '1.5'); svg.setAttribute('stroke-linecap', 'round');
    var p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    svg.appendChild(p);
    return svg;
  }

  // A neutral-grey bead, half outside the corner. Healthy must never compete
  // with ownership colour, so this is the same grey on every object.
  function bead(node) { node.appendChild(el('span', 'bead')); }

  var BUILD = {
    // 1 — TALL CARD · SOLID OWNER'S BAR · LIFTED
    profile: function (o, node) {
      // The asset pass ADR-133 reserved: a profile with an `icon` wears the
      // avatar-inventory diorama (same art the product ships); a missing
      // file falls back to the rings mark, exactly like the product does.
      if (o.icon) {
        var ava = document.createElement('img');
        ava.className = 'obj__ava';
        ava.src = 'avatars/' + o.icon + '.webp';
        ava.alt = '';
        ava.onerror = function () {
          node.replaceChild(markSvg(30, [[26, 26, 21, .9], [26, 26, 15, .6],
                                         [26, 26, 9, .42], [26, 26, 4, .9, 1]]), ava);
        };
        node.appendChild(ava);
      } else {
        node.appendChild(markSvg(30, [[26, 26, 21, .9], [26, 26, 15, .6],
                                      [26, 26, 9, .42], [26, 26, 4, .9, 1]]));
      }
      node.appendChild(el('div', 'obj__name', o.name));
      if (o.desc) node.appendChild(el('div', 'obj__desc', o.desc));
      node.appendChild(el('div', 'obj__foot', o.foot || ''));
      bead(node);
    },

    // 2 — WIDE PLAQUE · OWNER'S BAR · TIGHT RADIUS
    tool: function (o, node) {
      var icon = el('div', 'obj__icon');
      icon.appendChild(iconSvg('M3.4 5.2h17.2v15.4H3.4zM3.4 10.2h17.2M8.4 3.4v3.4M15.6 3.4v3.4'));
      node.appendChild(icon);
      var body = el('div');
      body.appendChild(el('div', 'obj__name', o.name));
      body.appendChild(el('div', 'obj__meta', o.meta || ''));
      node.appendChild(body);
      bead(node);
    },

    // 3 — RECESSED CONTAINER · OWNER'S BAR · HOLDS TILES
    reserved: function (o, node) {
      var head = el('div', 'obj__head');
      head.appendChild(markSvg(22, [[17, 19, 9.5, .85], [35, 19, 9.5, .6], [26, 35, 9.5, .45]]));
      var t = el('div');
      t.appendChild(el('div', 'obj__name', o.name));
      t.appendChild(el('div', 'obj__meta', o.meta || ''));
      head.appendChild(t);
      node.appendChild(head);

      var tiles = el('div', 'obj__tiles');
      (o.tiles || []).forEach(function (pair) {
        // A filled dot means an agent has registered the tile; a hollow one
        // means it is published but unclaimed.
        var tile = el('div', 'tile');
        tile.appendChild(el('span', 'tile__dot' + (pair[1] ? '' : ' tile__dot--open')));
        tile.appendChild(el('span', 'tile__name', pair[0]));
        tiles.appendChild(tile);
      });
      node.appendChild(tiles);
    },

    // 4 — CIRCLE · BLUE RING · NAME OUTSIDE
    person: function (o, node) {
      // A person with a `face` wears their portrait inside the disc; the
      // initials disc stays the no-asset (and load-failure) form.
      var disc = el('div', 'obj__disc', o.face ? null : o.initials);
      if (o.face) {
        var img = document.createElement('img');
        img.className = 'obj__face';
        img.src = 'avatars/' + o.face + '.png';
        img.alt = '';
        img.onerror = function () { disc.textContent = o.initials; img.remove(); };
        disc.appendChild(img);
      }
      node.appendChild(disc);
      node.appendChild(el('div', 'obj__name', o.name));
      node.appendChild(el('div', 'obj__meta', o.meta || ''));
    },

    // 5 — PILL · BLUE RING · AVATAR STACK
    group: function (o, node) {
      var faces = el('div', 'faces');
      (o.faces || []).forEach(function (f) { faces.appendChild(el('span', 'face', f)); });
      node.appendChild(faces);
      var body = el('div');
      body.appendChild(el('div', 'obj__name', o.name));
      body.appendChild(el('div', 'obj__meta', o.meta || ''));
      node.appendChild(body);
    },

    // 6 — FANNED HAND · OWNER'S BARS · NAME BELOW
    dist: function (o, node) {
      (o.fans || []).forEach(function (mono, n) {
        var card = el('div', 'fan');
        card.appendChild(el('span', 'mono-badge', mono));
        // Only the front card is named; the rest show their monogram in the
        // exposed strip.
        if (n === o.fans.length - 1 && o.front) {
          card.appendChild(el('span', 'fan__name', o.front));
        }
        node.appendChild(card);
      });
      var label = el('div', 'dist__label');
      label.appendChild(el('div', 'obj__name', o.name));
      label.appendChild(el('div', 'obj__meta', o.meta || ''));
      node.appendChild(label);
    },

    // 7 — TWO VARIANTS · ABSTRACT EVENT · REGISTRATIONS
    comm: function (o, node) {
      node.classList.add(o.dir === 'out' ? 'is-out' : 'is-in');
      var head = el('div', 'comm__head');
      head.appendChild(iconSvg('M1 12h16M13 7l5 5-5 5'));
      head.appendChild(el('span', null, o.dir === 'out' ? 'OUTBOUND' : 'INBOUND'));
      head.appendChild(el('span', 'n', o.count || ''));
      node.appendChild(head);
      // The subject is the abstract event, named in the panel's own title.
      node.appendChild(el('div', 'comm__event', o.event));
      node.appendChild(el('div', 'comm__rule'));
      (o.regs || []).forEach(function (r) {
        var row = el('div', 'comm__reg');
        row.appendChild(el('b', null, r[0]));
        row.appendChild(el('span', null, r[1]));
        node.appendChild(row);
      });
    },

    // 8 — SQUARE · TILTED · 2PX RADIUS · ITALIC
    sticky: function (o, node) {
      if (o.alt) node.classList.add('is-alt');
      node.textContent = o.text;
    }
  };

  var SVGNS = 'http://www.w3.org/2000/svg';

  // The connectors of the scene currently on the board. They are kept because
  // their geometry cannot be written once: every trim below is measured in
  // PIXELS (an object's half-extent, the gap before its edge, the length of an
  // arrowhead) and drawn in PERCENTAGES, and those two agree only at one stage
  // size. A resize re-derives them from the same list.
  var WIRES = [];

  // How far a connector stops SHORT of the box it touches, in CSS pixels.
  // The target end carries the arrowhead, whose tip lands on this point — a
  // few pixels of air so the chevron reads as pointing AT the object rather
  // than as a notch cut into it.
  var GAP_FROM = 4;
  var GAP_TO   = 6;

  // The arrowhead, in CSS pixels: 7 back along the line, 3.2 either side of
  // it. Two open strokes, never a filled triangle.
  var HEAD_LEN  = 7;
  var HEAD_HALF = 3.2;

  function drawScene(host, wireHost, scene) {
    host.innerHTML = '';
    clearWires(wireHost);
    WIRES = [];

    var nodes = scene.objects.map(function (o, n) {
      var node = el('div', 'obj obj--' + o.kind);
      node.style.setProperty('--x', o.at[0] + '%');
      node.style.setProperty('--y', o.at[1] + '%');
      // Drives the CSS stagger. The cascade does the waterfall, not a timer.
      node.style.setProperty('--i', n);
      if (o.own && OWN[o.own]) node.style.setProperty('--own', OWN[o.own]);
      BUILD[o.kind](o, node);
      host.appendChild(node);
      return node;
    });

    if (!scene.wires) return;

    // The connectors follow every object they touch, so the sequence reads as
    // cause: the things exist, then they are joined.
    var after = scene.objects.length * 90 + 240;

    scene.wires.forEach(function (w, n) {
      var delay = after + n * 90;
      var seg = {
        from: nodes[w[0]], to: nodes[w[1]],
        a: scene.objects[w[0]].at, b: scene.objects[w[1]].at,
        line: null, head: null, verb: null
      };

      if (wireHost) {
        seg.line = document.createElementNS(SVGNS, 'line');
        seg.line.setAttribute('class', 'wire');
        seg.line.style.setProperty('--d', delay);
        wireHost.appendChild(seg.line);

        // The head is a path this file draws, NOT the `marker-end` chevron in
        // the markup's <defs>. A marker is rendered in the referencing
        // element's user space, and this layer's user space is
        // `viewBox="0 0 100 100"` with preserveAspectRatio="none" — on a
        // 1118x236 board one unit is 11.18px across and 2.36px down. Measured:
        // the marker came out 39px wide and 11px tall, a flick rather than an
        // arrow, and its proportions changed with every viewport. Drawing the
        // two strokes here lets each offset be converted through the axis it
        // belongs to, so the chevron is the same shape at every size.
        seg.head = document.createElementNS(SVGNS, 'path');
        seg.head.setAttribute('class', 'wire__head');
        seg.head.style.setProperty('--d', delay);
        wireHost.appendChild(seg.head);
      }

      // A lowercase italic verb, on the paper — no pill, no border.
      if (w[2]) {
        seg.verb = el('span', 'verb', w[2]);
        seg.verb.style.setProperty('--d', delay + 90);
        host.appendChild(seg.verb);
      }

      WIRES.push(seg);
    });

    layoutWires(host);
  }

  // The box a connector must stop at, relative to the object's own centre —
  // which is also the point the connector is aimed at.
  //
  // For seven of the eight kinds that is the object's own box. The PERSON is
  // the exception, and it is the kind's whole definition: "the only one whose
  // name sits outside its shape". Its element is 101x90 because it carries a
  // name and a role under the disc, but the shape is the 47px circle — stop a
  // connector at the element's edge and the arrowhead hangs 27px out in the
  // open, pointing at the whitespace beside the label.
  function hitBox(node) {
    var shape = node.querySelector('.obj__disc');
    if (!shape) return { cx: 0, cy: 0, hw: node.offsetWidth / 2, hh: node.offsetHeight / 2 };
    return {
      cx: shape.offsetLeft + shape.offsetWidth / 2 - node.offsetWidth / 2,
      cy: shape.offsetTop + shape.offsetHeight / 2 - node.offsetHeight / 2,
      hw: shape.offsetWidth / 2,
      hh: shape.offsetHeight / 2
    };
  }

  // Where a ray leaving the object's centre crosses that box, as a fraction of
  // the whole segment — a slab intersection, not a circle approximation: a tool
  // is a 132x43 plaque and a profile a 148x140 card, and a radius that clears
  // one leaves the other's arrowhead buried inside it.
  //
  // `dx`/`dy` are the FULL centre-to-centre vector in PIXELS, signed to point
  // away from this end — pixels because that is the only space where a
  // half-extent and a gap mean the same thing on both axes, and full-length
  // because that makes the answer a fraction of the segment directly.
  function edgeOf(node, dx, dy, gap) {
    var box = hitBox(node);
    var tx = Infinity, ty = Infinity;
    if (Math.abs(dx) > 1e-6) tx = Math.max((box.cx - box.hw) / dx, (box.cx + box.hw) / dx);
    if (Math.abs(dy) > 1e-6) ty = Math.max((box.cy - box.hh) / dy, (box.cy + box.hh) / dy);
    return Math.max(0, Math.min(tx, ty)) + gap / Math.sqrt(dx * dx + dy * dy);
  }

  // `host` is the objects layer, which is inset:0 in the same stage the wire
  // layer fills — so its untransformed box IS the 0-100 user space's box, and
  // the stage's zoom (which scales wires and objects together) cancels out.
  function layoutWires(host) {
    if (!WIRES.length) return;
    var W = host.offsetWidth;
    var H = host.offsetHeight;
    if (!W || !H) return;
    var ux = 100 / W;   // one pixel across, in user units
    var uy = 100 / H;   // one pixel down, in user units

    WIRES.forEach(function (s) {
      var ax = s.a[0], ay = s.a[1], bx = s.b[0], by = s.b[1];
      var dx = bx - ax, dy = by - ay;
      var px = dx / ux, py = dy / uy;
      var len = Math.sqrt(px * px + py * py);
      if (!len) return;

      var ta = edgeOf(s.from, px, py, GAP_FROM);
      var tb = edgeOf(s.to, -px, -py, GAP_TO);
      // Two objects close enough to overlap would trim the line past itself
      // and draw it backwards, arrowhead pointing at the source. Keep a stub.
      if (ta + tb > 0.86) { var k = 0.86 / (ta + tb); ta *= k; tb *= k; }

      var x1 = ax + dx * ta, y1 = ay + dy * ta;
      var x2 = bx - dx * tb, y2 = by - dy * tb;

      if (s.line) {
        s.line.setAttribute('x1', x1); s.line.setAttribute('y1', y1);
        s.line.setAttribute('x2', x2); s.line.setAttribute('y2', y2);
      }

      if (s.head) {
        var hx = px / len, hy = py / len;             // unit heading, in px
        var barb = function (side) {
          var bxp = -HEAD_LEN * hx + side * HEAD_HALF * -hy;
          var byp = -HEAD_LEN * hy + side * HEAD_HALF * hx;
          return (x2 + bxp * ux) + ' ' + (y2 + byp * uy);
        };
        s.head.setAttribute('d',
          'M' + barb(1) + 'L' + x2 + ' ' + y2 + 'L' + barb(-1));
      }

      // The verb sits on the middle of the STROKE, not of the centre-to-centre
      // line the stroke is a fragment of — with a 148px card at one end and a
      // 47px disc at the other those two points are 30px apart.
      if (s.verb) {
        s.verb.style.setProperty('--x', (x1 + x2) / 2 + '%');
        s.verb.style.setProperty('--y', (y1 + y2) / 2 + '%');
      }
    });
  }

  // Keep <defs> — it is markup this file does not own. Only the strokes this
  // file drew come out.
  function clearWires(wireHost) {
    if (!wireHost) return;
    [].slice.call(wireHost.querySelectorAll('line, path.wire__head'))
      .forEach(function (n) { n.remove(); });
  }

  function leaveScene(host, wireHost) {
    [].forEach.call(host.children, function (node, n) {
      node.style.setProperty('--i', n);
      node.classList.add('is-leaving');
    });
    if (wireHost) wireHost.classList.add('is-leaving');
  }

  function span(cls, text) {
    var s = document.createElement('span');
    s.className = cls;
    s.textContent = text;
    return s;
  }

  // ============================================================== the sphere
  //
  // The mark is drawn by contour-sphere.js, which marches contour lines out of
  // 3D noise every frame. Two things move it: a slow idle drift so it is never
  // quite still, and the visitor's pointer, which it leans toward with real
  // inertia — it overshoots once and settles, which is what reads as mass.

  // What the membrane is marched WITH, at a given CSS size. One function
  // because there are two call sites — the loop and the single reduced-motion
  // frame — and they drifted apart once already: the still frame was passing
  // no `lightInk` at all, so the one frame a reduced-motion reader ever sees
  // was the only one drawn without the specular.
  //
  // These are tuned for the 48–58px lockup mark, and they are a CORRECTION.
  // ADR-128 recorded the symptom — "the contour lines it marches from noise read
  // as texture rather than as a figure" — and read it as a size problem. It was
  // a DENSITY problem, and these are the numbers that were wrong:
  //
  //   density  1/density is the contour interval, so 12 put ~17 level sets
  //            inside a 40px disc. Measured on the real draw path at 58px,
  //            that is a scribble; 6 leaves ~8, which is five or six visible
  //            bands crowding toward the limb — which is what a sphere DOES.
  //   scale    the noise frequency. At 2.9 the wobble is finer than the
  //            figure, so every band breaks into chatter and the summit splits
  //            into two lobes that read as eyes. At 1.8 the deformation is
  //            broader than a band, so the bands stay bands and there is one
  //            off-centre summit.
  //   amp      0.36 pushed the height field far enough that contours stopped
  //            following the sphere at all. 0.20 keeps the topography.
  //
  //   topoW    both are BELOW the vendored defaults of 1.9 / 2.8, and both are
  //   rimW     multiplied by a factor that has already bottomed out — the
  //            vendored `sw` clamps at 0.42 for anything under 176px — so at
  //            58px they land at 0.67 and 1.0 CSS px. Thinner strokes are what
  //            let the bands nearest the limb stay separate lines instead of
  //            merging into the dark ring that read as a medallion edge.
  //
  //   maxGrid  INERT at this size and kept honest rather than removed: the
  //            vendored grid is max(40, min(maxGrid, round(S*0.24))), and at
  //            S=58 the inner term is 14, so the floor of 40 wins whatever
  //            this says. It only binds if the mark is ever mounted large.
  //
  // Cost moves DOWN, not up: the grid is 40x40 either way (it is computed from
  // the CSS size, not the backing store, so devicePixelRatio does not touch
  // it), the fbm sampling is unchanged, and halving the density halves the
  // marching passes — 17 sweeps of the grid per frame become 8.
  function markCfg(size) {
    return {
      ink: INK,
      lightInk: SPEC,
      rFrac: 0.34,
      density: Math.max(5, Math.min(13, Math.round(size / 9.5))),
      scale: 1.8,
      amp: 0.2,
      topoW: 1.6,
      rimW: 2.4,
      maxGrid: 78
    };
  }

  function mountSphere(canvas) {
    var dpr = 0;
    var size = 0;

    // Both of these cache a LAYOUT READ. `measure` ran every frame and `rect`
    // was taken fresh inside the pointermove handler — which on a 1000Hz mouse
    // is a forced style-and-layout flush hundreds of times a second, while the
    // membrane is re-marching 3-octave noise on its own tick. Neither value
    // can change without a resize, a scroll, or a breakpoint moving the mark,
    // so each is recomputed on those and read from memory in between.
    var stale = true;
    var rect = null;

    function invalidate() { stale = true; rect = null; }

    // The backing store is the CSS box times devicePixelRatio, and the ratio is
    // read HERE rather than once at mount. It is not a constant: browser zoom
    // changes it without changing clientWidth, and so does dragging the window
    // between a 1x and a 2x display. Captured once, the canvas keeps a stale
    // backing store through both — a 58px mark still holding 58 device pixels
    // on a 2x screen, which is the half-resolution draw that turns 0.8px
    // contour strokes to mush. So the guard has to test BOTH numbers; `s ===
    // size` alone is exactly the early return that would swallow a dpr change.
    //
    // Capped at 2. A 3x phone would otherwise pay 2.25x the rasterisation for
    // a difference no one can see at 58px.
    function measure() {
      if (!stale) return;
      stale = false;
      var s = Math.round(canvas.clientWidth);
      var d = Math.min(2, window.devicePixelRatio || 1);
      if (!s || (s === size && d === dpr)) return;
      size = s;
      dpr = d;
      canvas.width = Math.round(s * d);
      canvas.height = Math.round(s * d);
    }

    function box() {
      if (!rect) rect = canvas.getBoundingClientRect();
      return rect;
    }

    // A single still frame is all reduced motion gets — but it is the same
    // mark, marched the same way.
    if (reduce.matches) {
      var still = function () {
        size = 0;
        invalidate();
        measure();
        if (size && window.ContourSphere) {
          // No pull, so no gathered light — but the config is the same one the
          // loop uses, so the still mark is the moving mark stopped, not a
          // second drawing that has to be kept in step by hand.
          window.ContourSphere.draw(canvas, 0, size, dpr, markCfg(size));
        }
      };
      still();
      window.addEventListener('resize', still);
      // A theme flip repaints the ONE frame in the new ink. Still one frame,
      // still no loop — the same contract as the resize above.
      onMQ(DARK, still);
      return;
    }

    var body = {
      px: 0, py: 0, near: 0,
      ox: 0, oy: 0, vx: 0, vy: 0,
      pull: 0, dirX: 0, dirY: 0
    };

    // Pointer awareness across the whole hero, not just over the canvas: the
    // body should react before the pointer arrives.
    var hero = canvas.closest('.hero') || document.body;

    hero.addEventListener('pointermove', function (e) {
      var r = box();
      if (!r.width) return;
      var cx = r.left + r.width / 2, cy = r.top + r.height / 2;
      body.px = e.clientX - cx;
      body.py = e.clientY - cy;
      var d = Math.sqrt(body.px * body.px + body.py * body.py);
      // Nonlinear: barely anything at distance, decisive up close.
      var near = Math.max(0, Math.min(1, 1 - d / (r.width * 2.4)));
      body.near = near * near;
    });

    hero.addEventListener('pointerleave', function () { body.near = 0; });

    // Only run while the mark is actually on screen.
    var visible = true;
    if ('IntersectionObserver' in window) {
      new IntersectionObserver(function (es) {
        visible = es[0].isIntersecting;
        invalidate();   // it just moved relative to the viewport
      }, { rootMargin: '120px' }).observe(canvas);
    }

    // A scroll moves the mark without resizing it, so the cached rect's top is
    // wrong until something says so. Passive: this never blocks the scroll.
    window.addEventListener('scroll', invalidate, { passive: true });

    var last = 0, t0 = performance.now();

    function frame(now) {
      requestAnimationFrame(frame);
      // The membrane is re-marched every frame and the noise is the expensive
      // part, so it runs at ~33fps while the CSS animations stay on the
      // compositor at the display's own rate.
      if (now - last < 30) return;
      last = now;
      if (document.hidden || !visible) return;

      measure();
      if (!size || !window.ContourSphere) return;

      // Idle drift, so it is alive even with no pointer in the room.
      var t = (now - t0) / 1000;
      var driftX = Math.cos(t * 0.31) * 0.22;
      var driftY = Math.sin(t * 0.24) * 0.22;

      var tx = driftX, ty = driftY, amt = 0.16;
      if (body.near > 0.01) {
        var d = Math.sqrt(body.px * body.px + body.py * body.py) || 1;
        tx = body.px / d;
        ty = body.py / d;
        amt = Math.max(amt, body.near);
      }
      var m = Math.sqrt(tx * tx + ty * ty) || 1;
      tx /= m; ty /= m;

      // Spring toward the target displacement, under-damped on purpose.
      var maxPull = size * 0.07;
      var k = 0.11, damp = 0.76;
      body.vx = (body.vx + (tx * amt * maxPull - body.ox) * k) * damp;
      body.vy = (body.vy + (ty * amt * maxPull - body.oy) * k) * damp;
      body.ox += body.vx;
      body.oy += body.vy;

      // The surface leads the body: deformation tracks the target directly
      // while the centre is still catching up.
      body.pull += (amt - body.pull) * 0.18;
      body.dirX += (tx - body.dirX) * 0.22;
      body.dirY += (ty - body.dirY) * 0.22;

      var cfg = markCfg(size);
      cfg.pull = body.pull;
      cfg.pullX = body.dirX;
      cfg.pullY = body.dirY;
      cfg.offX = body.ox;
      cfg.offY = body.oy;
      window.ContourSphere.draw(canvas, t, size, dpr, cfg);
    }

    window.addEventListener('resize', function () { size = 0; invalidate(); });
    requestAnimationFrame(frame);
  }

  function ready(fn) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fn);
    else fn();
  }
})();
