/* Avernal Forge - studio client.
   Plain ES modules-free JavaScript: no build step, no CDN, works offline. */

(function () {
  "use strict";

  var $ = function (id) { return document.getElementById(id); };
  var PAGE = 40;
  var KEY_STORE = "forge.apiKey";
  var SETTINGS_STORE = "forge.settings";

  var state = {
    config: null,
    items: [],
    total: 0,
    offset: 0,
    query: "",
    favouritesOnly: false,
    job: null,
    stage: [],
    lightboxIndex: -1,
    lightboxSource: [],
    events: null,
    retry: 0,
    reference: null
  };

  var SUGGESTIONS = [
    "a crimson desert horizon at sunset",
    "deep blue cosmic nebula with stars",
    "neon cyberpunk city grid at night",
    "soft pastel abstract fluid swirl",
    "emerald forest valley in morning mist",
    "monochrome noir portrait, harsh shadows"
  ];

  /* ------------------------------------------------------------ helpers */

  function apiKey() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }

  function api(path, options) {
    options = options || {};
    var headers = options.headers || {};
    if (options.body) { headers["Content-Type"] = "application/json"; }
    var key = apiKey();
    if (key) { headers["Authorization"] = "Bearer " + key; }
    return fetch(path, {
      method: options.method || "GET",
      headers: headers,
      body: options.body ? JSON.stringify(options.body) : undefined
    }).then(function (response) {
      return response.text().then(function (text) {
        var data = null;
        try { data = text ? JSON.parse(text) : null; } catch (e) { data = null; }
        if (!response.ok) {
          if (response.status === 401) { promptForKey(); }
          var message = (data && data.error && data.error.message) ||
            ("request failed (" + response.status + ")");
          throw new Error(message);
        }
        return data;
      });
    });
  }

  function promptForKey() {
    var entered = window.prompt("This Forge server requires an API key:");
    if (entered) {
      try { localStorage.setItem(KEY_STORE, entered.trim()); } catch (e) { /* ignore */ }
      location.reload();
    }
  }

  function toast(message, kind) {
    var node = document.createElement("div");
    node.className = "toast" + (kind === "ok" ? " toast--ok" : "");
    node.textContent = message;
    $("toasts").appendChild(node);
    setTimeout(function () {
      node.style.opacity = "0";
      setTimeout(function () { node.remove(); }, 250);
    }, kind === "ok" ? 2600 : 5200);
  }

  function bytes(value) {
    if (!value) { return "0 B"; }
    var units = ["B", "KB", "MB", "GB"];
    var index = 0;
    while (value >= 1024 && index < units.length - 1) { value /= 1024; index++; }
    return value.toFixed(value < 10 && index > 0 ? 1 : 0) + " " + units[index];
  }

  function when(seconds) {
    var delta = Date.now() / 1000 - seconds;
    if (delta < 60) { return "just now"; }
    if (delta < 3600) { return Math.floor(delta / 60) + "m ago"; }
    if (delta < 86400) { return Math.floor(delta / 3600) + "h ago"; }
    return new Date(seconds * 1000).toLocaleDateString();
  }

  /* ------------------------------------------------------------- boot */

  function boot() {
    renderSuggestions();
    bindControls();
    restoreSettings();

    api("/api/config").then(function (config) {
      state.config = config;
      applyConfig(config);
      loadGallery(true);
      connectEvents();
    }).catch(function (error) {
      toast("Could not reach the Forge server: " + error.message);
    });
  }

  function applyConfig(config) {
    var models = $("model");
    models.innerHTML = "";
    (config.models || []).forEach(function (model) {
      var option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.name + (model.kind === "builtin" ? "" : "  (" + model.kind + ")");
      option.dataset.engine = model.engine;
      models.appendChild(option);
    });
    if (!models.options.length) {
      var none = document.createElement("option");
      none.textContent = "no models found";
      models.appendChild(none);
    }

    var samplers = $("sampler");
    samplers.innerHTML = "";
    (config.samplers || []).forEach(function (sampler) {
      var option = document.createElement("option");
      option.value = sampler.id;
      option.textContent = sampler.label;
      samplers.appendChild(option);
    });
    samplers.value = (config.defaults && config.defaults.sampler) || "euler_a";

    var active = (config.engines || []).filter(function (engine) {
      return engine.id === config.default_engine;
    })[0];
    if (active) {
      $("engine-pill").textContent = active.id + " · " + active.device;
      $("engine-pill").title = active.description;
      $("model-hint").textContent = active.neural
        ? "Weights loaded from disk."
        : "Built-in renderer — add model weights for Stable Diffusion.";
      $("model-hint").title = config.paths.models;
    }

    var neural = (config.engines || []).filter(function (e) { return e.neural; })[0];
    if (neural && !neural.available && neural.reason) {
      $("model-warn").textContent = neural.reason;
      $("model-warn").title = neural.reason;
      $("model-warn").hidden = false;
    }

    updateStats(config.stats);

    var limits = config.limits || {};
    $("width").max = limits.max_side || 2048;
    $("height").max = limits.max_side || 2048;
    $("batch").max = limits.max_batch || 8;
    $("steps").max = Math.min(limits.max_steps || 60, 60);
    renderApiDocs();
  }

  function updateStats(stats) {
    if (!stats) { return; }
    $("stats-pill").textContent = stats.images + " images · " + bytes(stats.bytes_on_disk);
  }

  function renderSuggestions() {
    var host = $("suggestions");
    SUGGESTIONS.forEach(function (text) {
      var chip = document.createElement("button");
      chip.type = "button";
      chip.className = "chip";
      chip.textContent = text;
      chip.addEventListener("click", function () {
        $("prompt").value = text;
        $("prompt").focus();
      });
      host.appendChild(chip);
    });
  }

  /* --------------------------------------------------------- settings */

  function currentSettings() {
    return {
      prompt: $("prompt").value,
      negative: $("negative").value,
      width: parseInt($("width").value, 10) || 512,
      height: parseInt($("height").value, 10) || 512,
      steps: parseInt($("steps").value, 10) || 24,
      guidance: parseFloat($("guidance").value),
      batch: parseInt($("batch").value, 10) || 1,
      seed: $("seed").value === "" ? -1 : parseInt($("seed").value, 10),
      sampler: $("sampler").value,
      model: $("model").value
    };
  }

  function saveSettings() {
    try {
      localStorage.setItem(SETTINGS_STORE, JSON.stringify(currentSettings()));
    } catch (e) { /* private mode - not worth failing over */ }
  }

  function restoreSettings() {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(SETTINGS_STORE) || "null"); } catch (e) { saved = null; }
    var defaults = { width: 512, height: 512, steps: 24, guidance: 7, batch: 1, seed: -1 };
    var values = saved || defaults;
    $("prompt").value = values.prompt || "";
    $("negative").value = values.negative || "";
    if (values.negative) { $("negative-wrap").open = true; }
    $("width").value = values.width || 512;
    $("height").value = values.height || 512;
    $("steps").value = values.steps || 24;
    $("guidance").value = values.guidance === undefined ? 7 : values.guidance;
    $("batch").value = values.batch || 1;
    $("seed").value = values.seed === undefined || values.seed < 0 ? "" : values.seed;
    syncOutputs();
    markActiveSizeChip();
  }

  function syncOutputs() {
    $("steps-out").textContent = $("steps").value;
    $("guidance-out").textContent = parseFloat($("guidance").value).toFixed(1);
    $("batch-out").textContent = $("batch").value;
  }

  function markActiveSizeChip() {
    var width = $("width").value;
    var height = $("height").value;
    Array.prototype.forEach.call($("size-chips").children, function (chip) {
      chip.classList.toggle("is-active", chip.dataset.w === width && chip.dataset.h === height);
    });
  }

  /* --------------------------------------------------------- controls */

  function bindControls() {
    ["steps", "guidance", "batch"].forEach(function (id) {
      $(id).addEventListener("input", syncOutputs);
    });
    ["width", "height"].forEach(function (id) {
      $(id).addEventListener("input", markActiveSizeChip);
    });

    Array.prototype.forEach.call($("size-chips").children, function (chip) {
      chip.addEventListener("click", function () {
        $("width").value = chip.dataset.w;
        $("height").value = chip.dataset.h;
        markActiveSizeChip();
      });
    });

    $("swap-size").addEventListener("click", function () {
      var width = $("width").value;
      $("width").value = $("height").value;
      $("height").value = width;
      markActiveSizeChip();
    });

    $("random-seed").addEventListener("click", function () {
      $("seed").value = Math.floor(Math.random() * 2147483647);
    });

    $("compose-form").addEventListener("submit", function (event) {
      event.preventDefault();
      generate();
    });

    $("cancel-btn").addEventListener("click", function () {
      if (!state.job) { return; }
      api("/api/jobs/" + state.job.id + "/cancel", { method: "POST" })
        .catch(function (error) { toast(error.message); });
    });

    document.addEventListener("keydown", function (event) {
      if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
        event.preventDefault();
        generate();
      }
      if (event.key === "Escape") { closeLightbox(); closeApiPanel(); }
      if ($("lightbox").hidden) { return; }
      if (event.key === "ArrowLeft") { stepLightbox(-1); }
      if (event.key === "ArrowRight") { stepLightbox(1); }
    });

    var searchTimer = null;
    $("gallery-search").addEventListener("input", function (event) {
      clearTimeout(searchTimer);
      var value = event.target.value.trim();
      searchTimer = setTimeout(function () {
        state.query = value;
        loadGallery(true);
      }, 220);
    });

    $("fav-filter").addEventListener("click", function () {
      state.favouritesOnly = !state.favouritesOnly;
      $("fav-filter").setAttribute("aria-pressed", String(state.favouritesOnly));
      loadGallery(true);
    });

    $("load-more").addEventListener("click", function () { loadGallery(false); });

    $("lightbox-close").addEventListener("click", closeLightbox);
    $("lightbox-prev").addEventListener("click", function () { stepLightbox(-1); });
    $("lightbox-next").addEventListener("click", function () { stepLightbox(1); });
    $("lightbox").addEventListener("click", function (event) {
      if (event.target === $("lightbox")) { closeLightbox(); }
    });
    $("lightbox-reuse").addEventListener("click", reuseSettings);
    $("lightbox-fav").addEventListener("click", toggleFavourite);
    $("lightbox-delete").addEventListener("click", deleteCurrent);

    $("reference-clear").addEventListener("click", clearReference);
    $("api-help-btn").addEventListener("click", function () { $("api-panel").hidden = false; });
    $("api-close").addEventListener("click", closeApiPanel);
    $("api-panel").addEventListener("click", function (event) {
      if (event.target === $("api-panel")) { closeApiPanel(); }
    });
  }

  /* -------------------------------------------------------- generation */

  function generate() {
    var settings = currentSettings();
    if (!settings.prompt.trim()) {
      toast("Write a prompt first.");
      $("prompt").focus();
      return;
    }
    saveSettings();
    setBusy(true);
    setProgress(0, "queued", "");

    var selected = $("model").selectedOptions[0];
    var payload = {
      prompt: settings.prompt,
      negative: settings.negative,
      width: settings.width,
      height: settings.height,
      steps: settings.steps,
      guidance: settings.guidance,
      batch: settings.batch,
      seed: settings.seed,
      sampler: settings.sampler
    };
    if (selected && selected.dataset.engine) {
      payload.engine = selected.dataset.engine;
      payload.model = selected.value;
    }

    var reference = state.reference;
    if (reference) {
      if ($("reference-palette").checked && reference.palette && reference.palette.length > 1) {
        payload.palette = reference.palette;
      }
      if ($("reference-init").checked && !$("reference-init").disabled) {
        payload.reference_id = reference.id;
      }
    }

    api("/api/generate", { method: "POST", body: payload })
      .then(function (job) {
        state.job = job;
        state.stage = [];
        $("stage-grid").innerHTML = "";
      })
      .catch(function (error) {
        setBusy(false);
        toast(error.message);
      });
  }

  function setBusy(busy) {
    $("generate-btn").disabled = busy;
    $("generate-btn").textContent = busy ? "Generating…" : "Generate";
    $("cancel-btn").hidden = !busy;
    $("stage-progress").hidden = !busy;
    if (!busy) { state.job = null; }
  }

  function setProgress(fraction, note, count) {
    $("progress-bar").style.width = Math.round(fraction * 100) + "%";
    $("progress-note").textContent = note || "working";
    $("progress-count").textContent = count || "";
  }

  /* ------------------------------------------------------------ events */

  function connectEvents() {
    if (state.events) { state.events.close(); }
    var url = "/api/events";
    var key = apiKey();
    if (key) { url += "?key=" + encodeURIComponent(key); }
    var source = new EventSource(url);
    state.events = source;

    source.onopen = function () { state.retry = 0; };

    source.onmessage = function (event) {
      var data;
      try { data = JSON.parse(event.data); } catch (e) { return; }
      if (data.type === "job") { onJob(data.job); }
      if (data.type === "image") { onImage(data.image); }
    };

    source.onerror = function () {
      source.close();
      state.retry = Math.min(state.retry + 1, 6);
      setTimeout(connectEvents, 500 * Math.pow(2, state.retry - 1));
    };
  }

  function onJob(job) {
    if (!state.job || job.id !== state.job.id) { return; }
    state.job = job;
    if (job.status === "running" || job.status === "queued") {
      var count = job.total ? job.step + " / " + job.total : "";
      setProgress(job.progress, job.note || job.status, count);
      return;
    }
    setBusy(false);
    if (job.status === "error") { toast(job.error || "Generation failed."); }
    if (job.status === "cancelled") { toast("Cancelled.", "ok"); }
    if (job.status === "done") {
      var seconds = job.finished_at && job.started_at
        ? (job.finished_at - job.started_at).toFixed(1) : "?";
      toast(job.images.length + " image" + (job.images.length === 1 ? "" : "s") +
        " in " + seconds + "s", "ok");
      refreshStats();
    }
  }

  function onImage(image) {
    state.stage.push(image);
    state.items.unshift(image);
    state.total += 1;
    showStage();
    prependCard(image);
  }

  function showStage() {
    $("stage-empty").hidden = true;
    var grid = $("stage-grid");
    grid.hidden = false;
    grid.innerHTML = "";
    state.stage.forEach(function (image) {
      var img = document.createElement("img");
      img.src = image.url;
      img.alt = image.prompt;
      img.addEventListener("click", function () {
        openLightbox(state.stage.indexOf(image), state.stage);
      });
      grid.appendChild(img);
    });
  }

  function refreshStats() {
    api("/api/config").then(function (config) {
      state.config = config;
      updateStats(config.stats);
    }).catch(function () { /* stats are cosmetic */ });
  }

  /* ----------------------------------------------------------- gallery */

  function loadGallery(reset) {
    if (reset) { state.offset = 0; }
    var params = "?limit=" + PAGE + "&offset=" + state.offset;
    if (state.query) { params += "&q=" + encodeURIComponent(state.query); }
    if (state.favouritesOnly) { params += "&favorites=1"; }

    api("/api/gallery" + params).then(function (page) {
      state.total = page.total;
      if (reset) {
        state.items = page.items;
        $("gallery-grid").innerHTML = "";
      } else {
        state.items = state.items.concat(page.items);
      }
      page.items.forEach(function (image) { appendCard(image); });
      state.offset += page.items.length;
      $("gallery-empty").hidden = state.items.length > 0;
      $("load-more").hidden = state.items.length >= state.total;
    }).catch(function (error) { toast(error.message); });
  }

  function buildCard(image) {
    var card = document.createElement("figure");
    card.className = "card";
    card.dataset.id = image.id;

    var img = document.createElement("img");
    img.src = image.url;
    img.alt = image.prompt;
    img.loading = "lazy";
    card.appendChild(img);

    if (image.favorite) {
      var star = document.createElement("span");
      star.className = "card__fav";
      star.textContent = "★";
      card.appendChild(star);
    }

    var label = document.createElement("figcaption");
    label.className = "card__label";
    label.textContent = image.prompt || "(no prompt)";
    card.appendChild(label);

    card.addEventListener("click", function () {
      openLightbox(indexOfImage(image.id), state.items);
    });
    return card;
  }

  function appendCard(image) { $("gallery-grid").appendChild(buildCard(image)); }

  function prependCard(image) {
    var grid = $("gallery-grid");
    grid.insertBefore(buildCard(image), grid.firstChild);
    $("gallery-empty").hidden = true;
  }

  function indexOfImage(id) {
    for (var i = 0; i < state.items.length; i++) {
      if (state.items[i].id === id) { return i; }
    }
    return -1;
  }

  /* ---------------------------------------------------------- lightbox */

  function openLightbox(index, source) {
    if (index < 0) { return; }
    state.lightboxSource = source || state.items;
    state.lightboxIndex = index;
    renderLightbox();
    $("lightbox").hidden = false;
  }

  function closeLightbox() { $("lightbox").hidden = true; }
  function closeApiPanel() { $("api-panel").hidden = true; }

  function stepLightbox(delta) {
    var next = state.lightboxIndex + delta;
    if (next < 0 || next >= state.lightboxSource.length) { return; }
    state.lightboxIndex = next;
    renderLightbox();
  }

  function currentImage() { return state.lightboxSource[state.lightboxIndex]; }

  function renderLightbox() {
    var image = currentImage();
    if (!image) { return; }
    $("lightbox-img").src = image.url;
    $("lightbox-img").alt = image.prompt;
    $("lightbox-prompt").textContent = image.prompt || "(no prompt)";
    $("lightbox-download").href = image.url;
    $("lightbox-download").setAttribute("download", "forge-" + image.seed + ".png");
    $("lightbox-fav").textContent = image.favorite ? "★ Favourited" : "☆ Favourite";

    var rows = [
      ["Seed", image.seed],
      ["Size", image.width + " × " + image.height],
      ["Steps", image.steps],
      ["Guidance", image.guidance],
      ["Engine", image.engine],
      ["Model", image.model],
      ["Sampler", image.sampler],
      ["Made", when(image.created_at)]
    ];
    if (image.negative) { rows.push(["Negative", image.negative]); }
    if (image.extra && image.extra.style) { rows.push(["Style", image.extra.style]); }
    if (image.duration_ms) { rows.push(["Render", (image.duration_ms / 1000).toFixed(1) + "s"]); }

    var list = $("lightbox-dl");
    list.innerHTML = "";
    rows.forEach(function (row) {
      if (row[1] === undefined || row[1] === null || row[1] === "") { return; }
      var dt = document.createElement("dt");
      dt.textContent = row[0];
      var dd = document.createElement("dd");
      dd.textContent = String(row[1]);
      list.appendChild(dt);
      list.appendChild(dd);
    });
  }

  function reuseSettings() {
    var image = currentImage();
    if (!image) { return; }
    $("prompt").value = image.prompt || "";
    $("negative").value = image.negative || "";
    if (image.negative) { $("negative-wrap").open = true; }
    $("width").value = image.width;
    $("height").value = image.height;
    $("steps").value = image.steps;
    $("guidance").value = image.guidance;
    $("seed").value = image.seed;
    if (image.sampler) { $("sampler").value = image.sampler; }
    syncOutputs();
    markActiveSizeChip();
    saveSettings();
    closeLightbox();
    toast("Settings loaded into the composer.", "ok");
  }

  function toggleFavourite() {
    var image = currentImage();
    if (!image) { return; }
    api("/api/gallery/" + image.id + "/favorite", {
      method: "POST",
      body: { favorite: !image.favorite }
    }).then(function (updated) {
      Object.assign(image, updated);
      renderLightbox();
      var card = document.querySelector('.card[data-id="' + image.id + '"]');
      if (card) { card.replaceWith(buildCard(image)); }
    }).catch(function (error) { toast(error.message); });
  }

  function deleteCurrent() {
    var image = currentImage();
    if (!image || !window.confirm("Delete this image from disk?")) { return; }
    api("/api/gallery/" + image.id, { method: "DELETE" }).then(function () {
      var card = document.querySelector('.card[data-id="' + image.id + '"]');
      if (card) { card.remove(); }
      state.items = state.items.filter(function (item) { return item.id !== image.id; });
      state.stage = state.stage.filter(function (item) { return item.id !== image.id; });
      state.total = Math.max(0, state.total - 1);
      showStageOrEmpty();
      closeLightbox();
      toast("Deleted.", "ok");
      refreshStats();
    }).catch(function (error) { toast(error.message); });
  }

  function showStageOrEmpty() {
    if (state.stage.length) { showStage(); return; }
    $("stage-grid").hidden = true;
    $("stage-empty").hidden = false;
    $("gallery-empty").hidden = state.items.length > 0;
  }


  /* -------------------------------------------------------- references */

  function setReference(record, palette) {
    state.reference = {
      id: record.id,
      title: record.title || "Untitled",
      source: record.source || "",
      license: record.license || "",
      url: record.local_url || "",
      palette: palette || []
    };

    $("reference-thumb").src = state.reference.url;
    $("reference-thumb").alt = state.reference.title;
    $("reference-title").textContent = state.reference.title;
    $("reference-meta").textContent = [state.reference.source, state.reference.license]
      .filter(Boolean).join(" · ");

    var swatches = $("reference-swatches");
    swatches.innerHTML = "";
    (state.reference.palette || []).forEach(function (colour) {
      var chip = document.createElement("span");
      chip.style.background = colour;
      chip.title = colour;
      swatches.appendChild(chip);
    });

    var hasPalette = state.reference.palette.length > 1;
    $("reference-palette").checked = hasPalette;
    $("reference-palette").disabled = !hasPalette;

    // img2img needs a diffusion model; the procedural engine cannot start
    // from an image, so the control says so rather than failing later.
    var engine = state.config && (state.config.engines || []).filter(function (e) {
      return e.id === state.config.default_engine;
    })[0];
    var canInit = !!(engine && engine.neural) && !!state.reference.url;
    $("reference-init").disabled = !canInit;
    $("reference-init").checked = false;
    $("reference-init-hint").textContent = canInit
      ? ""
      : "(needs Stable Diffusion weights)";

    $("reference-slot").hidden = false;
  }

  function clearReference() {
    state.reference = null;
    $("reference-slot").hidden = true;
  }

  /* --------------------------------------------------------- API panel */

  function renderApiDocs() {
    var origin = location.origin;
    $("api-curl").textContent =
      "curl -X POST " + origin + "/v1/images/generations \\\n" +
      "  -H 'Content-Type: application/json' \\\n" +
      "  -d '{\"prompt\": \"a crimson desert horizon\", \"size\": \"512x512\"}'";
    $("api-python").textContent =
      "from openai import OpenAI\n\n" +
      "client = OpenAI(base_url=\"" + origin + "/v1\", api_key=\"local\")\n" +
      "image = client.images.generate(prompt=\"a crimson desert horizon\",\n" +
      "                               size=\"512x512\")";
  }

  window.ForgeApp = {
    api: api,
    toast: toast,
    setReference: setReference,
    clearReference: clearReference,
    appendPrompt: function (text) {
      var field = $("prompt");
      var current = field.value.trim();
      field.value = current ? current + ", " + text : text;
      field.focus();
      saveSettings();
    },
    config: function () { return state.config; }
  };

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", boot);
  } else {
    boot();
  }
})();
