# Troubleshooting

Symptom-first. Find what the page is doing, then work down the causes — they're
ordered by how often they turn out to be the culprit.

**Contents**
- [Stutter and jank](#stutter-and-jank)
- [Scenes fire at the wrong moment](#scenes-fire-at-the-wrong-moment)
- [Sticky won't stick](#sticky-wont-stick)
- [Mobile-only breakage](#mobile-only-breakage)
- [Wrong state after reload or navigation](#wrong-state-after-reload-or-navigation)
- [Flash of unstyled or unpositioned content](#flash-of-unstyled-or-unpositioned-content)
- [How to profile a scroll page](#how-to-profile-a-scroll-page)
- [Pre-ship checklist](#pre-ship-checklist)

---

## Stutter and jank

**Animating a property that isn't composited.** Anything driving `top`, `left`,
`width`, `height`, `margin`, or `padding` per frame forces layout on every
frame. Convert to `transform`. This is the first thing to check and usually the
answer.

**Layout thrash — reads interleaved with writes.** Reading
`getBoundingClientRect`, `offsetTop`, `scrollHeight`, or `getComputedStyle`
*after* writing styles in the same frame forces the browser to recompute layout
mid-frame, once per alternation. In DevTools this shows as a long purple Layout
block repeated many times per frame. Fix by measuring everything first, then
writing everything, which is what `ScrollWorld` does internally — if you're
reading layout inside a scene callback, hoist it out and cache it on resize.

**Too many elements animating.** Each composited layer costs GPU memory.
Dozens of simultaneously-animating elements will stutter on a mid-range phone
regardless of how correct the code is. Animate a container rather than its
children where you can.

**`will-change` sprayed everywhere.** It promotes elements to their own layer
permanently; enough of them exhausts GPU memory and the compositor starts
thrashing — the opposite of the intent. Apply it to the few elements actually
in motion, and drop it when they stop.

**Expensive filters.** `filter: blur()` and `backdrop-filter` composite but are
costly, and `backdrop-filter` on a large moving element is one of the most
expensive things you can ask a browser to do. One hero element is fine; a grid
of frosted cards moving at once is not.

**Heavy work inside the callback.** Anything allocating per frame — building
strings, `JSON.parse`, creating objects, `querySelector` — runs 60 times a
second. Hoist selectors and precompute outside; keep the callback arithmetic.

---

## Scenes fire at the wrong moment

**The page grew after you measured.** Late images and webfonts change document
height after first paint, so every runway below them shifts. The engine
re-measures on `load` and via `ResizeObserver`; if a scene is still off, call
`world.refresh()` after you change content yourself. Prevent it at source by
setting `width`/`height` (or `aspect-ratio`) on every image so nothing reflows.

**Wrong range for an element visible at load.** The default range assumes the
element enters from below, so anything on screen at load starts partway through
and appears pre-animated — a hero rendering half-faded is the classic symptom.
Use `.pin()`, or `start: 'top top'`, so progress 0 means "page top".

**Confusing element edges with viewport edges.** `"top bottom"` means *the
element's top* meeting *the viewport's bottom*. Reversing them is easy and
produces ranges that are inverted or near-zero-length. If progress snaps
between 0 and 1 with nothing in between, the start and end points have
collapsed onto each other.

**Transformed ancestors.** `getBoundingClientRect` returns the *transformed*
box. A scene inside a parent you're also translating measures its animated
position, which feeds back. Keep measured elements out of animated subtrees.

---

## Sticky won't stick

Almost always one of these, in this order:

1. **An intermediate ancestor has `overflow` set to anything but `visible`.**
   Sticky positions against its nearest scrolling ancestor, and any non-visible
   overflow silently becomes that ancestor.

   The important nuance, because the usual advice gets it backwards: `overflow`
   on `<html>` or `<body>` is **not** the problem. Those propagate to the
   viewport, so the element keeps sticking. Verified behaviour:

   | where `overflow-x: hidden` sits | sticky |
   |---|---|
   | `html` | works |
   | `body` | works |
   | any wrapper `<div>` in between | **broken** |

   So the familiar "remove `overflow-x: hidden` from body to fix sticky" is a
   dead end — it was never the cause. Look for a wrapper div instead, usually
   one added to stop a horizontal scrollbar. `overflow-y: auto` and plain
   `overflow: hidden` on a wrapper break it the same way. (`contain: paint` is
   fine; it doesn't create a scroll container.)

   ```js
   // walk up from the sticky element and name the actual offender
   let n = el.parentElement;
   while (n && n !== document.body) {
     const s = getComputedStyle(n);
     if (s.overflowX !== 'visible' || s.overflowY !== 'visible')
       console.log('breaks sticky:', n, s.overflowX, s.overflowY);
     n = n.parentElement;
   }
   ```

   To keep the horizontal-scrollbar fix without breaking sticky, move it to
   `html, body { overflow-x: hidden }` — or better, find the element that's
   actually overflowing and constrain that.
2. **No `top` (or `bottom`) set.** `position: sticky` alone does nothing; it
   needs an inset to stick against.
3. **The parent isn't taller than the sticky element.** Sticky travel is bounded
   by the parent's box — a track that isn't taller than its stage has nowhere to
   travel, so nothing appears to happen.
4. **The parent is a flex or grid container with default alignment**, which can
   stretch the child to full height and remove the travel. Set
   `align-self: start`.

---

## Mobile-only breakage

**`100vh` drift.** Mobile chrome hides and reveals as you scroll, changing the
viewport. `100vh` is the *largest* viewport, so full-screen stages end up taller
than the screen and every scene drifts progressively. Use `100svh`. This one
unit fixes most "fine on desktop, broken on my phone".

**Payload.** Frame sequences and scrubbed video are the usual cause of a page
that works but feels broken on a phone. Serve fewer, smaller frames below a
breakpoint, or a single still image.

**iOS scroll events during momentum.** Safari fires scroll during momentum but
can throttle rAF under pressure; keep the per-frame work small and it holds up.

**Hover-only affordances.** Anything revealed on hover doesn't exist on touch.
Check that every interactive element is reachable by tap.

**Address-bar resize storms.** Showing/hiding chrome fires `resize`, which
triggers re-measure. If scenes visibly jump when the bar moves, debounce the
resize handler or ignore height-only changes under a threshold on touch devices.

---

## Wrong state after reload or navigation

Browsers restore scroll position on reload and back-navigation, so the page
must be correct at an arbitrary scroll offset without having animated there.
If it isn't, some state is accumulating rather than being derived — look for
`classList.add` in a scroll handler, or a callback that depends on the previous
frame's value. Rewrite it as a pure function of progress.

Test it directly: scroll to the middle of a scene and hit reload. The page
should be identical to how it looked before the reload.

If you need to defeat restoration for a landing page, `history.scrollRestoration
= 'manual'` — but fix the state derivation first; restoration is exposing the
bug, not causing it.

---

## Flash of unstyled or unpositioned content

Elements that start hidden (`opacity: 0`) flash visible before the first frame
runs, or sit invisible forever if JS fails. Set the initial state in CSS via the
same custom property the engine writes, with a default:

```css
.reveal { opacity: var(--p, 0); }        /* correct before JS, correct after */
```

Guard against JS never arriving — a page whose content is invisible without it
is a broken page:

```html
<noscript><style>.reveal { opacity: 1 !important; transform: none !important; }</style></noscript>
```

---

## How to profile a scroll page

1. DevTools → Performance → enable **CPU throttling 4×** and **Screenshots**.
   Profiling on an unthrottled laptop tells you nothing about the phone the
   page will fail on.
2. Record while scrolling through the whole page.
3. Read the frames track. Long yellow (scripting) means the callback is doing
   too much; long purple (layout) means thrash or non-composited properties;
   long green (paint) means expensive filters or large repaints.
4. Rendering panel → **Paint flashing** shows what's repainting. A composited
   scroll animation should repaint almost nothing — large green flashes on
   scroll indicate a property that isn't compositing.
5. Rendering panel → **Layer borders** shows promoted layers. Far more layers
   than elements you're animating means `will-change` is over-applied.
6. Rendering panel → **Emulate prefers-reduced-motion** to check that path.

The target is 60fps sustained under 4× throttling. Occasional dropped frames
during a fling are acceptable; sustained sub-30fps is not.

---

## Pre-ship checklist

- Reload mid-scene: page is correct, no flash of wrong state
- Scroll up: everything plays backwards cleanly
- Reduced motion: pins released, all content readable, nothing frozen blank
- Keyboard: Tab reaches everything, focus is visible, Space/PageDown page normally
- Screen reader: content reads in order without motion wrappers interfering
- 200% zoom: still usable
- JS disabled: content is all there
- Real phone, real network: acceptable payload, no drift, no stutter
- Throttled profile: 60fps sustained
