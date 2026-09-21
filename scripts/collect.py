#!/usr/bin/env python3
"""
Sahel Monitor - collector.

Reads sources.yml, pulls every feed, keeps what mentions West Africa, tags it,
works out how well corroborated each story is, compares this week's volume
against each country's own history, and writes the JSON files the site reads.

Nothing here talks to the site directly. The site only ever reads JSON.

Files it writes:
    news.json, analysis.json, research.json   what the site displays
    archive/YYYY-MM.json                      accumulating record, never shown
    state.json                                counters that must survive runs

The archive exists so the tool can say something about change rather than only
about the present. It costs nothing to keep and cannot be recovered later if
we do not start now.
"""

from __future__ import annotations

import hashlib
import html
import json
import re
import sys
import unicodedata
from collections import defaultdict
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from pathlib import Path
from time import mktime

import feedparser
import requests
import yaml

ROOT = Path(__file__).resolve().parent.parent
CONFIG_PATH = ROOT / "sources.yml"
ARCHIVE_DIR = ROOT / "archive"
STATE_PATH = ROOT / "state.json"

USER_AGENT = ("Mozilla/5.0 (compatible; SahelMonitor/1.0; "
              "personal research feed reader)")
TIMEOUT = 25

# A run that collects almost nothing is usually a broken run rather than a
# quiet week. Below this, the workflow exits non-zero so GitHub emails you.
MIN_EXPECTED_ITEMS = 12


# ---------------------------------------------------------------------------
# text
# ---------------------------------------------------------------------------

def deaccent(text: str) -> str:
    return "".join(c for c in unicodedata.normalize("NFKD", text)
                   if not unicodedata.combining(c))


def normalise(text: str) -> str:
    text = html.unescape(text or "")
    text = deaccent(text).lower()
    text = re.sub(r"[\u2018\u2019\u201c\u201d]", "'", text)
    return re.sub(r"\s+", " ", text).strip()


def strip_tags(text: str) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", text or "")).strip()


def contains_term(haystack: str, term: str) -> bool:
    """Whole word match. 'mali' must not fire inside 'somalia'."""
    term = deaccent(str(term)).lower().strip()
    if not term:
        return False
    pattern = r"(?<![a-z0-9])" + re.escape(term).replace(r"\ ", r"[\s\-]+") + r"(?![a-z0-9])"
    return re.search(pattern, haystack) is not None


STOPWORDS = set(
    """a an the in on at to of and or for is are was were its it as by with from
    that this be has have after over says say said new amid into how why what
    when who will would could more than been being their there they them his her
    but not all out up off down about against between during under above""".split())


def stem(word: str) -> str:
    """Crude suffix stripping so 'ambushed', 'ambush' and 'ambushes' match."""
    for suffix in ("ements", "ement", "ing", "ed", "es", "s"):
        if len(word) - len(suffix) >= 4 and word.endswith(suffix):
            return word[: -len(suffix)]
    return word


def fingerprint(title: str) -> frozenset:
    words = re.sub(r"[^a-z0-9\s]", " ", normalise(title)).split()
    return frozenset(stem(w) for w in words if len(w) > 2 and w not in STOPWORDS)


def similarity(a: frozenset, b: frozenset) -> float:
    if not a or not b:
        return 0.0
    return len(a & b) / len(a | b)


def item_id(link: str, title: str) -> str:
    key = (link or "").split("?")[0].rstrip("/") or normalise(title)
    return hashlib.sha1(key.encode("utf-8")).hexdigest()[:16]


# ---------------------------------------------------------------------------
# fetching
# ---------------------------------------------------------------------------

def fetch_feed(source: dict) -> dict:
    """Pull one feed. Never raises: a dead feed is reported, not fatal."""
    out = {"name": source["name"], "lang": source.get("lang", "en"),
           "ok": False, "fetched": 0, "error": None, "entries": []}
    try:
        response = requests.get(source["url"], timeout=TIMEOUT,
                                headers={"User-Agent": USER_AGENT})
        response.raise_for_status()
        parsed = feedparser.parse(response.content)
        if parsed.bozo and not parsed.entries:
            raise ValueError("feed did not parse")
        out["entries"] = parsed.entries
        out["fetched"] = len(parsed.entries)
        out["ok"] = True
    except Exception as exc:  # noqa: BLE001 - every failure mode is interesting
        out["error"] = f"{type(exc).__name__}: {exc}"[:150]
    return out


def entry_datetime(entry) -> datetime | None:
    for key in ("published_parsed", "updated_parsed"):
        value = getattr(entry, key, None)
        if value:
            try:
                return datetime.fromtimestamp(mktime(value), tz=timezone.utc)
            except Exception:  # noqa: BLE001
                continue
    return None


def split_publisher(title: str) -> tuple[str, str]:
    """Google News formats titles as 'Headline - Publication'."""
    for sep in (" - ", " \u2014 ", " | "):
        if sep not in title:
            continue
        head, _, tail = title.rpartition(sep)
        tail = tail.strip()
        if (head.strip() and tail and len(tail) < 45
                and len(tail.split()) <= 6 and not tail[0].islower()):
            return head.strip(), tail
    return title.strip(), ""


# ---------------------------------------------------------------------------
# classification
# ---------------------------------------------------------------------------

class Classifier:
    def __init__(self, config: dict):
        self.countries = config.get("countries", {}) or {}
        self.traps = config.get("country_traps", {}) or {}
        self.themes = config.get("themes", {}) or {}
        self.events = config.get("events", {}) or {}
        self.exclude = [normalise(x) for x in (config.get("exclude", []) or [])]
        self.agencies = [normalise(a) for a in (config.get("agencies", []) or [])]
        self.aggregators = [normalise(a) for a in (config.get("aggregators", []) or [])]

    def is_noise(self, blob: str) -> bool:
        return any(term and term in blob for term in self.exclude)

    def match_countries(self, blob: str) -> list[str]:
        hits = []
        for country, spec in self.countries.items():
            terms = spec.get("terms", [])
            matched = [t for t in terms if contains_term(blob, t)]
            if not matched:
                continue
            traps = self.traps.get(country, [])
            # Only veto when the trap phrase is the sole reason for the match.
            if traps and len(matched) <= 1 and any(contains_term(blob, t) for t in traps):
                continue
            hits.append(country)
        return hits

    def match(self, blob: str, table: dict) -> list[str]:
        return [name for name, spec in table.items()
                if any(contains_term(blob, t) for t in spec.get("terms", []))]

    def is_agency(self, publisher: str) -> bool:
        p = " " + normalise(publisher) + " "
        return any(a.strip() and a.strip() in p for a in self.agencies)

    def is_aggregator(self, publisher: str) -> bool:
        p = " " + normalise(publisher) + " "
        return any(a.strip() and a.strip() in p for a in self.aggregators)


# ---------------------------------------------------------------------------
# collection
# ---------------------------------------------------------------------------

def collect(sources: list[dict], classifier: Classifier,
            cutoff: datetime) -> tuple[list[dict], list[dict]]:
    health, items = [], []
    if not sources:
        return items, health

    with ThreadPoolExecutor(max_workers=8) as pool:
        results = list(pool.map(fetch_feed, sources))

    for result in results:
        kept = 0
        for entry in result["entries"]:
            raw_title = html.unescape(getattr(entry, "title", "") or "")
            link = getattr(entry, "link", "") or ""
            if not raw_title or not link.startswith("http"):
                continue

            published = entry_datetime(entry)
            if published and published < cutoff:
                continue

            summary = strip_tags(getattr(entry, "summary", "") or "")
            title, publisher = split_publisher(raw_title)

            source_obj = getattr(entry, "source", None)
            if source_obj is not None:
                publisher = getattr(source_obj, "title", publisher) or publisher
            if not publisher:
                publisher = result["name"]

            blob = normalise(f"{title} {summary} {publisher}")
            if classifier.is_noise(blob):
                continue

            countries = classifier.match_countries(blob)
            if not countries:
                continue

            items.append({
                "id": item_id(link, title),
                "title": title,
                "link": link,
                "publisher": publisher,
                "feed": result["name"],
                "lang": result["lang"],
                "date": published.isoformat() if published else None,
                "summary": summary[:300],
                "countries": countries,
                "themes": classifier.match(blob, classifier.themes),
                "events": classifier.match(blob, classifier.events),
            })
            kept += 1

        health.append({"name": result["name"], "ok": result["ok"],
                       "fetched": result["fetched"], "kept": kept,
                       "error": result["error"]})
    return items, health


# ---------------------------------------------------------------------------
# corroboration and clustering
#
# Several outlets carrying the same story is real signal. Several outlets
# republishing one agency wire is not, so agency copy counts once.
# ---------------------------------------------------------------------------

def cluster(items: list[dict], threshold: float = 0.52) -> list[list[dict]]:
    """Group retellings of the same story.

    Compares against every member of a cluster rather than only the first one,
    because a reworded headline often resembles a later member more closely
    than the one that opened the cluster.
    """
    clusters: list[tuple[list[frozenset], list[dict]]] = []
    for item in items:
        fp = fingerprint(item["title"])
        placed = False
        for prints, members in clusters:
            if any(similarity(fp, p) > threshold for p in prints):
                prints.append(fp)
                members.append(item)
                placed = True
                break
        if not placed:
            clusters.append(([fp], [item]))
    return [members for _, members in clusters]


def score_clusters(items: list[dict], classifier: Classifier) -> list[dict]:
    """Collapse each cluster to one item carrying a corroboration count."""
    output = []
    for members in cluster(items):
        publishers, agency_seen = set(), False
        for m in members:
            if classifier.is_aggregator(m["publisher"]):
                continue          # a portal reprinting copy is not a witness
            if classifier.is_agency(m["publisher"]):
                agency_seen = True   # all wire copy counts once, together
            else:
                publishers.add(normalise(m["publisher"]))
        count = len(publishers) + (1 if agency_seen else 0)

        # Choose the version to display: never an aggregator if avoidable,
        # then prefer a real date, then the fullest summary.
        members.sort(key=lambda m: (
            not classifier.is_aggregator(m["publisher"]),
            m["date"] is not None,
            len(m.get("summary") or ""),
        ), reverse=True)

        best = dict(members[0])
        best["corroboration"] = max(1, count)
        best["fingerprint"] = sorted(fingerprint(best["title"]))
        if len(members) > 1:
            others = [m["publisher"] for m in members[1:6]]
            best["also"] = others
        output.append(best)
    return output


# ---------------------------------------------------------------------------
# archive
# ---------------------------------------------------------------------------

def load_archive(keep_days: int) -> dict[str, dict]:
    ARCHIVE_DIR.mkdir(exist_ok=True)
    cutoff = (datetime.now(timezone.utc) - timedelta(days=keep_days)).isoformat()
    archive: dict[str, dict] = {}
    for path in sorted(ARCHIVE_DIR.glob("*.json")):
        try:
            for record in json.loads(path.read_text(encoding="utf-8")):
                if (record.get("first_seen") or "") >= cutoff:
                    archive[record["id"]] = record
        except Exception as exc:  # noqa: BLE001
            print(f"  warning: could not read {path.name}: {exc}")
    return archive


def save_archive(archive: dict[str, dict]) -> None:
    ARCHIVE_DIR.mkdir(exist_ok=True)
    months: dict[str, list] = defaultdict(list)
    for record in archive.values():
        month = (record.get("first_seen") or record.get("date") or "")[:7]
        if month:
            months[month].append(record)
    for month, records in months.items():
        records.sort(key=lambda r: r.get("first_seen") or "")
        (ARCHIVE_DIR / f"{month}.json").write_text(
            json.dumps(records, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8")


def update_archive(archive: dict[str, dict], items: list[dict],
                   stream: str, now: datetime) -> None:
    for item in items:
        existing = archive.get(item["id"])
        if existing:
            existing["last_seen"] = now.isoformat()
            existing["corroboration"] = max(
                existing.get("corroboration", 1), item.get("corroboration", 1))
            continue
        archive[item["id"]] = {
            "id": item["id"],
            "title": item["title"],
            "link": item["link"],
            "publisher": item["publisher"],
            "stream": stream,
            "date": item["date"],
            "first_seen": now.isoformat(),
            "last_seen": now.isoformat(),
            "countries": item["countries"],
            "themes": item["themes"],
            "events": item["events"],
            "corroboration": item.get("corroboration", 1),
            "fingerprint": item.get("fingerprint", []),
        }


# ---------------------------------------------------------------------------
# derived signals: threads and coverage baselines
# ---------------------------------------------------------------------------

def mark_threads(items: list[dict], archive: dict[str, dict],
                 now: datetime, lookback_days: int = 30) -> None:
    """Mark each story 'new' or 'developing'.

    Follow-up coverage rewords almost everything except the proper nouns, so
    "Death toll rises after JNIM ambush near Djibo" shares little with "JNIM
    claims ambush on army convoy near Djibo" by plain word overlap. What it
    does share is the distinctive words.

    So: count a match when the two headlines overlap substantially AND share
    at least two words that are rare across the archive. Common words like
    'mali', 'army' or 'attack' appear everywhere and carry no information, so
    two unrelated Malian conflict stories will not be falsely linked.
    """
    since = (now - timedelta(days=lookback_days)).isoformat()
    prior = [frozenset(r.get("fingerprint") or [])
             for r in archive.values()
             if (r.get("first_seen") or "") >= since]

    # How many archived headlines each word appears in.
    frequency: dict[str, int] = defaultdict(int)
    for fp in prior:
        for word in fp:
            frequency[word] += 1
    rare_ceiling = max(2, int(len(prior) * 0.15)) if prior else 2

    def same_thread(a: frozenset, b: frozenset) -> bool:
        shared = a & b
        if len(shared) < 3:
            return False
        overlap = len(shared) / min(len(a), len(b))
        if overlap < 0.5:
            return False
        distinctive = sum(1 for w in shared if frequency.get(w, 0) <= rare_ceiling)
        return distinctive >= 2

    for item in items:
        fp = frozenset(item.get("fingerprint") or fingerprint(item["title"]))
        item["thread"] = "developing" if any(same_thread(fp, p) for p in prior) else "new"
        prior.append(fp)
        for word in fp:
            frequency[word] += 1


def coverage(archive: dict[str, dict], countries: dict,
             now: datetime, weeks: int) -> tuple[list[dict], set[str]]:
    """Last seven days against each country's own trailing weekly average."""
    week_ago = (now - timedelta(days=7)).isoformat()
    base_start = (now - timedelta(days=7 * (weeks + 1))).isoformat()

    recent = defaultdict(int)
    older = defaultdict(int)
    for record in archive.values():
        seen = record.get("first_seen") or ""
        if not seen:
            continue
        for country in record.get("countries", []):
            if seen >= week_ago:
                recent[country] += 1
            elif seen >= base_start:
                older[country] += 1

    rows, odd = [], set()
    for country in countries:
        baseline = older[country] / weeks if older[country] else 0.0
        rows.append({"country": country,
                     "recent": recent[country],
                     "baseline": round(baseline, 1)})
        # Only call something anomalous once there is enough history to mean it.
        if baseline >= 3:
            ratio = recent[country] / baseline
            if ratio < 0.5 or ratio > 2.0:
                odd.add(country)
    return rows, odd


# ---------------------------------------------------------------------------
# research, via OpenAlex (free, no key)
# ---------------------------------------------------------------------------

def fetch_research(queries: list[str], limit: int) -> tuple[list[dict], list[dict]]:
    since = (datetime.now(timezone.utc) - timedelta(days=150)).date().isoformat()
    items, health, seen = [], [], set()

    for query in queries:
        record = {"name": f"OpenAlex: {query}", "ok": False,
                  "fetched": 0, "kept": 0, "error": None}
        try:
            response = requests.get(
                "https://api.openalex.org/works",
                params={"search": query,
                        "filter": f"from_publication_date:{since}",
                        "sort": "publication_date:desc",
                        "per-page": 10},
                headers={"User-Agent": USER_AGENT}, timeout=TIMEOUT)
            response.raise_for_status()
            works = response.json().get("results", [])
            record["ok"] = True
            record["fetched"] = len(works)

            for work in works:
                title = (work.get("title") or "").strip()
                link = work.get("doi") or work.get("id")
                if not title or not link or link in seen:
                    continue
                seen.add(link)
                venue = (work.get("primary_location") or {}).get("source") or {}
                authors = [a.get("author", {}).get("display_name", "")
                           for a in (work.get("authorships") or [])[:3]]
                items.append({
                    "id": item_id(link, title),
                    "title": title,
                    "link": link,
                    "publisher": venue.get("display_name") or "Working paper",
                    "feed": query,
                    "lang": work.get("language") or "en",
                    "date": work.get("publication_date"),
                    "summary": ", ".join(a for a in authors if a),
                    "countries": [], "themes": [], "events": [],
                    "corroboration": 1,
                    "thread": "new",
                })
                record["kept"] += 1
        except Exception as exc:  # noqa: BLE001
            record["error"] = f"{type(exc).__name__}: {exc}"[:150]
        health.append(record)

    items.sort(key=lambda i: i.get("date") or "", reverse=True)
    return items[:limit], health


# ---------------------------------------------------------------------------
# state, so consecutive empty runs can be counted
# ---------------------------------------------------------------------------

def load_state() -> dict:
    if STATE_PATH.exists():
        try:
            return json.loads(STATE_PATH.read_text(encoding="utf-8"))
        except Exception:  # noqa: BLE001
            pass
    return {"dry_runs": {}}


def apply_dry_runs(health: list[dict], state: dict) -> None:
    counters = state.setdefault("dry_runs", {})
    for entry in health:
        name = entry["name"]
        if entry["ok"] and not entry["kept"]:
            counters[name] = counters.get(name, 0) + 1
        else:
            counters[name] = 0
        entry["dry_runs"] = counters[name]


# ---------------------------------------------------------------------------
# output
# ---------------------------------------------------------------------------

def write_stream(name: str, items: list[dict], health: list[dict],
                 meta: dict) -> None:
    for item in items:
        item.pop("fingerprint", None)
    payload = dict(meta)
    payload["items"] = items
    payload["health"] = health
    (ROOT / f"{name}.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"  {name}.json  {len(items)} items")


def write_sources(config: dict, health: list[dict], now: datetime) -> None:
    """Publish what the collector is configured to look at.

    Generated from sources.yml on every run, so the page can never drift out
    of date with what is actually being collected.
    """
    by_name = {h["name"]: h for h in health}

    def describe(feeds: list[dict]) -> list[dict]:
        rows = []
        for feed in feeds or []:
            status = by_name.get(feed["name"], {})
            rows.append({
                "name": feed["name"],
                "lang": feed.get("lang", "en"),
                "url": feed["url"],
                "kind": "search" if "news.google.com" in feed["url"] else "direct",
                "ok": status.get("ok"),
                "fetched": status.get("fetched", 0),
                "kept": status.get("kept", 0),
                "dry_runs": status.get("dry_runs", 0),
                "error": status.get("error"),
            })
        return rows

    def terms_of(table: dict, extra: str | None = None) -> list[dict]:
        rows = []
        for name, spec in (table or {}).items():
            row = {"name": name, "terms": spec.get("terms", [])}
            if extra:
                row[extra] = spec.get(extra)
            rows.append(row)
        return rows

    payload = {
        "generated": now.isoformat(),
        "settings": config.get("settings", {}),
        "streams": [
            {"stream": "news", "label": "News",
             "note": "Wire services, regional outlets and local reporting.",
             "sources": describe(config.get("news", []))},
            {"stream": "analysis", "label": "Analysis",
             "note": "Research institutes and specialist trackers.",
             "sources": describe(config.get("analysis", []))},
        ],
        "research_queries": [
            {"query": q,
             "ok": by_name.get(f"OpenAlex: {q}", {}).get("ok"),
             "kept": by_name.get(f"OpenAlex: {q}", {}).get("kept", 0)}
            for q in config.get("research_queries", []) or []
        ],
        "countries": [
            {"name": name, "tier": spec.get("tier", 2), "terms": spec.get("terms", [])}
            for name, spec in (config.get("countries", {}) or {}).items()
        ],
        "country_traps": config.get("country_traps", {}) or {},
        "themes": terms_of(config.get("themes", {}), "colour"),
        "events": terms_of(config.get("events", {})),
        "exclude": config.get("exclude", []) or [],
        "agencies": config.get("agencies", []) or [],
        "aggregators": config.get("aggregators", []) or [],
    }
    (ROOT / "sources.json").write_text(
        json.dumps(payload, ensure_ascii=False, indent=1), encoding="utf-8")
    counted = sum(len(s["sources"]) for s in payload["streams"])
    print(f"  sources.json  {counted} feeds, "
          f"{len(payload['research_queries'])} research queries")


def main() -> int:
    config = yaml.safe_load(CONFIG_PATH.read_text(encoding="utf-8"))
    settings = config.get("settings", {}) or {}
    window = int(settings.get("window_days", 21))
    now = datetime.now(timezone.utc)
    cutoff = now - timedelta(days=window)

    classifier = Classifier(config)
    state = load_state()
    archive = load_archive(int(settings.get("archive_days", 400)))
    print(f"Archive holds {len(archive)} items.")

    print("Collecting news...")
    news_raw, news_health = collect(config.get("news", []), classifier, cutoff)
    news = score_clusters(news_raw, classifier)

    print("Collecting analysis...")
    analysis_raw, analysis_health = collect(config.get("analysis", []), classifier, cutoff)
    analysis = score_clusters(analysis_raw, classifier)

    print("Collecting research...")
    research, research_health = fetch_research(
        config.get("research_queries", []), int(settings.get("max_research", 60)))

    # Threads and archive, before the coverage comparison so this run counts.
    mark_threads(news + analysis, archive, now)
    update_archive(archive, news, "news", now)
    update_archive(archive, analysis, "analysis", now)
    update_archive(archive, research, "research", now)

    countries_cfg = config.get("countries", {}) or {}
    coverage_rows, odd_countries = coverage(
        archive, countries_cfg, now, int(settings.get("baseline_weeks", 8)))

    for item in news + analysis:
        item["anomaly"] = any(c in odd_countries for c in item.get("countries", []))

    by_date = lambda items: sorted(items, key=lambda i: i.get("date") or "", reverse=True)
    news = by_date(news)[: int(settings.get("max_news", 300))]
    analysis = by_date(analysis)[: int(settings.get("max_analysis", 120))]

    all_health = news_health + analysis_health + research_health
    apply_dry_runs(all_health, state)

    meta = {
        "generated": now.isoformat(),
        "cadence_hours": int(settings.get("cadence_hours", 24)),
        "window_days": window,
        "countries": list(countries_cfg.keys()),
        "tiers": {name: spec.get("tier", 2) for name, spec in countries_cfg.items()},
        "themes": {name: {"colour": spec.get("colour", "#888888")}
                   for name, spec in (config.get("themes", {}) or {}).items()},
        "events": list((config.get("events", {}) or {}).keys()),
        "coverage": coverage_rows,
    }

    print("Writing...")
    write_stream("news", news, news_health, meta)
    write_stream("analysis", analysis, analysis_health, meta)
    write_stream("research", research, research_health, meta)
    write_sources(config, all_health, now)

    save_archive(archive)
    STATE_PATH.write_text(json.dumps(state, indent=1), encoding="utf-8")

    failed = [h["name"] for h in all_health if not h["ok"]]
    stale = [h["name"] for h in all_health if h.get("dry_runs", 0) >= 5]
    if failed:
        print("\nFeeds that did not respond:")
        for name in failed:
            print(f"  {name}")
    if stale:
        print("\nFeeds with five or more empty runs in a row:")
        for name in stale:
            print(f"  {name}")

    total = len(news) + len(analysis)
    print(f"\n{len(news)} news, {len(analysis)} analysis, {len(research)} research. "
          f"Archive now {len(archive)}.")

    # Deliberate failure on a suspiciously empty run, so GitHub emails you
    # rather than the site quietly showing a thin week.
    if total < MIN_EXPECTED_ITEMS:
        print(f"\nOnly {total} items collected, below the floor of {MIN_EXPECTED_ITEMS}. "
              "Treating this as a broken run. The site keeps the previous data.")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
