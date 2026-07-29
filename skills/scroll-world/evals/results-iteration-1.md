# Iteration 1 — results

One eval (`pinned-narrative`), run twice by independent subagents: once with the
skill, once with no skill at all. Both were told to build a cinematic
single-page site for a coffee roaster with a section that "stays put while the
story changes over it", zero dependencies.

Graded with `scripts/audit.mjs`, which drives a real headless Chromium.

| | with skill | baseline |
|---|---|---|
| errors | 0 | 0 |
| warnings | **1** | **5** |
| checks passing | 13/14 | 9/14 |

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

## What both agents got wrong, and what it changed

Neither agent rendered its page. The with-skill one reported "no browser is
installed"; the baseline reported "the proxy blocks Playwright downloads" and
built an elaborate Node canvas-recording harness instead. Both were wrong — a
prebuilt Chromium was sitting in `/opt/pw-browsers` the whole time.

It cost them. The with-skill page has **text landing on text** at rest, right
through the middle of the pinned section: a beat-number label overlapping the
chapter rail. It passes every static check, is invisible in source, and is
obvious in a screenshot. So:

- `audit.mjs` gained a `text-collision` check, counting only fully-opaque text
  so a legitimate cross-dissolve (both beats near 50%) isn't flagged.
- `audit.mjs` now finds a browser properly — `CHROMIUM_PATH`, then the usual
  prebuilt locations, then Playwright's own.
- SKILL.md now says plainly that "Playwright not available" usually means *not
  found*, not *not installed*, with the commands to go looking — and that a
  pinned layout stacks its beats, so text-on-text is the failure you cannot
  catch without rendering.

The baseline agent also "fixed" `overflow-x: hidden` on `body`, calling it "the
classic way to silently break `position: sticky`", switching it to `clip`. That
is the exact folklore measured false above — the change was harmless but the
reasoning was wrong, which is good evidence the corrected table earns its place
in `troubleshooting.md`.

## Three false alarms fixed in audit.mjs

Worth recording, because each would have made the tool untrustworthy:

1. **Exact string comparison of computed styles.** Flagged a 0.0009 difference
   in `scaleX` caused by the engine's own write-skip epsilon.
2. **Sampling mid-transition.** Read in-flight CSS transitions as accumulated
   state. It now waits for rendering to come to rest and reports elements that
   never settle as their own, gentler finding.
3. **One tolerance for every matrix component.** A transform matrix mixes scale
   ratios (~1.0) with pixel translations, so a threshold sensible for scale
   rejected a **0.15px** translation difference as a defect. Each component is
   now judged in its own unit.

The lesson generalises past this script: a checker that cries wolf on correct
work is worse than no checker, because the first thing anyone does with it is
stop believing it.

## Regression suite

`tests/engine.test.mjs` — 18 assertions against headless Chromium, locking in
all three fixes above plus reduced-motion behaviour.
