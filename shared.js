/* =========================================================================
   Sahel Monitor - shared behaviour for all three pages.

   Loaded before each page's own script. Everything hangs off window.SM.
   ========================================================================= */

(function () {
  "use strict";

  // =======================================================================
  //  CONFIG - the things you are most likely to want to change
  // =======================================================================

  var CONFIG = {
    // Primary model for the chat page. The nightly brief uses its own setting
    // inside the collector, so changing this does not affect the brief.
    //
    // Free options live on OpenRouter as of September 2026:
    //   z-ai/glm-5.2:free
    //   thinkingmachines/inkling:free          (1M context)
    //   xiaomi/mimo-v2-flash:free
    //   arcee-ai/trinity-large-thinking:free
    model: "z-ai/glm-5.2:free",

    // If the primary is retired, rate limited or erroring, OpenRouter falls
    // through this list in order. openrouter/free is a router that picks from
    // whatever free models exist at the time, so it should never go stale.
    // Keep it last.
    fallbacks: ["openrouter/free"],

    // How many archive items to hand the model per question.
    retrievalDepth: 40,

    // Used only for the "this page should have updated by now" check.
    // The collector also writes cadence_hours into the data; that wins if present.
    defaultCadenceHours: 24,

    endpoint: "https://openrouter.ai/api/v1/chat/completions"
  };

  // =======================================================================
  //  DOM helpers
  // =======================================================================

  function el(tag, cls, text) {
    var n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text !== undefined && text !== null) n.textContent = text;
    return n;
  }

  // Everything that reaches the page from a feed, a model or the network goes
  // through here before it becomes an href. Never build links by concatenation.
  function safeUrl(url) {
    try {
      var u = new URL(url, window.location.href);
      return (u.protocol === "http:" || u.protocol === "https:") ? u.href : null;
    } catch (e) { return null; }
  }

  function hoursSince(iso) {
    if (!iso) return null;
    var d = new Date(iso);
    if (isNaN(d.getTime())) return null;
    return (Date.now() - d.getTime()) / 3600000;
  }

  function relativeDate(iso) {
    var h = hoursSince(iso);
    if (h === null) return "undated";
    if (h < 24) return "today";
    var days = Math.floor(h / 24);
    if (days === 1) return "yesterday";
    if (days < 8) return days + " days ago";
    return new Date(iso).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
  }

  function longDate(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return "";
    return d.toLocaleString("en-AU",
      { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
  }

  function paragraphs(host, text) {
    host.textContent = "";
    String(text || "").split(/\n{2,}/).forEach(function (p) {
      if (p.trim()) host.appendChild(el("p", null, p.trim()));
    });
  }

  // =======================================================================
  //  Navigation
  // =======================================================================

  var PAGES = [
    { href: "index.html",   label: "Monitor" },
    { href: "brief.html",   label: "Brief" },
    { href: "ask.html",     label: "Ask" },
    // Reference rather than daily reading, so it sits apart on the right.
    { href: "sources.html", label: "Sources", secondary: true }
  ];

  function buildNav(current) {
    var nav = document.querySelector("nav.tabs");
    if (!nav) return;
    nav.textContent = "";
    PAGES.forEach(function (p) {
      var a = el("a", p.secondary ? "secondary" : null, p.label);
      a.href = p.href;
      if (p.href === current) a.setAttribute("aria-current", "page");
      nav.appendChild(a);
    });
  }

  // =======================================================================
  //  Freshness
  //
  //  The collector writes its own status into the data files. If the
  //  collector dies, that status freezes and keeps insisting all is well.
  //  So we ignore it and work out the age here, against this browser's
  //  clock, which cannot be frozen by a dead workflow.
  // =======================================================================

  function assessFreshness(meta, opts) {
    opts = opts || {};
    var pill = document.getElementById("status-pill");
    var lamp = pill ? pill.querySelector(".lamp") : null;
    var text = document.getElementById("status-text");
    var box = document.getElementById("alert");
    var title = document.getElementById("alert-title");
    var body = document.getElementById("alert-body");

    function set(colour, label, cls, heading, message) {
      if (lamp) lamp.style.background = colour;
      if (text) text.textContent = label;
      if (!box) return;
      box.className = cls;
      if (heading && title) title.textContent = heading;
      if (message && body) body.textContent = message;
    }

    if (!meta || !meta.generated) {
      set("var(--red)", "No data", "alert on severe",
        "The collector has never run here",
        "None of the data files were found. If this is a new deployment, run the " +
        "update workflow once from the Actions tab. If it was working before, the " +
        "files have been removed or the page is being served from the wrong folder.");
      return { state: "missing", hours: null };
    }

    var age = hoursSince(meta.generated);
    var cadence = Number(meta.cadence_hours) || CONFIG.defaultCadenceHours;
    var when = longDate(meta.generated);
    var days = Math.floor(age / 24);
    var ageText = days >= 1
      ? days + (days === 1 ? " day" : " days")
      : Math.round(age) + " hours";

    if (age <= cadence * 1.5) {
      set("var(--green)", "Updated " + when, "alert");
      return { state: "fresh", hours: age };
    }

    if (age <= cadence * 4) {
      set("var(--amber)", "Late by " + ageText, "alert on",
        "This page is showing older material than it should",
        "The last successful collection was " + when + ", which is " + ageText +
        " ago against a " + cadence + " hour cycle. One run may simply have failed. " +
        "If the next one does not land, check the Actions tab.");
      return { state: "late", hours: age };
    }

    set("var(--red)", "Stale, " + ageText + " old", "alert on severe",
      "Collection has stopped",
      (opts.severeMessage ||
        "Nothing has updated since " + when + ", which is " + ageText + " ago. " +
        "Everything below is a snapshot of that moment and says nothing about the " +
        "period since. Check the Actions tab before reading any of it as current."));
    return { state: "stale", hours: age };
  }

  // =======================================================================
  //  Data loading
  // =======================================================================

  var STREAMS = ["news", "social", "analysis", "research"];

  function grab(name) {
    return fetch(name + ".json?t=" + Date.now())
      .then(function (r) { return r.ok ? r.json() : null; })
      .catch(function () { return null; });
  }

  // Resolves to a single object holding every stream plus merged metadata,
  // so each page does the same load and picks what it needs.
  function loadAll() {
    return Promise.all(STREAMS.map(grab).concat([grab("brief")]))
      .then(function (results) {
        var brief = results[results.length - 1];
        var streams = {};
        var meta = null;
        var health = [];

        STREAMS.forEach(function (name, i) {
          var file = results[i];
          streams[name] = (file && file.items) || [];
          if (file && !meta) meta = file;
          if (file && file.health) health = health.concat(file.health);
        });

        var everything = [];
        STREAMS.forEach(function (name) {
          streams[name].forEach(function (item) {
            item.stream = name;
            everything.push(item);
          });
        });
        everything.sort(function (a, b) {
          return String(b.date || "").localeCompare(String(a.date || ""));
        });

        var themes = {};
        if (meta) {
          Object.keys(meta.themes || {}).forEach(function (n) {
            themes[n] = (meta.themes[n] || {}).colour || "#888";
          });
        }

        return {
          meta: meta,
          brief: brief,
          streams: streams,
          all: everything,
          health: health,
          themes: themes,
          tiers: (meta && meta.tiers) || {},
          events: (meta && meta.events) || [],
          coverage: (meta && meta.coverage) || [],
          countries: (meta && meta.countries) || []
        };
      });
  }

  // =======================================================================
  //  Shared rendering
  // =======================================================================

  function buildBadges(item) {
    var wrap = el("div", "badges");
    var n = Number(item.corroboration || 0);

    if (n >= 2) wrap.appendChild(el("span", "badge" + (n >= 4 ? " strong" : ""), n + " outlets"));
    else if (n === 1) wrap.appendChild(el("span", "badge single", "single source"));

    if (item.thread === "new") wrap.appendChild(el("span", "badge fresh", "new thread"));
    else if (item.thread === "developing") wrap.appendChild(el("span", "badge", "developing"));

    if (item.anomaly) wrap.appendChild(el("span", "badge odd", "off baseline"));

    (item.events || []).forEach(function (e) {
      wrap.appendChild(el("span", "badge", String(e).toLowerCase()));
    });
    return wrap.childNodes.length ? wrap : null;
  }

  function buildEntry(item, themes) {
    var li = el("li", "entry");
    var href = safeUrl(item.link);

    var head = el(href ? "a" : "span", "headline", item.title || "Untitled");
    if (href) { head.href = href; head.target = "_blank"; head.rel = "noopener noreferrer"; }
    li.appendChild(head);

    if (item.summary) li.appendChild(el("p", "blurb", item.summary));

    var badges = buildBadges(item);
    if (badges) li.appendChild(badges);

    var meta = el("div", "meta");
    if (item.publisher) meta.appendChild(el("span", "outlet", item.publisher));
    meta.appendChild(el("span", null, relativeDate(item.date)));
    if (item.lang && item.lang !== "en") {
      meta.appendChild(el("span", null, String(item.lang).toUpperCase()));
    }
    (item.countries || []).slice(0, 3).forEach(function (c) {
      meta.appendChild(el("span", "place", c));
    });
    (item.themes || []).forEach(function (t) {
      var dot = el("span", "tdot");
      dot.style.background = (themes && themes[t]) || "#777";
      dot.title = t;
      meta.appendChild(dot);
    });
    li.appendChild(meta);

    var first = (item.themes || [])[0];
    if (first && themes && themes[first]) li.style.borderLeftColor = themes[first];
    return li;
  }

  function skeletons(listEl, count) {
    for (var i = 0; i < (count || 4); i++) {
      var s = el("li", "skeleton");
      s.appendChild(el("div")); s.appendChild(el("div")); s.appendChild(el("div"));
      listEl.appendChild(s);
    }
  }

  // =======================================================================
  //  Model access
  //
  //  The key is held in this browser only. It is never written to the repo
  //  and never leaves the machine except in the request to OpenRouter.
  // =======================================================================

  var KEY_STORE = "sahel_monitor_openrouter_key";

  function getKey() {
    try { return localStorage.getItem(KEY_STORE) || ""; } catch (e) { return ""; }
  }
  function setKey(value) {
    try { localStorage.setItem(KEY_STORE, value); return true; } catch (e) { return false; }
  }
  function clearKey() {
    try { localStorage.removeItem(KEY_STORE); } catch (e) {}
  }

  function askModel(messages, options) {
    options = options || {};
    var key = getKey();
    if (!key) return Promise.reject(new Error("No API key stored in this browser."));

    return fetch(CONFIG.endpoint, {
      method: "POST",
      headers: {
        "Authorization": "Bearer " + key,
        "Content-Type": "application/json",
        "HTTP-Referer": window.location.origin,
        "X-Title": "Sahel Monitor"
      },
      body: JSON.stringify({
        model: options.model || CONFIG.model,
        models: [options.model || CONFIG.model].concat(CONFIG.fallbacks),
        messages: messages,
        max_tokens: options.maxTokens || 1400,
        temperature: options.temperature === undefined ? 0.3 : options.temperature
      })
    }).then(function (res) {
      return res.json().then(function (data) {
        if (!res.ok) {
          var detail = (data && data.error && data.error.message) || ("HTTP " + res.status);
          if (res.status === 401) {
            throw new Error("OpenRouter rejected the key. Check it, or clear and re-enter it.");
          }
          if (res.status === 429) {
            throw new Error("Rate limited. Free models allow roughly 20 requests a minute " +
              "and a few hundred a day. Wait a moment and try again.");
          }
          throw new Error(detail);
        }
        var choice = (data.choices || [])[0] || {};
        var text = (choice.message && choice.message.content) || "";
        return { text: String(text).trim(), model: data.model || "", raw: data };
      });
    });
  }

  // =======================================================================
  //  Text safety
  //
  //  Item text is third party content. When it goes into a prompt it is
  //  fenced, numbered and flattened so it cannot pose as an instruction.
  // =======================================================================

  function flatten(text, limit) {
    return String(text || "")
      .replace(/[\r\n]+/g, " ")
      .replace(/```/g, "'''")
      .replace(/(?:^|\s)(system|assistant|user|human)\s*:/gi, " $1 -")
      .trim()
      .slice(0, limit || 240);
  }

  // =======================================================================

  window.SM = {
    CONFIG: CONFIG,
    el: el,
    safeUrl: safeUrl,
    hoursSince: hoursSince,
    relativeDate: relativeDate,
    longDate: longDate,
    paragraphs: paragraphs,
    buildNav: buildNav,
    assessFreshness: assessFreshness,
    loadAll: loadAll,
    buildEntry: buildEntry,
    buildBadges: buildBadges,
    skeletons: skeletons,
    getKey: getKey,
    setKey: setKey,
    clearKey: clearKey,
    askModel: askModel,
    flatten: flatten,
    STREAMS: STREAMS
  };
})();
