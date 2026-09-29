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
   * One state at a time, and not a word of it.
   *
   * There used to be a line under the wordmark reading "Listening",
   * "Thinking", "System ready". Both it and the wordmark are gone, so the
   * state is carried by two things that were already on the screen: the dot
   * at the foot, which the stylesheet reads off `data-state`, and the sphere,
   * which turns harder while he is working.
   *
   * `resting` is kept even though nothing prints it — ACTIVITY reports it,
   * and a vault that could not be read is put in the reply where it can
   * actually be read rather than left to a coloured dot.
   */
  var state = 'idle';
  var resting = 'Reading vault';
  var restingFault = false;

  function paintState() {
    var stage = el('stage');
    stage.dataset.state = state;
    // Idle is not one thing: a vault that would not open is still idle, and
    // the dot has to be able to say so.
    stage.dataset.fault = state === 'idle' && restingFault ? 'true' : 'false';

    /*
     * The sphere is the whole report now.
     *
     * Activity drives how hard it turns and how much light is around it;
     * the fault flag stops the light entirely. Between them the screen says
     * idle, listening, thinking, speaking and broken without a word.
     */
    if (view !== null && typeof view.setActivity === 'function') {
      view.setActivity(state === 'thinking' || state === 'listening' ? 1 : 0);
    }
    if (view !== null && typeof view.setFault === 'function') {
      view.setFault(state === 'idle' && restingFault);
    }
  }

  /** Move to a state. Anything but idle is expected to end. */
  function setState(next) {
    if (state === next) return;
    state = next;
    paintState();
  }

  /** What is true when nothing is happening. Reported, not printed. */
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

    window.clearTimeout(replyTimer);
    var words = text.split(/\s+/).length;
    replyTimer = window.setTimeout(clearReply, Math.min(45000, Math.max(7000, words * 420)));
  }

  function clearReply() {
    window.clearTimeout(replyTimer);
    var reply = el('reply');
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
        // A read that succeeded clears a previous failure's message, so the
        // screen does not keep saying the vault is unreadable after it is not.
        if (restingFault) clearReply();
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
        // Said out loud as well as shown on the dot. A coloured dot is enough
        // to notice something is wrong and not enough to know what, and this
        // is the one fault that stops everything else working.
        showReply('The vault could not be read.');
        lastLatency = null;
        console.warn('Could not read the galaxy:', err.message);
      })
      .then(function () { busy(-1); });
  }

  /* ------------------------------------------------------------ the system */

  /**
   * The one status indicator: a dot, and the detail on hover.
   *
   * Named for what it reports rather than called setStatus, because the
   * generate panel already has a setStatus and an element called status. Two
   * of either is one too many: the id collision had the generate panel's
   * messages landing in this dot.
   */
  function setSystem(state, detail) {
    var node = el('system');
    node.dataset.state = state;
    // The word beside the dot said "ONLINE", which a lit dot already says.
    // What the dot cannot say goes in the title, one hover away.
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
        setSystem('on', Object.keys(services)
          .map(function (name) { return name + ': ' + services[name]; })
          .join('\n'));
      })
      .catch(function () {
        // Unknown is its own state: an unreachable server is not the same as
        // a subsystem reporting that it is disconnected.
        setSystem('fault', 'The server did not answer.');
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
  var PANELS = {
    'note-panel': 'Note',
    'gen-panel': 'Generate',
    'keys-panel': 'Keys',
    'pad-panel': 'Notepad',
    'export-panel': 'Export',
  };

  function showPanel(panelId) {
    if (!Object.prototype.hasOwnProperty.call(PANELS, panelId)) return false;
    // Read once, on the first open. The screen is not worth a request on
    // every page load when most opens of the sheet are for a note.
    if (panelId === 'keys-panel' && !keysLoaded) {
      keysStatus('');
      loadKeys();
    }
    // Read fresh every time: a note may have changed since it was last shown,
    // including by Helix himself.
    if (panelId === 'pad-panel') { padStatus(''); padLoad(el('pad-search').value); }
    if (panelId === 'export-panel') { exportStatus(''); exportLoad(); }
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
    if (recording) { stopListening(); event.preventDefault(); return; }
    if (hideSheet() || clearReply()) event.preventDefault();
  });

  /* --------------------------------------------------------------- notepad */

  /*
   * The notepad.
   *
   * Every note here is a file in the vault — the same vault the sphere draws
   * and the same one Helix answers from. Editing a note changes what he
   * knows; deleting one takes it out of the galaxy. There is no second store
   * and nothing to keep in step.
   */
  var padOpen = null;   // The note being edited, or null for the list.
  var padNotes = [];

  function padStatus(message, bad) {
    var out = el('pad-status');
    out.textContent = message || '';
    out.classList.toggle('error', Boolean(bad));
  }

  function padShowList() {
    padOpen = null;
    el('pad-note').hidden = true;
    el('pad-list').hidden = false;
    el('pad-count').hidden = false;
  }

  function when(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var now = new Date();
    var sameDay = d.toDateString() === now.toDateString();
    return sameDay
      ? 'today ' + pad(d.getHours()) + ':' + pad(d.getMinutes())
      : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function padRender() {
    var list = el('pad-list');
    list.innerHTML = '';

    el('pad-count').textContent =
      padNotes.length === 0
        ? 'No notes yet. New note starts one.'
        : padNotes.length === 1
          ? '1 note'
          : padNotes.length + ' notes';

    padNotes.forEach(function (note) {
      var item = document.createElement('li');
      item.className = 'hx-pad__row';
      item.tabIndex = 0;
      item.setAttribute('role', 'button');

      var title = document.createElement('span');
      title.className = 'hx-pad__row-title';
      title.textContent = note.title;

      var meta = document.createElement('span');
      meta.className = 'hx-pad__row-meta';
      meta.textContent = when(note.updated) + (note.tags.length ? ' · ' + note.tags.join(', ') : '');

      var excerpt = document.createElement('span');
      excerpt.className = 'hx-pad__row-excerpt';
      excerpt.textContent = note.excerpt;

      item.appendChild(title);
      item.appendChild(meta);
      item.appendChild(excerpt);
      var open = function () { padOpenNote(note.id); };
      item.addEventListener('click', open);
      item.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); }
      });
      list.appendChild(item);
    });
  }

  function padLoad(query) {
    busy(1);
    return fetch('/notepad' + (query ? '?q=' + encodeURIComponent(query) : ''))
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        padNotes = body.notes || [];
        padShowList();
        padRender();
      })
      .catch(function (err) { padStatus('Could not read the notes: ' + err.message, true); })
      .then(function () { busy(-1); });
  }

  function padOpenNote(id) {
    busy(1);
    return fetch('/notepad/note?id=' + encodeURIComponent(id))
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Could not open it.');
          return body;
        });
      })
      .then(function (note) {
        padOpen = note;
        el('pad-title').value = note.title;
        el('pad-body').value = note.content;
        el('pad-tags').value = note.tags.join(', ');
        el('pad-meta').textContent =
          'Written ' + when(note.created) + ' · last changed ' + when(note.updated) +
          ' · ' + note.words + (note.words === 1 ? ' word' : ' words');
        el('pad-note').hidden = false;
        el('pad-list').hidden = true;
        el('pad-count').hidden = true;
        padStatus('');
      })
      .catch(function (err) { padStatus(err.message, true); })
      .then(function () { busy(-1); });
  }

  el('pad-search').addEventListener('input', function () {
    // Searched on the server, which is where the note bodies are — matching
    // only what the list happens to be showing would miss every note whose
    // words are in its body rather than its title.
    window.clearTimeout(el('pad-search').dataset.timer);
    var term = el('pad-search').value;
    el('pad-search').dataset.timer = window.setTimeout(function () { padLoad(term); }, 200);
  });

  el('pad-new').addEventListener('click', function () {
    // A new note goes through the same POST /notes the capture field uses, so
    // there is one way a note comes into being.
    var text = window.prompt('What should the note say?');
    if (text === null || text.trim() === '') return;
    busy(1);
    fetch('/notes', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: text }),
    })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (body.error) throw new Error(body.details || body.error);
        padStatus('Saved as "' + body.title + '".');
        loadGalaxy();
        return padLoad('');
      })
      .catch(function (err) { padStatus(err.message, true); })
      .then(function () { busy(-1); });
  });

  el('pad-save').addEventListener('click', function () {
    if (padOpen === null) return;
    busy(1);
    fetch('/notepad/note', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: padOpen.id,
        title: el('pad-title').value,
        content: el('pad-body').value,
        tags: el('pad-tags').value.split(',').map(function (t) { return t.trim(); }).filter(Boolean),
      }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Could not save.');
          return body;
        });
      })
      .then(function (note) {
        padOpen = note;
        padStatus('Saved.');
        // The vault changed, so the sphere has.
        loadGalaxy();
      })
      .catch(function (err) { padStatus(err.message, true); })
      .then(function () { busy(-1); });
  });

  el('pad-delete').addEventListener('click', function () {
    if (padOpen === null) return;
    // Asked, because this takes the note out of the vault and out of what
    // Helix can answer with. There is no undo behind it.
    if (!window.confirm('Delete "' + padOpen.title + '"? Helix will forget it.')) return;

    busy(1);
    fetch('/notepad/note', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: padOpen.id }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Could not delete it.');
          return body;
        });
      })
      .then(function (body) {
        padStatus('Deleted "' + body.note.title + '".');
        loadGalaxy();
        return padLoad(el('pad-search').value);
      })
      .catch(function (err) { padStatus(err.message, true); })
      .then(function () { busy(-1); });
  });

  el('pad-back').addEventListener('click', function () {
    padShowList();
    padStatus('');
  });

  /* ---------------------------------------------------------------- export */

  /*
   * Taking it with you.
   *
   * No drive detection, because there is none to be had: a page cannot see a
   * USB stick. What this does is build the bundle on the server and hand it
   * to the browser as files to save — onto a flash drive if that is where you
   * point it.
   */
  var exportChoices = [];

  function exportLoad() {
    busy(1);
    return fetch('/export/options')
      .then(function (res) { return res.json(); })
      .then(function (body) {
        exportChoices = body.choices || [];
        var box = el('export-choices');
        box.innerHTML = '';

        exportChoices.forEach(function (choice, i) {
          var row = document.createElement('label');
          row.className = 'hx-choice';

          var radio = document.createElement('input');
          radio.type = 'radio';
          radio.name = 'export-choice';
          radio.value = choice.id;
          if (i === 0) radio.checked = true;

          var text = document.createElement('span');
          var label = document.createElement('span');
          label.className = 'hx-choice__label';
          label.textContent = choice.label;
          var says = document.createElement('span');
          says.className = 'hx-choice__says';
          says.textContent = choice.contains.join(' · ');
          text.appendChild(label);
          text.appendChild(says);

          row.appendChild(radio);
          row.appendChild(text);
          box.appendChild(row);
        });

        // What it will not contain, said before anything is written. The
        // reassuring half of an export is the half it leaves behind.
        var never = document.createElement('p');
        never.className = 'hx-note';
        never.textContent = 'Never included: ' + (body.never || []).join(' · ');
        box.appendChild(never);

        el('export-intro').textContent =
          'Helix builds a folder you save wherever you like — a flash drive included. ' +
          'It cannot see your drives from here, so it hands you the files and you choose.';
      })
      .catch(function (err) {
        el('export-intro').textContent = 'Could not read the export options: ' + err.message;
      })
      .then(function () { busy(-1); });
  }

  function exportStatus(message, bad) {
    var out = el('export-status');
    out.textContent = message || '';
    out.classList.toggle('error', Boolean(bad));
  }

  el('export-go').addEventListener('click', function () {
    var picked = el('export-choices').querySelector('input:checked');
    if (picked === null) return;

    busy(1);
    exportStatus('Building…');
    fetch('/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ choice: picked.value }),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Could not build it.');
          return body;
        });
      })
      .then(function (bundle) {
        // Each file saved on its own. A zip would need a library, and the
        // whole point of the folder layout is that it is readable without one.
        bundle.files.forEach(function (file, i) {
          window.setTimeout(function () { download(file.path, file.body); }, i * 250);
        });
        var counts = Object.keys(bundle.counts)
          .map(function (k) { return bundle.counts[k] + ' ' + k; })
          .join(', ');
        exportStatus(
          bundle.files.length + ' files' + (counts ? ' — ' + counts : '') +
            '. Your browser will ask where to put them.'
        );
      })
      .catch(function (err) { exportStatus(err.message, true); })
      .then(function () { busy(-1); });
  });

  /** Hand one file to the browser to save. */
  function download(path, body) {
    var blob = new Blob([body], { type: 'text/plain;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    // Slashes are not allowed in a download name, so the folder layout is
    // flattened into the filename and the README explains where each belongs.
    link.download = path.replace(/\//g, '_');
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    // Released on the next turn of the loop; revoking immediately can cancel
    // the download in some browsers.
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 4000);
  }

  /* ------------------------------------------------------------------ keys */

  /*
   * The settings screen.
   *
   * Built from /settings rather than written into the page, because the
   * server owns what is settable and two lists would drift. What comes back
   * is never a value — only whether one is set and its last four characters —
   * so a field left blank means "leave this alone", not "clear this".
   *
   * Clearing is the empty-string case, which needs a deliberate gesture: the
   * Clear button beside a field that has one. A blank box could not mean both
   * things.
   */
  var GROUPS = {
    mind: 'Thinking',
    voice: 'Voice',
    google: 'Google',
  };

  var keysLoaded = false;

  function keysStatus(message, bad) {
    var out = el('keys-status');
    out.textContent = message;
    out.classList.toggle('error', Boolean(bad));
  }

  function fieldFor(setting) {
    var row = document.createElement('div');
    row.className = 'hx-key';

    var label = document.createElement('label');
    label.className = 'hx-label';
    label.setAttribute('for', 'key-' + setting.key);
    label.textContent = setting.label;
    row.appendChild(label);

    var line = document.createElement('div');
    line.className = 'hx-key__line';

    var input = document.createElement('input');
    input.className = 'hx-field';
    input.id = 'key-' + setting.key;
    input.name = setting.key;
    // A secret is typed, not read back: type=password keeps it off the
    // screen and out of a screenshot, and autocomplete off keeps the browser
    // from offering to remember a key it has no business storing.
    input.type = setting.secret ? 'password' : 'text';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.placeholder = setting.set ? setting.hint : 'not set';
    line.appendChild(input);

    if (setting.set) {
      var clear = document.createElement('button');
      clear.type = 'button';
      clear.className = 'hx-key__clear';
      clear.textContent = 'Clear';
      clear.addEventListener('click', function () {
        // Marked rather than sent: nothing leaves until Save, so a misclick
        // is undone by closing the sheet.
        var wanted = row.dataset.clear !== 'true';
        row.dataset.clear = wanted ? 'true' : 'false';
        clear.textContent = wanted ? 'Will clear' : 'Clear';
        input.disabled = wanted;
      });
      line.appendChild(clear);
    }

    row.appendChild(line);

    var note = document.createElement('p');
    note.className = 'hx-note';
    note.textContent = setting.note;
    row.appendChild(note);

    return row;
  }

  function loadKeys() {
    // The status line is not touched here. loadKeys() runs after a save, and
    // clearing it was wiping the "3 settings saved" the save had just written.
    busy(1);
    return fetch('/settings')
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (body) {
        var form = el('keys-form');
        form.innerHTML = '';

        var byGroup = {};
        (body.settings || []).forEach(function (setting) {
          (byGroup[setting.group] = byGroup[setting.group] || []).push(setting);
        });

        Object.keys(GROUPS).forEach(function (group) {
          if (!byGroup[group]) return;
          var heading = document.createElement('p');
          heading.className = 'hx-key__group';
          heading.textContent = GROUPS[group];
          form.appendChild(heading);
          byGroup[group].forEach(function (setting) {
            form.appendChild(fieldFor(setting));
          });
        });

        el('keys-note').textContent = 'Saved to ' + body.path + ', readable only by you.';
        keysLoaded = true;
      })
      .catch(function (err) {
        el('keys-note').textContent = 'Could not read the settings: ' + err.message;
      })
      .then(function () { busy(-1); });
  }

  el('keys-save').addEventListener('click', function () {
    var updates = {};
    var rows = el('keys-form').querySelectorAll('.hx-key');
    for (var i = 0; i < rows.length; i += 1) {
      var input = rows[i].querySelector('.hx-field');
      if (rows[i].dataset.clear === 'true') updates[input.name] = '';
      else if (input.value.trim() !== '') updates[input.name] = input.value.trim();
    }

    if (Object.keys(updates).length === 0) {
      keysStatus('Nothing to save. Type a key first.', true);
      return;
    }

    el('keys-save').disabled = true;
    busy(1);
    keysStatus('Saving…');
    fetch('/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updates),
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'Could not save.');
          return body;
        });
      })
      .then(function (body) {
        var saved = (body.saved || []).length;
        var message = saved === 1 ? '1 setting saved.' : saved + ' settings saved.';
        // A new Google client cannot use tokens issued to the old one, so the
        // account has to be connected again. Said out loud, because a silently
        // dropped connection looks exactly like one that broke on its own.
        if ((body.reconnect || []).length > 0) {
          message += ' Connect ' + body.reconnect.join(' and ') + ' again — Ctrl K, CONNECT.';
        }
        keysStatus(message);
        // Rebuilt from what came back, so the fields show the new hints and
        // nothing that was just typed stays on screen.
        loadKeys();
        loadHealth();
      })
      .catch(function (err) { keysStatus(err.message, true); })
      .then(function () {
        el('keys-save').disabled = false;
        busy(-1);
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

  /*
   * The sphere breathes with what he is actually saying.
   *
   * The level is read off the playing audio through an AnalyserNode rather
   * than animated on a timer. A timer would keep swelling through the pauses
   * between words and drift out of step with the voice, which reads worse
   * than not moving at all.
   *
   * Three things about this are easy to get wrong and are load-bearing:
   *
   *   createMediaElementSource may be called once per element, ever. A second
   *   call throws, so the graph is built once and reused for every line.
   *
   *   Routing an element through Web Audio takes it off the speakers until
   *   something connects to the destination. Forget that and Helix goes
   *   silent — so the connection to destination is made in the same breath.
   *
   *   None of it may be allowed to cost the audio. Every step is guarded, and
   *   a failure means the sphere sits still while he talks, never that he
   *   cannot talk.
   */
  var voiceCtx = null;
  var voiceAnalyser = null;
  var voiceSamples = null;
  var voiceFrame = 0;

  function watchVoice() {
    if (voiceAnalyser !== null) return true;

    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (Ctor === undefined) return false;

    try {
      voiceCtx = new Ctor();
      var source = voiceCtx.createMediaElementSource(player);
      voiceAnalyser = voiceCtx.createAnalyser();
      voiceAnalyser.fftSize = 256;
      source.connect(voiceAnalyser);
      // And on to the speakers. Without this line he is mute.
      voiceAnalyser.connect(voiceCtx.destination);
      voiceSamples = new Float32Array(voiceAnalyser.fftSize);
      return true;
    } catch (err) {
      console.warn('The sphere will not follow the voice:', err.message);
      voiceCtx = null;
      voiceAnalyser = null;
      return false;
    }
  }

  function stopFollowingVoice() {
    if (voiceFrame !== 0) window.cancelAnimationFrame(voiceFrame);
    voiceFrame = 0;
    // null, not 0. Zero is a gap between two words and keeps the shell drawn
    // in; null is "he has stopped", and returns it to full size.
    if (view !== null && typeof view.setVoice === 'function') view.setVoice(null);
  }

  function followVoice() {
    if (voiceAnalyser === null || view === null || typeof view.setVoice !== 'function') return;
    stopFollowingVoice();

    // Speech sits well below full scale, so the RMS is lifted to use the
    // whole range. Squaring first keeps the quiet parts quiet — without it
    // the shell hovers near its maximum for the length of every sentence.
    var lift = 6;

    (function read() {
      voiceFrame = window.requestAnimationFrame(read);
      voiceAnalyser.getFloatTimeDomainData(voiceSamples);
      var sum = 0;
      for (var i = 0; i < voiceSamples.length; i += 1) sum += voiceSamples[i] * voiceSamples[i];
      var rms = Math.sqrt(sum / voiceSamples.length);
      view.setVoice(Math.min(1, rms * lift));
    })();
  }

  // play() resolves when playback starts, not when it ends, so the end of the
  // spoken line has to come from the element itself. Without this the screen
  // drops out of "speaking" while he is still talking.
  player.addEventListener('ended', function () { stopFollowingVoice(); setState('idle'); });
  player.addEventListener('error', function () { stopFollowingVoice(); setState('idle'); });
  player.addEventListener('pause', stopFollowingVoice);

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
        // Built before play, because routing the element through Web Audio
        // after it has started can drop the first moment of the line.
        var following = watchVoice();
        // A context created before the first gesture starts suspended, and a
        // suspended context passes silence through. Resuming is a no-op when
        // it is already running.
        if (following && voiceCtx.state === 'suspended') voiceCtx.resume().catch(function () {});

        // Autoplay may be refused until the page has been interacted with.
        // Speaking is always triggered by a click or a keystroke, so this
        // should not arise — but a rejected promise must not go unhandled.
        return player
          .play()
          .then(function () { if (following) followVoice(); })
          .catch(function (err) {
            stopFollowingVoice();
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
    }

    // The web, said plainly. Which words turned it on, and whether it was
    // actually used — a search offered and declined is not a search, and the
    // two must not look the same.
    if (body.web) {
      if (body.web.searches > 0) {
        var hosts = (body.web.sources || [])
          .map(function (source) {
            try { return new URL(source.url).hostname.replace(/^www\./, ''); }
            catch (err) { return null; }
          })
          .filter(function (host) { return host !== null; });
        parts.push(
          'Searched the web (' + body.web.trigger + ')' +
            (hosts.length > 0 ? ': ' + hosts.slice(0, 3).join(', ') : '')
        );
      } else {
        parts.push('Web offered (' + body.web.trigger + '), not used');
      }
    }

    if (
      (!body.sources || body.sources.length === 0) &&
      body.grounded === false &&
      body.answer
    ) {
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

        /*
         * The notepad first, if that is what the words were about.
         *
         * Acting before the answer is displayed so the screen is already
         * where it should be — asking to open the notepad and then being told
         * about it is not the same as it opening.
         */
        var padSaid = null;
        if (body.notepad) {
          padSaid = window.Helix.notepad(body.notepad);
          if (body.notepad.saved) {
            padSaid = 'Written down as "' + body.notepad.saved.title + '".';
          }
        }

        // On screen whether or not it can be spoken. The words are the
        // answer; the voice is only the delivery.
        if (typeof body.answer === 'string' && body.answer !== '') {
          showReply(body.answer, provenance(body));
        } else if (typeof body.answerUnavailable === 'string') {
          showReply(body.answerUnavailable, provenance(body));
        } else if (padSaid !== null) {
          // He did the thing but had nothing to say about it — usually
          // because no model is configured. The action is still real and
          // still worth stating.
          showReply(padSaid, provenance(body));
        }

        // Nothing to say is not something to say: a kept memory with no
        // answer behind it must not become an utterance.
        if (body.canSpeak && typeof body.answer === 'string' && body.answer !== '') {
          setState('speaking');
          return speak(body.answer).then(
            function () { return body; },
            function (err) {
              // Said but not spoken is still said — but it has to say so.
              // The answer is already on screen by this point, so the note
              // is rewritten rather than returned: putting voiceError on a
              // copy of the body and returning it told nobody, because
              // nothing renders the body again.
              var withError = Object.assign({}, body, { voiceError: err.message });
              showReply(body.answer, provenance(withError));
              setState('idle');
              return withError;
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
   * The voice control, end to end.
   *
   * Press it, speak, and it stops on its own when you stop talking. The clip
   * goes to /voice/listen, which transcribes it through ElevenLabs — the same
   * key that gives Helix his voice — and the transcript goes straight into the
   * same ask() the console uses. There is one implementation of asking;
   * speaking is another way in.
   *
   * This was the browser's own SpeechRecognition, which is Chrome and Safari
   * only, needs a secure context, and sends audio to the browser vendor rather
   * than to the service the user already configured. Recording and posting the
   * clip works everywhere MediaRecorder does and keeps it to one provider.
   */
  var MAX_CLIP_MS = 30000;   // A question, not a monologue.
  var SILENCE_MS = 1400;     // How long a pause has to run before it counts.
  var SILENCE_LEVEL = 0.012; // RMS below this is room tone, not speech.

  var recorder = null;
  var recording = false;
  var audioStream = null;
  var audioContext = null;
  var silenceWatch = 0;
  var clipLimit = 0;
  var heardSomething = false;

  function micOff(message) {
    var mic = el('mic');
    mic.disabled = true;
    mic.title = message;
  }

  /** Let go of the microphone. Leaving it open leaves the tab's light on. */
  function releaseMic() {
    window.clearInterval(silenceWatch);
    window.clearTimeout(clipLimit);
    silenceWatch = 0;
    clipLimit = 0;
    if (audioContext !== null) {
      audioContext.close().catch(function () {});
      audioContext = null;
    }
    if (audioStream !== null) {
      audioStream.getTracks().forEach(function (track) { track.stop(); });
      audioStream = null;
    }
  }

  /**
   * Watch the level and stop once the talking has stopped.
   *
   * Push-to-talk would be simpler, but holding a button to speak to an
   * assistant is a worse thing to do than speaking to it. The hard limit
   * stands behind this so a recorder can never run away.
   */
  function watchForSilence(stream) {
    var Ctor = window.AudioContext || window.webkitAudioContext;
    if (Ctor === undefined) return; // No level metering; the timeout still applies.

    audioContext = new Ctor();
    var analyser = audioContext.createAnalyser();
    analyser.fftSize = 512;
    audioContext.createMediaStreamSource(stream).connect(analyser);

    var samples = new Float32Array(analyser.fftSize);
    var quietSince = 0;
    heardSomething = false;

    silenceWatch = window.setInterval(function () {
      analyser.getFloatTimeDomainData(samples);
      var sum = 0;
      for (var i = 0; i < samples.length; i += 1) sum += samples[i] * samples[i];
      var level = Math.sqrt(sum / samples.length);

      if (level >= SILENCE_LEVEL) {
        heardSomething = true;
        quietSince = 0;
        return;
      }
      // Silence before anything was said is someone deciding what to say.
      if (!heardSomething) return;
      if (quietSince === 0) quietSince = Date.now();
      else if (Date.now() - quietSince >= SILENCE_MS) stopListening();
    }, 150);
  }

  function stopListening() {
    if (recorder !== null && recording) recorder.stop();
  }

  /** Send the clip, then ask what it turned out to be. */
  function transcribe(clip) {
    if (clip.size === 0) {
      showReply('Nothing was recorded.');
      setState('idle');
      return;
    }

    setState('thinking');
    busy(1);
    fetch('/voice/listen', {
      method: 'POST',
      headers: { 'Content-Type': clip.type || 'audio/webm' },
      body: clip,
    })
      .then(function (res) {
        return res.json().then(function (body) {
          if (!res.ok) throw new Error(body.error || 'That could not be transcribed.');
          return body;
        });
      })
      .then(function (body) {
        busy(-1);
        // ask() takes it from here, including putting the answer on screen.
        return ask(body.text).catch(function () {});
      })
      .catch(function (err) {
        busy(-1);
        showReply(err.message);
        setState('idle');
      });
  }

  function startListening() {
    if (recording || el('mic').disabled) return;

    // getUserMedia is only available in a secure context. Saying which is the
    // difference between a broken button and a fixable setup.
    if (navigator.mediaDevices === undefined || !window.isSecureContext) {
      showReply(
        'The microphone needs a secure page. Open Helix on localhost or over HTTPS, ' +
          'or use Ctrl K and type.'
      );
      return;
    }

    navigator.mediaDevices
      .getUserMedia({ audio: true })
      .then(function (stream) {
        audioStream = stream;
        // Let the browser pick the container. Chrome records webm/opus and
        // Safari mp4; the server passes whichever through to the service
        // rather than insisting on one and being deaf on the other.
        recorder = new MediaRecorder(stream);
        var chunks = [];

        recorder.addEventListener('dataavailable', function (event) {
          if (event.data && event.data.size > 0) chunks.push(event.data);
        });

        recorder.addEventListener('start', function () {
          recording = true;
          el('mic').setAttribute('aria-pressed', 'true');
          clearReply();
          setState('listening');
        });

        recorder.addEventListener('stop', function () {
          recording = false;
          el('mic').setAttribute('aria-pressed', 'false');
          releaseMic();
          transcribe(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }));
        });

        recorder.addEventListener('error', function (event) {
          recording = false;
          el('mic').setAttribute('aria-pressed', 'false');
          releaseMic();
          showReply('The recording failed: ' + ((event.error && event.error.name) || 'unknown'));
          setState('idle');
        });

        recorder.start();
        watchForSilence(stream);
        // The backstop. Silence detection is a heuristic; this is not.
        clipLimit = window.setTimeout(stopListening, MAX_CLIP_MS);
      })
      .catch(function (err) {
        releaseMic();
        // A refused permission will be refused again until the person changes
        // it in the browser, so the control stands down rather than failing
        // identically on every press.
        if (err.name === 'NotAllowedError' || err.name === 'SecurityError') {
          micOff('Microphone permission was refused. Allow it in the browser to use voice.');
          showReply('Microphone permission was refused.');
        } else if (err.name === 'NotFoundError') {
          micOff('No microphone was found.');
          showReply('No microphone was found.');
        } else {
          showReply('The microphone could not be opened: ' + err.message);
        }
        setState('idle');
      });
  }

  if (window.MediaRecorder === undefined || navigator.mediaDevices === undefined) {
    micOff('This browser cannot record audio. Use Ctrl K and type.');
  } else {
    el('mic').addEventListener('click', function () {
      if (recording) stopListening();
      else startListening();
    });

    // Whether the server can transcribe at all. Asked once: a mic that opens
    // and records and then reports that no key is set has wasted the whole
    // performance, and made the user say it twice.
    fetch('/voice/status')
      .then(function (res) { return res.json(); })
      .then(function (status) {
        if (status.canHear === false) {
          micOff(status.hearingReason || 'Set ELEVENLABS_API_KEY to let Helix listen.');
        }
      })
      .catch(function () {
        // An unreachable server is not a missing key, and the button is not
        // the place to report that the whole server is down.
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
    /** Start or stop listening. Returns false when it cannot. */
    listen: function (on) {
      if (el('mic').disabled) return false;
      if (on === false) stopListening();
      else startListening();
      return true;
    },
    /** True while the microphone is open. */
    listening: function () { return recording; },
    focusNoteField: function () {
      showPanel('note-panel');
      el('note').focus();
    },
    focusPromptField: function () {
      showPanel('gen-panel');
      el('prompt').focus();
    },
    /**
     * Act on a notepad intent the server recognised.
     *
     * The server decides what was meant, from the same words whether they
     * were spoken or typed; this only carries it out. Returns what happened
     * so the reply can say it.
     */
    notepad: function (intent) {
      if (intent === null || intent === undefined) return null;

      if (intent.action === 'open') {
        el('pad-search').value = '';
        showPanel('pad-panel');
        return 'Notepad open.';
      }
      if (intent.action === 'search') {
        el('pad-search').value = intent.subject;
        showPanel('pad-panel');
        return intent.subject === ''
          ? 'Notepad open.'
          : 'Searching your notes for "' + intent.subject + '".';
      }
      if (intent.action === 'export') {
        showPanel('export-panel');
        return 'Export ready — choose what to take.';
      }
      if (intent.action === 'delete') {
        // Never done from a sentence. Deleting is one click away with the
        // note in front of you, and a misheard word must not be able to
        // remove one.
        el('pad-search').value = intent.subject;
        showPanel('pad-panel');
        return intent.subject === ''
          ? 'Which note? Open it and delete it there.'
          : 'Found what matches "' + intent.subject + '". Open the one you mean to delete it.';
      }
      if (intent.action === 'create') {
        showPanel('pad-panel');
        if (intent.subject === '') return 'Notepad open. New note starts one.';
        return null; // The server saved it; the reply says so.
      }
      return null;
    },
    /** Open the settings screen and put the cursor in the first empty field. */
    openSettings: function () {
      showPanel('keys-panel');
      window.setTimeout(function () {
        var empty = el('keys-form').querySelector('.hx-field:placeholder-shown');
        if (empty !== null) empty.focus();
      }, 120);
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
