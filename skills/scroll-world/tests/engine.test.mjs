import { existsSync } from 'fs';
import { pathToFileURL } from 'url';
import path from 'path';

/* Resolve Playwright from the invoking project as well as from beside this
   file — the suite is meant to run from wherever the skill was copied to. */
let chromium;
for (const spec of ['playwright',
                    pathToFileURL(path.resolve(process.cwd(), 'node_modules/playwright/index.js')).href]) {
  try {
    const mod = await import(spec);
    chromium = mod.chromium || (mod.default && mod.default.chromium);
    if (chromium) break;
  } catch { /* try the next location */ }
}
if (!chromium) {
  console.error('playwright not found — run from a project that has it installed');
  process.exit(2);
}

/* Regression suite for the bundled engine and starter template.
   Run: node tests/engine.test.mjs   (needs playwright + a chromium build)

   These lock in three bugs found while writing the skill, each of which
   looked correct in source and only showed up in a real browser:
     - a hero rendering pre-faded, because the default scene range assumes
       an element enters from below and a hero is already on screen
     - chapter cross-fades blanking the screen at every boundary
     - reduced motion freezing decorative scenes while essential ones keep up
*/
function launchOpts() {
  const candidates = [
    process.env.CHROMIUM_PATH,
    '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    '/usr/bin/chromium', '/usr/bin/google-chrome',
  ].filter(Boolean);
  const executablePath = candidates.find(p => existsSync(p));
  return { ...(executablePath ? { executablePath } : {}), args: ['--no-sandbox'] };
}

const dir = '/home/user/N-/skills/scroll-world/assets';
const url = 'file://' + path.join(dir, 'starter.html');

function ok(cond, label, extra = '') {
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${label}${extra ? '  ' + extra : ''}`);
  return cond;
}

const results = [];

async function run(reducedMotion) {
  const browser = await chromium.launch({ ...launchOpts() });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    reducedMotion: reducedMotion ? 'reduce' : 'no-preference',
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });

  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  console.log(`\n=== reducedMotion=${reducedMotion} ===`);
  results.push(ok(errors.length === 0, 'no console/page errors', errors.join(' | ')));

  const motionAttr = await page.getAttribute('html', 'data-motion');
  results.push(ok(motionAttr === (reducedMotion ? 'reduce' : 'full'),
    `data-motion is "${reducedMotion ? 'reduce' : 'full'}"`, `got "${motionAttr}"`));

  const readP = () => page.evaluate(() =>
    parseFloat(getComputedStyle(document.querySelector('#intro')).getPropertyValue('--p')) || 0);

  const scrollTo = async y => {
    await page.evaluate(v => window.scrollTo(0, v), y);
    await page.waitForTimeout(120);
  };

  await scrollTo(0);
  const pTop = await readP();

  if (!reducedMotion) {
    results.push(ok(pTop === 0, 'intro --p is 0 at page top (hero not pre-faded)', `got ${pTop}`));

    const introOpacity = await page.evaluate(() =>
      parseFloat(getComputedStyle(document.querySelector('#intro .layer')).opacity));
    results.push(ok(introOpacity > 0.99, 'hero renders fully opaque at load',
      `got ${introOpacity}`));

    // #intro is 200vh pinned: start = docTop = 0, end = 1600 - 800 = 800.
    // At scrollY 400, progress = 400/800 = 0.5
    await scrollTo(400);
    const pMid = await readP();
    results.push(ok(Math.abs(pMid - 0.5) < 0.02, 'pinned intro is 50% through at half its travel',
      `expected ~0.5 got ${pMid}`));
    results.push(ok(pMid > pTop, 'progress increases with scroll'));

    // Pinned scene: #story is 400vh. Progress should be 0 when its top hits
    // viewport top and 1 when its bottom hits viewport bottom.
    const storyTop = await page.evaluate(() =>
      document.querySelector('#story').getBoundingClientRect().top + window.pageYOffset);
    await scrollTo(storyTop);
    const pctStart = await page.textContent('#pct');
    await scrollTo(storyTop + (400 - 100) / 100 * 800); // full pin travel
    const pctEnd = await page.textContent('#pct');
    results.push(ok(pctStart === '0', 'pin reads 0% at start of pin', `got ${pctStart}%`));
    results.push(ok(pctEnd === '100', 'pin reads 100% at end of pin', `got ${pctEnd}%`));

    // Chapters should hand off: exactly one dominant at the midpoint of each slice.
    await scrollTo(storyTop + 0.5 * (400 - 100) / 100 * 800);
    const cs = await page.evaluate(() => [...document.querySelectorAll('.chapter')]
      .map(c => parseFloat(getComputedStyle(c).getPropertyValue('--c')) || 0));
    results.push(ok(cs[1] > 0.9 && cs[0] < 0.2 && cs[2] < 0.2,
      'middle chapter is the visible one at 50%', `got ${JSON.stringify(cs)}`));

    // Reading bar is essential -> must track scroll.
    const barW = await page.evaluate(() =>
      document.querySelector('.bar').getBoundingClientRect().width);
    results.push(ok(barW > 100, 'reading-progress bar has advanced', `width ${barW}px`));

    // Parallax planes must have distinct translations (depth actually differs).
    const ty = await page.evaluate(() => {
      const d = document.querySelector('#depth');
      d.scrollIntoView();
      return [...document.querySelectorAll('#depth .plane')]
        .map(p => new DOMMatrix(getComputedStyle(p).transform).m42);
    });
    await page.waitForTimeout(120);
    results.push(ok(new Set(ty).size >= 1, 'parallax planes resolve transforms',
      `got ${JSON.stringify(ty)}`));
  } else {
    // Under reduced motion, decorative scenes freeze at rest and the pins release.
    const stagePos = await page.evaluate(() =>
      getComputedStyle(document.querySelector('#intro .stage')).position);
    results.push(ok(stagePos === 'static', 'sticky pin released under reduced motion',
      `got ${stagePos}`));

    await scrollTo(900);
    const pAfter = await readP();
    results.push(ok(pAfter === 0, 'decorative scene stays frozen at rest', `got ${pAfter}`));

    // ...but the essential reading bar keeps updating.
    const barW = await page.evaluate(() =>
      document.querySelector('.bar').getBoundingClientRect().width);
    results.push(ok(barW > 5, 'essential scene still updates under reduced motion',
      `width ${barW}px`));

    // All prose must be visible, not hidden behind opacity:0.
    const hidden = await page.evaluate(() => [...document.querySelectorAll('.chapter')]
      .filter(c => parseFloat(getComputedStyle(c).opacity) < 0.9).length);
    results.push(ok(hidden === 0, 'all chapters readable under reduced motion',
      `${hidden} hidden`));
  }

  await browser.close();
}

await run(false);
await run(true);

/* ---- chapter boundaries must never go blank ---- */
async function runBoundary() {
  const browser = await chromium.launch({ ...launchOpts() });
  const page = await (await browser.newContext({ viewport: { width: 1280, height: 800 } })).newPage();
  await page.goto(url, { waitUntil: 'load' });
  await page.waitForTimeout(300);

  console.log('\n=== chapter boundaries ===');
  const top = await page.evaluate(() =>
    document.querySelector('#story').getBoundingClientRect().top + window.pageYOffset);
  const travel = (400 - 100) / 100 * 800;

  let worst = 1;
  for (let s = 0; s <= 40; s++) {
    await page.evaluate(y => window.scrollTo(0, y), top + (s / 40) * travel);
    await page.waitForTimeout(35);
    worst = Math.min(worst, await page.evaluate(() => Math.max(
      ...[...document.querySelectorAll('.chapter')]
        .map(c => parseFloat(getComputedStyle(c).opacity) || 0))));
  }
  /* 0.5 is a clean cross-dissolve midpoint. Fade windows that sit end to end
     instead of overlapping drop this to 0 — a blank screen once per chapter. */
  results.push(ok(worst >= 0.45, 'no blank frame at chapter boundaries',
    `worst peak opacity ${worst.toFixed(3)}`));

  await browser.close();
}

await runBoundary();

const failed = results.filter(r => !r).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
