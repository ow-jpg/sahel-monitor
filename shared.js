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
    // Used only for the "this page should have updated by now" check.
    // The collector also writes cadence_hours into the data; that wins if present.

    // Collection only runs when you start it in GitHub, so the site never
    // expects data to appear on a schedule. This is only used to decide how
    // loudly to warn when the data is getting old.
    defaultStaleDays: 10
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
  //  Cards
  // =======================================================================

  // Items may carry an English translation alongside the original. Prefer
  // the translation for reading, but never throw the original away.
  function displayTitle(item) { return item.title_en || item.title || "Untitled"; }
  function displayBlurb(item) { return item.summary_en || item.summary || ""; }
  function isTranslated(item) { return Boolean(item.title_en && item.title_en !== item.title); }

  function buildBadges(item) {
    var wrap = el("div", "badges");
    var n = Number(item.corroboration || 0);
    var also = (item.also || []).length;

    if (also) {
      wrap.appendChild(el("span", "badge grouped",
        "+" + also + " more report" + (also === 1 ? "" : "s")));
    }
    if (n >= 2) {
      wrap.appendChild(el("span", "badge" + (n >= 4 ? " strong" : ""), n + " outlets"));
    } else if (n === 1) {
      wrap.appendChild(el("span", "badge", "single source"));
    }
    if (item.thread === "new") wrap.appendChild(el("span", "badge fresh", "new thread"));
    else if (item.thread === "developing") wrap.appendChild(el("span", "badge", "developing"));
    if (item.anomaly) wrap.appendChild(el("span", "badge odd", "off baseline"));
    (item.events || []).forEach(function (e) {
      wrap.appendChild(el("span", "badge", String(e).toLowerCase()));
    });
    return wrap.childNodes.length ? wrap : null;
  }

  function buildEntry(item, themes) {
    var li = el("li");
    var card = el("button", "card");
    card.type = "button";

    var accent = el("span", "card-accent");
    var first = (item.themes || [])[0];
    if (first && themes && themes[first]) accent.style.background = themes[first];
    card.appendChild(accent);

    card.appendChild(el("p", "card-title", displayTitle(item)));
    if (isTranslated(item)) {
      card.appendChild(el("p", "card-original", item.title));
    }

    var badges = buildBadges(item);
    if (badges) card.appendChild(badges);

    var meta = el("div", "card-meta");
    if (item.publisher) meta.appendChild(el("span", "outlet", item.publisher));
    meta.appendChild(el("span", null, relativeDate(item.date)));
    if (item.lang && item.lang !== "en") {
      meta.appendChild(el("span", null, String(item.lang).toUpperCase()));
    }
    (item.countries || []).slice(0, 3).forEach(function (c) {
      meta.appendChild(el("span", null, c));
    });
    card.appendChild(meta);

    card.addEventListener("click", function () { openSheet(item, themes); });
    li.appendChild(card);
    return li;
  }

  // =======================================================================
  //  Detail dialog
  // =======================================================================

  var lastFocused = null;

  function closeSheet() {
    var scrim = document.getElementById("scrim");
    if (!scrim) return;
    scrim.classList.remove("on");
    document.body.style.overflow = "";
    if (lastFocused && lastFocused.focus) lastFocused.focus();
  }

  function fact(label, value) {
    if (!value) return null;
    var box = el("div", "fact");
    box.appendChild(el("dt", null, label));
    box.appendChild(el("dd", null, value));
    return box;
  }

  function openSheet(item, themes) {
    var scrim = document.getElementById("scrim");
    if (!scrim) return;
    lastFocused = document.activeElement;

    document.getElementById("sheet-title").textContent = displayTitle(item);
    var body = document.getElementById("sheet-body");
    body.textContent = "";

    function section(heading) {
      var sec = el("section", "sheet-section");
      if (heading) sec.appendChild(el("h3", null, heading));
      body.appendChild(sec);
      return sec;
    }

    if (isTranslated(item)) {
      var orig = section("Original, " + String(item.lang).toUpperCase());
      orig.appendChild(el("p", "sheet-original", item.title));
      orig.appendChild(el("p", "sheet-note",
        "Machine translated. The original is shown so you can check it."));
    }

    var blurb = displayBlurb(item);
    if (blurb) {
      section("From the feed").appendChild(el("p", "sheet-blurb", blurb));
    }

    var facts = section("Details");
    var grid = el("dl", "facts");
    [["Outlet", item.publisher],
     ["Published", item.date ? longDate(item.date) : "undated"],
     ["Independent outlets", String(item.corroboration || 1)],
     ["Story", item.thread === "developing" ? "Continuing" : "First seen this run"],
     ["Places", (item.countries || []).join(", ")],
     ["Themes", (item.themes || []).join(", ")],
     ["Event type", (item.events || []).join(", ")],
     ["Feed", item.feed]].forEach(function (pair) {
      var f = fact(pair[0], pair[1]);
      if (f) grid.appendChild(f);
    });
    facts.appendChild(grid);

    var also = item.also || [];
    if (also.length) {
      var sec = section("Also reported by  (" + also.length + ")");
      var list = el("ul", "also-list");
      also.forEach(function (other) {
        var li = el("li", "also-item");
        li.appendChild(el("span", "who", other.publisher || "Unknown"));
        var what = el("span", "what");
        var href = safeUrl(other.link);
        if (href) {
          var a = el("a", null, other.title || href);
          a.href = href; a.target = "_blank"; a.rel = "noopener noreferrer";
          what.appendChild(a);
        } else {
          what.appendChild(document.createTextNode(other.title || ""));
        }
        li.appendChild(what);
        if (other.agency) li.appendChild(el("span", "flag", "wire"));
        if (other.aggregator) li.appendChild(el("span", "flag", "aggregator"));
        if (other.lang && other.lang !== "en") {
          li.appendChild(el("span", "flag", String(other.lang).toUpperCase()));
        }
        list.appendChild(li);
      });
      sec.appendChild(list);
      sec.appendChild(el("p", "sheet-note",
        "Grouped because the headlines closely match. Wire copy counts once "
        + "towards the outlet total, and aggregators are not counted at all."));
    }

    var actions = el("div", "sheet-actions");
    var href = safeUrl(item.link);
    if (href) {
      var open = el("a", "btn", "Read the original");
      open.href = href; open.target = "_blank"; open.rel = "noopener noreferrer";
      actions.appendChild(open);
    }
    var dismiss = el("button", "btn quiet", "Close");
    dismiss.type = "button";
    dismiss.addEventListener("click", closeSheet);
    actions.appendChild(dismiss);
    body.appendChild(actions);

    body.appendChild(el("p", "sheet-note",
      "This monitor reads headlines and feed blurbs only. It has not read the "
      + "article, so nothing here is a substitute for opening it."));

    scrim.classList.add("on");
    document.body.style.overflow = "hidden";
    document.getElementById("sheet-close").focus();
  }

  function wireSheet() {
    var scrim = document.getElementById("scrim");
    if (!scrim) return;
    document.getElementById("sheet-close").addEventListener("click", closeSheet);
    scrim.addEventListener("click", function (e) {
      if (e.target === scrim) closeSheet();
    });
    document.addEventListener("keydown", function (e) {
      if (e.key === "Escape" && scrim.classList.contains("on")) closeSheet();
    });
  }

  function skeletons(listEl, count) {
    for (var i = 0; i < (count || 4); i++) {
      var s = el("li", "skeleton");
      s.appendChild(el("div")); s.appendChild(el("div")); s.appendChild(el("div"));
      listEl.appendChild(s);
    }
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
    wireSheet: wireSheet,
    openSheet: openSheet,
    closeSheet: closeSheet,
    displayTitle: displayTitle,
    STREAMS: STREAMS
  };
})();
