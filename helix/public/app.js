/*
 * Main screen wiring.
 *
 * Two jobs: keep the HUD showing what the server actually reports, and run the
 * note and generate controls. The controls behave exactly as they did before
 * the screen was rebuilt — same endpoints, same payloads, same messages.
 */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  /* ------------------------------------------------------------ the galaxy */

  var view = window.HelixGalaxy
    ? window.HelixGalaxy.mount(el('galaxy'), document.querySelector('.hx-reticle'))
    : null;

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function setLink(text, fault) {
    var link = el('hud-link');
    link.textContent = text;
    link.style.color = fault ? 'var(--hx-alert)' : '';
  }

  function loadGalaxy() {
    return fetch('/galaxy')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (galaxy) {
        el('hud-nodes').textContent = String(galaxy.nodes.length);
        el('hud-links').textContent = String(galaxy.links.length);
        el('hud-groups').textContent = String(galaxy.groups.length);
        el('core-sub').textContent =
          galaxy.nodes.length === 0
            ? 'Vault empty'
            : plural(galaxy.nodes.length, 'note') + ' · ' + plural(galaxy.links.length, 'link');
        setLink('Online', false);
        if (view !== null) view.setData(galaxy);
      })
      .catch(function (err) {
        // The readouts stay as dashes rather than showing a number that is not
        // true. Saying the link is down is the honest reading.
        el('core-sub').textContent = 'Vault unreadable';
        setLink('Offline', true);
        console.warn('Could not read the galaxy:', err.message);
      });
  }

  /* --------------------------------------------------------- subsystem HUD */

  function loadHealth() {
    return fetch('/health')
      .then(function (res) { return res.json(); })
      .then(function (health) {
        var services = health.services || {};
        var states = {
          'sig-gmail': services.gmail === 'authenticated',
          'sig-youtube': services.youtube === 'authenticated',
          'sig-generators': services.generators === 'available',
        };
        for (var id in states) {
          if (Object.prototype.hasOwnProperty.call(states, id)) {
            el(id).dataset.state = states[id] ? 'on' : 'off';
          }
        }
      })
      .catch(function () {
        // Unknown is its own state: an unreachable server is not the same as a
        // subsystem reporting that it is disconnected.
        var ids = ['sig-gmail', 'sig-youtube', 'sig-generators'];
        for (var i = 0; i < ids.length; i += 1) el(ids[i]).dataset.state = 'fault';
      });
  }

  /* ------------------------------------------------------------- the clock */

  function tickClock() {
    var now = new Date();
    var pad = function (n) { return String(n).padStart(2, '0'); };
    el('hud-clock').textContent = pad(now.getHours()) + ':' + pad(now.getMinutes()) + ':' + pad(now.getSeconds());
  }

  el('hud-origin').textContent = window.location.host || 'file';
  tickClock();
  window.setInterval(tickClock, 1000);

  loadGalaxy();
  loadHealth();

  /* ----------------------------------------------------------------- tabs */

  document.querySelectorAll('.hx-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      document.querySelectorAll('.hx-tab').forEach(function (t) {
        t.classList.toggle('active', t === tab);
      });
      ['note-panel', 'gen-panel'].forEach(function (id) {
        el(id).hidden = id !== tab.dataset.panel;
      });
    });
  });

  /* ----------------------------------------------------------------- notes */

  el('save').addEventListener('click', async function () {
    var text = el('note').value.trim();
    var out = el('note-status');
    var show = function (msg, bad) {
      out.textContent = msg;
      out.classList.toggle('error', Boolean(bad));
    };

    if (!text) { show('Write something first.', true); return; }

    el('save').disabled = true;
    show('Saving...');
    try {
      const res = await fetch('/notes', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text }),
      });
      const data = await res.json();
      if (!res.ok) { show(data.details || data.error || 'Could not save.', true); return; }
      show('Saved as "' + data.title + '".');
      el('note').value = '';
      // The vault just gained a note, so the centrepiece is now out of date.
      loadGalaxy();
    } catch (err) {
      show('Could not reach the server: ' + err.message, true);
    } finally {
      el('save').disabled = false;
    }
  });

  /* ------------------------------------------------------------ generation */

  var status = el('status');
  var result = el('result');

  function setStatus(text, isError) {
    status.textContent = text;
    status.classList.toggle('error', Boolean(isError));
  }

  el('go').addEventListener('click', async function () {
    const prompt = el('prompt').value.trim();
    if (!prompt) {
      setStatus('Enter a prompt first.', true);
      return;
    }

    const mode = el('mode').value;
    const steps = Number(el('steps').value) || undefined;
    const seedRaw = el('seed').value.trim();

    const body = { prompt };
    if (steps !== undefined) body.steps = steps;
    if (seedRaw !== '') body.seed = Number(seedRaw);

    el('go').disabled = true;
    result.innerHTML = '';
    setStatus(
      'Generating. The first run downloads about 5GB of model weights, and on CPU a single image takes several minutes.'
    );

    try {
      const res = await fetch('/generate/' + mode, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      });
      const data = await res.json();

      if (!res.ok || data.success === false) {
        setStatus(data.details || data.error || 'Generation failed.', true);
        return;
      }

      setStatus('Done in ' + (data.device || 'unknown') + ' mode.');
      const img = document.createElement('img');
      // Cache-bust so regenerating with the same seed does not show the old file.
      img.src = data.url + '?t=' + Date.now();
      img.alt = data.prompt || prompt;
      result.appendChild(img);

      const meta = document.createElement('div');
      meta.className = 'hx-meta';
      meta.textContent = 'seed ' + data.seed + ' · ';
      const link = document.createElement('a');
      link.href = data.url;
      link.textContent = data.filename;
      meta.appendChild(link);
      result.appendChild(meta);
    } catch (err) {
      setStatus('Could not reach the server: ' + err.message, true);
    } finally {
      el('go').disabled = false;
    }
  });
})();
