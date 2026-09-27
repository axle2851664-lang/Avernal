/*
 * Command console.
 *
 * Opens on Ctrl+K, Cmd+K or "/", and drives the page through the small API
 * app.js exposes rather than reaching into it. Every command here maps to
 * something that already exists: a panel the tabs can show, a field you could
 * have clicked, an endpoint the server already serves, or a figure the page
 * has already read. There is no command for a feature that is not there —
 * there is no settings screen, so there is no SETTINGS.
 *
 * Commands that reach the network are marked, because the difference between
 * reading what the page already holds and going and fetching someone's mail
 * should be visible before you press Enter.
 */
(function () {
  'use strict';

  var el = function (id) { return document.getElementById(id); };

  var root = el('cmd');
  var input = el('cmd-input');
  var list = el('cmd-list');
  var out = el('cmd-out');
  if (root === null || input === null || list === null || out === null) return;

  var api = function () { return window.Helix || {}; };

  var MAX_RESULTS = 8;

  var open = false;
  var active = 0;
  var rows = [];
  var restoreFocusTo = null;

  /* ------------------------------------------------------------ reporting */

  function report(lines, bad) {
    out.innerHTML = '';
    for (var i = 0; i < lines.length; i += 1) {
      var line = document.createElement('div');
      line.className = 'hx-cmd__line' + (bad ? ' hx-cmd__line--bad' : '');
      line.textContent = lines[i];
      out.appendChild(line);
    }
    out.hidden = lines.length === 0;
  }

  function fail(message) { report([message], true); }

  /* ------------------------------------------------------------- commands */

  function requireGalaxy() {
    var g = api().galaxy ? api().galaxy() : null;
    if (g === null || g === undefined) {
      fail('The vault has not been read yet. Try REFRESH.');
      return null;
    }
    return g;
  }

  var COMMANDS = [
    {
      name: 'HELP',
      hint: 'List every command',
      run: function () {
        report(
          COMMANDS.map(function (c) {
            return c.name + (c.arg ? ' ' + c.arg : '') + '  —  ' + c.hint;
          })
        );
        return 'stay';
      },
    },
    {
      name: 'SEARCH',
      arg: '<text>',
      hint: 'Find a note by name and point at it',
      // Handled by the matcher below, which turns the query into one result
      // per matching note. Running it bare just explains itself.
      run: function (arg) {
        if (arg === '') {
          report(['Type SEARCH followed by part of a note name.']);
          return 'stay';
        }
        fail('No note matches "' + arg + '".');
        return 'stay';
      },
    },
    {
      name: 'OPEN NOTE',
      hint: 'Show the capture field and put the cursor in it',
      run: function () {
        if (!api().focusNoteField) return fail('The page is not ready yet.'), 'stay';
        api().focusNoteField();
        return 'close';
      },
    },
    {
      name: 'OPEN GENERATE',
      hint: 'Show the prompt field and put the cursor in it',
      run: function () {
        if (!api().focusPromptField) return fail('The page is not ready yet.'), 'stay';
        api().focusPromptField();
        return 'close';
      },
    },
    {
      name: 'ASK',
      arg: '<question>',
      hint: 'Ask Helix something — he answers from your vault, and says it',
      network: true,
      run: function (arg) {
        if (!api().ask) return fail('The page is not ready yet.'), 'stay';
        if (arg === '') {
          report(['Type ASK followed by your question. Or just end it with a "?".']);
          return 'stay';
        }
        report(['Thinking\u2026']);
        api()
          .ask(arg)
          .then(function (body) {
            var lines = [body.answer];
            if (body.sources && body.sources.length > 0) {
              // Which notes he used, so a wrong answer is traceable.
              lines.push('');
              lines.push('From: ' + body.sources.map(function (s) { return s.label; }).join(', '));
            } else if (!body.grounded) {
              lines.push('');
              lines.push('Not from your notes — he was just talking.');
            }
            if (body.voiceError) {
              lines.push('');
              lines.push('(Could not speak it: ' + body.voiceError + ')');
            }
            report(lines);
          })
          .catch(function (err) { fail(err.message); });
        return 'stay';
      },
    },
    {
      name: 'SPEAK',
      arg: '<text>',
      hint: 'Say something out loud, through ElevenLabs',
      network: true,
      run: function (arg) {
        if (!api().speak) return fail('The page is not ready yet.'), 'stay';
        if (arg === '') {
          report(['Type SPEAK followed by the line you want said.']);
          return 'stay';
        }
        report(['Speaking\u2026']);
        api()
          .speak(arg)
          .then(function () { report(['Said it.']); })
          .catch(function (err) { fail(err.message); });
        return 'stay';
      },
    },
    {
      name: 'ANALYZE',
      hint: 'Report the shape of the vault',
      run: function () {
        var g = requireGalaxy();
        if (g === null) return 'stay';
        if (g.nodes.length === 0) {
          report(['The vault is empty. Nothing to analyse yet.']);
          return 'stay';
        }

        var degree = {};
        var perGroup = {};
        var i;
        for (i = 0; i < g.nodes.length; i += 1) {
          degree[g.nodes[i].id] = 0;
          perGroup[g.nodes[i].group] = (perGroup[g.nodes[i].group] || 0) + 1;
        }
        for (i = 0; i < g.links.length; i += 1) {
          degree[g.links[i].source] += 1;
          degree[g.links[i].target] += 1;
        }

        var best = g.nodes[0];
        var alone = 0;
        for (i = 0; i < g.nodes.length; i += 1) {
          if (degree[g.nodes[i].id] > degree[best.id]) best = g.nodes[i];
          if (degree[g.nodes[i].id] === 0) alone += 1;
        }

        var biggest = '';
        for (var name in perGroup) {
          if (!Object.prototype.hasOwnProperty.call(perGroup, name)) continue;
          if (biggest === '' || perGroup[name] > perGroup[biggest]) biggest = name;
        }

        report([
          'Notes            ' + g.nodes.length,
          'Links            ' + g.links.length,
          'Clusters         ' + g.groups.length,
          'Unlinked         ' + alone,
          'Most linked      ' + best.label + ' (' + degree[best.id] + ')',
          'Largest cluster  ' + biggest + ' (' + perGroup[biggest] + ')',
        ]);
        return 'stay';
      },
    },
    {
      name: 'ACTIVITY',
      hint: 'Report what this page has measured',
      run: function () {
        var m = api().metrics ? api().metrics() : null;
        var h = api().health ? api().health() : null;
        if (m === null) return fail('The page is not ready yet.'), 'stay';

        var lines = [
          'Last vault read  ' + (m.syncedAt === null ? 'never' : m.syncedAt),
          'Round trip       ' + (m.latencyMs === null ? 'unknown' : m.latencyMs + ' ms'),
          'Page open for    ' + m.uptime,
          'Requests in air  ' + m.inFlight,
        ];
        if (h !== null && h.services) {
          lines.push('Gmail            ' + h.services.gmail);
          lines.push('YouTube          ' + h.services.youtube);
          lines.push('Generators       ' + h.services.generators);
        } else {
          lines.push('Subsystems       not reported');
        }
        report(lines);
        return 'stay';
      },
    },
    {
      name: 'REFRESH',
      hint: 'Read the vault again',
      network: true,
      run: function () {
        if (!api().refresh) return fail('The page is not ready yet.'), 'stay';
        report(['Reading the vault…']);
        api()
          .refresh()
          .then(function () {
            var g = api().galaxy();
            report(
              g === null
                ? ['The vault could not be read.']
                : ['Read ' + g.nodes.length + ' notes and ' + g.links.length + ' links.']
            );
          });
        return 'stay';
      },
    },
    {
      name: 'SYNC GMAIL',
      hint: 'Fetch unread mail through the server',
      network: true,
      run: function () { return post('/sync/gmail/unread', 'Fetched'); },
    },
    {
      name: 'SYNC YOUTUBE',
      hint: 'Fetch recent videos through the server',
      network: true,
      run: function () { return post('/sync/youtube/videos', 'Fetched'); },
    },
    {
      name: 'CONNECT GMAIL',
      hint: 'Get the Google sign-in link for mail',
      network: true,
      run: function () { return authLink('/auth/gmail/start', 'Gmail'); },
    },
    {
      name: 'CONNECT YOUTUBE',
      hint: 'Get the Google sign-in link for YouTube',
      network: true,
      run: function () { return authLink('/auth/youtube/start', 'YouTube'); },
    },
  ];

  function post(path, verb) {
    if (!api().request) return fail('The page is not ready yet.'), 'stay';
    report(['Working…']);
    api()
      .request(path)
      .then(function (result) {
        if (!result.ok) {
          // The server's own message, not a guess at what went wrong.
          fail(result.body.error || 'The request failed.');
          return;
        }
        report([verb + ' ' + result.body.count + ' item' + (result.body.count === 1 ? '' : 's') + '.']);
        if (api().refresh) api().refresh();
      })
      .catch(function (err) { fail('Could not reach the server: ' + err.message); });
    return 'stay';
  }

  /**
   * Ask the server for a sign-in URL and show it as a link.
   *
   * Shown rather than followed: consent is Google's to ask for and the
   * person's to give, so opening it is a click they make, not something a
   * command does to them.
   */
  function authLink(path, service) {
    report(['Asking the server for a link…']);
    // The JSON form. Without it the route redirects to Google, fetch follows
    // it, and the console gets a cross-origin failure instead of a link —
    // which is the wrong outcome twice over, since the point of showing the
    // link rather than following it is that opening it is the user's move.
    fetch(path + '?json=1', { headers: { Accept: 'application/json' } })
      .then(function (res) { return res.json(); })
      .then(function (body) {
        if (!body.authUrl) {
          fail(body.error || 'The server did not return a sign-in link.');
          return;
        }
        out.innerHTML = '';
        var line = document.createElement('div');
        line.className = 'hx-cmd__line';
        line.textContent = 'Open this to connect ' + service + ':';
        var link = document.createElement('a');
        link.className = 'hx-cmd__link';
        link.href = body.authUrl;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = body.authUrl;
        out.appendChild(line);
        out.appendChild(link);
        out.hidden = false;
      })
      .catch(function (err) { fail('Could not reach the server: ' + err.message); });
    return 'stay';
  }

  /* -------------------------------------------------------------- matching */

  function matches(haystack, needle) {
    return haystack.toLowerCase().indexOf(needle.toLowerCase()) !== -1;
  }

  /** Note results for a SEARCH, from the galaxy the page already holds. */
  function noteResults(query) {
    var g = api().galaxy ? api().galaxy() : null;
    if (g === null || g === undefined || query === '') return [];

    var found = [];
    for (var i = 0; i < g.nodes.length && found.length < MAX_RESULTS; i += 1) {
      if (!matches(g.nodes[i].label, query)) continue;
      found.push({
        label: g.nodes[i].label,
        hint: g.nodes[i].group,
        tag: 'NOTE',
        id: g.nodes[i].id,
      });
    }
    return found;
  }

  function build(raw) {
    var query = raw.trim();
    var upper = query.toUpperCase();

    // "SEARCH foo" and a bare "foo" both look through the notes. The bare form
    // is what most people will type, and the explicit one is discoverable.
    var searchTerm = null;
    if (upper.indexOf('SEARCH') === 0) searchTerm = query.slice(6).trim();

    // SPEAK and ASK carry their text as an argument, so the row has to be
    // built with that argument rather than matched as a bare command name.
    var withArgument = [['SPEAK', 5], ['ASK', 3]];
    for (var w = 0; w < withArgument.length; w += 1) {
      var name = withArgument[w][0];
      if (upper.indexOf(name) !== 0) continue;
      var rest = query.slice(withArgument[w][1]).trim();
      var command = COMMANDS.filter(function (c) { return c.name === name; })[0];
      return [commandRow(command, rest)];
    }

    // Anything phrased as a question is a question. Typing it is the shortest
    // path to the thing most people open this for, and it does not shadow a
    // command: no command name ends in a question mark.
    if (query.slice(-1) === '?') {
      var askCommand = COMMANDS.filter(function (c) { return c.name === 'ASK'; })[0];
      return [commandRow(askCommand, query)];
    }

    var results = [];

    if (searchTerm !== null) {
      results = noteResults(searchTerm).map(toNoteRow);
      if (results.length === 0) {
        results.push(commandRow(COMMANDS[1], searchTerm));
      }
      return results;
    }

    for (var i = 0; i < COMMANDS.length; i += 1) {
      if (query === '' || matches(COMMANDS[i].name, query)) {
        results.push(commandRow(COMMANDS[i], ''));
      }
    }

    // Anything typed that is not a command prefix is treated as a note search,
    // so the console is useful without having to know the verbs.
    if (query !== '') {
      var notes = noteResults(query).map(toNoteRow);
      results = results.concat(notes);
    }

    return results.slice(0, MAX_RESULTS + COMMANDS.length);
  }

  function commandRow(command, arg) {
    return {
      label: command.name + (command.arg && arg === '' ? ' ' + command.arg : arg ? ' ' + arg : ''),
      hint: command.hint,
      tag: command.network ? 'NET' : 'CMD',
      run: function () { return command.run(arg); },
    };
  }

  function toNoteRow(note) {
    return {
      label: note.label,
      hint: note.hint,
      tag: 'NOTE',
      run: function () {
        if (api().markNode && api().markNode(note.id)) return 'close';
        fail('That note is in the vault but is not plotted on the shell.');
        return 'stay';
      },
    };
  }

  /* --------------------------------------------------------------- render */

  function render() {
    rows = build(input.value);
    if (active >= rows.length) active = Math.max(0, rows.length - 1);

    list.innerHTML = '';
    for (var i = 0; i < rows.length; i += 1) {
      var item = document.createElement('li');
      item.className = 'hx-cmd__row' + (i === active ? ' is-active' : '');
      item.setAttribute('role', 'option');
      item.setAttribute('aria-selected', i === active ? 'true' : 'false');

      var label = document.createElement('span');
      label.className = 'hx-cmd__label';
      label.textContent = rows[i].label;

      var hint = document.createElement('span');
      hint.className = 'hx-cmd__hint';
      hint.textContent = rows[i].hint;

      var tag = document.createElement('span');
      tag.className = 'hx-cmd__tag';
      tag.textContent = rows[i].tag;

      item.appendChild(label);
      item.appendChild(hint);
      item.appendChild(tag);
      item.addEventListener('mousedown', bindRun(i));
      list.appendChild(item);
    }

    if (rows.length === 0) {
      var empty = document.createElement('li');
      empty.className = 'hx-cmd__row hx-cmd__row--empty';
      empty.textContent = 'Nothing matches. Try HELP.';
      list.appendChild(empty);
    }
  }

  function bindRun(index) {
    return function (event) {
      // mousedown rather than click, and prevented, so the input never loses
      // focus between press and release.
      event.preventDefault();
      active = index;
      execute();
    };
  }

  function execute() {
    var row = rows[active];
    if (row === undefined) return;
    var outcome = row.run();
    if (outcome === 'close') close();
    else render();
  }

  /* --------------------------------------------------------- open / close */

  function show() {
    if (open) return;
    open = true;
    restoreFocusTo = document.activeElement;
    root.hidden = false;
    input.value = '';
    out.hidden = true;
    out.innerHTML = '';
    active = 0;
    render();
    input.focus();
  }

  function close() {
    if (!open) return;
    open = false;

    // Blur before hiding. Hiding the panel does not move focus off the input,
    // and a focused field inside a hidden dialog swallows every keystroke
    // afterwards — including the Ctrl+K that would reopen the console, since
    // the key then looks like it was pressed inside a text field.
    input.blur();
    root.hidden = true;

    // Hand focus back where it came from, but only where that means
    // something: body.focus() is a no-op, so asking for it would leave focus
    // wherever blur() just put it, which is what we want anyway.
    if (
      restoreFocusTo !== null &&
      restoreFocusTo !== document.body &&
      restoreFocusTo.isConnected === true &&
      typeof restoreFocusTo.focus === 'function'
    ) {
      restoreFocusTo.focus();
    }
    restoreFocusTo = null;
  }

  /* ------------------------------------------------------------- keyboard */

  /** True when the keystroke belongs to something the person is typing in. */
  function typingInto(target) {
    if (target === null || target === undefined) return false;
    // The console's own field is not the page's: a key arriving from it while
    // the console is shut is a stray, not someone writing a note.
    if (typeof target.closest === 'function' && target.closest('#cmd') !== null) return false;
    var tag = (target.tagName || '').toUpperCase();
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target.isContentEditable === true;
  }

  document.addEventListener('keydown', function (event) {
    if (open) {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        if (rows.length > 0) { active = (active + 1) % rows.length; render(); }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        if (rows.length > 0) { active = (active - 1 + rows.length) % rows.length; render(); }
        return;
      }
      if (event.key === 'Enter') { event.preventDefault(); execute(); return; }
      return;
    }

    // Cmd+K is safe anywhere. Ctrl+K is not: in a text field on macOS it is
    // the system's delete-to-end-of-line, so it is only honoured outside one.
    if (event.key === 'k' || event.key === 'K') {
      if (event.metaKey || (event.ctrlKey && !typingInto(event.target))) {
        event.preventDefault();
        show();
      }
      return;
    }

    // "/" is a character. It opens the console only when it is not being
    // typed into something, and never with a modifier held.
    if (event.key === '/' && !event.metaKey && !event.ctrlKey && !event.altKey && !typingInto(event.target)) {
      event.preventDefault();
      show();
    }
  });

  input.addEventListener('input', function () {
    active = 0;
    render();
  });

  el('cmd-scrim').addEventListener('mousedown', function (event) {
    event.preventDefault();
    close();
  });

  el('cmd-open').addEventListener('click', show);
})();
