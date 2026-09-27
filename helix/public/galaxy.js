/*
 * The centrepiece: the vault's note graph, drawn as a slowly turning shell of
 * points.
 *
 * Everything here is derived from real data returned by GET /galaxy. A node is
 * a note, an edge is a wikilink or a mention the graph builder found. Nothing
 * is added to make the picture look busier — an empty vault draws nothing, and
 * the readouts say so.
 *
 * Canvas rather than DOM: a few hundred points and their edges redrawn every
 * frame is a handful of draw calls, where the same thing in elements would be
 * a few hundred layers for the compositor to keep.
 */
(function () {
  'use strict';

  // Enough to read as a galaxy, few enough that a large vault cannot turn the
  // frame budget into a slideshow. Beyond this the newest notes are still
  // counted in the readouts, just not plotted.
  var MAX_NODES = 420;
  var MAX_LINKS = 900;

  // 24fps. The motion is a slow drift, so frames past this buy nothing but
  // battery — and on a laptop that matters more than smoothness nobody sees.
  var FRAME_MS = 1000 / 24;

  var TURN_PER_MS = (2 * Math.PI) / 90000; // one revolution every 90 seconds
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  /**
   * Place nodes on a sphere.
   *
   * A Fibonacci lattice spreads points evenly, which keeps density honest: a
   * dense patch on screen means notes that are actually related, not an
   * artefact of the layout. Group membership then nudges each point toward its
   * cluster's own longitude, so folders read as regions.
   */
  function layout(nodes, groups) {
    var count = nodes.length;
    var placed = [];
    var sectorOf = {};
    for (var g = 0; g < groups.length; g += 1) {
      sectorOf[groups[g]] = (g / Math.max(groups.length, 1)) * 2 * Math.PI;
    }

    for (var i = 0; i < count; i += 1) {
      // y walks from +1 to -1 so the lattice covers the whole sphere.
      var y = count === 1 ? 0 : 1 - (i / (count - 1)) * 2;
      var radius = Math.sqrt(Math.max(0, 1 - y * y));
      var spiral = GOLDEN_ANGLE * i;
      var sector = sectorOf[nodes[i].group];
      // Two-thirds spiral, one-third cluster: the lattice keeps them apart,
      // the sector pulls folders together.
      var theta = sector === undefined ? spiral : spiral * 0.66 + sector;

      placed.push({
        x: Math.cos(theta) * radius,
        y: y,
        z: Math.sin(theta) * radius,
        label: nodes[i].label,
      });
    }
    return placed;
  }

  function mount(canvas, ring) {
    var ctx = canvas.getContext('2d');
    if (ctx === null) return null; // No 2D context: the HUD still works.

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var points = [];
    var edges = [];
    var angle = 0;
    var width = 0;
    var height = 0;
    var last = 0;
    var frame = 0;
    var shell = 0;

    /**
     * How far from the centre the outermost point may fall.
     *
     * Taken from the rendered size of the CSS reticle rather than from the
     * canvas, so the ring stays the single source of truth for the
     * composition: change its size in the stylesheet at any breakpoint and the
     * point cloud follows instead of having to be re-tuned to match.
     */
    function shellRadius() {
      if (ring !== null && ring !== undefined) {
        var box = ring.getBoundingClientRect();
        if (box.width > 0) return (box.width / 2) * 0.92;
      }
      // No reticle in the DOM: fall back to the canvas, weighting width and
      // height separately so a tall narrow stage still yields a shell that
      // fits across.
      return Math.min(width * 0.26, height * 0.34);
    }

    function resize() {
      var rect = canvas.getBoundingClientRect();
      // Capping the ratio keeps a 3x phone from rendering nine times the
      // pixels for a difference nobody can see on a field of 2px dots.
      var dpr = Math.min(window.devicePixelRatio || 1, 2);
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(width * dpr));
      canvas.height = Math.max(1, Math.round(height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      shell = shellRadius();
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      if (points.length === 0) return;

      var cx = width / 2;
      var cy = height / 2;
      var scale = shell;
      var sin = Math.sin(angle);
      var cos = Math.cos(angle);

      var screen = [];
      for (var i = 0; i < points.length; i += 1) {
        var p = points[i];
        var x = p.x * cos - p.z * sin;
        var z = p.x * sin + p.z * cos;
        // Mild perspective: enough for front and back to separate, not enough
        // to throw the silhouette out of round.
        var depth = 1 / (2.2 - z);
        screen.push({
          // The 2.2 cancels against the depth divisor for a point on the
          // equator, so `shell` really is the radius of the widest point.
          x: cx + x * scale * depth * 2.2,
          y: cy + p.y * scale * depth * 2.2,
          // 0 at the back, 1 at the front.
          near: (z + 1) / 2,
        });
      }

      // Edges first, so points sit on top of their own connections.
      ctx.lineWidth = 1;
      for (var e = 0; e < edges.length; e += 1) {
        var a = screen[edges[e].source];
        var b = screen[edges[e].target];
        if (a === undefined || b === undefined) continue;
        var lit = (a.near + b.near) / 2;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.03 + lit * 0.10).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(a.x, a.y);
        ctx.lineTo(b.x, b.y);
        ctx.stroke();
      }

      for (var n = 0; n < screen.length; n += 1) {
        var s = screen[n];
        var r = 0.7 + s.near * 1.5;
        ctx.fillStyle = 'rgba(255,255,255,' + (0.20 + s.near * 0.70).toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(s.x, s.y, r, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    function tick(now) {
      frame = window.requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      angle += (now - last) * TURN_PER_MS;
      last = now;
      draw();
    }

    function start() {
      if (reduced || frame !== 0) return;
      last = window.performance.now();
      frame = window.requestAnimationFrame(tick);
    }

    function stop() {
      if (frame !== 0) window.cancelAnimationFrame(frame);
      frame = 0;
    }

    resize();
    window.addEventListener('resize', function () {
      resize();
      draw();
    });

    // A background tab should not be animating. Chrome throttles rAF anyway,
    // but stopping outright is the difference between slow and nothing.
    document.addEventListener('visibilitychange', function () {
      if (document.hidden) stop();
      else start();
    });

    return {
      /** Replace what is drawn. Safe to call repeatedly. */
      setData: function (galaxy) {
        var nodes = galaxy.nodes.slice(0, MAX_NODES);
        points = layout(nodes, galaxy.groups || []);

        var plotted = nodes.length;
        edges = [];
        for (var i = 0; i < galaxy.links.length && edges.length < MAX_LINKS; i += 1) {
          var link = galaxy.links[i];
          // Links into the unplotted tail would draw to nowhere.
          if (link.source < plotted && link.target < plotted) edges.push(link);
        }

        draw();
        if (points.length > 0) start();
        else stop();
      },
    };
  }

  window.HelixGalaxy = { mount: mount };
})();
