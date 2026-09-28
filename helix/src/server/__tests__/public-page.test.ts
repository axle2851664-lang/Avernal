import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

// The page in public/ has no build step and no component test, so a careless
// edit to its markup breaks the UI silently. These assertions pin the two
// things the browser-side script depends on: the element ids it looks up, and
// the class names it queries and toggles. They are deliberately about wiring
// only — nothing here constrains how the page looks.

const PUBLIC = join(import.meta.dirname, '..', '..', '..', 'public');
const page = readFileSync(join(PUBLIC, 'index.html'), 'utf8');
const app = readFileSync(join(PUBLIC, 'app.js'), 'utf8');

describe('public/index.html', () => {
  it('keeps every id the page script looks up', () => {
    const ids = [
      'note',
      'save',
      'note-status',
      'note-panel',
      'prompt',
      'mode',
      'steps',
      'seed',
      'go',
      'status',
      'result',
      'gen-panel',
      // The sheet the two panels live in.
      'sheet',
      'sheet-title',
      'sheet-close',
      // The stage, the one line of state on it, and the reply. Both are
      // written from script, so a dropped id means the screen silently stops
      // saying anything.
      'galaxy',
      'stage',
      'core-state',
      'reply',
      // One status dot, and the two ways in.
      'system',
      'mic',
      // The in-flight indicator.
      'activity',
      // Command console.
      'cmd',
      'cmd-input',
      'cmd-list',
      'cmd-out',
      'cmd-open',
    ];
    const missing = ids.filter((id) => !page.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('keeps the controls shut until something asks for them', () => {
    // The point of the sheet: the main screen is the sphere, and a form is
    // only on it when you went for one. A tab strip holding a panel open is
    // the easy thing to reintroduce, so both halves are pinned.
    expect(page).toContain('class="hx-sheet" id="sheet" hidden');
    expect(page).not.toContain('hx-tab');
    expect(app).toContain("var PANELS = { 'note-panel': 'Note', 'gen-panel': 'Generate'");
  });

  it('carries nothing on the wall that is not measured or a control', () => {
    // The readouts, clock, origin, latency, uptime and the five subsystem
    // dots all moved into ACTIVITY. Reintroducing one means reintroducing a
    // line of text nobody asked for.
    for (const gone of ['hud-nodes', 'hud-clock', 'tech-uptime', 'hx-frame', 'sig-gmail']) {
      expect(page).not.toContain(gone);
    }
  });

  it('keeps the screen to one focal point and two controls', () => {
    // The brief for this screen, pinned: a sphere, a wordmark, a line, a dot,
    // and exactly two ways in. Every button added here is a button on an
    // otherwise empty screen, so the count is the constraint.
    const stage = page.slice(
      page.indexOf('<div class="hx-stage"'),
      page.indexOf('<!-- The controls.')
    );
    expect([...stage.matchAll(/<button/g)]).toHaveLength(2);
    expect(stage).toContain('id="mic"');
    expect(stage).toContain('id="cmd-open"');
  });

  it('gives every element a distinct id', () => {
    // A duplicate id does not error anywhere: getElementById simply returns
    // the first one, and two unrelated features quietly write to the same
    // element. This caught exactly that — a HUD dot named "status" over the
    // generate panel's own status line.
    const ids = [...page.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1] ?? '');
    const seen = new Set<string>();
    const duplicated = ids.filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
    expect(duplicated).toEqual([]);
  });

  it('loads the shared stylesheet rather than inlining its own look', () => {
    expect(page).toContain('href="/helix.css"');
    expect(page).not.toContain('<style>');
  });

  it('loads its behaviour from files rather than an inline block', () => {
    expect(page).toContain('src="/galaxy.js"');
    expect(page).toContain('src="/app.js"');
    expect(page).toContain('src="/console.js"');
    expect(page).not.toContain('<script>');
  });

  it('asks for an icon that is actually present, so no request 404s', () => {
    expect(page).toContain('href="/favicon.svg"');
    expect(() => readFileSync(join(PUBLIC, 'favicon.svg'))).not.toThrow();
  });
});

describe('public/helix.css', () => {
  const css = readFileSync(join(PUBLIC, 'helix.css'), 'utf8');

  it('defines the primitives the rest of Helix is meant to reuse', () => {
    for (const rule of ['.hx-panel', '.hx-field', '.hx-btn', '.hx-label', '.hx-status', '.hx-sheet']) {
      expect(css).toContain(rule);
    }
  });

  it('honours a request for reduced motion', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('styles the stage the main screen is built around', () => {
    for (const rule of ['.hx-stage', '.hx-hud', '.hx-core', '.hx-signal']) {
      expect(css).toContain(rule);
    }
  });

  it('draws no ring around the sphere', () => {
    // The shell is the whole composition; a ring around it was furniture.
    // Pinned because it is easy to reintroduce one by habit.
    expect(css).not.toContain('.hx-reticle');
  });

  it('keeps the two remaining HUD tiers visually distinct', () => {
    // State and subsystem are all that is left on the screen, and they have to
    // differ in weight or the hierarchy is only in the markup.
    expect(css).toContain('.hx-core__state {');
    expect(css).toContain('.hx-signal {');
    expect(css).toContain('.hx-reply {');
  });

  it('carries no styles for furniture the screen no longer has', () => {
    for (const gone of ['.hx-readout', '.hx-tabs', '.hx-tech-strip', '.hx-frame']) {
      expect(css).not.toContain(gone);
    }
  });
});

describe('public/galaxy.js', () => {
  const galaxy = readFileSync(join(PUBLIC, 'galaxy.js'), 'utf8');

  it('draws no rings around the sphere', () => {
    // The aurora curtains and the scanning-plane ellipse both read as rings.
    // The sphere is the composition; anything drawn around it is furniture,
    // and both of these are easy to reintroduce by habit.
    for (const gone of ['aurora', 'AURORA', 'reticle']) {
      expect(galaxy).not.toContain(gone);
    }
  });

  it('keeps the sweep as an effect rather than an outline', () => {
    // Points still brighten as the band passes over them. What went is the
    // ellipse that drew where the band was.
    expect(galaxy).toContain('SCAN_BAND');
    expect(galaxy).not.toContain('one ellipse at the current latitude');
  });

  it('builds its one sprite once rather than every frame', () => {
    // Blitting a ready-made dot is a texture copy; rasterising a gradient per
    // point per frame is how a canvas visualisation starts to crawl.
    expect(galaxy).toContain('function makeGlowSprite()');
    const draw = galaxy.slice(galaxy.indexOf('function draw()'));
    expect(draw).not.toContain('makeGlowSprite(');
  });

  it('sizes the shell from the canvas, not from a ring that no longer exists', () => {
    expect(galaxy).toContain('function shellRadius()');
  });

  it('keeps a ceiling on everything it draws', () => {
    // The renderer's cost is bounded by these, not by how large a vault gets.
    for (const cap of ['MAX_NODES', 'MAX_LINKS', 'MAX_GLOW', 'MAX_PULSES']) {
      expect(galaxy).toContain('var ' + cap + ' =');
    }
  });

  it('stops animating when nothing can see it', () => {
    expect(galaxy).toContain('visibilitychange');
    expect(galaxy).toContain('IntersectionObserver');
  });

  it('pulls nothing out of thin air when the vault is empty', () => {
    // draw() returns before touching any buffer, so an empty galaxy paints
    // nothing rather than a decorative starfield.
    expect(galaxy).toContain('if (points.length === 0) return;');
  });
});

describe('public/console.js', () => {
  const cmd = readFileSync(join(PUBLIC, 'console.js'), 'utf8');
  const app = readFileSync(join(PUBLIC, 'app.js'), 'utf8');
  const page = readFileSync(join(PUBLIC, 'index.html'), 'utf8');

  it('only reaches endpoints the server actually serves', () => {
    // Every path the console can request, checked against the routes in
    // src/server/index.ts. A command for an endpoint that does not exist is
    // the exact kind of fake functionality this must not grow.
    const server = readFileSync(
      join(import.meta.dirname, '..', 'index.ts'),
      'utf8'
    );
    // Route patterns, with :params expanded to match a segment — the server
    // serves /auth/gmail/start from /auth/:service/start, and a literal
    // comparison would call that missing.
    const routes = [...server.matchAll(/app\.(?:get|post|patch|delete)\('([^']+)'/g)].map(
      (m) => new RegExp('^' + (m[1] ?? '').replace(/:[a-zA-Z]+/g, '[^/]+') + '$')
    );

    const paths = [...cmd.matchAll(/'(\/[a-z0-9/_-]+)'/g)].map((m) => m[1] ?? '');
    const unknown = paths.filter((path) => !routes.some((route) => route.test(path)));
    expect(unknown).toEqual([]);
  });

  it('drives the page through the published hooks, not its internals', () => {
    for (const hook of ['refresh', 'markNode', 'metrics', 'galaxy', 'request']) {
      expect(app).toContain(hook + ':');
    }
  });

  it('offers SETTINGS only because there is now a screen behind it', () => {
    // This test used to assert the opposite — there was no settings surface,
    // so a SETTINGS command would have been a command that went nowhere. The
    // rule has not changed, only the fact: the command exists now because the
    // panel does, and both halves are pinned here.
    expect(cmd).toContain("name: 'SETTINGS'");
    expect(cmd).toContain('api().openSettings()');
    expect(app).toContain('openSettings:');
    expect(page).toContain('id="keys-panel"');
  });

  it('separates the argument from every command that takes one', () => {
    // A command missing from this list still shows in the list, but typing it
    // with an argument falls through to the ASK fallback with the command
    // name still stuck to the front of the question. WEB was missing.
    expect(cmd).toContain(
      "var withArgument = [['SPEAK', 5], ['ASK', 3], ['HISTORY', 7], ['WEB', 3]];"
    );
  });

  it('reaches the web through the same words a spoken question would use', () => {
    // WEB prefixes the question rather than setting a flag, so typing it and
    // saying it go through one rule. A flag here would be a second way in
    // that the microphone could not take.
    expect(cmd).toContain("api().ask('Search the web: ' + arg)");
  });

  it('leaves typing in the page alone', () => {
    // "/" and Ctrl+K must not be stolen from a field someone is writing in.
    expect(cmd).toContain('typingInto');
    expect(cmd).toContain("tag === 'TEXTAREA'");
  });

  it('lets go of focus before hiding itself', () => {
    // A focused field inside a hidden dialog swallows every later keystroke.
    expect(cmd).toContain('input.blur();');
  });
});

describe('public/app.js', () => {
  it('reads the HUD from the server rather than hard-coding numbers', () => {
    expect(app).toContain("fetch('/galaxy')");
    expect(app).toContain("fetch('/health')");
  });

  it('still posts notes and generations to the endpoints that existed before', () => {
    expect(app).toContain("fetch('/notes'");
    expect(app).toContain("fetch('/generate/' + mode");
  });

  it('still measures what it stopped showing', () => {
    // The counts, round trip and uptime came off the screen, not out of the
    // page: ACTIVITY reports them, and it reads them from here.
    expect(app).toContain('lastLatency = Math.round(');
    expect(app).toContain('function uptime()');
    expect(app).toContain('uptime: uptime(),');
  });

  it('leaves Escape to the console while the console is open', () => {
    // Both bind Escape on the document. The sheet has to stand down, or it
    // closes out from under the dialog on top of it.
    expect(app).toContain("if (!el('cmd').hidden) return;");
  });

  it('counts requests in flight rather than toggling a flag', () => {
    // With a flag, the first of two overlapping requests to finish clears the
    // indicator while the second is still running.
    expect(app).toContain('inFlight = Math.max(0, inFlight + delta)');
  });

  it('says so on screen when it could not speak the answer', () => {
    // The answer is already displayed by the time speaking fails, so the note
    // has to be rewritten. Putting voiceError on a returned copy of the body
    // told nobody — nothing renders the body a second time.
    expect(app).toContain('showReply(body.answer, provenance(withError));');
  });

  it('does not report a drawing fault as an unreadable vault', () => {
    // setData is called inside the fetch promise chain, so without its own
    // catch a rendering bug surfaces to the user as "Vault unreadable".
    const guarded = app.slice(app.indexOf('view.setData'));
    expect(app.slice(0, app.indexOf('view.setData'))).toContain('try {');
    expect(guarded).toContain('} catch (err) {');
  });
});
