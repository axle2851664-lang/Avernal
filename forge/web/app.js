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
    reference: null,
    presets: [],
    hasNeural: false
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

    // The difference between abstract fields and photorealistic people is
    // weights, not a setting, so say so rather than implying otherwise.
    var hasNeural = (config.engines || []).some(function (engine) {
      return engine.neural && engine.available;
    });
    state.hasNeural = hasNeural;
    $("capability-notice").hidden = hasNeural;
    // The Look list stays readable without a model: it is ignored rather than
    // inapplicable, and the hint says so. The detail pass is a genuine no-op
    // on the procedural engine, so that one really is disabled.
    $("detail-pass").disabled = !hasNeural;
    $("detail-line").classList.toggle("is-off", !hasNeural);
    updateStyleHint();

    updateStats(config.stats);

    var presets = config.presets || [];
    var styleSelect = $("style-preset");
    styleSelect.innerHTML = "";
    presets.forEach(function (preset) {
      var option = document.createElement("option");
      option.value = preset.id;
      option.textContent = preset.label;
      option.dataset.description = preset.description;
      option.dataset.neuralOnly = String(preset.neural_only);
      option.dataset.suggests = JSON.stringify(preset.suggests || {});
      styleSelect.appendChild(option);
    });
    state.presets = presets;

    var video = config.video || {};
    var formats = video.formats || ["apng"];
    var formatSelect = $("video-format");
    formatSelect.innerHTML = "";
    formats.forEach(function (id) {
      var option = document.createElement("option");
      option.value = id;
      option.textContent = id === "mp4" ? "MP4 (H.264)" : "Animated PNG";
      formatSelect.appendChild(option);
    });
    formatSelect.value = video.default_format || formats[0];
    $("video-format-hint").textContent = video.ffmpeg
      ? "MP4 via ffmpeg on this machine."
      : "ffmpeg is not installed, so clips are written as animated PNG. " +
        "Install ffmpeg for smaller MP4 files.";

    var videoChip = $("kind-chips").querySelector('[data-kind="video"]');
    if (video.supported === false) {
      videoChip.disabled = true;
      videoChip.title = "No engine on this machine can produce video.";
    }

    var limits = config.limits || {};
    $("width").max = limits.max_side || 2048;
    $("height").max = limits.max_side || 2048;
    $("batch").max = limits.max_batch || 8;
    $("steps").max = Math.min(limits.max_steps || 60, 60);
    $("frames").max = Math.min(limits.max_frames || 96, 96);
    $("frames").min = limits.min_frames || 2;
    $("fps").max = Math.min(limits.max_fps || 30, 30);
    renderApiDocs();
  }

  function updateStats(stats) {
    if (!stats) { return; }
    var label = stats.images + " item" + (stats.images === 1 ? "" : "s");
    if (stats.videos) { label += " · " + stats.videos + " clip" + (stats.videos === 1 ? "" : "s"); }
    $("stats-pill").textContent = label + " · " + bytes(stats.bytes_on_disk);
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

  function currentKind() {
    var active = $("kind-chips").querySelector(".chip.is-active");
    return active ? active.dataset.kind : "image";
  }

  function currentSettings() {
    return {
      kind: currentKind(),
      style: $("style-preset").value || "none",
      detailPass: $("detail-pass").checked,
      frames: parseInt($("frames").value, 10) || 24,
      fps: parseInt($("fps").value, 10) || 12,
      motion: parseFloat($("motion").value),
      videoFormat: $("video-format").value || "auto",
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
    if (values.style) { $("style-preset").value = values.style; }
    $("detail-pass").checked = !!values.detailPass;
    $("frames").value = values.frames || 24;
    $("fps").value = values.fps || 12;
    $("motion").value = values.motion === undefined ? 1 : values.motion;
    setKind(values.kind === "video" ? "video" : "image");
    syncOutputs();
    markActiveSizeChip();
  }

  function syncOutputs() {
    $("steps-out").textContent = $("steps").value;
    $("guidance-out").textContent = parseFloat($("guidance").value).toFixed(1);
    $("batch-out").textContent = $("batch").value;
    $("frames-out").textContent = $("frames").value;
    $("fps-out").textContent = $("fps").value;
    $("motion-out").textContent = parseFloat($("motion").value).toFixed(1);

    var frames = parseInt($("frames").value, 10) || 1;
    var fps = parseInt($("fps").value, 10) || 1;
    $("kind-hint").textContent = currentKind() === "video"
      ? (frames / fps).toFixed(1) + "s clip, loops seamlessly"
      : "";
  }

  function setKind(kind) {
    $("style-preset").addEventListener("change", function () {
      updateStyleHint();
      applyPresetSuggestions();
      saveSettings();
    });
    $("detail-pass").addEventListener("change", saveSettings);

    Array.prototype.forEach.call($("kind-chips").children, function (chip) {
      chip.classList.toggle("is-active", chip.dataset.kind === kind);
    });
    $("video-fields").hidden = kind !== "video";
    if (!$("generate-btn").disabled) {
      $("generate-btn").textContent = kind === "video" ? "Generate clip" : "Generate";
    }
    syncOutputs();
  }

  function markActiveSizeChip() {
    var width = $("width").value;
    var height = $("height").value;
    Array.prototype.forEach.call($("size-chips").children, function (chip) {
      chip.classList.toggle("is-active", chip.dataset.w === width && chip.dataset.h === height);
    });
  }


  function updateStyleHint() {
    var option = $("style-preset").selectedOptions[0];
    if (!option) { $("style-hint").textContent = ""; return; }
    if (!state.hasNeural && option.dataset.neuralOnly === "true") {
      $("style-hint").textContent =
        "Looks apply to trained models; the built-in renderer ignores them.";
      return;
    }
    $("style-hint").textContent = option.dataset.description || "";
  }

  function applyPresetSuggestions() {
    var option = $("style-preset").selectedOptions[0];
    if (!option || !state.hasNeural) { return; }
    var suggests = {};
    try { suggests = JSON.parse(option.dataset.suggests || "{}"); } catch (e) { return; }

    // Suggestions, not rules: they fill the controls so they stay visible and
    // editable rather than being applied invisibly at generation time.
    if (suggests.steps) { $("steps").value = suggests.steps; }
    if (suggests.guidance) { $("guidance").value = suggests.guidance; }
    if (suggests.width && suggests.height) {
      $("width").value = suggests.width;
      $("height").value = suggests.height;
      markActiveSizeChip();
    }
    if (suggests.detail_pass !== undefined) {
      $("detail-pass").checked = !!suggests.detail_pass;
    }
    syncOutputs();
  }

  /* --------------------------------------------------------- controls */

  function bindControls() {
    ["steps", "guidance", "batch", "frames", "fps", "motion"].forEach(function (id) {
      $(id).addEventListener("input", syncOutputs);
    });

    $("style-preset").addEventListener("change", function () {
      updateStyleHint();
      applyPresetSuggestions();
      saveSettings();
    });
    $("detail-pass").addEventListener("change", saveSettings);

    Array.prototype.forEach.call($("kind-chips").children, function (chip) {
      chip.addEventListener("click", function () {
        setKind(chip.dataset.kind);
        saveSettings();
      });
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
      kind: settings.kind,
      style: settings.style,
      detail_pass: settings.detailPass,
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
    if (settings.kind === "video") {
      payload.frames = settings.frames;
      payload.fps = settings.fps;
      payload.motion = settings.motion;
      payload.video_format = settings.videoFormat;
    }
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
    $("generate-btn").textContent = busy
      ? "Generating…"
      : (currentKind() === "video" ? "Generate clip" : "Generate");
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
      var noun = (job.request && job.request.kind === "video") ? "clip" : "image";
      toast(job.images.length + " " + noun + (job.images.length === 1 ? "" : "s") +
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

    // Append only what is new. Rebuilding the grid on every image event made
    // every already-visible result re-run its entry animation part-way
    // through a batch, and replaced elements the viewer was looking at.
    if (grid.childElementCount > state.stage.length) {
      grid.innerHTML = "";
    }
    for (var i = grid.childElementCount; i < state.stage.length; i++) {
      (function (image) {
        var node = mediaElement(image, { autoplay: true });
        node.addEventListener("click", function () {
          openLightbox(state.stage.indexOf(image), state.stage);
        });
        grid.appendChild(node);
      })(state.stage[i]);
    }
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

    card.appendChild(mediaElement(image, { lazy: true }));

    if (image.kind === "video") {
      var clip = document.createElement("span");
      clip.className = "card__clip";
      clip.textContent = image.frames ? image.frames + "f" : "clip";
      card.appendChild(clip);
    }

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

    // Swap the element itself, since a clip may need <video> where the last
    // one needed <img>.
    var current = $("lightbox-img");
    var node = mediaElement(image, { autoplay: true, controls: isVideoFile(image) });
    node.id = "lightbox-img";
    current.replaceWith(node);

    $("lightbox-prompt").textContent = image.prompt || "(no prompt)";
    $("lightbox-download").href = image.url;
    $("lightbox-download").setAttribute(
      "download", "forge-" + image.seed + "." + mediaExtension(image));
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
    if (image.kind === "video") {
      rows.splice(2, 0, ["Clip", image.frames + " frames @ " + image.fps + "fps"]);
      rows.splice(3, 0, ["Length", (image.frames / (image.fps || 1)).toFixed(1) + "s"]);
    }
    if (image.negative) { rows.push(["Negative", image.negative]); }
    if (image.extra && image.extra.style) { rows.push(["Style", image.extra.style]); }
    if (image.extra && image.extra.detail_pass) { rows.push(["Detail pass", "yes"]); }
    if (image.extra && image.extra.final_prompt &&
        image.extra.final_prompt !== image.prompt) {
      rows.push(["Sent to model", image.extra.final_prompt]);
    }
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
    if (image.extra && image.extra.style) {
      $("style-preset").value = image.extra.style;
      updateStyleHint();
    }
    if (image.extra && image.extra.detail_pass !== undefined) {
      $("detail-pass").checked = !!image.extra.detail_pass;
    }
    if (image.kind === "video") {
      $("frames").value = image.frames || 24;
      $("fps").value = image.fps || 12;
    }
    setKind(image.kind === "video" ? "video" : "image");
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



  /* ------------------------------------------------------------- media */

  /* An APNG clip is still a PNG, and <img> animates it natively; only a real
     video container needs <video>. So the element is chosen by mime type, not
     by whether the record is a clip. */
  function isVideoFile(record) {
    return String(record.mime || "").indexOf("video/") === 0;
  }

  function mediaElement(record, options) {
    options = options || {};
    var node;
    if (isVideoFile(record)) {
      node = document.createElement("video");
      node.src = record.url;
      node.loop = true;
      node.muted = true;
      node.playsInline = true;
      node.preload = options.controls ? "auto" : "metadata";
      if (options.autoplay) { node.autoplay = true; }
      if (options.controls) { node.controls = true; }
    } else {
      node = document.createElement("img");
      node.src = record.url;
      node.alt = record.prompt || "";
      if (options.lazy) { node.loading = "lazy"; }
    }
    return node;
  }

  function mediaExtension(record) {
    var match = /\.([a-z0-9]+)(?:\?|$)/i.exec(record.url || "");
    return match ? match[1] : "png";
  }

  /* -------------------------------------------------------- references */

  function setReference(record, palette) {
    state.reference = {
      id: record.id,
      title: record.title || "Untitled",
      source: record.source || "",
      license: record.license || "",
      url: record.local_url || "",
      mime: record.mime || "",
      palette: palette || []
    };

    var thumb = $("reference-thumb");
    var replacement = mediaElement(
      { url: state.reference.url, mime: state.reference.mime || "",
        prompt: state.reference.title },
      { autoplay: true }
    );
    replacement.id = "reference-thumb";
    thumb.replaceWith(replacement);
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
