#!/usr/bin/env node
/**
 * audit.mjs — check a scroll page against the things that actually break.
 *
 *   node audit.mjs path/to/index.html
 *
 * Static checks need nothing but Node. If Playwright happens to be installed
 * it also drives a real browser and runs the checks that only mean something
 * at runtime — chiefly "is the page a pure function of scroll position",
 * which is the property that makes reload-mid-scene and scroll-up work and
 * which no amount of source reading can confirm.
 *
 * Exit code is 1 if any ERROR fired; warnings alone don't fail the run.
 */

import { readFileSync, existsSync } from 'fs';
import { dirname, resolve, isAbsolute } from 'path';
import { pathToFileURL } from 'url';

const target = process.argv[2];
if (!target || !existsSync(target)) {
  console.error('usage: node audit.mjs <path-to-html>');
  process.exit(2);
}

const file = isAbsolute(target) ? target : resolve(process.cwd(), target);
const html = readFileSync(file, 'utf8');

const findings = [];
const add = (level, check, detail) => findings.push({ level, check, detail });
const ERROR = 'ERROR', WARN = 'WARN', OK = 'OK';

/* Inline <style> and <script> plus anything they link to locally, so the
   checks see the whole page rather than just its markup. */
function collect(re) {
  return [...html.matchAll(re)].map(m => m[1]).join('\n');
}
let css = collect(/<style[^>]*>([\s\S]*?)<\/style>/gi);
let js = collect(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/gi);

for (const [, href] of html.matchAll(/<link[^>]+href=["']([^"']+\.css)["']/gi)) {
  const p = resolve(dirname(file), href);
  if (existsSync(p)) css += '\n' + readFileSync(p, 'utf8');
}
for (const [, src] of html.matchAll(/<script[^>]+src=["']([^"']+\.js)["']/gi)) {
  const p = resolve(dirname(file), src);
  if (existsSync(p)) js += '\n' + readFileSync(p, 'utf8');
  else if (!/^https?:/.test(src)) add(ERROR, 'assets', `missing local script: ${src}`);
}

const stripComments = s => s.replace(/\/\*[\s\S]*?\*\//g, '');
const cssClean = stripComments(css);

/* ---------------- static checks ---------------- */

// Full-screen stages measured in vh drift as mobile browser chrome moves.
{
  const vh = [...cssClean.matchAll(/(?:^|[^a-z-])(?:min-height|height)\s*:\s*100vh/gi)];
  if (vh.length) add(WARN, 'viewport-units',
    `${vh.length}× "100vh" — use 100svh for full-screen stages so mobile chrome doesn't shift them`);
  else add(OK, 'viewport-units', 'no bare 100vh stages');
}

// Reduced motion must produce a readable page, not a frozen one.
{
  if (!/prefers-reduced-motion/i.test(cssClean + js)) {
    add(ERROR, 'reduced-motion', 'no prefers-reduced-motion handling at all');
  } else {
    const block = cssClean.slice(cssClean.search(/prefers-reduced-motion/i));
    const releases = /position\s*:\s*static/i.test(block) || /height\s*:\s*auto/i.test(block);
    if (/position\s*:\s*sticky/i.test(cssClean) && !releases) {
      add(WARN, 'reduced-motion',
        'page pins but reduced-motion block never releases sticky/tall tracks — content may freeze blank');
    } else {
      add(OK, 'reduced-motion', 'handled, and pinning is released');
    }
  }
}

// Hijacking the wheel breaks trackpads, keyboards, find-in-page and AT.
{
  const hijack = /addEventListener\s*\(\s*["'](?:wheel|mousewheel|touchmove)["'][\s\S]{0,240}?preventDefault/gi;
  if (hijack.test(js)) add(ERROR, 'scroll-hijack', 'preventDefault on wheel/touchmove — never take over scrolling');
  else add(OK, 'scroll-hijack', 'native scrolling left intact');
}

// Per-frame writes to layout properties relayout the whole page.
{
  const bad = /\.style\.(top|left|right|bottom|width|height|margin\w*|padding\w*)\s*=/g;
  const hits = [...js.matchAll(bad)].map(m => m[1]);
  if (hits.length) add(WARN, 'composited-props',
    `writes layout properties from JS (${[...new Set(hits)].join(', ')}) — prefer transform/opacity`);
  else add(OK, 'composited-props', 'no per-frame layout-property writes');
}

// Accumulating state is what breaks reload-mid-scene and scrolling upward.
{
  const scrollHandler = /addEventListener\s*\(\s*["']scroll["']([\s\S]{0,600})/gi;
  let flagged = false;
  for (const m of js.matchAll(scrollHandler)) {
    if (/classList\.(add|remove|toggle)/.test(m[1])) flagged = true;
  }
  if (flagged) add(WARN, 'purity',
    'classList mutation inside a scroll handler — usually means state accumulates; derive it from progress instead');
  else add(OK, 'purity', 'no obvious state accumulation in scroll handlers');
}

// will-change is a budget, not a decoration.
{
  const n = (cssClean.match(/will-change/gi) || []).length;
  if (n > 8) add(WARN, 'will-change', `${n} will-change declarations — over-promotion exhausts GPU memory`);
  else add(OK, 'will-change', `${n} will-change declarations`);
}

// Images without intrinsic size reflow on load and shift every scene below.
{
  const imgs = [...html.matchAll(/<img\b[^>]*>/gi)].map(m => m[0]);
  const bare = imgs.filter(t =>
    !/\b(width|height)\s*=/.test(t) && !/aspect-ratio/.test(t));
  if (bare.length) add(WARN, 'layout-shift',
    `${bare.length}/${imgs.length} <img> without width/height — late reflow shifts scene ranges`);
  else add(OK, 'layout-shift', `${imgs.length} images sized`);
}

// Content that only exists after JS is invisible to a real set of readers.
{
  const hidden = (cssClean.match(/opacity\s*:\s*0\b/g) || []).length;
  if (hidden > 0 && !/<noscript/i.test(html)) {
    add(WARN, 'no-js', `${hidden} rules start at opacity:0 with no <noscript> fallback — content vanishes if JS fails`);
  } else add(OK, 'no-js', 'no-JS path considered');
}

// Sticky needs an inset; the ancestor-chain half is checked at runtime, where
// it can be answered precisely instead of guessed at from source.
{
  if (/position\s*:\s*sticky/i.test(cssClean)) {
    const insets = /position\s*:\s*sticky[\s\S]{0,200}?(top|bottom)\s*:/i.test(cssClean) ||
                   /(top|bottom)\s*:[\s\S]{0,200}?position\s*:\s*sticky/i.test(cssClean);
    if (!insets) add(ERROR, 'sticky-inset', 'position:sticky with no top/bottom inset — it will never stick');
    else add(OK, 'sticky-inset', 'sticky rules declare an inset');
  }
}

/* ---------------- runtime checks (optional) ---------------- */

async function runtime() {
  /* Resolve Playwright from the audited project as well as from next to this
     script — a bundled skill script rarely sits inside the node_modules tree
     of the page it is checking. */
  let chromium;
  for (const spec of ['playwright',
                      pathToFileURL(resolve(process.cwd(), 'node_modules/playwright/index.js')).href,
                      pathToFileURL(resolve(dirname(file), 'node_modules/playwright/index.js')).href]) {
    try {
      const mod = await import(spec);
      /* Playwright is CommonJS, so depending on how it was resolved the
         browsers hang off the namespace or off .default. */
      chromium = mod.chromium || (mod.default && mod.default.chromium);
      if (chromium) break;
    } catch { /* try the next location */ }
  }
  if (!chromium) return null;

  /* Playwright's own download is often unavailable (offline, or a proxy that
     blocks it) while a perfectly good Chromium is already on disk. Prefer an
     explicit CHROMIUM_PATH, then the usual prebuilt locations, then let
     Playwright find its own. */
  const launch = { args: ['--no-sandbox'] };
  const candidates = [process.env.CHROMIUM_PATH];
  for (const root of ['/opt/pw-browsers', `${process.env.HOME || '/root'}/.cache/ms-playwright`]) {
    for (const build of ['chromium', 'chromium-*']) {
      candidates.push(`${root}/${build}/chrome-linux/chrome`);
    }
  }
  candidates.push('/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/google-chrome');

  for (const c of candidates) {
    if (!c) continue;
    if (c.includes('*')) {                        // expand a single glob segment
      const [base, rest] = c.split('*');
      const dir = dirname(base);
      let entries = [];
      try { entries = (await import('fs')).readdirSync(dir); } catch { continue; }
      const prefix = base.slice(dir.length + 1);
      const hit = entries.filter(e => e.startsWith(prefix))
        .map(e => `${dir}/${e}${rest}`).find(existsSync);
      if (hit) { launch.executablePath = hit; break; }
    } else if (existsSync(c)) { launch.executablePath = c; break; }
  }

  let browser;
  try { browser = await chromium.launch(launch); }
  catch { return null; }

  const url = pathToFileURL(file).href;
  const ctx = await browser.newContext({ viewport: { width: 1280, height: 800 } });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e).slice(0, 160)));
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(250);

  if (errors.length) add(ERROR, 'runtime-errors', errors.join(' | '));
  else add(OK, 'runtime-errors', 'no uncaught errors');

  /* Does anything actually stick? An intermediate ancestor with non-visible
     overflow silently turns every pin into a normal scrolling block. html and
     body are exempt: their overflow propagates to the viewport. */
  const stickyReport = await page.evaluate(() => {
    const out = [];
    for (const el of document.querySelectorAll('*')) {
      if (getComputedStyle(el).position !== 'sticky') continue;
      let n = el.parentElement;
      while (n && n !== document.body && n !== document.documentElement) {
        const s = getComputedStyle(n);
        if (s.overflowX !== 'visible' || s.overflowY !== 'visible') {
          out.push(`${el.className || el.tagName} blocked by <${n.tagName.toLowerCase()}${
            n.className ? '.' + String(n.className).split(' ')[0] : ''}> overflow:${s.overflowX}/${s.overflowY}`);
          break;
        }
        n = n.parentElement;
      }
    }
    return out;
  });
  if (stickyReport.length) add(ERROR, 'sticky-ancestors', stickyReport.join(' | '));
  else add(OK, 'sticky-ancestors', 'no overflow ancestor blocks sticky');

  const height = await page.evaluate(() => document.documentElement.scrollHeight);
  const vp = 800;

  /* Purity: the picture at a given offset must not depend on how you got
     there. Sample scrolling down, then again scrolling up, and compare.

     Scroll has to be held still until rendering settles first, or this
     measures in-flight CSS transitions rather than page state — a different
     problem with a different fix, and worth naming separately. */
  const snapshot = () => page.evaluate(() => {
    const out = {};
    document.querySelectorAll('body *').forEach((el, i) => {
      const s = getComputedStyle(el);
      if (s.transform !== 'none' || parseFloat(s.opacity) < 1)
        out[i] = [...(s.transform.match(/-?[\d.]+/g) || []).map(Number), parseFloat(s.opacity)];
    });
    return out;
  });

  /* Compare numerically with a tolerance rather than by string. Engines that
     skip imperceptible writes (this one skips deltas under 0.0005) can land a
     hair apart depending on approach direction; flagging that as a defect
     would mean flagging every correctly-built page. Translations are compared
     in pixels, scales and opacity as ratios, so use a threshold below which
     nothing is visible either way. */
  /* A transform matrix mixes units: scale and skew are ratios around 1, but
     translations are pixels, and the last entry here is opacity. Comparing
     them all against one number means a threshold sensible for scale is
     absurdly tight for pixels — a 0.15px translation difference is invisible
     on any display yet fails a 0.05 test. Judge each component in its own
     unit, scaled by `k` so the same function can ask a strict question
     (has it stopped moving) and a lenient one (do these look the same). */
  const near = (a, b, k) => {
    if (!a || !b || a.length !== b.length) return false;
    const n = a.length - 1;                       // last entry is opacity
    const translations = n === 16 ? [12, 13, 14]  // matrix3d
                       : n === 6  ? [4, 5]        // 2D matrix
                       : [];
    return a.every((v, i) => {
      const tol = i === n ? 0.04 * k                       // opacity, a ratio
                : translations.includes(i) ? 1.0 * k       // pixels
                : 0.02 * k;                                // scale / skew
      return Math.abs(v - b[i]) < tol;
    });
  };
  /* Two different questions needing two different thresholds. "Do these two
     renderings match?" wants a loose one, so imperceptible differences aren't
     called defects. "Has it stopped moving?" wants a tight one — a slow
     transition creeping a hair per sample clears a loose threshold and looks
     settled while still drifting, which is exactly how an animation still in
     flight gets misreported as impure state. */
  const same   = (a, b) => near(a, b, 1);      // imperceptible = identical
  const stable = (a, b) => near(a, b, 0.05);   // still drifting at all?

  const unsettled = new Set();
  const settle = async y => {
    await page.evaluate(v => window.scrollTo(0, v), y);
    let prev = await (await page.waitForTimeout(80), snapshot());
    const ROUNDS = 14;                            // up to ~2.1s of settling
    for (let i = 0; i < ROUNDS; i++) {
      await page.waitForTimeout(150);
      const next = await snapshot();
      const keys = new Set([...Object.keys(prev), ...Object.keys(next)]);
      const moving = [...keys].filter(k => !stable(prev[k], next[k]));
      prev = next;
      if (!moving.length) return next;
      if (i === ROUNDS - 1) moving.forEach(k => unsettled.add(k));
    }
    return prev;
  };

  const stops = [0.25, 0.5, 0.75].map(f => Math.round((height - vp) * f));
  const down = [];
  for (const y of stops) down.push(await settle(y));
  await page.evaluate(v => window.scrollTo(0, v), height);
  await page.waitForTimeout(200);
  const up = [];
  for (const y of [...stops].reverse()) up.unshift(await settle(y));

  /* Elements still moving while scroll is held aren't scroll-derived at all
     (a looping keyframe animation, or a transition that never lands), so
     excluding them keeps the purity verdict about what it claims to be. */
  const differing = stops.map((_, i) => {
    const keys = new Set([...Object.keys(down[i]), ...Object.keys(up[i])]);
    return [...keys].filter(k => !unsettled.has(k) && !same(down[i][k], up[i][k]));
  });
  const mismatch = differing.filter(d => d.length).length;

  if (mismatch) add(ERROR, 'purity-runtime',
    `${mismatch}/${stops.length} scroll positions settle differently depending on scroll direction ` +
    `(e.g. ${differing.find(d => d.length).slice(0, 2).map(k => `el#${k}`).join(', ')}) — ` +
    `state is carried between frames rather than derived from progress`);
  else add(OK, 'purity-runtime', 'identical rendering scrolling up and down');

  /* Chapters in a pinned scene are absolutely positioned on top of each other
     by necessity, so a mistake in one beat's offsets shows up as text sitting
     on text — invisible in source, obvious on screen. Only fully-opaque text
     counts: mid-dissolve both beats are legitimately present at ~50%. */
  const collisions = [];
  for (const y of stops) {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(400);
    const n = await page.evaluate(() => {
      const solid = [...document.querySelectorAll('body *')].filter(el => {
        if (!el.textContent.trim() || el.children.length) return false;
        const s = getComputedStyle(el);
        if (s.visibility === 'hidden' || s.display === 'none') return false;
        let node = el, eff = 1;              // opacity multiplies down the tree
        while (node && node !== document.body) {
          eff *= parseFloat(getComputedStyle(node).opacity); node = node.parentElement;
        }
        if (eff < 0.85) return false;
        const r = el.getBoundingClientRect();
        return r.width > 0 && r.height > 0 && r.top < innerHeight && r.bottom > 0;
      });
      let hits = 0;
      for (let i = 0; i < solid.length; i++)
        for (let j = i + 1; j < solid.length; j++) {
          const a = solid[i].getBoundingClientRect(), b = solid[j].getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 4 &&
              Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 4) hits++;
        }
      return hits;
    });
    collisions.push(n);
  }
  const worstCollide = Math.max(...collisions);
  if (worstCollide) add(WARN, 'text-collision',
    `${worstCollide} pair(s) of fully-opaque text overlap at rest — beats are landing on top of each other`);
  else add(OK, 'text-collision', 'no overlapping text at any sampled position');

  if (unsettled.size) add(WARN, 'settling',
    `${unsettled.size} element(s) never come to rest with scroll held still — usually a CSS ` +
    `transition on a scroll-driven property, which makes rendering lag the scrollbar`);

  /* Reduced motion must leave prose readable rather than at opacity 0. */
  const rctx = await browser.newContext({ viewport: { width: 1280, height: 800 }, reducedMotion: 'reduce' });
  const rpage = await rctx.newPage();
  await rpage.goto(url, { waitUntil: 'load' });
  await rpage.waitForTimeout(250);
  const invisible = await rpage.evaluate(() => {
    let n = 0;
    for (const el of document.querySelectorAll('p,h1,h2,h3,li')) {
      const s = getComputedStyle(el);
      if (parseFloat(s.opacity) < 0.1 && el.textContent.trim()) n++;
    }
    return n;
  });
  if (invisible) add(ERROR, 'reduced-motion-runtime',
    `${invisible} text elements invisible under prefers-reduced-motion`);
  else add(OK, 'reduced-motion-runtime', 'all prose readable under reduced motion');

  await browser.close();
  return true;
}

const ran = await runtime();

/* ---------------- report ---------------- */

const icon = { OK: ' ok ', WARN: 'warn', ERROR: 'FAIL' };
const order = { ERROR: 0, WARN: 1, OK: 2 };
findings.sort((a, b) => order[a.level] - order[b.level]);

console.log(`\nscroll-world audit — ${file}\n`);
for (const f of findings) console.log(`  [${icon[f.level]}] ${f.check.padEnd(22)} ${f.detail}`);
if (ran === null) console.log('\n  (runtime checks skipped — Playwright not available)');

const errs = findings.filter(f => f.level === ERROR).length;
const warns = findings.filter(f => f.level === WARN).length;
console.log(`\n${errs} error(s), ${warns} warning(s)\n`);
process.exit(errs ? 1 : 0);
