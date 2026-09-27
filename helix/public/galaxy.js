/*
 * The centrepiece: the vault's note graph, drawn as a slowly turning shell of
 * points.
 *
 * Everything drawn here is derived from real data returned by GET /galaxy. A
 * point is a note, an edge is a wikilink or a mention the graph builder found,
 * and a point's size and brightness come from how many edges actually reach
 * it. Nothing is added to make the picture look busier or more active than the
 * vault is: an empty vault draws nothing at all.
 *
 * Canvas rather than DOM: a few hundred points and their edges redrawn every
 * frame is a handful of draw calls, where the same thing in elements would be
 * hundreds of layers for the compositor to keep.
 *
 * The frame budget is the constraint that shapes the rest. Per frame this does
 * O(nodes + edges) arithmetic into buffers allocated once, one pre-rendered
 * sprite blit per glowing point, and no allocation at all. Everything that can
 * be computed when the data arrives — positions, degrees, sort order — is.
 */
(function () {
  'use strict';

  // Enough to read as a galaxy, few enough that a large vault cannot turn the
  // frame budget into a slideshow. Beyond this the extra notes are still
  // counted in the readouts, just not plotted.
  var MAX_NODES = 420;
  var MAX_LINKS = 900;

  // Glow is the one per-point cost that is not arithmetic, so it is rationed:
  // only the nearest, best-connected points get one.
  var MAX_GLOW = 48;

  // Pulses travel real edges. A couple of dozen reads as circulation; more
  // just fills the shell with moving dots.
  var MAX_PULSES = 24;

  // 24fps. The motion is a slow drift, so frames past this buy nothing but
  // battery — and on a laptop that matters more than smoothness nobody sees.
  var FRAME_MS = 1000 / 24;

  var TURN_PER_MS = (2 * Math.PI) / 90000; // one revolution every 90 seconds
  var SCAN_PER_MS = 1 / 9000; // one sweep of the shell every 9 seconds
  var PULSE_PER_MS = 1 / 2600; // one edge traversal every 2.6 seconds
  var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

  /*
   * Above this many edges, the ones facing away are not drawn.
   *
   * Edges are the entire cost of a frame — a full-width shell with a thousand
   * long hairlines measured 28fps with them and 61fps without — and the half
   * facing away draws between 3% and 8% alpha behind everything in front of
   * it. Dropping those brings it back to 58fps.
   *
   * It is conditional because the reason for it is: a small vault costs
   * nothing to draw in full, and there every connection is worth seeing.
   * Batching the strokes instead was measured at 6fps, and drawing them onto
   * a half-resolution layer at 30fps — both worse than this, and both tried
   * before settling here.
   */
  var EDGE_CULL_ABOVE = 300;
  var EDGE_BACK_CUTOFF = 0.5;

  // Half-thickness of the scanning plane, in shell units.
  var SCAN_BAND = 0.07;

  /** How far past the shell the light reaches, and how thick the band is. */
  var AURORA_OUTER = 1.24;
  var AURORA_SPRITE = 384;

  var AURORA_SPIN = (2 * Math.PI) / 64000;

  /**
   * The aurora: curtains of light around the shell, rendered once.
   *
   * Decoration, and held to the same rule as the corner brackets and the
   * sweep — it reports nothing.
   *
   * It lives in this canvas rather than in a CSS layer over it, which is where
   * it started. A translucent element above a canvas that repaints every frame
   * has to be re-composited every frame with it: in CSS it measured 25fps
   * against a 43fps baseline, and a completely static one still measured 31 —
   * the animation was never the cost, the extra layer was. In here it is drawn
   * only on the frames the shell is already being drawn on.
   */
  /**
   * Curtains, hand-placed. Radius and sweep are fractions of the sprite; the
   * rest is how thick, how bright, and how soft.
   */
  var AURORA_CURTAINS = [
    { radius: 0.88, from: 0.15, sweep: 0.95, width: 0.012, alpha: 0.14, blur: 44 },
    { radius: 0.94, from: 1.15, sweep: 0.45, width: 0.008, alpha: 0.12, blur: 52 },
    { radius: 0.86, from: 2.35, sweep: 1.10, width: 0.016, alpha: 0.10, blur: 48 },
    { radius: 0.92, from: 3.95, sweep: 0.60, width: 0.01, alpha: 0.15, blur: 40 },
    { radius: 0.89, from: 5.00, sweep: 0.80, width: 0.014, alpha: 0.11, blur: 50 },
  ];

  function makeAuroraSprite() {
    var size = AURORA_SPRITE;
    var sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    var g = sprite.getContext('2d');
    if (g === null) return null;

    var mid = size / 2;

    /*
     * Built once, so it can be built expensively.
     *
     * Each curtain is an arc stroked with a wide shadow, which is how you get
     * a genuinely soft edge on a canvas. Doing that per frame would be
     * unaffordable; doing it once and blitting the result costs nothing after.
     *
     * Arcs rather than a ring of varying brightness: a ring, however uneven,
     * reads as fog around the shell — which is what the first attempt at this
     * looked like — and fog does not move. Separate curtains at different
     * radii, with dark between them, read as light.
     */
    g.lineCap = 'round';
    g.shadowColor = 'rgba(255,255,255,1)';

    for (var i = 0; i < AURORA_CURTAINS.length; i += 1) {
      var curtain = AURORA_CURTAINS[i];
      g.strokeStyle = 'rgba(255,255,255,' + curtain.alpha + ')';
      g.lineWidth = curtain.width * size;
      g.shadowBlur = curtain.blur;
      g.beginPath();
      g.arc(mid, mid, curtain.radius * mid, curtain.from, curtain.from + curtain.sweep);
      g.stroke();
    }

    /*
     * Then cut away anything that reaches the sphere or the sprite's own
     * edge. The shadow spreads past both, and a square edge showing through
     * is exactly the artefact that gives a blitted sprite away.
     */
    var ring = g.createRadialGradient(mid, mid, 0, mid, mid, mid);
    ring.addColorStop(0.0, 'rgba(0,0,0,0)');
    // Nothing survives inside 0.78 of the sprite. The clip below starts at
    // 0.773 of it, so the clip never cuts a lit pixel — when it did, it left
    // a hard arc across the curtains, which is the one thing that makes this
    // look like a sprite instead of light.
    ring.addColorStop(0.78, 'rgba(0,0,0,0)');
    ring.addColorStop(0.85, 'rgba(0,0,0,1)');
    ring.addColorStop(0.95, 'rgba(0,0,0,1)');
    ring.addColorStop(1.0, 'rgba(0,0,0,0)');
    g.shadowBlur = 0;
    g.globalCompositeOperation = 'destination-in';
    g.fillStyle = ring;
    g.fillRect(0, 0, size, size);

    return sprite;
  }

  /**
   * A soft white dot, rendered once into an offscreen canvas.
   *
   * Drawing a radial gradient per point per frame is the classic way to make
   * a canvas visualisation crawl: the gradient has to be rasterised every
   * time. Blitting one ready-made sprite is a texture copy instead, so the
   * cost stops scaling with how much glow is on screen.
   */
  function makeGlowSprite() {
    var size = 64;
    var sprite = document.createElement('canvas');
    sprite.width = size;
    sprite.height = size;
    var g = sprite.getContext('2d');
    if (g === null) return null;

    var gradient = g.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
    gradient.addColorStop(0, 'rgba(255,255,255,0.55)');
    gradient.addColorStop(0.35, 'rgba(255,255,255,0.14)');
    gradient.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gradient;
    g.fillRect(0, 0, size, size);
    return sprite;
  }

  /**
   * Place nodes on a sphere.
   *
   * A Fibonacci lattice spreads points evenly, which keeps density honest: a
   * dense patch on screen means notes that are actually related, not an
   * artefact of the layout.
   *
   * The golden angle has to be used exactly for that to hold. Scaling it —
   * to pull each folder toward a longitude of its own, say — turns the even
   * lattice into a handful of visible spiral arms, which is a picture of the
   * arithmetic rather than of the vault. Folders are grouped by the order
   * points are placed in instead: notes are laid down folder by folder, so
   * each one takes a contiguous band of the shell while the spacing stays
   * even.
   */
  function layout(nodes) {
    var count = nodes.length;
    var placed = new Array(count);

    // Rank within a stable sort by folder, then by the order the server sent.
    var ranked = [];
    for (var r = 0; r < count; r += 1) ranked.push(r);
    ranked.sort(function (a, b) {
      var ga = nodes[a].group;
      var gb = nodes[b].group;
      if (ga < gb) return -1;
      if (ga > gb) return 1;
      return a - b;
    });

    for (var slot = 0; slot < count; slot += 1) {
      var i = ranked[slot];
      // y walks from +1 to -1 so the lattice covers the whole sphere.
      var y = count === 1 ? 0 : 1 - (slot / (count - 1)) * 2;
      var radius = Math.sqrt(Math.max(0, 1 - y * y));
      var theta = GOLDEN_ANGLE * slot;

      placed[i] = {
        x: Math.cos(theta) * radius,
        y: y,
        z: Math.sin(theta) * radius,
        label: nodes[i].label,
        group: nodes[i].group,
        degree: 0,
      };
    }
    return placed;
  }

  function mount(canvas) {
    var ctx = canvas.getContext('2d');
    if (ctx === null) return null; // No 2D context: the HUD still works.

    var reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    // Hover and parallax are for a mouse. On a touch screen there is no
    // pointer to follow, and listening for moves there would only compete with
    // the scroll the finger is actually performing.
    var fine = window.matchMedia('(pointer: fine)').matches;

    var glow = makeGlowSprite();
    var aurora = makeAuroraSprite();

    var points = [];
    var edges = [];
    // Projection output, allocated when the data arrives and reused every
    // frame: sx, sy, depth-weight, radius.
    var px = null;
    var py = null;
    var pnear = null;
    var pulses = [];

    var angle = 0;
    var clock = 0;
    var scan = 0;
    // How hard the shell is working, 0 to 1, and the value easing toward it.
    // Set from outside when Helix is listening or thinking; eased rather than
    // switched so the change reads as the sphere leaning in, not as a jump.
    var activity = 0;
    var activityTarget = 0;
    var tilt = 0;
    var tiltTarget = 0;
    var width = 0;
    var height = 0;
    var last = 0;
    var frame = 0;
    var shell = 0;
    var unit = 1;
    var visible = true;
    var pointerX = -1;
    var pointerY = -1;
    var hover = -1;
    // A node the command console asked to point out. Independent of hover, so
    // moving the mouse does not lose it.
    var marked = -1;

    /**
     * How far from the centre the outermost point may fall.
     *
     * Width and height are weighted separately rather than taking the smaller
     * of the two: the stage is wide and short on a desktop and tall and narrow
     * on a phone, and one factor cannot serve both. The width factor is the
     * one that keeps the shell clear of the corner readouts.
     */
    function shellRadius() {
      return Math.min(width * 0.36, height * 0.46);
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
      // Dot and glow sizes are quoted against a desktop shell. On a phone the
      // shell is a third of that, and fixed pixel sizes there make a
      // well-linked vault a solid white blob: the points overlap and the glow
      // sprites stack. Everything drawn per point scales with the shell.
      unit = Math.max(0.42, Math.min(1.15, shell / 240));
    }

    /* ------------------------------------------------------- projection */

    // Rotation about Y (the turn) then about X (the pointer tilt). Written out
    // rather than composed through a matrix helper because it runs for every
    // point and every edge endpoint on every frame.
    var sinY = 0;
    var cosY = 1;
    var sinX = 0;
    var cosX = 1;
    var cx = 0;
    var cy = 0;

    var outX = 0;
    var outY = 0;
    var outNear = 0;

    function project(x, y, z) {
      var rx = x * cosY - z * sinY;
      var rz = x * sinY + z * cosY;
      var ry = y * cosX - rz * sinX;
      var rzz = y * sinX + rz * cosX;
      // Mild perspective: enough for front and back to separate, not enough to
      // throw the silhouette out of round. The 2.2 cancels against the divisor
      // for a point on the equator, so `shell` is the true outer radius.
      var depth = 2.2 / (2.2 - rzz);
      outX = cx + rx * shell * depth;
      outY = cy + ry * shell * depth;
      outNear = (rzz + 1) / 2; // 0 at the back, 1 at the front
    }

    function draw() {
      ctx.clearRect(0, 0, width, height);
      if (points.length === 0) return;

      cx = width / 2;
      cy = height / 2;
      sinY = Math.sin(angle);
      cosY = Math.cos(angle);
      sinX = Math.sin(tilt);
      cosX = Math.cos(tilt);

      // Where the scanning plane currently sits, in shell units. It travels a
      // little past each pole so the sweep has a clean start and finish.
      var scanY = 1.14 - (scan % 1) * 2.28;

      /* Points, projected once into the reused buffers. */
      for (var i = 0; i < points.length; i += 1) {
        var p = points[i];
        project(p.x, p.y, p.z);
        px[i] = outX;
        py[i] = outY;
        pnear[i] = outNear;
      }

      /* The aurora, behind everything: it is the light the shell sits in. */
      if (aurora !== null) {
        var reach = shell * AURORA_OUTER;
        ctx.save();
        // Clip to the annulus the light actually occupies. Without it the
        // blit touches the hollow centre and the corners too — about half the
        // rectangle is fully transparent, and paying to composite it is the
        // difference between this being affordable and not.
        ctx.beginPath();
        ctx.arc(cx, cy, reach, 0, Math.PI * 2);
        ctx.arc(cx, cy, shell * 1.02, 0, Math.PI * 2, true);
        ctx.clip();
        // The sprite is nothing but soft gradients, so the expensive filter
        // buys nothing on the way up and costs a third of the frame.
        ctx.imageSmoothingQuality = 'low';
        ctx.translate(cx, cy);

        // The same curtains twice, turning opposite ways at different rates.
        // One pass only spins; two drift in and out of phase, and that
        // interference is what waves. A third was not worth the frame.
        for (var v = 0; v < 1; v += 1) {
          var back = v === 1;
          ctx.save();
          ctx.globalAlpha =
            (back ? 0.5 : 0.85) *
            (0.55 + 0.45 * Math.sin((clock / (back ? 23000 : 17000)) * Math.PI * 2 + v * 2.1));
          ctx.rotate(clock * AURORA_SPIN * (back ? -0.62 : 1) + v * 2.4);
          ctx.drawImage(aurora, -reach, -reach, reach * 2, reach * 2);
          ctx.restore();
        }

        ctx.restore();
        ctx.globalAlpha = 1;
      }

      /* Edges, drawn before the points so a point sits on top of its own
         connections.
         
         A stroke each, rather than batched into a few large paths by depth
         band. Batching looks like the obvious optimisation and measures as the
         opposite: a path spanning the whole shell makes every stroke rasterise
         an area the size of the canvas, where a short segment touches only its
         own bounding box. On a 400-note vault at 1440x900 and a 2x pixel
         ratio, batching into three paths cost 9fps against 59fps for this. */
      ctx.lineWidth = 1;
      // -1 keeps every edge: no value of `lit` falls below it.
      var cutoff = edges.length / 2 > EDGE_CULL_ABOVE ? EDGE_BACK_CUTOFF : -1;
      for (var e = 0; e < edges.length; e += 2) {
        var a = edges[e];
        var b = edges[e + 1];
        var lit = (pnear[a] + pnear[b]) / 2;
        if (lit < cutoff) continue;
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.03 + lit * 0.1).toFixed(3) + ')';
        ctx.beginPath();
        ctx.moveTo(px[a], py[a]);
        ctx.lineTo(px[b], py[b]);
        ctx.stroke();
      }

      /* Glow, rationed to the nearest well-connected points. `order` is sorted
         by degree once, when the data arrives, so this walk stops early. */
      if (glow !== null) {
        var lit2 = 0;
        for (var o = 0; o < points.length && lit2 < MAX_GLOW; o += 1) {
          var id = order[o];
          var near = pnear[id];
          if (near < 0.55) continue;
          var size = (6 + points[id].degree * 2.5) * near * unit;
          ctx.globalAlpha = (near - 0.55) / 0.45;
          ctx.drawImage(glow, px[id] - size, py[id] - size, size * 2, size * 2);
          lit2 += 1;
        }
        ctx.globalAlpha = 1;
      }

      /* Points. Size and brightness carry the node's degree, so what stands
         out on screen is what is actually well connected in the vault. */
      for (var n = 0; n < points.length; n += 1) {
        var near2 = pnear[n];
        var pt = points[n];
        // Inside the scanning plane a point brightens briefly. The plane is a
        // readout of position on the shell, not of anything in the data.
        var swept = reduced ? 0 : Math.max(0, 1 - Math.abs(pt.y - scanY) / SCAN_BAND);
        var radius = (0.7 + near2 * 1.3 + Math.min(pt.degree, 6) * 0.22 + swept * 0.9) * unit;
        var alpha = Math.min(1, 0.18 + near2 * 0.62 + Math.min(pt.degree, 6) * 0.03 + swept * 0.45);
        ctx.fillStyle = 'rgba(255,255,255,' + alpha.toFixed(3) + ')';
        ctx.beginPath();
        ctx.arc(px[n], py[n], radius, 0, Math.PI * 2);
        ctx.fill();
      }

      /* The scanning plane itself: one ellipse at the current latitude. */
      if (!reduced) {
        var r = Math.sqrt(Math.max(0, 1 - scanY * scanY));
        if (r > 0.01) {
          ctx.beginPath();
          var first = true;
          for (var s = 0; s <= 40; s += 1) {
            var t = (s / 40) * Math.PI * 2;
            project(Math.cos(t) * r, scanY, Math.sin(t) * r);
            if (first) { ctx.moveTo(outX, outY); first = false; }
            else ctx.lineTo(outX, outY);
          }
          // Fades out at the poles, where the ring collapses to a dot.
          ctx.strokeStyle = 'rgba(255,255,255,' + (0.16 * r).toFixed(3) + ')';
          ctx.lineWidth = 1;
          ctx.stroke();
        }
      }

      /* Pulses: a bright mote travelling one real edge. They carry no count
         and no hidden meaning — they show which connections exist by walking
         them. */
      if (!reduced) {
        for (var q = 0; q < pulses.length; q += 1) {
          var pulse = pulses[q];
          var from = points[pulse.a];
          var to = points[pulse.b];
          if (from === undefined || to === undefined) continue;
          // A pulse starts at a negative t so the set does not march in step.
          // Until it reaches its edge there is nothing to draw, and drawing it
          // anyway would extrapolate past the endpoint and ask for a negative
          // radius.
          if (pulse.t < 0) continue;
          var k = pulse.t;
          project(
            from.x + (to.x - from.x) * k,
            from.y + (to.y - from.y) * k,
            from.z + (to.z - from.z) * k
          );
          // Brightest mid-flight, so a pulse fades in and out rather than
          // popping at the endpoints.
          var life = Math.sin(k * Math.PI);
          ctx.fillStyle = 'rgba(255,255,255,' + (0.5 * life * outNear).toFixed(3) + ')';
          ctx.beginPath();
          ctx.arc(outX, outY, 1.2 * life, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      /* A marked node keeps its ring and label until something clears it, so
         a search result stays findable while the shell turns. */
      if (marked >= 0 && marked < points.length) {
        ctx.beginPath();
        ctx.arc(px[marked], py[marked], 10, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,' + (0.35 + pnear[marked] * 0.5).toFixed(3) + ')';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Crosshair ticks, so it reads as a target rather than another node.
        ctx.beginPath();
        ctx.moveTo(px[marked] - 16, py[marked]);
        ctx.lineTo(px[marked] - 12, py[marked]);
        ctx.moveTo(px[marked] + 12, py[marked]);
        ctx.lineTo(px[marked] + 16, py[marked]);
        ctx.stroke();

        if (marked !== hover) {
          ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
          ctx.fillStyle = 'rgba(255,255,255,0.8)';
          var mt = points[marked].label;
          var mw = ctx.measureText(mt).width;
          var mx = px[marked] + 20;
          if (mx + mw > width - 4) mx = px[marked] - 20 - mw;
          ctx.fillText(mt, mx, py[marked] + 4);
        }
      }

      /* Hover: name the note under the pointer. The label is the real one from
         the vault, which is why this is worth the hit test. */
      hover = -1;
      if (fine && pointerX >= 0) {
        var best = 14 * 14;
        for (var h = 0; h < points.length; h += 1) {
          if (pnear[h] < 0.4) continue; // Do not pick notes on the far side.
          var dx = px[h] - pointerX;
          var dy = py[h] - pointerY;
          var d2 = dx * dx + dy * dy;
          if (d2 < best) { best = d2; hover = h; }
        }
      }

      if (hover >= 0) {
        var hp = points[hover];
        ctx.beginPath();
        ctx.arc(px[hover], py[hover], 7, 0, Math.PI * 2);
        ctx.strokeStyle = 'rgba(255,255,255,0.55)';
        ctx.lineWidth = 1;
        ctx.stroke();

        var text = hp.label + '  ·  ' + hp.degree + (hp.degree === 1 ? ' link' : ' links');
        ctx.font = '11px ui-monospace, "SF Mono", Menlo, Consolas, monospace';
        ctx.fillStyle = 'rgba(255,255,255,0.86)';
        // Flip the label to the other side near the right edge so it never
        // runs off the canvas.
        var textWidth = ctx.measureText(text).width;
        var lx = px[hover] + 12;
        if (lx + textWidth > width - 4) lx = px[hover] - 12 - textWidth;
        ctx.fillText(text, lx, py[hover] + 4);
      }

      canvas.style.cursor = hover >= 0 ? 'crosshair' : '';
    }

    /* ------------------------------------------------------------ the loop */

    var order = [];

    function advance(dt) {
      activity += (activityTarget - activity) * 0.05;

      // At full activity the shell turns half again as fast and the pulses
      // run at double. Both are multiplications already in the loop, so this
      // costs nothing measurable — it is the same frame, slightly quicker.
      angle += dt * TURN_PER_MS * (1 + activity * 0.5);
      clock += dt;
      scan += dt * SCAN_PER_MS * (1 + activity);
      // Ease toward the pointer rather than snapping to it.
      tilt += (tiltTarget - tilt) * 0.08;

      for (var i = 0; i < pulses.length; i += 1) {
        pulses[i].t += dt * PULSE_PER_MS * (1 + activity);
        if (pulses[i].t >= 1) reseat(pulses[i]);
      }
    }

    /** Send a pulse down a different edge, chosen at random from the real set. */
    function reseat(pulse) {
      if (edges.length === 0) return;
      var e = (Math.random() * (edges.length / 2)) | 0;
      pulse.a = edges[e * 2];
      pulse.b = edges[e * 2 + 1];
      pulse.t = -Math.random() * 0.4; // Stagger, so they do not march in step.
    }

    function tick(now) {
      frame = window.requestAnimationFrame(tick);
      var dt = now - last;
      if (dt < FRAME_MS) return;
      last = now;
      // A tab that was hidden or a thread that stalled can hand back a huge
      // delta; clamping stops the shell from jumping a quarter turn.
      advance(Math.min(dt, 250));
      draw();
    }

    function start() {
      if (reduced || frame !== 0 || !visible || points.length === 0) return;
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

    // Nor should a stage that has been scrolled past. On a phone the console
    // fills the screen once you start typing, and the galaxy is then drawing
    // frames nobody can see.
    if (typeof window.IntersectionObserver === 'function') {
      new window.IntersectionObserver(function (entries) {
        visible = entries[entries.length - 1].isIntersecting;
        if (visible) start();
        else stop();
      }, { threshold: 0 }).observe(canvas);
    }

    if (fine) {
      canvas.addEventListener('pointermove', function (event) {
        var rect = canvas.getBoundingClientRect();
        pointerX = event.clientX - rect.left;
        pointerY = event.clientY - rect.top;
        // A shallow tilt toward the pointer. Capped low: this is parallax to
        // suggest depth, not a camera to fly.
        tiltTarget = ((pointerY / Math.max(rect.height, 1)) - 0.5) * 0.5;
        // Under reduced motion nothing is looping, so the hover has to be
        // drawn on the event itself.
        if (reduced) draw();
      });

      canvas.addEventListener('pointerleave', function () {
        pointerX = -1;
        pointerY = -1;
        tiltTarget = 0;
        if (reduced) draw();
      });
    }

    return {
      /**
       * Point out one node until told otherwise. Pass -1 to clear.
       *
       * Draws immediately as well as marking, so it works under reduced
       * motion where there is no loop to pick the change up.
       */
      mark: function (id) {
        marked = typeof id === 'number' && id >= 0 && id < points.length ? id : -1;
        draw();
        return marked;
      },

      /**
       * How hard the shell should look like it is working, 0 to 1.
       *
       * Eased in the loop, so calling this is only a target change. Under
       * reduced motion there is no loop to ease it, and the shell is
       * deliberately left alone rather than redrawn at a new speed.
       */
      setActivity: function (level) {
        activityTarget = Math.max(0, Math.min(1, Number(level) || 0));
        return activityTarget;
      },

      /** Replace what is drawn. Safe to call repeatedly. */
      setData: function (galaxy) {
        var nodes = galaxy.nodes.slice(0, MAX_NODES);
        points = layout(nodes);

        var plotted = nodes.length;
        // Edge endpoints are held flat, two entries per edge, so the draw loop
        // walks one array instead of dereferencing an object per edge.
        edges = [];
        for (var i = 0; i < galaxy.links.length && edges.length < MAX_LINKS * 2; i += 1) {
          var link = galaxy.links[i];
          // Links into the unplotted tail would draw to nowhere.
          if (link.source >= plotted || link.target >= plotted) continue;
          edges.push(link.source, link.target);
          points[link.source].degree += 1;
          points[link.target].degree += 1;
        }

        px = new Float32Array(plotted);
        py = new Float32Array(plotted);
        pnear = new Float32Array(plotted);

        // Best connected first, so the glow pass can stop once its budget is
        // spent and still have lit the points that matter.
        order = [];
        for (var o = 0; o < plotted; o += 1) order.push(o);
        order.sort(function (a, b) { return points[b].degree - points[a].degree; });

        marked = -1;
        pulses = [];
        var wanted = Math.min(MAX_PULSES, Math.floor(edges.length / 2));
        for (var q = 0; q < wanted; q += 1) {
          var pulse = { a: 0, b: 0, t: 0 };
          reseat(pulse);
          pulses.push(pulse);
        }

        draw();
        if (points.length > 0) start();
        else stop();
      },
    };
  }

  window.HelixGalaxy = { mount: mount };
})();
