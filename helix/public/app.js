/*
 * Main screen wiring.
 *
 * Three jobs: keep the one line of state under the wordmark honest, run the
 * voice control, and run the note and generate controls. The controls behave
 * exactly as they did before the screen was stripped back — same endpoints,
 * same payloads, same messages.
 *
 * Everything the old HUD showed on the wall — counts, clock, round trip, how
 * long the page has been open, the five subsystem dots — is still measured
 * here and still reported, by the ACTIVITY command. It is kept off the
 * screen, not thrown away.
 *
 * The screen says one thing at a time. What Helix is doing goes in the state
 * line; what he said goes in the reply, which leaves again once it has been
 * read. Nothing else is permanent.
 */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  var pad = function (n) { return String(n).padStart(2, '0'); };

  function clockOf(date) {
    return pad(date.getHours()) + ':' + pad(date.getMinutes()) + ':' + pad(date.getSeconds());
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

  /* --------------------------------------------------------- what he is doing */

  /*
   * One line, one state.
   *
   * Idle is the resting line — what the vault read last said, or that it could
   * not be read. Every other state is transient and says only itself: a screen
   * that shows "listening", "thinking" and "ready" at the same time is telling
   * you about its own markup rather than about Helix.
   */
  var TRANSIENT = { listening: 'Listening', thinking: 'Thinking', speaking: 'Speaking' };

  var state = 'idle';
  var resting = 'Reading vault';
  var restingFault = false;

  function paintState() {
    var line = el('core-state');
    var text = state === 'idle' ? resting : TRANSIENT[state] || resting;
    if (line.textContent !== text) line.textContent = text;
    line.classList.toggle('is-fault', state === 'idle' && restingFault);
    el('stage').dataset.state = state;

    // The sphere leans in while he is working. One multiplier, eased — it
    // costs nothing per frame and it is the only thing on screen that says
    // "busy" without adding a word to it.
    if (view !== null && typeof view.setActivity === 'function') {
      view.setActivity(state === 'thinking' || state === 'listening' ? 1 : 0);
    }
  }

  /** Move to a state. Anything but idle is expected to end. */
  function setState(next) {
    if (state === next) return;
    state = next;
    paintState();
  }

  /** The line shown whenever nothing is happening. */
  function setResting(text, fault) {
    resting = text;
    restingFault = Boolean(fault);
    paintState();
  }

  /* ------------------------------------------------------------- the reply */

  var replyTimer = 0;

  /**
   * Show what he said, then let it go.
   *
   * The dismissal is on a timer rather than permanent because the resting
   * screen is the point: a reply that stays until the next one turns the
   * centre of the screen into a log. Reading time is estimated from length,
   * with a floor, and a click or Escape cuts it short.
   */
  function showReply(text, note) {
    el('reply-text').textContent = text;
    el('reply-note').textContent = note || '';
    el('reply-note').hidden = !note;
    el('reply').hidden = false;
    // The state line and the reply say the same thing in different words, so
    // only one of them is ever up. The reply wins: it is the answer.
    el('core-state').hidden = true;

    window.clearTimeout(replyTimer);
    var words = text.split(/\s+/).length;
    replyTimer = window.setTimeout(clearReply, Math.min(45000, Math.max(7000, words * 420)));
  }

  function clearReply() {
    window.clearTimeout(replyTimer);
    var reply = el('reply');
    el('core-state').hidden = false;
    if (reply.hidden) return false;
    reply.hidden = true;
    el('reply-text').textContent = '';
    el('reply-note').textContent = '';
    return true;
  }

  el('reply').addEventListener('click', clearReply);

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
        setResting(galaxy.nodes.length === 0 ? 'Vault empty' : 'System ready', false);

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
        // No count is shown rather than one that is not true. The last sync
        // time is left alone, because it is still the last time this page did
        // read the vault.
        setResting('Vault unreadable', true);
        lastLatency = null;
        console.warn('Could not read the galaxy:', err.message);
      })
      .then(function () { busy(-1); });
  }

  /* ------------------------------------------------------------ the system */

  /**
   * The one status indicator: a dot, a word, and the detail on hover.
   *
   * The word does not repeat the name — the wordmark is directly above it —
   * it says whether the server is answering, which is the only thing a single
   * dot can honestly carry.
   *
   * Named for what it reports rather than called setStatus, because the
   * generate panel already has a setStatus and an element called status. Two
   * of either is one too many: the id collision had the generate panel's
   * messages landing in this dot.
   */
  function setSystem(state, label, detail) {
    var node = el('system');
    node.dataset.state = state;
    node.textContent = label;
    node.title = detail;
  }

  function loadHealth() {
    return fetch('/health')
      .then(function (res) { return res.json(); })
      .then(function (health) {
        lastHealth = health;
        var services = health.services || {};

        // One dot for the whole system. Five dots and five words was a
        // readout nobody was reading; the breakdown still exists, in
        // ACTIVITY, where you go when you actually want it. The title is
        // there so it is one hover away rather than one command away.
        setSystem('on', 'Online', Object.keys(services)
          .map(function (name) { return name + ': ' + services[name]; })
          .join('\n'));
      })
      .catch(function () {
        // Unknown is its own state: an unreachable server is not the same as
        // a subsystem reporting that it is disconnected.
        setSystem('fault', 'Offline', 'The server did not answer.');
      });
  }

  /* ------------------------------------------------------------- the clock */

  var openedAt = Date.now();

  /** How long this page has been open. Read on demand, so nothing ticks. */
  function uptime() {
    var up = Math.floor((Date.now() - openedAt) / 1000);
    return pad(Math.floor(up / 3600)) + ':' + pad(Math.floor(up / 60) % 60) + ':' + pad(up % 60);
  }

  loadGalaxy();
  loadHealth();

  /* ---------------------------------------------------------------- sheet */

  /*
   * The controls live in a sheet that is shut until something asks for it.
   *
   * There used to be a tab bar holding one of the two panels permanently open.
   * That put a form on the screen at all times for the sake of reaching it in
   * one click, which the console already does by name. Shut, the screen is the
   * sphere and nothing else.
   */
  var PANELS = { 'note-panel': 'Note', 'gen-panel': 'Generate' };

  function showPanel(panelId) {
    if (!Object.prototype.hasOwnProperty.call(PANELS, panelId)) return false;
    el('sheet-title').textContent = PANELS[panelId];
    Object.keys(PANELS).forEach(function (id) {
      el(id).hidden = id !== panelId;
    });
    el('sheet').hidden = false;
    return true;
  }

  function hideSheet() {
    if (el('sheet').hidden) return false;
    el('sheet').hidden = true;
    return true;
  }

  el('sheet-close').addEventListener('click', hideSheet);

  // Escape shuts the sheet — but only when the console is not the thing on
  // top. The console owns Escape while it is open, and stealing it here would
  // close the sheet out from under it.
  document.addEventListener('keydown', function (event) {
    if (event.key !== 'Escape') return;
    // The console owns Escape while it is open. Under it, one layer comes off
    // per press, outermost first, so Escape always means "the thing in front
    // of me" rather than "everything".
    if (!el('cmd').hidden) return;
    if (listening) { stopListening(); event.preventDefault(); return; }
    if (hideSheet() || clearReply()) event.preventDefault();
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

  // play() resolves when playback starts, not when it ends, so the end of the
  // spoken line has to come from the element itself. Without this the screen
  // drops out of "speaking" while he is still talking.
  player.addEventListener('ended', function () { setState('idle'); });
  player.addEventListener('error', function () { setState('idle'); });

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
  /**
   * The small print under an answer: what was kept, and where it came from.
   *
   * Nothing is stored quietly — that rule is only real if the keeping is
   * visible, and the console used to be where it showed. The answer is on the
   * main screen now, so this is too.
   */
  function provenance(body) {
    var parts = [];
    (body.remembered || []).forEach(function (item) {
      parts.push('Kept (' + item.category + '): ' + item.text);
    });
    (body.notRemembered || []).forEach(function (why) {
      parts.push('Not kept: ' + why);
    });
    if (body.sources && body.sources.length > 0) {
      parts.push(
        'From ' +
          body.sources
            .map(function (source) { return source.label; })
            .filter(function (label) { return label !== null; })
            .join(', ')
      );
    } else if (body.grounded === false && body.answer) {
      parts.push('Not from your notes');
    }
    if (body.voiceError) parts.push('Not spoken: ' + body.voiceError);
    return parts.join(' · ');
  }

  function ask(question) {
    setState('thinking');
    clearReply();
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

        // On screen whether or not it can be spoken. The words are the
        // answer; the voice is only the delivery.
        if (typeof body.answer === 'string' && body.answer !== '') {
          showReply(body.answer, provenance(body));
        } else if (typeof body.answerUnavailable === 'string') {
          showReply(body.answerUnavailable, provenance(body));
        }

        // Nothing to say is not something to say: a kept memory with no
        // answer behind it must not become an utterance.
        if (body.canSpeak && typeof body.answer === 'string' && body.answer !== '') {
          setState('speaking');
          return speak(body.answer).then(
            function () { return body; },
            function (err) {
              // Said but not spoken is still said.
              setState('idle');
              return Object.assign({}, body, { voiceError: err.message });
            }
          );
        }
        setState('idle');
        return body;
      })
      .catch(function (err) {
        busy(-1);
        // Reported here rather than left to the caller: the answer shows on
        // this screen, so the failure to produce one belongs on it too.
        showReply('That failed. ' + err.message);
        setState('idle');
        throw err;
      });
  }

  /* ------------------------------------------------------------- listening */

  /*
   * The voice control.
   *
   * Speech recognition is the browser's own — no library, no key, no audio
   * leaving the page except through whatever the browser already does. Where
   * it is missing the control says so and stays put: a dead button that
   * explains itself is better than one that silently does nothing, and better
   * than none at all when the question is "can Helix hear me".
   */
  var Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  var listener = null;
  var listening = false;

  // What the recognition API's error codes actually mean, in words. The codes
  // themselves are no use to anyone standing in front of the screen.
  var LISTEN_ERRORS = {
    'not-allowed': 'Microphone permission was refused.',
    'service-not-allowed': 'This browser will not allow speech recognition here.',
    'no-speech': 'I heard nothing.',
    'audio-capture': 'No microphone was found.',
    network: 'Speech recognition could not reach its service.',
    aborted: '',
  };

  function micFault(message) {
    var mic = el('mic');
    mic.disabled = true;
    mic.title = message;
  }

  function stopListening() {
    if (listener !== null && listening) listener.stop();
  }

  function startListening() {
    if (listener === null || listening) return;
    try {
      listener.start();
    } catch (err) {
      // start() throws if it is already running — which the flag should have
      // caught, but the flag is set by an event and the event can be late.
      console.warn('Could not start listening:', err.message);
    }
  }

  if (Recognition === undefined) {
    micFault('This browser has no speech recognition. Use Ctrl K and type.');
  } else {
    listener = new Recognition();
    listener.lang = document.documentElement.lang || 'en';
    listener.interimResults = false;
    listener.maxAlternatives = 1;

    listener.addEventListener('start', function () {
      listening = true;
      el('mic').setAttribute('aria-pressed', 'true');
      clearReply();
      setState('listening');
    });

    listener.addEventListener('result', function (event) {
      var result = event.results[event.results.length - 1];
      var said = result && result[0] ? result[0].transcript.trim() : '';
      if (said === '') return;
      // Straight to the same path the console's ASK uses. There is one
      // implementation of asking, and speaking into it is just another way in.
      // ask() has already put any failure on the screen; this is only here
      // so the rejection is not unhandled.
      ask(said).catch(function () {});
    });

    listener.addEventListener('error', function (event) {
      var why = LISTEN_ERRORS[event.error];
      if (why === undefined) why = 'Listening failed (' + event.error + ').';
      if (why !== '') showReply(why);
      // A refused permission will be refused again. Saying so once and
      // standing down beats a button that fails identically on every press.
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
        micFault(why);
      }
    });

    listener.addEventListener('end', function () {
      listening = false;
      el('mic').setAttribute('aria-pressed', 'false');
      // Only idle if nothing came of it: a result has already moved the
      // screen on to thinking, and this event lands after it.
      if (state === 'listening') setState('idle');
    });

    el('mic').addEventListener('click', function () {
      if (listening) stopListening();
      else startListening();
    });
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
        uptime: uptime(),
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
    /** What the screen is showing. Reported by ACTIVITY, not inferred by it. */
    state: function () { return state; },
    /** Start or stop listening. Returns false when this browser cannot. */
    listen: function (on) {
      if (listener === null || el('mic').disabled) return false;
      if (on === false) stopListening();
      else startListening();
      return true;
    },
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
