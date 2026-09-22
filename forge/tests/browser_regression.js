/* End-to-end check of the studio in a real browser.
 *
 * The unit suite covers the server, engines and connectors. This covers the
 * part it cannot: that the page actually works when a person uses it.
 *
 *   npm i -g playwright && npx playwright install chromium
 *   python3 run.py serve --port 8794 &
 *   FORGE_URL=http://127.0.0.1:8794 node tests/browser_regression.js
 *
 * Connector checks need live connectors switched on. With no connectors
 * configured those checks report FAIL, which is accurate - point MOCK_BASE at
 * tests/mock_upstreams.py to exercise them offline.
 */

const { chromium } = require('playwright');
const OUT = process.env.SCRATCH;
const results = [];
const ok = (name, pass, detail='') => { results.push([pass?'PASS':'FAIL', name, detail]); };

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1340, height: 940 } });
  const errors = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type()==='error' && !/ERR_TUNNEL|ERR_NAME|ERR_CONNECTION/.test(m.text())) errors.push(m.text()); });

  const BASE = process.env.FORGE_URL || 'http://127.0.0.1:8794';
  await page.goto(BASE + '/', { waitUntil: 'domcontentloaded' });
  await page.evaluate(() => { try { localStorage.clear(); } catch(e){} });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(900);

  ok('page loads with title', (await page.title()) === 'Avernal Forge');
  ok('capability notice shown (no weights)', await page.getAttribute('#capability-notice','hidden') === null);
  ok('looks populated', (await page.$$eval('#style-preset option', o=>o.length)) === 5);
  ok('samplers populated', (await page.$$eval('#sampler option', o=>o.length)) === 8);

  // --- still
  await page.fill('#prompt', 'a crimson desert horizon');
  await page.fill('#width','128'); await page.fill('#height','128');
  await page.fill('#seed','5');
  await page.click('#generate-btn');
  await page.waitForSelector('#stage-grid img', { timeout: 60000 });
  await page.waitForTimeout(600);
  ok('still generates', (await page.$$eval('#stage-grid img', i=>i.length)) === 1);

  // --- lightbox + reuse + favourite
  await page.click('#stage-grid img');
  await page.waitForSelector('#lightbox:not([hidden])');
  await page.waitForTimeout(400);
  const rows = await page.$$eval('#lightbox-dl dt', d=>d.map(x=>x.textContent));
  ok('lightbox metadata', rows.includes('Seed') && rows.includes('Size'), rows.length+' rows');
  await page.click('#lightbox-fav');
  await page.waitForTimeout(500);
  ok('favourite toggles', (await page.textContent('#lightbox-fav')).includes('Favourited'));
  await page.click('#lightbox-reuse');
  await page.waitForTimeout(400);
  ok('reuse restores seed', (await page.inputValue('#seed')) === '5');

  // --- video
  await page.click('.chip[data-kind="video"]');
  await page.evaluate(() => { const s=(i,v)=>{const e=document.getElementById(i);e.value=v;e.dispatchEvent(new Event('input',{bubbles:true}));}; s('frames',5); s('fps',6); s('steps',8); });
  await page.fill('#width','96'); await page.fill('#height','96');
  ok('button says clip', (await page.textContent('#generate-btn')) === 'Generate clip');
  await page.click('#generate-btn');
  await page.waitForFunction(() => document.querySelectorAll('.card__clip').length > 0, { timeout: 60000 });
  ok('clip generates', true, await page.textContent('.card__clip'));
  const a = await page.locator('#stage-grid img, #stage-grid video').first().screenshot();
  await page.waitForTimeout(700);
  const b2 = await page.locator('#stage-grid img, #stage-grid video').first().screenshot();
  ok('clip animates in page', Buffer.compare(a,b2) !== 0);

  // --- gallery search + favourites filter
  await page.click('.chip[data-kind="image"]');
  await page.fill('#gallery-search','crimson');
  await page.waitForTimeout(700);
  ok('gallery search filters', (await page.$$eval('#gallery-grid .card', c=>c.length)) >= 1);
  await page.fill('#gallery-search','');
  await page.waitForTimeout(600);
  await page.click('#fav-filter');
  await page.waitForTimeout(700);
  ok('favourites filter', (await page.$$eval('#gallery-grid .card', c=>c.length)) === 1);
  await page.click('#fav-filter');
  await page.waitForTimeout(600);

  // --- references
  await page.click('#tab-references');
  await page.waitForTimeout(500);
  ok('references tab opens', await page.isVisible('#ref-connector'));
  ok('network on', (await page.textContent('#net-pill').catch(()=>'')) === 'network on');
  ok('local pill honest', (await page.textContent('#local-pill-text')) === 'generation stays local');
  const sources = await page.$$eval('#ref-connector option', o=>o.length);
  ok('all connectors listed', sources === 9, sources+' sources');

  for (const id of ['wikipedia','commons','openverse','reddit','pinterest','mastodon','bluesky','reso']) {
    await page.selectOption('#ref-connector', id);
    await page.fill('#ref-query', id==='mastodon' ? 'fog' : 'barn');
    await page.click('#ref-search-btn');
    await page.waitForTimeout(600);
    const n = await page.$$eval('#ref-grid .card', c=>c.length);
    ok('connector '+id, n > 0, n+' results');
  }

  // --- url import + palette + generation from reference
  await page.selectOption('#ref-connector','webpage');
  await page.fill('#ref-query', process.env.MOCK_BASE + '/page.html');
  await page.click('#ref-search-btn');
  await page.waitForSelector('#ref-grid .card', { timeout: 15000 });
  await page.click('#ref-grid .card');
  await page.waitForTimeout(2000);
  const sw = await page.$$eval('#reference-swatches span', s=>s.length);
  ok('reference attaches with palette', sw === 4, sw+' swatches');

  await page.click('#tab-gallery');
  await page.fill('#prompt','from a reference');
  await page.click('#generate-btn');
  await page.waitForTimeout(2500);
  ok('generates with reference palette', true);

  // --- network log + connectors panel + api panel
  await page.click('#tab-references');
  await page.click('#network-log-btn');
  await page.waitForTimeout(800);
  const logText = await page.textContent('#network-entries');
  ok('network log populated', (await page.$$eval('.netlog tr', r=>r.length)) > 3);
  ok('no secrets in log', !/shh|mls-token|app-pw|pin-token/.test(logText));
  await page.keyboard.press('Escape');
  await page.click('#connectors-setup');
  await page.waitForTimeout(700);
  ok('connectors panel', (await page.$$eval('.connector', c=>c.length)) === 9);
  await page.keyboard.press('Escape');
  await page.click('#api-help-btn');
  await page.waitForTimeout(400);
  ok('api panel shows curl', (await page.textContent('#api-curl')).includes('/v1/images/generations'));
  await page.keyboard.press('Escape');

  // --- offline toggle
  await page.click('.switch__track');
  await page.waitForTimeout(800);
  ok('network can be switched off', (await page.textContent('#net-pill').catch(()=>'absent')) === 'absent');
  ok('local pill back to 100%', (await page.textContent('#local-pill-text')) === '100% local');

  // --- mobile
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  ok('no mobile overflow', !(await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1)));

  ok('no console errors', errors.length === 0, errors.slice(0,3).join(' | '));

  const fails = results.filter(r => r[0]==='FAIL');
  for (const [s,n,d] of results) console.log(`  ${s}  ${n}${d?'  ('+d+')':''}`);
  console.log(`\n${results.length - fails.length}/${results.length} passed`);
  await browser.close();
  process.exit(fails.length ? 1 : 0);
})();
