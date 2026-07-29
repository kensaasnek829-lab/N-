# Scene vocabulary

Working recipes for the effects a scroll world is built from. Each assumes
`assets/scroll-world.js` is loaded and `const world = ScrollWorld()` exists.

**Contents**
- [Native CSS, no JS](#native-css-no-js) — try this first
- [Pinned chapters](#pinned-chapters)
- [Parallax depth](#parallax-depth)
- [Horizontal scroll](#horizontal-scroll)
- [Scrubbed canvas sequences](#scrubbed-canvas-sequences)
- [Scrubbed video](#scrubbed-video)
- [Text reveals](#text-reveals)
- [Counters and scrubbed data](#counters-and-scrubbed-data)
- [Sticky stacking cards](#sticky-stacking-cards)
- [Scene transitions](#scene-transitions)

---

## Native CSS, no JS

Baseline 2024 in Chrome and Edge, Safari 26+, Firefox behind a flag as of early
2026. For reveal-on-enter and progress bars — the majority of what pages
actually need — this is less code than any JS approach and runs off the main
thread entirely, so it cannot jank.

```css
/* Fade a card in as it crosses the viewport */
.card {
  animation: reveal linear both;
  animation-timeline: view();
  animation-range: entry 10% cover 35%;
}
@keyframes reveal {
  from { opacity: 0; transform: translateY(2rem); }
  to   { opacity: 1; transform: none; }
}

/* Reading progress driven by document scroll */
.bar {
  animation: grow linear both;
  animation-timeline: scroll(root block);
  transform-origin: left;
}
@keyframes grow { from { transform: scaleX(0); } to { transform: scaleX(1); } }
```

`view()` measures the element against the viewport; `scroll()` measures a
scroll container. `animation-range` takes `entry`, `exit`, `cover`, `contain`.

Feature-detect and let the JS engine be the fallback rather than shipping both:

```css
@supports not (animation-timeline: view()) {
  .card { opacity: 0; }   /* engine takes over via --p */
}
```

```js
if (!CSS.supports('animation-timeline', 'view()')) {
  document.querySelectorAll('.card').forEach(el => world.scene(el, {
    start: 'top bottom', end: 'center center'
  }));
}
```

Reach for JS when you need to drive something that isn't a CSS property
(canvas, video, WebGL), coordinate several elements against one shared
progress, or support Firefox without a flag.

---

## Pinned chapters

The workhorse: one visual, several beats narrated over it.

```html
<section class="track" id="story">
  <div class="stage">
    <div class="visual"></div>
    <article class="chapter">…</article>
    <article class="chapter">…</article>
    <article class="chapter">…</article>
  </div>
</section>
```

```css
#story { height: 400vh; }                 /* 3 beats + room to read */
#story .stage { position: sticky; top: 0; height: 100svh; }
.chapter {
  position: absolute;
  opacity: var(--c, 0);
  transform: translateY(calc((1 - var(--c, 0)) * 2rem));
}
```

```js
const chapters = [...document.querySelectorAll('#story .chapter')];
const slice = 1 / chapters.length;
const CROSS = 0.18;              // share of a slice spent cross-fading

world.pin('#story', p => {
  const last = chapters.length - 1;
  chapters.forEach((el, i) => {
    const w = slice * CROSS, start = i * slice, end = (i + 1) * slice;
    // windows straddle the boundary, so one chapter is still leaving as the
    // next arrives; the outer two hold rather than fade against nothing
    const fadeIn  = i === 0    ? 1 : ScrollWorld.range(p, start - w, start + w);
    const fadeOut = i === last ? 0 : ScrollWorld.range(p, end   - w, end   + w);
    el.style.setProperty('--c', Math.min(fadeIn, 1 - fadeOut).toFixed(3));
  });
});
```

**The fade windows have to overlap.** The obvious version — fade each chapter
out over the last 20% of its own slice, fade the next in over the first 20% of
the following slice — looks equivalent and isn't. Those windows sit end to end,
so at every boundary the outgoing chapter has already reached zero before the
incoming one starts, and the screen goes blank once per chapter. Sampling that
version across a four-chapter pin, peak opacity hits **0.000** at each seam;
straddling the boundary as above never drops below a normal 0.5 cross-dissolve.

The hold in the middle matters too. Cross-fading continuously means text is in
motion the whole time it's being read, which is exactly when you want it still.
Every beat should get a plateau where nothing moves.

---

## Parallax depth

Depth is nothing more than different layers moving at different speeds. Three
is plenty; more reads as soup.

```css
.plane[data-depth="far"] { transform: translateY(calc(var(--p) * -6vh)); }
.plane[data-depth="mid"] { transform: translateY(calc(var(--p) * -22vh)); }
.plane[data-depth="near"]{ transform: translateY(calc(var(--p) * -48vh)); }
```

```js
world.pin('#depth');   // one --p, all three layers read it
```

Support the illusion with the other depth cues or it stays flat: far layers
larger, softer, lower contrast; near layers smaller, sharper, brighter.

Never put body text on a moving plane. Text that drifts while being read is
unreadable, and it's the most common way parallax pages fail. Move the
scenery; hold the words.

---

## Horizontal scroll

A pinned section that translates a wide rail sideways as you scroll down. Keep
these short — the mismatch between gesture and direction gets tiring fast, and
it is genuinely hostile on a trackpad if overlong.

```css
#gallery { height: 300vh; }
#gallery .stage { position: sticky; top: 0; height: 100svh; overflow: hidden; }
.rail { display: flex; gap: 2rem; will-change: transform; }
```

```js
const rail = document.querySelector('.rail');

world.pin('#gallery', p => {
  const distance = rail.scrollWidth - window.innerWidth;
  rail.style.transform = `translate3d(${-p * distance}px,0,0)`;
});
```

`rail.scrollWidth` is a layout read inside the render pass. It's one read on a
single element so it's tolerable, but cache it on resize if the rail is large:

```js
let distance = 0;
const remeasure = () => { distance = rail.scrollWidth - window.innerWidth; };
addEventListener('resize', remeasure); addEventListener('load', remeasure);
```

Under reduced motion, let the rail be a normal horizontally-scrollable strip
(`overflow-x: auto`) rather than a frozen one.

---

## Scrubbed canvas sequences

The Apple-style "product rotates as you scroll" effect: a frame sequence drawn
to canvas, indexed by progress.

```js
const canvas = document.querySelector('#seq');
const ctx = canvas.getContext('2d');
const COUNT = 120;
const frames = [];
let ready = 0;

for (let i = 0; i < COUNT; i++) {
  const img = new Image();
  img.src = `/frames/${String(i).padStart(4, '0')}.webp`;
  img.onload = () => { if (++ready === 1) draw(0); };
  frames[i] = img;
}

function draw(p) {
  const img = frames[Math.min(COUNT - 1, Math.floor(p * COUNT))];
  if (!img || !img.complete) return;
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
}

world.pin('#sequence', draw);
```

Budget honestly: 120 frames of 1600px WebP is roughly 6–12MB. That is a real
cost on mobile data and it is the main reason these sections feel broken on
phones. Mitigate by serving a shorter sequence at smaller dimensions below a
breakpoint, decoding ahead with `createImageBitmap`, and giving the section a
sensible poster frame until enough has loaded. If you can't get the payload
down, use a single well-chosen still image on mobile — nobody misses it.

---

## Scrubbed video

Cheaper than a frame sequence and often just as good, but seeking is only
smooth if the file is encoded for it — short keyframe interval (every 5–10
frames), no audio track, `preload="auto"`, and `playsinline` plus `muted` so
iOS will decode it at all.

```js
const video = document.querySelector('#clip');

world.pin('#clip-scene', p => {
  if (video.readyState < 2 || !video.duration) return;
  video.currentTime = p * video.duration;
});
```

Test on a real iPhone before committing to this. Safari's seek behaviour under
rapid `currentTime` writes is the deciding factor and it does not reproduce in
desktop simulation.

---

## Text reveals

Wrap the units you want to animate, then stagger them across progress. Keep the
original text intact for screen readers rather than trusting split spans to
read correctly.

```js
const heading = document.querySelector('#headline');
const words = heading.textContent.split(' ');
heading.setAttribute('aria-label', heading.textContent);
heading.innerHTML = words
  .map(w => `<span class="w" aria-hidden="true">${w}</span>`)
  .join(' ');

const spans = [...heading.querySelectorAll('.w')];
world.scene('#headline', p => {
  spans.forEach((s, i) => {
    const t = ScrollWorld.range(p, i / spans.length * 0.6, i / spans.length * 0.6 + 0.4);
    s.style.setProperty('--w', t.toFixed(3));
  });
}, { start: 'top bottom', end: 'center center' });
```

```css
.w { display: inline-block; opacity: var(--w, 0);
     transform: translateY(calc((1 - var(--w, 0)) * .5em)); }
```

Per-letter staggering looks impressive on a three-word headline and turns a
paragraph into a slot machine. Words for headlines; whole lines or blocks for
anything longer.

---

## Counters and scrubbed data

Scrubbing a number to progress feels far more connected than a one-shot
count-up, because scrolling back counts back down.

```js
world.scene('#stat', p => {
  el.textContent = Math.round(ScrollWorld.ease.out(p) * 12500).toLocaleString();
}, { start: 'top bottom', end: 'center center' });
```

Use `font-variant-numeric: tabular-nums` so the digits stop jittering, and mark
the element `aria-live="off"` — otherwise some screen readers announce every
intermediate value.

---

## Sticky stacking cards

Cards that stack as each sticks in turn under the one before. Almost pure CSS.

```css
.card {
  position: sticky;
  top: calc(6rem + var(--i) * 1.5rem);   /* --i set per card, staggers the rest */
}
```

```js
document.querySelectorAll('.card').forEach((c, i) => {
  c.style.setProperty('--i', i);
  world.scene(c, { start: 'top top', end: 'bottom top' });  // --p for scale/dim
});
```

```css
.card { transform: scale(calc(1 - var(--p, 0) * .06)); filter: brightness(calc(1 - var(--p,0) * .3)); }
```

---

## Scene transitions

Between scenes, keep one thing continuous — a colour, a shape, a position.
A hard cut between two unrelated full-screen scenes reads as two websites
stapled together.

The cheapest continuity is background colour interpolated across the seam:

```js
world.scene('#seam', p => {
  document.body.style.setProperty('--bg-mix', p.toFixed(3));
}, { start: 'top bottom', end: 'bottom top' });
```

```css
body { background: color-mix(in oklab, var(--scene-a), var(--scene-b) calc(var(--bg-mix, 0) * 100%)); }
```

Interpolate in `oklab` rather than sRGB — sRGB blends run through a muddy grey
midpoint, which is very visible on a full-page background.
