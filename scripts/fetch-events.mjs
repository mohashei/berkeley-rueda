#!/usr/bin/env node
/**
 * Fetches the public "una bulla" Bay Area Cuban-dance Google Calendar (.ics),
 * expands recurring events into real dates, and writes data/events.json.
 *
 * Why: browsers can't read the .ics directly (Google serves it without CORS
 * headers), so we snapshot it server-side. The GitHub Action in
 * .github/workflows/update-events.yml runs this every morning and commits the
 * result, which makes the app fast, offline-friendly and dependency-free.
 *
 * Usage:  node scripts/fetch-events.mjs [--days 70] [--out data/events.json]
 * Needs Node 18+ (global fetch). No npm packages.
 */

import { writeFileSync, readFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";

const CONFIG_PATH = resolve("data/config.json");
const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
const CAL_ID = cfg.events.googleCalendarId;
const TZ = cfg.timezone || "America/Los_Angeles";
const ICS_URL = `https://calendar.google.com/calendar/ical/${encodeURIComponent(
  CAL_ID
)}/public/basic.ics`;

const args = process.argv.slice(2);
const argOf = (flag, fallback) => {
  const i = args.indexOf(flag);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const DAYS = Number(argOf("--days", 70));
const OUT = resolve(argOf("--out", "data/events.json"));

/* ------------------------------------------------------------------ ICS ---- */

/** Unfold (RFC 5545 §3.1) then split into {name, params, value} per line. */
function parseLines(text) {
  const unfolded = text.replace(/\r\n/g, "\n").replace(/\n[ \t]/g, "");
  return unfolded
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const colon = line.indexOf(":");
      if (colon < 0) return null;
      const left = line.slice(0, colon);
      const value = line.slice(colon + 1);
      const [name, ...paramParts] = left.split(";");
      const params = {};
      for (const p of paramParts) {
        const eq = p.indexOf("=");
        if (eq > 0) params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"|"$/g, "");
      }
      return { name: name.toUpperCase(), params, value };
    })
    .filter(Boolean);
}

function splitComponents(lines) {
  const events = [];
  let cur = null;
  for (const l of lines) {
    if (l.name === "BEGIN" && l.value === "VEVENT") cur = { props: [] };
    else if (l.name === "END" && l.value === "VEVENT") {
      if (cur) events.push(cur);
      cur = null;
    } else if (cur) cur.props.push(l);
  }
  return events;
}

const unescapeText = (s) =>
  (s || "")
    .replace(/\\n/gi, "\n")
    .replace(/\\,/g, ",")
    .replace(/\\;/g, ";")
    .replace(/\\\\/g, "\\");

/* ------------------------------------------------------- time zone math ---- */

const offsetCache = new Map();
/** Offset in minutes (east positive) of `tz` at the given UTC instant. */
function tzOffsetMinutes(utcMs, tz) {
  const key = `${Math.floor(utcMs / 3600000)}|${tz}`;
  if (offsetCache.has(key)) return offsetCache.get(key);
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    timeZoneName: "longOffset",
  })
    .formatToParts(new Date(utcMs))
    .find((p) => p.type === "timeZoneName").value; // e.g. "GMT-08:00"
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  const mins = m ? (m[1] === "-" ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3])) : 0;
  offsetCache.set(key, mins);
  return mins;
}

/** Wall-clock time in `tz` -> UTC epoch ms. */
function zonedToUtc({ y, mo, d, h = 0, mi = 0, s = 0 }, tz) {
  const naive = Date.UTC(y, mo - 1, d, h, mi, s);
  let guess = naive - tzOffsetMinutes(naive, tz) * 60000;
  // One correction pass handles DST boundaries.
  guess = naive - tzOffsetMinutes(guess, tz) * 60000;
  return guess;
}

/** Parse DTSTART/DTEND/UNTIL/EXDATE values. Returns {ms, allDay, parts}. */
function parseDate(value, params) {
  const v = value.trim();
  let m = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/.exec(v);
  if (m) {
    const parts = {
      y: +m[1], mo: +m[2], d: +m[3], h: +m[4], mi: +m[5], s: +m[6],
    };
    if (m[7] === "Z") return { ms: Date.UTC(parts.y, parts.mo - 1, parts.d, parts.h, parts.mi, parts.s), allDay: false, parts };
    const tz = params.TZID || TZ;
    return { ms: zonedToUtc(parts, tz), allDay: false, parts, tz };
  }
  m = /^(\d{4})(\d{2})(\d{2})$/.exec(v);
  if (m) {
    const parts = { y: +m[1], mo: +m[2], d: +m[3] };
    return { ms: zonedToUtc(parts, params.TZID || TZ), allDay: true, parts };
  }
  return null;
}

/* ---------------------------------------------------------- recurrence ----- */

const WEEKDAY = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

function parseRRule(value) {
  const out = {};
  for (const pair of value.split(";")) {
    const [k, v] = pair.split("=");
    if (!k || v === undefined) continue;
    out[k.toUpperCase()] = v;
  }
  return out;
}

/** Day-of-week of a UTC instant *as seen in tz*, plus its y/m/d there. */
function wallParts(ms, tz) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", weekday: "short",
  }).formatToParts(new Date(ms));
  const get = (t) => p.find((x) => x.type === t)?.value;
  const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[get("weekday")];
  return { y: +get("year"), mo: +get("month"), d: +get("day"), dow: wd };
}

/**
 * Expand one RRULE into UTC instants inside [from, to].
 * Supports FREQ=DAILY/WEEKLY/MONTHLY/YEARLY with INTERVAL, BYDAY (incl.
 * ordinals like 4FR / -1SU), BYMONTHDAY, COUNT and UNTIL — i.e. everything
 * Google Calendar's UI can produce for a weekly/monthly social.
 */
function expandRule(rule, start, from, to, tz, exdates) {
  const freq = rule.FREQ;
  const interval = Math.max(1, Number(rule.INTERVAL || 1));
  const count = rule.COUNT ? Number(rule.COUNT) : null;
  const until = rule.UNTIL ? parseDate(rule.UNTIL, {}).ms : null;
  const hardStop = Math.min(to, until ?? to);
  const time = { h: start.parts.h ?? 0, mi: start.parts.mi ?? 0, s: start.parts.s ?? 0 };
  const byDay = (rule.BYDAY || "").split(",").filter(Boolean).map((tok) => {
    const m = /^([+-]?\d)?([A-Z]{2})$/.exec(tok.trim());
    return m ? { ord: m[1] ? Number(m[1]) : 0, dow: WEEKDAY[m[2]] } : null;
  }).filter(Boolean);
  const byMonthDay = (rule.BYMONTHDAY || "").split(",").filter(Boolean).map(Number);

  const out = [];
  const push = (ms) => {
    if (ms < start.ms) return;
    if (until !== null && ms > until) return;
    if (exdates.has(ms)) return;
    if (ms >= from && ms <= to) out.push(ms);
  };
  const atWall = (y, mo, d) => zonedToUtc({ y, mo, d, ...time }, tz);
  const startWall = wallParts(start.ms, tz);
  let emitted = 0;

  if (freq === "WEEKLY") {
    const days = byDay.length ? byDay.map((b) => b.dow) : [startWall.dow];
    // Walk week by week from the start's week.
    const weekStartMs = atWall(startWall.y, startWall.mo, startWall.d) - startWall.dow * 86400000;
    for (let w = 0; ; w += interval) {
      const base = weekStartMs + w * 7 * 86400000;
      if (base > hardStop + 7 * 86400000) break;
      for (const dow of days.slice().sort((a, b) => a - b)) {
        const probe = base + dow * 86400000;
        const pw = wallParts(probe, tz);
        const ms = atWall(pw.y, pw.mo, pw.d);
        if (ms < start.ms) continue;
        if (count !== null && emitted >= count) return out;
        if (until !== null && ms > until) return out;
        emitted++;
        push(ms);
      }
      if (count !== null && emitted >= count) break;
    }
    return out;
  }

  if (freq === "MONTHLY" || freq === "YEARLY") {
    const stepMonths = freq === "YEARLY" ? 12 * interval : interval;
    for (let i = 0; ; i++) {
      const total = (startWall.y * 12 + (startWall.mo - 1)) + i * stepMonths;
      const y = Math.floor(total / 12);
      const mo = (total % 12) + 1;
      const firstMs = atWall(y, mo, 1);
      if (firstMs > hardStop + 40 * 86400000) break;
      const daysInMonth = new Date(Date.UTC(y, mo, 0)).getUTCDate();
      let candidates = [];
      if (byDay.length) {
        for (const { ord, dow } of byDay) {
          const matching = [];
          for (let d = 1; d <= daysInMonth; d++) {
            if (wallParts(atWall(y, mo, d), tz).dow === dow) matching.push(d);
          }
          if (ord === 0) candidates.push(...matching);
          else if (ord > 0 && matching[ord - 1]) candidates.push(matching[ord - 1]);
          else if (ord < 0 && matching[matching.length + ord]) candidates.push(matching[matching.length + ord]);
        }
      } else if (byMonthDay.length) {
        candidates = byMonthDay.map((d) => (d > 0 ? d : daysInMonth + d + 1));
      } else {
        candidates = [startWall.d];
      }
      for (const d of [...new Set(candidates)].sort((a, b) => a - b)) {
        if (d < 1 || d > daysInMonth) continue;
        const ms = atWall(y, mo, d);
        if (ms < start.ms) continue;
        if (count !== null && emitted >= count) return out;
        if (until !== null && ms > until) return out;
        emitted++;
        push(ms);
      }
      if (count !== null && emitted >= count) break;
      if (i > 400) break;
    }
    return out;
  }

  // DAILY (and anything unrecognised: treat as daily so we never silently drop)
  for (let i = 0; ; i++) {
    const ms = start.ms + i * interval * 86400000;
    if (ms > hardStop) break;
    if (count !== null && emitted >= count) break;
    emitted++;
    push(ms);
    if (i > 2000) break;
  }
  return out;
}

/* ------------------------------------------------------------- cleaning ---- */

const EMOJI_TAGS = [
  [/💃|🕺/u, "social"],
  [/🪘|🎺|🎷|🥁/u, "live"],
  [/✊/u, "cause"],
  [/🎟/u, "festival"],
  [/✨/u, "special"],
];

function describe(raw) {
  // Google wraps links in <a href="https://www.google.com/url?q=REAL&..."> —
  // unwrap those, then strip the rest of the markup.
  let s = unescapeText(raw);
  s = s.replace(/https?:\/\/www\.google\.com\/url\?q=([^"&\s]+)[^"\s]*/g, (_, u) =>
    decodeURIComponent(u)
  );
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>(.*?)<\/a>/gis, (_, href, label) => {
    const text = label.replace(/<[^>]+>/g, "").trim();
    return text && !/^https?:/i.test(text) ? `${text} (${href})` : href;
  });
  s = s.replace(/<br\s*\/?>/gi, "\n").replace(/<\/p>/gi, "\n");
  s = s.replace(/<[^>]+>/g, "");
  s = s.replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<")
       .replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;/g, "'");
  return s.replace(/\n{3,}/g, "\n\n").trim();
}

const firstUrl = (s) => (s.match(/https?:\/\/[^\s)<>"']+/) || [null])[0];

const REGIONS = {
  EB: "East Bay", SF: "San Francisco", SB: "South Bay", MARIN: "Marin",
  PEN: "Peninsula", PENINSULA: "Peninsula", NB: "North Bay", SAC: "Sacramento",
};

/**
 * una bulla titles look like "[EB: 💃🏽🪘] AHÍ NAMA ($10)".
 * Pull that apart so the app can filter by area / price / kind of night.
 */
function parseTitle(raw) {
  let title = raw.trim();
  let region = null;
  const tags = new Set(
    EMOJI_TAGS.filter(([re]) => re.test(title)).map(([, t]) => t)
  );
  const bracket = /^\[([^\]]*)\]\s*/.exec(title);
  if (bracket) {
    const inner = bracket[1];
    const key = (inner.split(":")[0] || "").trim().toUpperCase();
    if (REGIONS[key]) region = REGIONS[key];
    else if (key && key.length <= 12 && !/^\p{Emoji}/u.test(key)) region = inner.split(":")[0].trim();
    title = title.slice(bracket[0].length).trim();
  }
  let price = null;
  const money = /\(\s*\$([^)]*)\)\s*$/.exec(title);
  if (money) {
    const v = money[1].trim();
    price = /^free$/i.test(v) ? "Free" : `$${v}`;
    title = title.slice(0, money.index).trim();
  }
  if (/\b(class|workshop|lesson|intensive|bootcamp)\b/i.test(`${raw}`)) tags.add("class");
  if (/\b(rueda|casino|timba|cuban)\b/i.test(`${raw}`)) tags.add("cuban");
  return { title: title.replace(/\s{2,}/g, " "), region, price, tags: [...tags] };
}

/* ----------------------------------------------------------------- main ---- */

const res = await fetch(ICS_URL, { headers: { "user-agent": "berkeley-rueda-app/1.0" } });
if (!res.ok) {
  console.error(`Calendar fetch failed: ${res.status} ${res.statusText}`);
  process.exit(1);
}
const ics = await res.text();
const comps = splitComponents(parseLines(ics));
console.log(`fetched ${ics.length} bytes, ${comps.length} VEVENTs`);

const now = Date.now();
const FROM = now - 12 * 3600000; // keep today's earlier events visible
const TO = now + DAYS * 86400000;

/** uid -> overrides keyed by the original instance start (RECURRENCE-ID). */
const overrides = new Map();
const masters = [];

for (const c of comps) {
  const get = (n) => c.props.find((p) => p.name === n);
  const all = (n) => c.props.filter((p) => p.name === n);
  const dtstart = get("DTSTART");
  if (!dtstart) continue;
  const start = parseDate(dtstart.value, dtstart.params);
  if (!start) continue;
  const dtend = get("DTEND");
  const end = dtend ? parseDate(dtend.value, dtend.params) : null;
  const uid = get("UID")?.value || Math.random().toString(36).slice(2);
  const recId = get("RECURRENCE-ID");
  const ev = {
    uid,
    start,
    end,
    durationMs: end ? end.ms - start.ms : start.allDay ? 86400000 : 2 * 3600000,
    title: unescapeText(get("SUMMARY")?.value || "").trim(),
    location: unescapeText(get("LOCATION")?.value || "").trim(),
    desc: describe(get("DESCRIPTION")?.value || ""),
    cancelled: (get("STATUS")?.value || "").toUpperCase() === "CANCELLED",
    rrule: get("RRULE") ? parseRRule(get("RRULE").value) : null,
    exdates: new Set(
      all("EXDATE").flatMap((p) =>
        p.value.split(",").map((v) => parseDate(v, p.params)?.ms).filter(Boolean)
      )
    ),
  };
  if (recId) {
    const key = parseDate(recId.value, recId.params)?.ms;
    if (!overrides.has(uid)) overrides.set(uid, new Map());
    overrides.get(uid).set(key, ev);
  } else {
    masters.push(ev);
  }
}

const out = [];
for (const ev of masters) {
  const ovr = overrides.get(ev.uid) || new Map();
  let instants;
  if (ev.rrule) {
    instants = expandRule(ev.rrule, ev.start, FROM, TO, ev.start.tz || TZ, ev.exdates);
  } else {
    instants = ev.start.ms + ev.durationMs >= FROM && ev.start.ms <= TO ? [ev.start.ms] : [];
  }
  for (const ms of instants) {
    const o = ovr.get(ms);
    const src = o || ev;
    if (src.cancelled) continue;
    const startMs = o ? o.start.ms : ms;
    if (startMs + src.durationMs < FROM || startMs > TO) continue;
    const t = parseTitle(src.title);
    out.push({
      id: `${ev.uid}-${startMs}`,
      start: new Date(startMs).toISOString(),
      end: new Date(startMs + src.durationMs).toISOString(),
      allDay: !!src.start.allDay,
      title: t.title,
      rawTitle: src.title,
      region: t.region,
      price: t.price,
      location: src.location,
      notes: src.desc,
      url: firstUrl(`${src.desc} ${src.location}`),
      recurring: !!ev.rrule,
      tags: t.tags,
    });
  }
}

// Google's feed can repeat a one-off across duplicate VEVENTs; de-dupe on
// (start, normalised title).
const seen = new Set();
const events = out
  .filter((e) => {
    const k = `${e.start}|${e.rawTitle.replace(/[^a-z0-9]/gi, "").toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  })
  .sort((a, b) => a.start.localeCompare(b.start));

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      generated: new Date().toISOString(),
      timezone: TZ,
      windowDays: DAYS,
      source: cfg.events.sourceName,
      sourceUrl: cfg.events.sourceUrl,
      count: events.length,
      events,
    },
    null,
    1
  ) + "\n"
);
console.log(`wrote ${events.length} events -> ${OUT}`);
console.log(
  events.slice(0, 8).map((e) => `  ${e.start.slice(0, 16)}  ${e.title.slice(0, 54)}`).join("\n")
);
