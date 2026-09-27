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
  // -1 is "nothing chosen yet", and it is what the console opens on. A
  // pre-selected first row means Enter fires a command the person never
  // picked — so a choice has to be made, by arrowing to it or clicking it,
  // before Enter can run one.
  var active = -1;
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
        /*
         * Fire and close.
         *
         * The answer, what was kept and where it came from all land on the
         * main screen now. Printing them here as well put the same sentence
         * on screen twice, once behind the console's own scrim — so the
         * console gets out of the way and lets the screen answer.
         *
         * The rejection is swallowed because ask() has already displayed it.
         */
        api().ask(arg).catch(function () {});
        return 'close';
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
      name: 'HISTORY',
      arg: '<text>',
      hint: 'What you and Helix have said, across restarts',
      network: true,
      run: function (arg) {
        report(['Reading\u2026']);
        fetch('/brain/conversation?q=' + encodeURIComponent(arg))
          .then(function (res) { return res.json(); })
          .then(function (body) {
            if (body.turns.length === 0) {
              report([arg === '' ? 'Nothing said yet.' : 'Nothing matching "' + arg + '".']);
              return;
            }
            var lines = [
              body.total + ' exchange' + (body.total === 1 ? '' : 's') +
                ' across ' + body.sessions + ' session' + (body.sessions === 1 ? '' : 's') + '.',
              '',
            ];
            // Newest first, and only a handful: this is a glance, not an
            // archive. The whole thing is at GET /brain/conversation.
            body.turns.slice(0, 6).forEach(function (turn) {
              lines.push(turn.at.slice(11, 16) + '  ' + turn.question);
              lines.push('       ' + turn.answer);
            });
            report(lines);
          })
          .catch(function (err) { fail('Could not read it: ' + err.message); });
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
    var withArgument = [['SPEAK', 5], ['ASK', 3], ['HISTORY', 7]];
    for (var w = 0; w < withArgument.length; w += 1) {
      var name = withArgument[w][0];
      if (upper.indexOf(name) !== 0) continue;
      var rest = query.slice(withArgument[w][1]).trim();
      var command = COMMANDS.filter(function (c) { return c.name === name; })[0];
      return [commandRow(command, rest)];
    }

    /*
     * Anything phrased as a question, or opening like something said to
     * Helix rather than looked up, goes to him.
     *
     * This is a routing guess, not the memory policy: the console decides
     * whether a line is something you are saying, and the server decides
     * whether it is something to keep. Being wrong here costs an answer
     * instead of a search — it cannot cause anything to be remembered that
     * the server would not have remembered anyway.
     */
    if (query.slice(-1) === '?' || SPOKEN.test(query)) {
      return [askRow(query)];
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

    return withFallback(results.slice(0, MAX_RESULTS + COMMANDS.length), query);
  }

  /*
   * Openings that read as talking rather than searching. Deliberately a
   * short list of first words: a longer one starts shadowing note titles.
   */
  var SPOKEN =
    /^\s*(?:remember|don'?t\s+forget|do\s+not\s+forget|keep\s+in\s+mind|make\s+a\s+note|always|never|from\s+now\s+on|call\s+me|stop\s+\w+ing|i\s+(?:prefer|like|love|hate|dislike|don'?t|do\s+not))\b/i;

  function askRow(text) {
    return commandRow(
      COMMANDS.filter(function (c) { return c.name === 'ASK'; })[0],
      text
    );
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
    // Clamp, but never back to 0: a shrinking list must not select something
    // on the person's behalf either.
    if (active >= rows.length) active = rows.length === 0 ? -1 : rows.length - 1;

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

  /** Matching no command and no note is not a dead end: say it to him. */
  function withFallback(results, query) {
    return results.length === 0 && query !== '' ? [askRow(query)] : results;
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
    /*
     * Enter with nothing chosen.
     *
     * On an empty console it does nothing, which is the point of opening
     * unselected. With something typed it runs the first row — which is what
     * the typed text resolves to, a matched command or the ASK fallback —
     * because refusing to act on text the person typed and submitted would
     * just be pedantry.
     */
    var row = rows[active === -1 ? 0 : active];
    if (row === undefined || (active === -1 && input.value.trim() === '')) return;
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
    active = -1;
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
        // From nothing, down goes to the first row; -1 + 1 is already 0.
        if (rows.length > 0) { active = (active + 1) % rows.length; render(); }
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        // From nothing, up goes to the last row. The modulo would land on the
        // second to last, because -1 is one before the first and not one
        // after the end.
        if (rows.length > 0) {
          active = active === -1 ? rows.length - 1 : (active - 1 + rows.length) % rows.length;
          render();
        }
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
    active = -1;
    render();
  });

  el('cmd-scrim').addEventListener('mousedown', function (event) {
    event.preventDefault();
    close();
  });

  el('cmd-open').addEventListener('click', show);
})();
