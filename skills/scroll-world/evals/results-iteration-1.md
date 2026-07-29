# Iteration 1 — results

One eval (`pinned-narrative`), run twice by independent subagents: once with the
skill, once with no skill at all. Both were told to build a cinematic
single-page site for a coffee roaster with a section that "stays put while the
story changes over it", zero dependencies.

Graded with `scripts/audit.mjs`, which drives a real headless Chromium.

| | with skill | baseline |
|---|---|---|
| errors | 0 | 0 |
| warnings | **0** | **5** |
| checks passing | 13/13 | 8/13 |

Both produced a working, good-looking page with a real pinned section, and both
had all four narrative beats (origin, harvest, roast, cup) present as text in
the HTML at load — so the baseline is not bad work. The difference is entirely
in the failure modes the skill exists to prevent:

| baseline warning | what it costs |
|---|---|
| `2× 100vh` | full-screen stages drift as mobile browser chrome hides |
| reduced-motion block never releases pinning | motion-sensitive readers get a page frozen mid-scene |
| writes `width` from JS per frame | relayout every frame instead of compositing |
| 3 rules at `opacity:0`, no `<noscript>` | content disappears entirely if JS fails |
| 11 elements never settle with scroll held still | CSS transitions on scroll-driven properties; rendering lags the scrollbar and depends on arrival speed |

The last one was the most useful finding: adding `transition` to smooth a
scroll-driven property is an instinctive move that quietly breaks the purity
the architecture depends on. It wasn't called out in the skill, so a note was
added to the non-negotiables, and `audit.mjs` grew a `settling` check for it.

## Bugs this round found in the skill's own material

Testing the skill turned up three defects that all looked correct in source and
only appeared in a browser:

1. **Hero rendered pre-faded.** The default scene range assumes an element
   enters from below, so anything on screen at load starts partway through it.
   Fixed in `starter.html` (use `.pin()`) and documented.
2. **Chapter cross-fades blanked the screen at every boundary.** Fading one
   chapter out over the end of its slice and the next in over the start of the
   following slice puts the windows end to end rather than overlapping; peak
   opacity measured **0.000** at each seam. The corrected version never drops
   below 0.5.
3. **`overflow-x: hidden` on `body` does not break sticky.** The widely
   repeated advice is wrong. Measured across a matrix: `html` and `body`
   propagate overflow to the viewport and sticky keeps working; only an
   intermediate wrapper breaks it. `troubleshooting.md` now carries the tested
   table.

Two false alarms in `audit.mjs` were also fixed: it compared computed styles as
exact strings, so it flagged sub-pixel differences (0.0009 in `scaleX`) caused
by the engine's own write-skip epsilon, and it read in-flight CSS transitions as
accumulated state. It now settles before sampling and compares numerically with
a tolerance.

## Regression suite

`tests/engine.test.mjs` — 18 assertions against headless Chromium, locking in
all three fixes above plus reduced-motion behaviour.
