/* Live references: connector search, palette sampling, network controls.

   Kept separate from app.js because it is the one part of the studio that
   touches the network at all. Generation never comes through here. */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var App = window.ForgeApp;
  var state = { connectors: [], online: false, results: [], saved: [] };

  /* ------------------------------------------------------------- palette */

  function luminance(colour) {
    return 0.2126 * colour.r + 0.7152 * colour.g + 0.0722 * colour.b;
  }

  function toHex(colour) {
    return "#" + [colour.r, colour.g, colour.b].map(function (value) {
      return ("0" + Math.max(0, Math.min(255, value)).toString(16)).slice(-2);
    }).join("");
  }

  function isVideoUrl(url) {
    return /\.(mp4|webm|mov|ogv)(\?|$)/i.test(String(url || ""));
  }

  function mediaNode(record, options) {
    options = options || {};
    var url = record.local_url || record.thumb_url || record.image_url || "";
    if (isVideoUrl(url)) {
      var video = document.createElement("video");
      video.src = url;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = "metadata";
      if (options.autoplay) { video.autoplay = true; }
      return video;
    }
    var image = document.createElement("img");
    image.src = url;
    image.alt = record.title || "";
    if (options.lazy) { image.loading = "lazy"; }
    if (options.noReferrer) { image.referrerPolicy = "no-referrer"; }
    return image;
  }

  /* Sample a palette in the browser: it handles every format the page can
     display, so no image decoder is needed on the server. The file is served
     from our own origin, so the canvas is never tainted. A clip is sampled
     from its first frame. */
  function extractPalette(url, count) {
    return new Promise(function (resolve) {
      if (!url) { resolve([]); return; }
      if (isVideoUrl(url)) {
        var clip = document.createElement("video");
        clip.muted = true;
        clip.playsInline = true;
        clip.preload = "auto";
        clip.addEventListener("loadeddata", function () {
          sampleFrom(clip, count, resolve);
        });
        clip.addEventListener("error", function () { resolve([]); });
        clip.src = url;
        return;
      }
      var image = new Image();
      image.onload = function () {
        sampleFrom(image, count, resolve);
      };
      image.onerror = function () { resolve([]); };
      image.src = url;
    });
  }

  function sampleFrom(source, count, resolve) {
    (function () {
        var size = 64;
        var canvas = document.createElement("canvas");
        canvas.width = size;
        canvas.height = size;
        var ctx = canvas.getContext("2d", { willReadFrequently: true });
        var pixels;
        try {
          ctx.drawImage(source, 0, 0, size, size);
          pixels = ctx.getImageData(0, 0, size, size).data;
        } catch (error) {
          resolve([]);            // tainted canvas or a format we cannot read
          return;
        }

        var bins = {};
        for (var i = 0; i < pixels.length; i += 4) {
          if (pixels[i + 3] < 128) { continue; }
          var r = pixels[i], g = pixels[i + 1], b = pixels[i + 2];
          var key = (r >> 4) + "," + (g >> 4) + "," + (b >> 4);
          var bin = bins[key] || (bins[key] = { n: 0, r: 0, g: 0, b: 0 });
          bin.n += 1; bin.r += r; bin.g += g; bin.b += b;
        }

        var ranked = Object.keys(bins).map(function (key) {
          var bin = bins[key];
          return {
            n: bin.n,
            r: Math.round(bin.r / bin.n),
            g: Math.round(bin.g / bin.n),
            b: Math.round(bin.b / bin.n)
          };
        }).sort(function (a, b) { return b.n - a.n; });

        // Take the most common colours, skipping ones too close to a colour
        // already chosen, or the palette collapses into a single hue.
        var picked = [];
        for (var j = 0; j < ranked.length && picked.length < (count || 5); j++) {
          var candidate = ranked[j];
          var distinct = picked.every(function (chosen) {
            return Math.abs(chosen.r - candidate.r) +
                   Math.abs(chosen.g - candidate.g) +
                   Math.abs(chosen.b - candidate.b) > 60;
          });
          if (distinct) { picked.push(candidate); }
        }
        picked.sort(function (a, b) { return luminance(a) - luminance(b); });
        resolve(picked.map(toHex));
    })();
  }

  /* -------------------------------------------------------------- state */

  function loadConnectors() {
    return App.api("/api/connectors").then(function (data) {
      state.connectors = data.connectors || [];
      state.online = !!data.online;
      state.allowed = data.allowed_domains || [];
      state.forced = !!data.online_forced;
      renderNetbar();
      renderConnectorSelect();
      renderConnectorList();
    });
  }

  function renderNetbar() {
    $("online-toggle").checked = state.online;
    $("online-toggle").disabled = state.forced;
    $("online-label").textContent = state.online
      ? "Live connectors on"
      : "Live connectors off";

    // "100% local" stops being true the moment connectors can fetch. Generation
    // is still local either way, so say precisely that instead.
    var localText = $("local-pill-text");
    if (localText) {
      localText.textContent = state.online ? "generation stays local" : "100% local";
      $("local-pill").title = state.online
        ? "Prompts and images never leave this machine. Connectors may fetch reference material."
        : "Nothing leaves this machine";
    }

    var pill = $("engine-pill");
    if (pill && pill.parentNode) {
      var existing = $("net-pill");
      if (state.online && !existing) {
        var badge = document.createElement("span");
        badge.className = "pill pill--warn";
        badge.id = "net-pill";
        badge.textContent = "network on";
        badge.title = "Connectors may reach: " + (state.allowed.join(", ") || "nothing yet");
        pill.parentNode.insertBefore(badge, pill);
      } else if (!state.online && existing) {
        existing.remove();
      } else if (existing) {
        existing.title = "Connectors may reach: " + (state.allowed.join(", ") || "nothing yet");
      }
    }
  }

  function usable() {
    return state.connectors.filter(function (connector) {
      return connector.enabled && connector.configured;
    });
  }

  function renderConnectorSelect() {
    var select = $("ref-connector");
    var previous = select.value;
    select.innerHTML = "";
    var options = usable();
    if (!options.length) {
      var none = document.createElement("option");
      none.textContent = "no connectors set up";
      none.value = "";
      select.appendChild(none);
    }
    options.forEach(function (connector) {
      var option = document.createElement("option");
      option.value = connector.id;
      option.textContent = connector.label;
      select.appendChild(option);
    });
    if (previous) { select.value = previous; }
    updateSearchHint();
  }

  function currentConnector() {
    var id = $("ref-connector").value;
    return state.connectors.filter(function (c) { return c.id === id; })[0] || null;
  }

  function updateSearchHint() {
    var connector = currentConnector();
    var isUrl = connector && connector.id === "webpage";
    $("ref-query").placeholder = isUrl
      ? "Paste a page URL to import"
      : "Search for reference material";
    $("ref-search-btn").textContent = isUrl ? "Import" : "Search";
    $("ref-hint").textContent = connector
      ? (connector.note || connector.description || "")
      : "Open Connectors to switch one on.";
  }

  /* ------------------------------------------------------------ searching */

  function runSearch() {
    var connector = currentConnector();
    var query = $("ref-query").value.trim();
    if (!connector) { App.toast("Set up a connector first."); return; }
    if (!query) { App.toast("Type something to search for."); return; }
    if (!state.online) { App.toast("Turn live connectors on first."); return; }

    $("ref-empty").hidden = false;
    $("ref-empty").textContent = "Searching " + connector.label + "…";
    $("ref-grid").innerHTML = "";

    var request = connector.id === "webpage"
      ? App.api("/api/references/import", { method: "POST", body: { url: query } })
      : App.api("/api/references/search?connector=" + encodeURIComponent(connector.id) +
                "&q=" + encodeURIComponent(query) + "&limit=18");

    request.then(function (data) {
      state.results = data.results || [];
      renderResults();
    }).catch(function (error) {
      $("ref-empty").hidden = false;
      $("ref-empty").textContent = error.message;
      App.toast(error.message);
    });
  }

  function renderResults() {
    var grid = $("ref-grid");
    grid.innerHTML = "";
    if (!state.results.length) {
      $("ref-empty").hidden = false;
      $("ref-empty").textContent = "Nothing came back for that.";
      return;
    }
    $("ref-empty").hidden = true;
    state.results.forEach(function (result) {
      grid.appendChild(buildResultCard(result));
    });
  }

  function buildResultCard(result) {
    var card = document.createElement("figure");
    card.className = "card card--ref";
    card.title = "Use as reference";

    if (result.thumb_url || result.image_url) {
      var node = mediaNode(result, { lazy: true, noReferrer: true });
      node.onerror = function () { node.replaceWith(placeholder(result)); };
      card.appendChild(node);
      if (result.kind === "video") {
        var badge = document.createElement("span");
        badge.className = "card__clip";
        badge.textContent = "clip";
        card.appendChild(badge);
      }
    } else {
      card.appendChild(placeholder(result));
    }

    var source = document.createElement("span");
    source.className = "card__src";
    source.textContent = result.source;
    card.appendChild(source);

    var label = document.createElement("figcaption");
    label.className = "card__label";
    label.textContent = result.title || "(untitled)";
    card.appendChild(label);

    card.addEventListener("click", function () { useResult(result, card); });
    return card;
  }

  function placeholder(result) {
    var box = document.createElement("div");
    box.className = "card__none";
    box.textContent = result.summary
      ? result.summary.slice(0, 110)
      : (result.title || "no image");
    box.title = result.summary || result.title || "";
    return box;
  }

  function useResult(result, card) {
    if (card) { card.style.opacity = "0.5"; }
    App.api("/api/references", { method: "POST", body: { reference: result } })
      .then(function (record) {
        state.saved.unshift(record);
        renderSaved();
        return extractPalette(record.local_url, 5).then(function (palette) {
          App.setReference(record, palette);
          var terms = (record.prompt_terms || []).slice(0, 3).join(", ");
          App.toast(record.local_url
            ? "Reference attached" + (palette.length ? " with its palette." : ".")
            : "Saved the text; its image host is not on the allowlist.", "ok");
          if (!record.local_url && terms) { App.appendPrompt(terms); }
        });
      })
      .catch(function (error) { App.toast(error.message); })
      .then(function () { if (card) { card.style.opacity = ""; } });
  }

  /* --------------------------------------------------------------- saved */

  function loadSaved() {
    return App.api("/api/references?limit=24").then(function (data) {
      state.saved = data.items || [];
      renderSaved();
    }).catch(function () { /* the panel still works without history */ });
  }

  function renderSaved() {
    var grid = $("saved-grid");
    grid.innerHTML = "";
    $("saved-head").hidden = state.saved.length === 0;
    state.saved.forEach(function (record) {
      var card = document.createElement("figure");
      card.className = "card card--ref";
      card.title = record.title;

      if (record.local_url) {
        card.appendChild(mediaNode(record, { lazy: true }));
        if (record.kind === "video") {
          var clipBadge = document.createElement("span");
          clipBadge.className = "card__clip";
          clipBadge.textContent = "clip";
          card.appendChild(clipBadge);
        }
      } else {
        card.appendChild(placeholder(record));
      }

      var label = document.createElement("figcaption");
      label.className = "card__label";
      label.textContent = record.title || "(untitled)";
      card.appendChild(label);

      card.addEventListener("click", function () {
        extractPalette(record.local_url, 5).then(function (palette) {
          App.setReference(record, palette);
          App.toast("Reference attached.", "ok");
        });
      });
      grid.appendChild(card);
    });
  }

  /* ---------------------------------------------------------- connectors */

  function renderConnectorList() {
    var host = $("connector-list");
    host.innerHTML = "";
    state.connectors.forEach(function (connector) {
      host.appendChild(buildConnectorRow(connector));
    });
  }

  function buildConnectorRow(connector) {
    var row = document.createElement("div");
    row.className = "connector";

    var head = document.createElement("div");
    head.className = "connector__head";
    var name = document.createElement("strong");
    name.textContent = connector.label;
    head.appendChild(name);

    var stateLabel = document.createElement("span");
    stateLabel.className = "connector__state " +
      (connector.configured ? "is-ready" : "is-missing");
    stateLabel.textContent = connector.configured
      ? (connector.enabled ? "ready" : "off")
      : "needs " + connector.missing.join(", ");
    head.appendChild(stateLabel);
    row.appendChild(head);

    var description = document.createElement("p");
    description.textContent = connector.description;
    row.appendChild(description);

    if (connector.note) {
      var note = document.createElement("p");
      note.className = "connector__note";
      note.textContent = connector.note;
      row.appendChild(note);
    }

    var inputs = {};
    if (connector.credential_fields.length) {
      var fields = document.createElement("div");
      fields.className = "connector__fields";
      var advanced = document.createElement("div");
      advanced.className = "connector__fields";

      connector.credential_fields.forEach(function (field) {
        var input = document.createElement("input");
        input.type = field.secret ? "password" : "text";
        input.placeholder = field.label + (field.required ? "" : " (optional)") +
          (field.placeholder ? " — " + field.placeholder : "");
        input.autocomplete = "off";
        inputs[field.name] = input;
        (field.advanced ? advanced : fields).appendChild(input);
      });

      row.appendChild(fields);
      if (advanced.children.length) {
        // Overrides for an unusual API: out of the way until needed.
        var details = document.createElement("details");
        details.className = "connector__advanced";
        var summary = document.createElement("summary");
        summary.textContent = "Field mapping — only if auto-detection misses";
        details.appendChild(summary);
        details.appendChild(advanced);
        row.appendChild(details);
      }
    }

    var actions = document.createElement("div");
    actions.className = "connector__actions";

    if (connector.credential_fields.length) {
      var save = document.createElement("button");
      save.className = "btn btn--primary";
      save.textContent = "Save keys";
      save.addEventListener("click", function () {
        var values = {};
        Object.keys(inputs).forEach(function (key) {
          if (inputs[key].value.trim()) { values[key] = inputs[key].value.trim(); }
        });
        if (!Object.keys(values).length) { App.toast("Nothing to save."); return; }
        App.api("/api/connectors/" + connector.id + "/credentials",
                { method: "POST", body: values })
          .then(function () {
            App.toast(connector.label + " keys saved on this machine.", "ok");
            Object.keys(inputs).forEach(function (key) { inputs[key].value = ""; });
            return loadConnectors();
          })
          .catch(function (error) { App.toast(error.message); });
      });
      actions.appendChild(save);
    }

    var toggle = document.createElement("button");
    toggle.className = "btn btn--ghost";
    toggle.textContent = connector.enabled ? "Switch off" : "Switch on";
    toggle.addEventListener("click", function () {
      App.api("/api/connectors/" + connector.id + "/enabled",
              { method: "POST", body: { enabled: !connector.enabled } })
        .then(loadConnectors)
        .catch(function (error) { App.toast(error.message); });
    });
    actions.appendChild(toggle);

    if (connector.configured && connector.enabled) {
      var check = document.createElement("button");
      check.className = "btn btn--ghost";
      check.textContent = "Test";
      check.addEventListener("click", function () {
        check.textContent = "Testing…";
        App.api("/api/connectors/" + connector.id + "/check", { method: "POST" })
          .then(function (result) {
            App.toast(connector.label + ": " + result.detail, result.ok ? "ok" : "");
          })
          .catch(function (error) { App.toast(error.message); })
          .then(function () { check.textContent = "Test"; });
      });
      actions.appendChild(check);
    }

    if (connector.docs_url) {
      var docs = document.createElement("a");
      docs.className = "btn btn--ghost";
      docs.href = connector.docs_url;
      docs.target = "_blank";
      docs.rel = "noopener noreferrer";
      docs.textContent = "Get keys";
      actions.appendChild(docs);
    }

    row.appendChild(actions);
    return row;
  }

  /* --------------------------------------------------------- network log */

  function showNetworkLog() {
    $("network-panel").hidden = false;
    App.api("/api/network/log?limit=120").then(function (data) {
      $("allowlist-note").textContent = data.allowed_domains.length
        ? "Reachable hosts: " + data.allowed_domains.join(", ")
        : "No hosts are reachable right now.";

      var host = $("network-entries");
      host.innerHTML = "";
      if (!data.entries.length) {
        var empty = document.createElement("p");
        empty.className = "empty";
        empty.textContent = "Nothing has been requested yet.";
        host.appendChild(empty);
        return;
      }

      var table = document.createElement("table");
      table.className = "netlog";
      table.innerHTML = "<tr><th>When</th><th>Source</th><th>Status</th><th>URL</th></tr>";
      data.entries.forEach(function (entry) {
        var row = table.insertRow();
        row.insertCell().textContent = new Date(entry.ts * 1000).toLocaleTimeString();
        row.insertCell().textContent = entry.connector;
        var status = row.insertCell();
        status.textContent = entry.status === null ? "-" : entry.status;
        if (entry.status === "blocked") { status.className = "is-blocked"; }
        var url = row.insertCell();
        url.className = "url";
        url.textContent = entry.url;
        if (entry.error) { url.title = entry.error; }
      });
      host.appendChild(table);
    }).catch(function (error) { App.toast(error.message); });
  }

  /* ---------------------------------------------------------------- boot */

  function showPanel(which) {
    var references = which === "references";
    $("panel-gallery").hidden = references;
    $("panel-references").hidden = !references;
    $("gallery-tools").hidden = references;
    $("tab-gallery").classList.toggle("is-active", !references);
    $("tab-references").classList.toggle("is-active", references);
    $("tab-gallery").setAttribute("aria-selected", String(!references));
    $("tab-references").setAttribute("aria-selected", String(references));
    if (references && !state.connectors.length) { loadConnectors(); }
  }

  function boot() {
    if (!App) { return; }

    $("tab-gallery").addEventListener("click", function () { showPanel("gallery"); });
    $("tab-references").addEventListener("click", function () { showPanel("references"); });
    $("ref-connector").addEventListener("change", updateSearchHint);
    $("ref-search-btn").addEventListener("click", runSearch);
    $("ref-query").addEventListener("keydown", function (event) {
      if (event.key === "Enter") { event.preventDefault(); runSearch(); }
    });

    $("online-toggle").addEventListener("change", function (event) {
      App.api("/api/connectors/online",
              { method: "POST", body: { online: event.target.checked } })
        .then(function (data) {
          state.online = !!data.online;
          state.allowed = data.allowed_domains || [];
          renderNetbar();
          App.toast(state.online
            ? "Live connectors on. Generation still runs locally."
            : "Live connectors off. Nothing can leave this machine.", "ok");
        })
        .catch(function (error) {
          event.target.checked = state.online;
          App.toast(error.message);
        });
    });

    $("connectors-setup").addEventListener("click", function () {
      $("connectors-panel").hidden = false;
      loadConnectors();
    });
    $("connectors-close").addEventListener("click", function () {
      $("connectors-panel").hidden = true;
    });
    $("connectors-panel").addEventListener("click", function (event) {
      if (event.target === $("connectors-panel")) { $("connectors-panel").hidden = true; }
    });

    $("network-log-btn").addEventListener("click", showNetworkLog);
    $("network-close").addEventListener("click", function () {
      $("network-panel").hidden = true;
    });
    $("network-panel").addEventListener("click", function (event) {
      if (event.target === $("network-panel")) { $("network-panel").hidden = true; }
    });

    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        $("connectors-panel").hidden = true;
        $("network-panel").hidden = true;
      }
    });

    loadConnectors().then(loadSaved).catch(function () { /* offline is fine */ });
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
