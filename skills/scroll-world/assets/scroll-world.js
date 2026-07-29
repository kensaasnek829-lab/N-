/*!
 * scroll-world.js — a small engine for scroll-driven scenes.
 * Zero dependencies. ~6kb unminified. MIT.
 *
 * The whole idea: scroll position is an *input*, not an event to react to.
 * You register scenes; the engine tells each one how far through it you are
 * (0 → 1) once per animation frame, and you turn that number into a picture.
 *
 *   const world = ScrollWorld();
 *   world.scene('#intro');                        // writes --p: 0→1 on the element
 *   world.scene('#chart', p => draw(p));          // or run your own code
 *
 * Reads (measuring the page) and writes (changing the page) are kept in
 * separate passes, so the browser never has to recompute layout mid-frame.
 * That separation is the difference between 60fps and a slideshow.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else if (typeof define === 'function' && define.amd) define(factory);
  else root.ScrollWorld = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var EDGE = { top: 0, center: 0.5, bottom: 1 };

  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }

  /* "top bottom" → { el: 0, vp: 1 }
     Reads as: this point of the element, meeting this point of the viewport. */
  function parseEdge(spec, fallback) {
    var parts = String(spec == null ? fallback : spec).trim().split(/\s+/);
    var el = EDGE[parts[0]], vp = EDGE[parts[1]];
    return { el: el == null ? 0 : el, vp: vp == null ? 0 : vp };
  }

  function resolve(target, ctx) {
    if (!target) return null;
    if (target.nodeType === 1) return target;
    return (ctx || document).querySelector(target);
  }

  function ScrollWorld(config) {
    config = config || {};

    var scenes = [];
    var vh = 0;
    var queued = false;
    var measured = false;
    var destroyed = false;
    var lastY = -1;

    var mq = window.matchMedia('(prefers-reduced-motion: reduce)');
    var reduced = mq.matches;

    /* Publish the motion mode so CSS can opt out of pinning and parallax
       wholesale — see the [data-motion="reduce"] rules in your stylesheet.
       Reduced motion isn't "same page, no animation"; it's a different,
       calmer layout, and CSS is the right place to express that. */
    function publishMotion() {
      document.documentElement.setAttribute('data-motion', reduced ? 'reduce' : 'full');
    }

    /* ---- reading the page (never mixed with writing) ---- */

    function measure() {
      vh = window.innerHeight || document.documentElement.clientHeight;
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;

      for (var i = 0; i < scenes.length; i++) {
        var s = scenes[i];
        var rect = s.el.getBoundingClientRect();
        var top = rect.top + y;
        var h = rect.height;

        /* Scroll offset at which the chosen element edge meets the chosen
           viewport edge. Distance between the two is the scene's runway. */
        s.startY = (top + h * s.start.el) - vh * s.start.vp;
        s.endY = (top + h * s.end.el) - vh * s.end.vp;
        s.span = s.endY - s.startY;
      }
      measured = true;
    }

    /* ---- writing to the page ---- */

    function render(force) {
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;

      for (var i = 0; i < scenes.length; i++) {
        var s = scenes[i];

        /* A scene frozen for reduced motion still gets one write, so it
           lands in a sensible resting state instead of an arbitrary one. */
        if (reduced && !s.essential) {
          if (!s.settled) { s.settled = true; apply(s, s.rest); }
          continue;
        }

        var p = s.span === 0 ? (y >= s.startY ? 1 : 0)
                             : clamp01((y - s.startY) / s.span);
        if (s.ease) p = s.ease(p);

        /* Skip writes that wouldn't be visible. Sub-thousandth changes cost
           a style recalc and buy nothing. */
        if (!force && s.last != null && Math.abs(p - s.last) < 0.0005) continue;

        apply(s, p);
      }
      lastY = y;
    }

    function apply(scene, p) {
      scene.last = p;
      if (scene.fn) scene.fn(p, scene);
      else scene.out.style.setProperty(scene.prop, scene.decimals == null
        ? p
        : p.toFixed(scene.decimals));
    }

    /* ---- frame scheduling ---- */

    function schedule(remeasure) {
      if (destroyed) return;
      if (remeasure) measured = false;
      if (queued) return;
      queued = true;
      requestAnimationFrame(function () {
        queued = false;
        if (destroyed) return;
        /* A fresh measure invalidates every cached progress value, so the
           following render must write unconditionally rather than trusting
           its "has this changed enough to matter" shortcut. */
        var remeasured = !measured;
        if (remeasured) measure();
        render(remeasured);
      });
    }

    function onScroll() { schedule(false); }
    function onResize() { schedule(true); }

    window.addEventListener('scroll', onScroll, { passive: true });
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);

    /* Late-loading images and webfonts change the page height after first
       paint, which silently shifts every scene's runway. Re-measure. */
    window.addEventListener('load', onResize);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(onResize).observe(document.documentElement);
    }
    if (mq.addEventListener) {
      mq.addEventListener('change', function (e) {
        reduced = e.matches;
        publishMotion();
        for (var i = 0; i < scenes.length; i++) scenes[i].settled = false;
        schedule(true);
      });
    }

    publishMotion();

    /* ---- public API ---- */

    var api = {
      /*
       * scene(target, fn?, opts?)
       *
       *   target  element or selector — the thing whose travel defines 0→1
       *   fn      optional; called with (progress, scene) each frame.
       *           Omit it and the engine writes a CSS custom property instead,
       *           which is usually what you want: keep the maths in JS and the
       *           look in CSS, so a designer can retune without touching code.
       *
       *   opts.start / opts.end   "elementEdge viewportEdge", e.g. "top bottom"
       *   opts.out                element to receive the custom property
       *   opts.prop               property name (default "--p")
       *   opts.ease               p => p, for non-linear pacing
       *   opts.essential          true = keep updating under reduced motion.
       *                           Use for state that carries meaning (which
       *                           chapter is active) rather than decoration.
       *   opts.rest               progress to freeze at under reduced motion
       */
      scene: function (target, fn, opts) {
        if (fn && typeof fn === 'object') { opts = fn; fn = null; }
        opts = opts || {};

        var el = resolve(target);
        if (!el) return api;

        scenes.push({
          el: el,
          fn: fn || opts.onProgress || null,
          out: resolve(opts.out) || el,
          prop: opts.prop || '--p',
          decimals: opts.decimals == null ? 4 : opts.decimals,
          ease: opts.ease || null,
          essential: !!opts.essential,
          rest: opts.rest == null ? 0 : opts.rest,
          start: parseEdge(opts.start, 'top bottom'),
          end: parseEdge(opts.end, 'bottom top'),
          startY: 0, endY: 0, span: 1, last: null, settled: false
        });

        schedule(true);
        return api;
      },

      /*
       * A pinned scene: a tall track scrolls past while its sticky child
       * stays put. Progress runs 0→1 across exactly the pinned travel, so
       * "how far through this chapter am I" means what you'd expect.
       *
       * Pair it with CSS the engine can't write for you:
       *   .track  { height: 300vh }
       *   .stage  { position: sticky; top: 0; height: 100vh }
       */
      pin: function (track, fn, opts) {
        opts = opts || {};
        if (fn && typeof fn === 'object') { opts = fn; fn = null; }
        opts.start = opts.start || 'top top';
        opts.end = opts.end || 'bottom bottom';
        return api.scene(track, fn, opts);
      },

      /* Force a re-measure — call after you add, remove, or resize content
         yourself. Cheap, and cheaper than a page whose scenes fire early. */
      refresh: function () { schedule(true); return api; },

      get reducedMotion() { return reduced; },

      destroy: function () {
        destroyed = true;
        window.removeEventListener('scroll', onScroll);
        window.removeEventListener('resize', onResize);
        window.removeEventListener('orientationchange', onResize);
        window.removeEventListener('load', onResize);
        scenes.length = 0;
      }
    };

    return api;
  }

  /* Handy easings. Progress is linear by default because linear is honest;
     reach for these when a beat should land softly rather than arrive. */
  ScrollWorld.ease = {
    inOut: function (p) { return p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2; },
    out: function (p) { return 1 - Math.pow(1 - p, 3); },
    in: function (p) { return p * p * p; }
  };

  /* Re-map a sub-range of a scene to a fresh 0→1. Chapters within a pinned
     section are much easier to write as several small ranges than as one
     long timeline full of magic numbers. */
  ScrollWorld.range = function (p, from, to) {
    return clamp01((p - from) / (to - from));
  };

  return ScrollWorld;
}));
