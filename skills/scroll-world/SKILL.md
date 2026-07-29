---
name: scroll-world
description: Build scroll-driven immersive web pages — pinned/sticky scenes, scrollytelling, parallax depth, chapter-by-chapter narrative, horizontal scroll galleries, progress-linked animation, reveal-on-scroll sequences. Use this skill whenever someone wants a page that "animates as you scroll", an Apple-style or Awwwards-style product page, a scrollable data story, a section that stays put while content changes over it, or a landing page described as cinematic, immersive, or something that "unfolds" or "reveals itself" as you go — including when they describe the feeling they want without ever saying the word "scroll". Also use it when debugging an existing scroll page that stutters, jumps, fires at the wrong moment, or breaks on mobile.
---

# Scroll World

A scroll world is a page where scroll position drives what's on screen — the
reader travels through it rather than paging down it. Done well it feels
inevitable. Done badly it's the single most annoying thing on the web: janky,
scroll-hijacked, unreadable on a phone, and invisible to anyone who turned
motion off.

The difference is almost never the effects. It's the architecture underneath
and the storyboard on top.

## The one idea

**Scroll position is an input, not an event.** The page is a pure function of
progress: given "you are 40% through this scene", there is exactly one correct
picture. Nothing accumulates, nothing depends on which direction you came from,
nothing depends on having seen the previous frame.

That constraint buys you everything that makes these pages feel solid:

- Refresh at any scroll position and the page is already correct — no flash of
  wrong state, no scenes that only work if you scrolled through them in order.
- Scroll up and it plays backwards perfectly, for free.
- Fling-scroll past three scenes and the fourth is right, because it never
  needed the frames it skipped.

The failure mode this rules out is the tempting one: listening for `scroll` and
mutating things as it fires (`if (scrolled past X) el.classList.add('in')`).
That accumulates state, breaks on reverse, breaks on reload-at-position, and
drops frames because every handler reads layout the browser just invalidated.

The second half of the idea: **read the page and write to the page in separate
passes.** Measuring (`getBoundingClientRect`) forces the browser to settle
pending layout. Interleaving reads and writes makes it settle repeatedly per
frame — layout thrash, the usual cause of a scroll page that stutters on a
machine that runs games fine. `assets/scroll-world.js` does this batching for
you; if you hand-roll, keep the passes apart.

## Build order

Motion last. Every step before it produces something shippable on its own,
which is what lets you cut motion under deadline without cutting content.

**1 — Storyboard the beats.** Write the sequence in prose before touching code:
what does the reader see, and what changes at each beat? Five or six beats for
a landing page, one per point you're making. A scroll world without a beat sheet
becomes decoration that moves — expensive, impressive for two seconds, and
saying nothing. If a beat doesn't survive being written as a sentence, it won't
survive being animated either.

**2 — Build the page with no motion at all.** Real content, real headings, real
semantic HTML, readable top to bottom. This is the artifact that has to work for
search engines, screen readers, reader mode, and anyone with motion disabled —
and it's much easier to keep that true by never breaking it than by retrofitting
it later.

Content lives in the HTML at load. Motion reveals it; motion never supplies it.
The moment a paragraph only exists after a scroll handler injects it, the page
is broken for a real set of readers.

**3 — Map beats to scenes.** Decide each beat's runway: how much scrolling it
gets. Roughly 100vh of track per beat feels natural; under ~60vh feels rushed,
over ~200vh feels like the page is stuck. Pin a section when several beats share
one visual (a diagram that builds up); let it scroll normally when each beat has
its own.

**4 — Layer the motion.** Now add transforms, driven by progress. Start with the
smallest version that reads, then push. Almost every scroll page in the wild is
overdone rather than underdone — an element that travels 20vh reads as
purposeful, the same element travelling 80vh reads as noise.

**5 — Budget and degrade.** Profile on a mid-range phone, not your laptop. Then
do the reduced-motion pass (below). Both are quick if you built in this order
and miserable if you didn't.

## The engine

`assets/scroll-world.js` — zero dependencies, no build step, ~6kb. Copy it in
alongside `assets/starter.html`, which is a working three-scene world you can
strip down. Both are tested; the starter is the faster way in.

```js
const world = ScrollWorld();

world.scene('#intro');                  // writes --p: 0→1 onto the element
world.scene('#chart', p => draw(p));    // or take the number yourself
world.pin('#story', p => { ... });      // progress across a sticky section
```

**Default: write a CSS custom property, not inline styles.** With no callback
the engine sets `--p` on the element and CSS does the rest:

```css
.layer { transform: translateY(calc(var(--p) * -30vh)); }
```

Keep it this way whenever you can. The arithmetic stays in JS, the look stays in
CSS, and retuning a scene is a number in a stylesheet rather than a code change.
Use a callback for things CSS genuinely can't do — canvas, WebGL, video
`currentTime`, counting a number up.

**Ranges.** `start` and `end` read as `"elementEdge viewportEdge"` — the moment
that point of the element meets that point of the viewport.

| | meaning |
|---|---|
| `start: 'top bottom'` (default) | 0 as the element's top enters from below |
| `end: 'bottom top'` (default) | 1 as its bottom leaves past the top |
| `start: 'top top'`, `end: 'bottom bottom'` | exactly the pinned travel — what `.pin()` sets |

The default assumes an element rises into view from below. Anything already on
screen at load — a hero — is *already partway through* that range and renders
pre-faded. Use `.pin()` for those, so progress 0 means "page top".

**Pinning** needs CSS the engine can't write for you:

```css
.track { height: 300vh; }                        /* the runway */
.stage { position: sticky; top: 0; height: 100svh; }  /* what stays */
```

The track's extra height *is* the scroll duration: 300vh gives two viewports of
pinned travel. Sticky only works if no ancestor has `overflow: hidden` — that
one silently breaks more pins than every other cause combined.

**Chapters inside a pin.** `ScrollWorld.range(p, from, to)` re-maps a slice to a
fresh 0→1, so beats stay independent instead of becoming one timeline of magic
numbers:

```js
world.pin('#story', p => {
  const intro = ScrollWorld.range(p, 0,   0.4);
  const build = ScrollWorld.range(p, 0.35, 0.8);   // overlap = cross-fade
});
```

Other options: `ease` (`ScrollWorld.ease.inOut/out/in`), `out` and `prop` to
write the property somewhere else, `essential` and `rest` for reduced motion,
`refresh()` after you change content yourself.

## Reduced motion is a different page, not a frozen one

`prefers-reduced-motion` is a medical setting — scroll-linked parallax is a
known trigger for vestibular symptoms, i.e. actual nausea. Wiring it to
"animations still run, just instantly" leaves a page pinned at whatever state
progress 0 happened to be, which is often blank.

Give it a real layout: release the pins, collapse the tall tracks, let the page
be an ordinary readable document. The engine sets `data-motion="reduce"` on
`<html>` so CSS can do it wholesale — `assets/starter.html` has the full block
to copy.

```css
@media (prefers-reduced-motion: reduce) {
  html[data-motion="reduce"] .track { height: auto !important; }
  html[data-motion="reduce"] .stage { position: static; height: auto; }
  html[data-motion="reduce"] .chapter { opacity: 1 !important; transform: none !important; }
}
```

Mark a scene `essential: true` to keep it updating anyway. The test is whether
it *reports* something or *decorates* something: a reading-progress bar and an
active-section highlight are information and should keep working; parallax and
fly-ins are decoration and should stop.

Check it for real — DevTools → Rendering → Emulate `prefers-reduced-motion`.

## Non-negotiables

These are the ones that turn a good demo into a page that survives contact with
real readers and real devices.

**Animate `transform` and `opacity`; treat everything else as suspect.** Those
two the compositor handles without recomputing layout or repainting. Animating
`top`, `left`, `width`, `height`, or `margin` per frame relayouts the page 60
times a second. `filter` and `backdrop-filter` composite but are expensive —
fine on one hero element, not on twelve. Use `will-change` on the handful of
elements actually animating and remove it when they stop; blanketing the page
in it exhausts GPU memory and makes things slower.

**Never hijack the scroll.** Not `preventDefault` on wheel, not remapping one
notch to one section. It breaks trackpad momentum, keyboard paging, find-in-page
and screen readers, and it's the reason people bounce off pages like this.
Smooth-scroll libraries (Lenis and friends) are a softer version of the same
trade — they can look lovely, but they replace native scrolling wholesale, and
they're the wrong first move on a page that isn't finished.

**Use `svh`, not `vh`, for full-screen stages.** Mobile browser chrome hides and
reveals as you scroll, changing the viewport; `100vh` ignores this, so stages
end up taller than the screen and every scene drifts. `100svh` is the stable
one, and this single unit fixes most "works on desktop, broken on my phone".

**Re-measure after the page settles.** Late images and webfonts change the
document height after first paint, which shifts every scene's runway — scenes
then fire visibly early or late. The engine re-measures on `load` and via
`ResizeObserver`; if you hand-roll, do the same, and set explicit dimensions on
images so the layout doesn't move in the first place.

**Keep it navigable.** Headings in order, focusable things reachable by keyboard
and visible when focused, anchor links that land somewhere sensible, and the
page still usable at 200% zoom.

## Check your work

`scripts/audit.mjs` checks a built page against everything above:

```sh
node scripts/audit.mjs path/to/index.html
```

Static checks need only Node. If Playwright is installed it also drives a real
browser and answers the questions that source reading can't — whether anything
actually sticks, whether the page renders identically scrolling up and down
(the purity property), and whether prose stays readable under reduced motion.
Run it before calling a scroll page done; it catches the boring failures fast
so review time goes to the storyboard instead.

## Going further

- `references/effects.md` — the scene vocabulary with working code: pinned
  chapters, parallax depth, horizontal scroll, scroll-scrubbed canvas and video,
  text reveals, counters, and the native CSS `animation-timeline` route for the
  simple cases where you don't need JS at all.
- `references/troubleshooting.md` — symptom-first diagnosis. Start here for
  stutter, scenes firing at the wrong time, sticky that won't stick, mobile
  breakage, and how to actually profile a scroll page.
