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
      // The HUD readouts. Each is filled from a server response, so a dropped
      // id means a number silently stops updating rather than erroring.
      'galaxy',
      'core-sub',
      'hud-nodes',
      'hud-links',
      'hud-groups',
      'hud-clock',
      'hud-origin',
      'hud-link',
      'sig-gmail',
      'sig-youtube',
      'sig-generators',
      // Metadata tier, and the in-flight indicator.
      'hud-orphans',
      'tech-sync',
      'tech-latency',
      'tech-uptime',
      'activity',
    ];
    const missing = ids.filter((id) => !page.includes(`id="${id}"`));
    expect(missing).toEqual([]);
  });

  it('keeps the tab hooks the script queries and toggles', () => {
    expect(app).toContain("querySelectorAll('.hx-tab')");
    // Two tabs, each naming the panel it reveals.
    expect(page).toContain('class="hx-tab active" data-panel="note-panel"');
    expect(page).toContain('class="hx-tab" data-panel="gen-panel"');
  });

  it('loads the shared stylesheet rather than inlining its own look', () => {
    expect(page).toContain('href="/helix.css"');
    expect(page).not.toContain('<style>');
  });

  it('loads its behaviour from files rather than an inline block', () => {
    expect(page).toContain('src="/galaxy.js"');
    expect(page).toContain('src="/app.js"');
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
    for (const rule of ['.hx-panel', '.hx-field', '.hx-btn', '.hx-label', '.hx-status', '.hx-tab']) {
      expect(css).toContain(rule);
    }
  });

  it('honours a request for reduced motion', () => {
    expect(css).toContain('prefers-reduced-motion: reduce');
  });

  it('styles the stage the main screen is built around', () => {
    for (const rule of ['.hx-stage', '.hx-reticle', '.hx-hud', '.hx-core', '.hx-signal']) {
      expect(css).toContain(rule);
    }
  });

  it('keeps the three HUD tiers visually distinct', () => {
    // Primary, secondary and metadata have to differ in weight or the
    // hierarchy is only in the markup.
    expect(css).toContain('.hx-readout__value--sm');
    expect(css).toContain('.hx-tech {');
    expect(css).toContain('.hx-readout__value--changed');
  });
});

describe('public/galaxy.js', () => {
  const galaxy = readFileSync(join(PUBLIC, 'galaxy.js'), 'utf8');

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

describe('public/app.js', () => {
  it('reads the HUD from the server rather than hard-coding numbers', () => {
    expect(app).toContain("fetch('/galaxy')");
    expect(app).toContain("fetch('/health')");
  });

  it('still posts notes and generations to the endpoints that existed before', () => {
    expect(app).toContain("fetch('/notes'");
    expect(app).toContain("fetch('/generate/' + mode");
  });

  it('flashes a readout only when its value actually changed', () => {
    // Re-running the animation on every poll would make a still vault look
    // busy, which is the opposite of what the flash is for.
    expect(app).toContain('if (node.textContent === text) return;');
  });

  it('counts requests in flight rather than toggling a flag', () => {
    // With a flag, the first of two overlapping requests to finish clears the
    // indicator while the second is still running.
    expect(app).toContain('inFlight = Math.max(0, inFlight + delta)');
  });

  it('does not report a drawing fault as an unreadable vault', () => {
    // setData is called inside the fetch promise chain, so without its own
    // catch a rendering bug surfaces to the user as "Vault unreadable".
    const guarded = app.slice(app.indexOf('view.setData'));
    expect(app.slice(0, app.indexOf('view.setData'))).toContain('try {');
    expect(guarded).toContain('} catch (err) {');
  });
});
