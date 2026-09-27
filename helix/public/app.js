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

  var pad = function (n) { return String(n).padStart(2, '0'); };

  function clockOf(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
  }

  /**
   * Write a readout, and mark it only when the value actually changed.
   *
   * The flash is the HUD's way of saying something moved. Re-running it on
   * every poll would make a still vault look busy, so the comparison against
   * what is already on screen is the point of this helper, not an
   * optimisation.
   */
  function setReadout(id, value) {
    var node = el(id);
    var text = String(value);
    if (node.textContent === text) return;
    node.textContent = text;
    node.classList.remove('hx-readout__value--changed');
    // Reading offsetWidth restarts the animation; without it the class goes
    // straight back on in the same frame and nothing replays.
    void node.offsetWidth;
    node.classList.add('hx-readout__value--changed');
  }

  /* ------------------------------------------------------- activity line */

  // A counter rather than a flag, so two requests in flight do not let the
  // first one to finish clear the indicator for both.
  var inFlight = 0;

  function busy(delta) {
    inFlight = Math.max(0, inFlight + delta);
    el('activity').hidden = inFlight === 0;
  }

  /* ------------------------------------------------------------ the galaxy */

  var view = window.HelixGalaxy ? window.HelixGalaxy.mount(el('galaxy')) : null;

  function plural(n, word) { return n + ' ' + word + (n === 1 ? '' : 's'); }

  function setLink(text, fault) {
    var link = el('hud-link');
    link.textContent = text;
    link.style.color = fault ? 'var(--hx-alert)' : '';
  }

  /** Notes that nothing links to and that link to nothing. */
  function countUnlinked(galaxy) {
    var linked = {};
    for (var i = 0; i < galaxy.links.length; i += 1) {
      linked[galaxy.links[i].source] = true;
      linked[galaxy.links[i].target] = true;
    }
    var alone = 0;
    for (var n = 0; n < galaxy.nodes.length; n += 1) {
      if (linked[galaxy.nodes[n].id] !== true) alone += 1;
    }
    return alone;
  }

  // The last successful reads, kept so the command console can answer from
  // what the page already has instead of going back to the server.
  var lastGalaxy = null;
  var lastHealth = null;
  var lastSyncAt = null;
  var lastLatency = null;

  function loadGalaxy() {
    var started = window.performance.now();
    busy(1);
    return fetch('/galaxy')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (galaxy) {
        // Measured round trip for this request, not an average or an estimate.
        lastLatency = Math.round(window.performance.now() - started);
        lastSyncAt = new Date();
        lastGalaxy = galaxy;
        el('tech-latency').textContent = lastLatency + ' ms';
        el('tech-sync').textContent = 'Sync ' + clockOf(lastSyncAt);

        setReadout('hud-nodes', galaxy.nodes.length);
        setReadout('hud-links', galaxy.links.length);
        setReadout('hud-groups', galaxy.groups.length);
        setReadout('hud-orphans', countUnlinked(galaxy));
        el('core-sub').textContent =
          galaxy.nodes.length === 0
            ? 'Vault empty'
            : plural(galaxy.nodes.length, 'note') + ' · ' + plural(galaxy.links.length, 'link');
        setLink('Online', false);

        // Drawing is caught separately. A fault in the visualisation is not a
        // fault in the vault, and reporting it as one would send someone
        // looking at their notes for a bug that is on this side of the wire.
        if (view !== null) {
          try {
            view.setData(galaxy);
          } catch (err) {
            console.error('The galaxy could not be drawn:', err);
          }
        }
      })
      .catch(function (err) {
        // The readouts stay as dashes rather than showing a number that is not
        // true. Saying the link is down is the honest reading, and the last
        // sync time is left alone because it is still the last time this page
        // did read the vault.
        el('core-sub').textContent = 'Vault unreadable';
        lastLatency = null;
        el('tech-latency').textContent = '— ms';
        setLink('Offline', true);
        console.warn('Could not read the galaxy:', err.message);
      })
      .then(function () { busy(-1); });
  }

  /* --------------------------------------------------------- subsystem HUD */

  function loadHealth() {
    return fetch('/health')
      .then(function (res) { return res.json(); })
      .then(function (health) {
        lastHealth = health;
        var services = health.services || {};
        var states = {
          'sig-gmail': services.gmail === 'authenticated',
          'sig-youtube': services.youtube === 'authenticated',
          'sig-generators': services.generators === 'available',
          'sig-voice': services.voice === 'available',
          'sig-mind': services.mind === 'available',
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
        var ids = ['sig-gmail', 'sig-youtube', 'sig-generators', 'sig-voice', 'sig-mind'];
        for (var i = 0; i < ids.length; i += 1) el(ids[i]).dataset.state = 'fault';
      });
  }

  /* ------------------------------------------------------------- the clock */

  var openedAt = Date.now();

  function tickClock() {
    el('hud-clock').textContent = clockOf(new Date());

    // How long this page has been open. Useful on a screen left running, and
    // the one number here that is about the browser rather than the vault.
    var up = Math.floor((Date.now() - openedAt) / 1000);
    el('tech-uptime').textContent =
      'Up ' + pad(Math.floor(up / 3600)) + ':' + pad(Math.floor(up / 60) % 60) + ':' + pad(up % 60);
  }

  el('hud-origin').textContent = window.location.host || 'file';
  tickClock();
  window.setInterval(tickClock, 1000);

  loadGalaxy();
  loadHealth();

  /* ----------------------------------------------------------------- tabs */

  function showPanel(panelId) {
    var found = false;
    document.querySelectorAll('.hx-tab').forEach(function (t) {
      var mine = t.dataset.panel === panelId;
      if (mine) found = true;
      t.classList.toggle('active', mine);
    });
    if (!found) return false;
    ['note-panel', 'gen-panel'].forEach(function (id) {
      el(id).hidden = id !== panelId;
    });
    return true;
  }

  document.querySelectorAll('.hx-tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      showPanel(tab.dataset.panel);
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
    busy(1);
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
      busy(-1);
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
    busy(1);
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
      busy(-1);
    }
  });

  /* ----------------------------------------------------------------- voice */

  // One element, reused. A new Audio per line would leave the previous one
  // playing, and Helix talking over himself is not the joke.
  var player = new Audio();

  function speak(text) {
    busy(1);
    return fetch('/voice/speak', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (res) {
        if (!res.ok) {
          return res.json().then(function (body) {
            throw new Error(body.error || 'Speech failed.');
          });
        }
        return res.blob();
      })
      .then(function (blob) {
        // The previous line's object URL is released before the next is made,
        // so a long session does not hold on to every reply it ever spoke.
        if (player.src !== '') URL.revokeObjectURL(player.src);
        player.src = URL.createObjectURL(blob);
        // Autoplay may be refused until the page has been interacted with.
        // Speaking is always triggered by a click or a keystroke, so this
        // should not arise — but a rejected promise must not go unhandled.
        return player.play().catch(function (err) {
          throw new Error('The browser would not play it: ' + err.message);
        });
      })
      .then(function () { busy(-1); })
      .catch(function (err) { busy(-1); throw err; });
  }

  /* ------------------------------------------------------------------- ask */

  /**
   * Ask Helix something, and have him say it.
   *
   * Speaking is attempted only when the server says it can, and a failure to
   * speak never loses the answer — the words are the point, the voice is the
   * delivery.
   */
  function ask(question) {
    busy(1);
    return fetch('/ask', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ question: question }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Helix could not answer.');
          return body;
        });
      })
      .then(function (body) {
        busy(-1);
        // The vault just told him something, so the counts may have moved.
        if (body.canSpeak) {
          return speak(body.answer).then(
            function () { return body; },
            function (err) {
              // Said but not spoken is still said.
              return Object.assign({}, body, { voiceError: err.message });
            }
          );
        }
        return body;
      })
      .catch(function (err) { busy(-1); throw err; });
  }

  /* --------------------------------------------------------- console hooks */

  /*
   * What the command console is allowed to reach.
   *
   * Deliberately a handful of getters and the actions this file already
   * performs, rather than the internals: the console runs the same code paths
   * the buttons do, so there is one implementation of each action and no way
   * for the console to do something the UI cannot.
   */
  window.Helix = {
    galaxy: function () { return lastGalaxy; },
    health: function () { return lastHealth; },
    metrics: function () {
      return {
        syncedAt: lastSyncAt === null ? null : clockOf(lastSyncAt),
        latencyMs: lastLatency,
        uptime: el('tech-uptime').textContent.replace(/^Up /, ''),
        inFlight: inFlight,
      };
    },
    refresh: loadGalaxy,
    showPanel: showPanel,
    /** Point the visualisation at one note. Returns false if it could not. */
    markNode: function (id) {
      if (view === null || typeof view.mark !== 'function') return false;
      return view.mark(id) === id;
    },
    speak: speak,
    ask: ask,
    focusNoteField: function () {
      showPanel('note-panel');
      el('note').focus();
    },
    focusPromptField: function () {
      showPanel('gen-panel');
      el('prompt').focus();
    },
    /** Wraps a request in the same activity indicator the buttons use. */
    request: function (path) {
      busy(1);
      return fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' } })
        .then(function (res) {
          return res.json().then(function (body) { return { ok: res.ok, body: body }; });
        })
        .then(function (result) { busy(-1); return result; })
        .catch(function (err) { busy(-1); throw err; });
    },
  };
})();
