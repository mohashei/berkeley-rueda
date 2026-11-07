/* Berkeley Rueda — app logic.
   Plain ES module, no framework, no build step. Everything it needs comes from
   data/*.json so the group can change times, links and moves without touching
   code. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const h = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c])
  );
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/* ───────────────────────────────── storage ─────────────────────────────── */

const KEY = "berkeley-rueda:v1";
const defaults = {
  theme: "light",
  learned: [],
  level: "all",
  filters: [],
  evFilter: "all",
};
let prefs = { ...defaults };
try {
  Object.assign(prefs, JSON.parse(localStorage.getItem(KEY) || "{}"));
} catch { /* private mode, first run — defaults are fine */ }
const save = () => {
  try { localStorage.setItem(KEY, JSON.stringify(prefs)); } catch { /* ignore */ }
};
const learned = new Set(prefs.learned);
// Earlier versions had more filters; drop any we no longer understand.
prefs.filters = (prefs.filters || []).filter((f) => ["learned", "unlearned", "video"].includes(f));
const syncSets = () => {
  prefs.learned = [...learned];
  save();
};

/* ───────────────────────────────── toast ───────────────────────────────── */

let toastT;
function toast(msg) {
  const t = $("#toast");
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastT);
  toastT = setTimeout(() => (t.hidden = true), 2200);
}

/* ───────────────────────────── time-zone math ──────────────────────────── */

let TZ = "America/Los_Angeles";

/** Wall-clock fields of an instant, as seen in the group's timezone. */
function wall(ms = Date.now()) {
  const p = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    weekday: "short", hour12: false,
  }).formatToParts(new Date(ms));
  const g = (t) => p.find((x) => x.type === t)?.value;
  return {
    y: +g("year"), mo: +g("month"), d: +g("day"),
    h: +g("hour") % 24, mi: +g("minute"), s: +g("second"),
    dow: { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[g("weekday")],
    date: `${g("year")}-${g("month")}-${g("day")}`,
  };
}

function tzOffset(ms) {
  const name = new Intl.DateTimeFormat("en-US", { timeZone: TZ, timeZoneName: "longOffset" })
    .formatToParts(new Date(ms)).find((x) => x.type === "timeZoneName").value;
  const m = /GMT([+-])(\d{2}):(\d{2})/.exec(name);
  return m ? (m[1] === "-" ? -1 : 1) * (+m[2] * 60 + +m[3]) : 0;
}

/** Wall clock in the group's timezone -> epoch ms. */
function toMs({ y, mo, d, h: hh = 0, mi = 0 }) {
  const naive = Date.UTC(y, mo - 1, d, hh, mi, 0);
  let guess = naive - tzOffset(naive) * 60000;
  return naive - tzOffset(guess) * 60000;
}

const addDays = (w, n) => {
  const d = new Date(Date.UTC(w.y, w.mo - 1, w.d + n));
  return { y: d.getUTCFullYear(), mo: d.getUTCMonth() + 1, d: d.getUTCDate() };
};
const dateKey = (w) =>
  `${w.y}-${String(w.mo).padStart(2, "0")}-${String(w.d).padStart(2, "0")}`;

const fmtTime = (ms) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, hour: "numeric", minute: "2-digit",
  }).format(new Date(ms)).replace(" ", "").toLowerCase();

const fmtDay = (ms, opts = {}) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: TZ, weekday: "long", month: "short", day: "numeric", ...opts,
  }).format(new Date(ms));

function fmtDur(ms) {
  const mins = Math.max(0, Math.round(ms / 60000));
  const d = Math.floor(mins / 1440), hh = Math.floor((mins % 1440) / 60), mm = mins % 60;
  if (d) return `${d}d ${hh}h`;
  if (hh) return `${hh}h ${String(mm).padStart(2, "0")}m`;
  return `${mm}m`;
}

/* ───────────────────────────────── loading ─────────────────────────────── */

const state = { cfg: null, moves: [], events: [], notices: [], weather: null };

async function getJSON(path) {
  const res = await fetch(path, { cache: "no-cache" });
  if (!res.ok) throw new Error(`${path}: ${res.status}`);
  return res.json();
}

async function boot() {
  applyTheme();
  state.cfg = await getJSON("data/config.json");
  TZ = state.cfg.timezone || TZ;
  $("#brandName").textContent = state.cfg.group.shortName || state.cfg.group.name;
  $("#brandTag").textContent = state.cfg.group.city || "";
  document.title = state.cfg.group.shortName || "Rueda";

  // Non-blocking: each panel renders as soon as its own data lands.
  renderNow();
  renderInfo();
  setInterval(renderNow, 20000);

  getJSON("data/status.json")
    .then((s) => { state.notices = s.notices || []; renderNow(); })
    .catch(() => {});

  getJSON("data/moves.json")
    .then((m) => {
      state.moves = (m.moves || []).map((mv) => ({
        ...mv,
        hay: [mv.name, mv.family, mv.note, mv.section, ...(mv.aliases || [])]
          .filter(Boolean).join(" ").toLowerCase()
          .normalize("NFD").replace(/[\u0300-\u036f]/g, ""),
      }));
      state.movesMeta = m;
      renderMoves();
      renderNow();
    })
    .catch((e) => {
      $("#movesList").innerHTML = card(`<p class="muted">We couldn't load the move list just now (${h(e.message)}). Try again in a moment?</p>`);
    });

  getJSON("data/events.json")
    .then((e) => { state.events = e.events || []; state.eventsMeta = e; renderEvents(); renderNow(); })
    .catch(() => { state.eventsMeta = null; renderEvents(); });

  loadWeather();
}

/* ───────────────────────────────── router ─────────────────────────────── */

const views = ["now", "moves", "events", "info"];
function go(view) {
  views.forEach((v) => ($(`#view-${v}`).hidden = v !== view));
  $$(".tab").forEach((t) => {
    const on = t.dataset.view === view;
    t.classList.toggle("is-on", on);
    on ? t.setAttribute("aria-current", "page") : t.removeAttribute("aria-current");
  });
  if (location.hash.slice(1) !== view) history.replaceState(null, "", `#${view}`);
  window.scrollTo({ top: 0 });
}
$$(".tab").forEach((t) => t.addEventListener("click", () => go(t.dataset.view)));
window.addEventListener("hashchange", () => {
  const v = location.hash.slice(1);
  if (views.includes(v)) go(v);
});

/* ───────────────────────────────── theme ──────────────────────────────── */

function applyTheme() {
  document.documentElement.setAttribute("data-theme", prefs.theme === "dark" ? "dark" : "light");
}
$("#themeBtn").addEventListener("click", () => {
  prefs.theme = prefs.theme === "dark" ? "light" : "dark";
  save();
  applyTheme();
  toast(prefs.theme === "dark" ? "Dimmed the lights" : "Back to daylight");
});

/* ───────────────────────────── class schedule ─────────────────────────── */

const card = (inner, cls = "") => `<div class="card ${cls}">${inner}</div>`;

/** All sessions for a given wall-clock date, as epoch ms ranges. */
function sessionsOn(w) {
  const out = [];
  for (const s of state.cfg.schedule) {
    if (s.day !== w.dow) continue;
    const [sh, sm] = s.start.split(":").map(Number);
    const [eh, em] = s.end.split(":").map(Number);
    out.push({
      ...s,
      startMs: toMs({ ...w, h: sh, mi: sm }),
      endMs: toMs({ ...w, h: eh, mi: em }),
      date: dateKey(w),
    });
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

/** Sessions for the next 14 days from `now`, in order. */
function upcomingSessions(now = Date.now(), days = 14) {
  const base = wall(now);
  const out = [];
  for (let i = 0; i <= days; i++) {
    const w = addDays(base, i);
    w.dow = new Date(Date.UTC(w.y, w.mo - 1, w.d)).getUTCDay();
    out.push(...sessionsOn(w));
  }
  return out.sort((a, b) => a.startMs - b.startMs);
}

const noticeFor = (date) => state.notices.find((n) => n.date === date) || null;

/** The group's WhatsApp invite, if one is set in config.links. */
const chatUrl = () =>
  state.cfg?.links?.find((l) => /whatsapp/i.test(`${l.url} ${l.label}`))?.url || null;

/* ───────────────────────────────── TONIGHT ────────────────────────────── */

function renderNow() {
  if (!state.cfg) return;
  const now = Date.now();
  const all = upcomingSessions(now);
  const live = all.filter((s) => now >= s.startMs && now < s.endMs);
  const next = all.find((s) => s.startMs > now);
  const nextDate = live[0]?.date || next?.date;
  const notice = nextDate ? noticeFor(nextDate) : null;
  const off = notice && (notice.state === "cancelled" || notice.state === "off");

  // ── status card ──
  let html;
  if (off) {
    html = `
      <div class="status-top"><span class="badge off">No class this week</span>
        <span class="muted small">${h(fmtDay(toMs({ ...parseKey(notice.date), h: 12 }), { weekday: "long", month: "short", day: "numeric" }))}</span></div>
      <p class="status-h">${h(notice.title || "No class this week")}</p>
      <p class="status-sub">${h(notice.note || "We'll be back next week — keep an eye on the WhatsApp group.")}</p>`;
  } else if (live.length) {
    const s = live[0];
    const pct = clamp(((now - s.startMs) / (s.endMs - s.startMs)) * 100, 0, 100);
    html = `
      <div class="status-top"><span class="dot-live"></span><span class="badge live">We're dancing right now</span></div>
      <p class="status-h">${h(s.title)}</p>
      <p class="status-sub">Come join — ${h(fmtDur(s.endMs - now))} still to go, until ${h(fmtTime(s.endMs))}${
        s.venue ? ` · ${h(s.venue)}` : ""
      }</p>
      <div class="bar"><i style="width:${pct.toFixed(1)}%"></i></div>`;
  } else if (next) {
    const today = wall(now).date === next.date;
    const weekday = new Intl.DateTimeFormat("en-US", { timeZone: TZ, weekday: "long" })
      .format(new Date(next.startMs));
    html = `
      <div class="status-top"><span class="badge">${today ? "Later today" : `See you ${h(weekday)}`}</span></div>
      <p class="status-h">${h(next.title)}</p>
      <p class="status-sub">${h(today ? "Today" : fmtDay(next.startMs))} at ${h(fmtTime(next.startMs))}${
        next.venue ? ` · ${h(next.venue)}` : ""
      }. Everyone's welcome.</p>`;
  } else {
    html = `<p class="status-h">Nothing on the calendar yet</p>
            <p class="status-sub">Add your class times to <code>data/config.json</code> and they'll show up here.</p>`;
  }
  const sc = $("#statusCard");
  sc.className = `card status ${off ? "off" : live.length ? "on" : ""}`;
  sc.innerHTML = html;

  // ── moved / announcement notice ──
  $("#noticeSlot").innerHTML =
    notice && !off
      ? card(`
          <div class="status-top"><span class="badge">One thing</span>
            <span class="muted small">${h(notice.date)}</span></div>
          <p class="status-h" style="font-size:18px">${h(notice.title || "A change this week")}</p>
          <p class="status-sub">${h(notice.note || "")}</p>
          ${notice.mapsUrl ? `<div class="ev-actions"><a class="btn" href="${h(notice.mapsUrl)}" target="_blank" rel="noopener">Take me there</a></div>` : ""}`)
      : "";

  // ── tonight's timeline ──
  const dayKey = nextDate;
  const daySessions = dayKey ? all.filter((s) => s.date === dayKey) : [];
  $("#timelineCard").innerHTML = daySessions.length
    ? card(`
        <h2 class="card-h">${h(fmtDay(daySessions[0].startMs, { weekday: "long", month: undefined, day: undefined }))} evening</h2>
        <div class="tl">${daySessions
          .map((s) => {
            const isNow = now >= s.startMs && now < s.endMs;
            const done = now >= s.endMs;
            return `<div class="tl-row ${isNow ? "now" : ""} ${done ? "done" : ""}">
              <div class="tl-time">${h(fmtTime(s.startMs))}<br>${h(fmtTime(s.endMs))}</div>
              <div class="tl-mark"><i></i></div>
              <div><div class="tl-t">${h(s.title)}</div>
                <div class="tl-n">${h(s.note || "")}${s.venue ? ` · ${h(s.venue)}` : ""}</div>
                ${s.signupUrl ? `<a class="small" href="${h(s.signupUrl)}" target="_blank" rel="noopener">Put your name down →</a>` : ""}
              </div></div>`;
          })
          .join("")}</div>`)
    : "";

  // ── where ──
  const loc = state.cfg.location;
  const after = state.cfg.schedule.find((s) => s.mapsUrl);
  $("#placeCard").innerHTML = card(`
    <h2 class="card-h">Find us here</h2>
    <div class="tl-t">${h(loc.name)}</div>
    <p class="status-sub" style="margin-top:4px">${h(loc.detail || "")}</p>
    <div class="ev-actions" style="margin-top:11px">
      <a class="btn primary" href="${h(loc.mapsUrl)}" target="_blank" rel="noopener">Show me on a map</a>
      ${after ? `<a class="btn" href="${h(after.mapsUrl)}" target="_blank" rel="noopener">Where we go after</a>` : ""}
    </div>`) +
    (chatUrl()
      ? card(`
        <h2 class="card-h">Say hello</h2>
        <p class="status-sub">Questions, a lift, or just want to know if anyone else is going? The WhatsApp group is where we sort all that out — and it's where we post if class is ever off.</p>
        <div class="ev-actions" style="margin-top:12px">
          <a class="btn primary" href="${h(chatUrl())}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true"><path d="M20 11.8a8 8 0 0 1-11.9 7L4 20l1.3-3.9A8 8 0 1 1 20 11.8z" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"/></svg>
            Join the WhatsApp group
          </a>
        </div>`)
      : "");

  // ── other dancing tonight ──
  const todayKey = wall(now).date;
  const tonight = state.events.filter((e) => wall(Date.parse(e.start)).date === todayKey && Date.parse(e.end) > now);
  $("#tonightEvents").innerHTML = tonight.length
    ? card(`<h2 class="card-h">Also on tonight</h2>
        <div class="stack">${tonight.slice(0, 4).map(evRow).join("")}</div>
        <div class="ev-actions" style="margin-top:12px">
          <button class="btn ghost" type="button" data-goto="events">See everything that's on →</button>
        </div>`)
    : "";

  renderWeatherCard();
}

const parseKey = (k) => {
  const [y, mo, d] = k.split("-").map(Number);
  return { y, mo, d };
};

document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-goto]");
  if (b) go(b.dataset.goto);
});

/* ───────────────────────────────── weather ────────────────────────────── */

const WX = {
  0: ["Clear", "☀️"], 1: ["Mostly clear", "🌤"], 2: ["Partly cloudy", "⛅️"], 3: ["Overcast", "☁️"],
  45: ["Fog", "🌫"], 48: ["Freezing fog", "🌫"],
  51: ["Light drizzle", "🌦"], 53: ["Drizzle", "🌦"], 55: ["Heavy drizzle", "🌧"],
  56: ["Freezing drizzle", "🌧"], 57: ["Freezing drizzle", "🌧"],
  61: ["Light rain", "🌧"], 63: ["Rain", "🌧"], 65: ["Heavy rain", "🌧"],
  66: ["Freezing rain", "🌧"], 67: ["Freezing rain", "🌧"],
  71: ["Snow", "🌨"], 73: ["Snow", "🌨"], 75: ["Heavy snow", "🌨"],
  80: ["Showers", "🌦"], 81: ["Showers", "🌧"], 82: ["Heavy showers", "⛈"],
  95: ["Thunderstorm", "⛈"], 96: ["Thunderstorm", "⛈"], 99: ["Thunderstorm", "⛈"],
};

async function loadWeather() {
  const cfg = state.cfg;
  if (!cfg?.weather?.enabled || !cfg.location?.lat) return;
  const u = new URL("https://api.open-meteo.com/v1/forecast");
  u.search = new URLSearchParams({
    latitude: cfg.location.lat, longitude: cfg.location.lon,
    hourly: "temperature_2m,precipitation_probability,weather_code,wind_speed_10m",
    temperature_unit: "fahrenheit", wind_speed_unit: "mph",
    timezone: cfg.timezone, forecast_days: "8",
  });
  try {
    const d = await getJSON(u.toString());
    state.weather = d;
    renderWeatherCard();
  } catch { /* offline: card simply doesn't appear */ }
}

function renderWeatherCard() {
  const slot = $("#weatherCard");
  if (!slot || !state.weather || !state.cfg) return;
  const now = Date.now();
  const outdoor = upcomingSessions(now).find((s) => s.atLocation !== false && s.endMs > now);
  if (!outdoor) { slot.innerHTML = ""; return; }
  // Forecast horizon is 7 days; the hourly array is in the group's timezone.
  const w = wall(outdoor.startMs);
  const stamp = `${w.date}T${String(w.h).padStart(2, "0")}:00`;
  const i = state.weather.hourly.time.indexOf(stamp);
  if (i < 0) { slot.innerHTML = ""; return; }
  const t = Math.round(state.weather.hourly.temperature_2m[i]);
  const pop = state.weather.hourly.precipitation_probability[i] ?? 0;
  const code = state.weather.hourly.weather_code[i];
  const wind = Math.round(state.weather.hourly.wind_speed_10m[i]);
  const [desc, icon] = WX[code] || ["—", "🌡"];
  const wet = pop >= 40 || (code >= 51 && code <= 99);
  const chilly = t <= 52;
  slot.innerHTML = card(`
    <h2 class="card-h">What to wear · ${h(fmtTime(outdoor.startMs))}</h2>
    <div class="wx">
      <div style="font-size:34px;line-height:1">${icon}</div>
      <div>
        <div class="wx-temp">${t}°F</div>
        <div class="wx-body">${h(desc)} · ${pop}% chance of rain · wind ${wind} mph</div>
      </div>
    </div>
    ${
      wet
        ? `<p class="status-sub" style="margin-top:11px"><strong>Rain looks likely</strong> — we dance outside, so keep an eye on ${
            chatUrl() ? `<a href="${h(chatUrl())}" target="_blank" rel="noopener">the WhatsApp group</a>` : "the WhatsApp group"
          } in case we call it off.</p>`
        : chilly
        ? `<p class="status-sub" style="margin-top:11px">Bring a layer — it gets chilly once the sun goes down.</p>`
        : ""
    }`, wet ? "warn" : "");
}

/* ────────────────────────────────── MOVES ─────────────────────────────── */

const LEVELS = ["beginner", "intermediate", "advanced"];
const ytUrl = (m) =>
  m.yt
    ? `https://www.youtube.com/watch?v=${m.yt.split("?")[0]}`
    : `https://www.youtube.com/results?search_query=${encodeURIComponent(m.search || `rueda de casino ${m.name}`)}`;

function moveFilterPass(m) {
  const f = prefs.filters;
  if (f.includes("learned") && !learned.has(m.id)) return false;
  if (f.includes("unlearned") && learned.has(m.id)) return false;
  if (f.includes("video") && !m.yt) return false;
  return true;
}

function visibleMoves() {
  const q = ($("#moveSearch").value || "").trim().toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  return state.moves.filter((m) => {
    if (prefs.level !== "all" && m.level !== prefs.level) return false;
    if (!moveFilterPass(m)) return false;
    if (q && !m.hay.includes(q)) return false;
    return true;
  });
}

/** The three level rings. Cheap enough to redraw on every tick of progress. */
function renderProgress() {
  $("#progressCard").innerHTML = card(`
    <h2 class="card-h">How you're getting on</h2>
    <div class="ring-row"><div class="rings">${LEVELS.map((lv) => {
      const all = state.moves.filter((m) => m.level === lv);
      const got = all.filter((m) => learned.has(m.id)).length;
      const pct = all.length ? got / all.length : 0;
      const C = 2 * Math.PI * 22;
      const col = { beginner: "var(--palm)", intermediate: "var(--sky)", advanced: "var(--red)" }[lv];
      return `<div class="ring">
        <svg viewBox="0 0 54 54" aria-hidden="true">
          <circle cx="27" cy="27" r="22" fill="none" stroke="var(--surface-2)" stroke-width="5"/>
          <circle cx="27" cy="27" r="22" fill="none" stroke="${col}" stroke-width="5"
            stroke-linecap="round" stroke-dasharray="${C}" stroke-dashoffset="${C * (1 - pct)}"/>
        </svg>
        <span class="ring-v">${got}/${all.length}</span>
        <span class="ring-t">${lv.slice(0, 3).toUpperCase()}</span>
      </div>`;
    }).join("")}</div>
    <p class="muted small" style="margin:0">Tick off a move once you can dance it in the circle without thinking about it. There's no rush at all — people spend happy months in one level, and everyone's glad to have you there.</p>
    </div>`);
}

function updateMovesCount(shown = visibleMoves().length) {
  const got = learned.size;
  $("#movesCount").textContent =
    `Showing ${shown} of ${state.moves.length} moves` +
    (got ? ` · ${got} you've got down` : "");
}

function renderMoves() {
  if (!state.moves.length) return;
  const list = visibleMoves();
  updateMovesCount(list.length);
  $("#searchClear").hidden = !$("#moveSearch").value;

  renderProgress();

  if (!list.length) {
    $("#movesList").innerHTML = card(`<p class="muted" style="margin:0">Nothing here yet. ${
      prefs.filters.length ? "Try turning off a filter?" : "Try a shorter search — spelling varies a lot between groups."
    }</p>`);
    return;
  }

  // group: level -> section, families nested under their parent move
  const key = (lv, name) => `${lv}|${String(name).toLowerCase()}`;
  const byId = new Map(state.moves.map((m) => [key(m.level, m.name), m]));
  const shown = new Set(list.map((m) => m.id));
  const out = [];
  for (const lv of LEVELS) {
    const inLv = list.filter((m) => m.level === lv);
    if (!inLv.length) continue;
    if (prefs.level === "all") out.push(`<p class="section-h level">${lv}</p>`);
    const sections = [...new Set(inLv.map((m) => m.section))];
    for (const sec of sections) {
      out.push(`<p class="section-h">${h(sec)}</p>`);
      const items = inLv.filter((m) => m.section === sec);
      // a move whose family is also visible gets rendered inside the parent
      const parents = items.filter(
        (m) => !m.family || !shown.has(byId.get(key(m.level, m.family))?.id)
      );
      for (const p of parents) {
        const kids = items.filter(
          (k) => k.family && byId.get(key(k.level, k.family))?.id === p.id
        );
        out.push(moveCard(p, kids));
      }
    }
  }
  $("#movesList").innerHTML = out.join("");
}

function moveCard(m, kids = []) {
  const isL = learned.has(m.id);
  const lineage = [m.subgroup, m.family].filter(Boolean).join(" › ");
  return `<article class="move ${isL ? "learned" : ""}" id="mv-${h(m.id)}">
    <button class="move-head" type="button" data-toggle="${h(m.id)}" aria-expanded="false">
      <span style="min-width:0">
        <span class="move-name">${h(m.name)}</span>
        <span class="move-meta">${h(lineage || m.section)}${kids.length ? ` · ${kids.length} variation${kids.length > 1 ? "s" : ""}` : ""}</span>
      </span>
      <span class="move-flags">
        ${m.yt ? '<span class="tag">video</span>' : ""}
        <svg class="caret" viewBox="0 0 24 24" aria-hidden="true"><path d="m6 9 6 6 6-6" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg>
      </span>
    </button>
    <div class="move-body" hidden>
      ${m.note ? `<p class="move-note">${h(m.note)}</p>` : `<p class="move-note muted">No notes written down for this one — have a look at a video, or just ask one of us on Thursday. We love being asked.</p>`}
      ${m.aliases?.length ? `<div class="var-row">${m.aliases.map((a) => `<span class="var">${h(a)}</span>`).join("")}</div>` : ""}
      ${
        m.yt
          ? `<div class="embed"><iframe loading="lazy" title="${h(m.name)} demonstration"
               src="https://www.youtube-nocookie.com/embed/${h(m.yt.replace("?t=", "?start="))}"
               allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
               referrerpolicy="strict-origin-when-cross-origin" allowfullscreen></iframe></div>`
          : ""
      }
      <div class="ev-actions">
        <a class="btn ${m.yt ? "ghost" : "primary"}" href="${h(ytUrl(m))}" target="_blank" rel="noopener">
          ${m.yt ? "Watch on YouTube" : "Find someone dancing it"}
        </a>
        <button class="btn ghost" type="button" data-learn="${h(m.id)}">${isL ? "Still working on it" : "I've got this one"}</button>
      </div>
      ${
        kids.length
          ? `<div><p class="card-h" style="margin:4px 0 7px">Ways to dress it up</p>
             <div class="stack">${kids.map((k) => moveCard(k)).join("")}</div></div>`
          : ""
      }
    </div>
  </article>`;
}

$("#moveSearch").addEventListener("input", () => renderMoves());
$("#searchClear").addEventListener("click", () => { $("#moveSearch").value = ""; renderMoves(); });
$$(".seg[data-level]").forEach((b) =>
  b.addEventListener("click", () => {
    prefs.level = b.dataset.level; save();
    $$(".seg[data-level]").forEach((x) => {
      const on = x === b;
      x.classList.toggle("is-on", on);
      x.setAttribute("aria-selected", String(on));
    });
    renderMoves();
  })
);
$$("#moveFilters .chip").forEach((b) =>
  b.addEventListener("click", () => {
    const f = b.dataset.filter;
    const i = prefs.filters.indexOf(f);
    if (i >= 0) prefs.filters.splice(i, 1);
    else {
      prefs.filters.push(f);
      // learned / unlearned are mutually exclusive
      const other = f === "learned" ? "unlearned" : f === "unlearned" ? "learned" : null;
      if (other) prefs.filters = prefs.filters.filter((x) => x !== other);
    }
    save();
    syncFilterChips();
    renderMoves();
  })
);
function syncFilterChips() {
  $$("#moveFilters .chip").forEach((c) =>
    c.classList.toggle("is-on", prefs.filters.includes(c.dataset.filter))
  );
}

$("#view-moves").addEventListener("click", (e) => {
  const t = e.target.closest("[data-toggle]");
  if (t) {
    const art = t.closest(".move");
    const body = $(".move-body", art);
    const open = art.classList.toggle("open");
    body.hidden = !open;
    t.setAttribute("aria-expanded", String(open));
    return;
  }
  const l = e.target.closest("[data-learn]");
  if (l) toggleMove(l.dataset.learn);
});

/**
 * Tick a move off (or put it back). Updates that one card in place so an open
 * card stays open — unless a filter means the move should now disappear, in
 * which case we redraw the list.
 */
function toggleMove(id) {
  const isOn = !learned.has(id);
  isOn ? learned.add(id) : learned.delete(id);
  syncSets();
  toast(isOn ? "Nice — one more in the bag" : "Back on the list");
  renderProgress();
  updateMovesCount();

  if (prefs.filters.some((f) => f === "learned" || f === "unlearned")) { renderMoves(); return; }

  const art = document.getElementById(`mv-${id}`);
  if (!art) return;
  art.classList.toggle("learned", isOn);
  const btn = art.querySelector(`[data-learn="${CSS.escape(id)}"]`);
  if (btn) btn.textContent = isOn ? "Still working on it" : "I've got this one";
}

/* ────────────────────────────────── EVENTS ────────────────────────────── */

function evRow(e) {
  const start = Date.parse(e.start);
  const tags = [
    e.price && { t: e.price, c: /free/i.test(e.price) ? "free" : "" },
    e.region && { t: e.region },
    ...(e.tags || []).filter((t) => t !== "social").map((t) => ({ t })),
  ].filter(Boolean);
  return `<div class="ev">
    <div class="ev-top">
      <span class="ev-time">${h(e.allDay ? "all day" : fmtTime(start))}</span>
      <span class="ev-title">${h(e.title)}</span>
    </div>
    ${e.location ? `<div class="ev-where">${h(e.location)}</div>` : ""}
    ${tags.length ? `<div class="ev-tags">${tags.map((x) => `<span class="tag ${x.c || ""}">${h(x.t)}</span>`).join("")}</div>` : ""}
    ${
      e.notes
        ? `<details><summary>What's the night like?</summary><div class="ev-notes">${linkify(e.notes)}</div></details>`
        : ""
    }
    <div class="ev-actions">
      ${e.location ? `<a class="btn ghost" href="https://maps.google.com/?q=${encodeURIComponent(e.location)}" target="_blank" rel="noopener">Map</a>` : ""}
      ${e.url ? `<a class="btn ghost" href="${h(e.url)}" target="_blank" rel="noopener">Link</a>` : ""}
      <button class="btn ghost" type="button" data-ics="${h(e.id)}">Save the date</button>
    </div>
  </div>`;
}

const linkify = (s) =>
  h(s).replace(/https?:\/\/[^\s)<>"']+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u.replace(/^https?:\/\/(www\.)?/, "").slice(0, 38)}…</a>`);

function renderEvents() {
  const meta = state.eventsMeta;
  const list = $("#eventsList");
  if (!state.events.length) {
    list.innerHTML = card(`
      <h2 class="card-h">Straight from the source</h2>
      <p class="muted">We haven't got a saved copy yet, so here's the live calendar as una bulla keeps it.</p>
      ${calEmbed()}`);
    $("#eventsFoot").innerHTML = "";
    return;
  }

  const now = Date.now();
  const f = prefs.evFilter;
  const sel = state.events.filter((e) => {
    if (Date.parse(e.end) < now - 2 * 36e5) return false;
    if (f === "all") return true;
    if (f === "week") return Date.parse(e.start) < now + 7 * 864e5;
    if (f === "free") return /free/i.test(e.price || "");
    if (f === "live") return e.tags?.includes("live");
    if (f === "cuban") return e.tags?.includes("cuban") || /rueda|casino|timba|cuban/i.test(`${e.title} ${e.notes}`);
    return e.region === f;
  });

  const todayKey = wall(now).date;
  const tomorrowKey = dateKey(addDays(wall(now), 1));
  const groups = new Map();
  for (const e of sel) {
    const k = wall(Date.parse(e.start)).date;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(e);
  }

  list.innerHTML = groups.size
    ? [...groups.entries()]
        .map(([k, evs]) => {
          const ms = Date.parse(evs[0].start);
          const label = k === todayKey ? "Tonight" : k === tomorrowKey ? "Tomorrow" : fmtDay(ms);
          return `<div><p class="day-h">${k === todayKey || k === tomorrowKey ? `<b>${h(label)}</b> · ${h(fmtDay(ms))}` : h(label)}</p>
            <div class="stack">${evs.map((e) => card(evRow(e))).join("")}</div></div>`;
        })
        .join("")
    : card(`<p class="muted" style="margin:0">Nothing in that corner of the Bay right now — try "Everything".</p>`);

  const ageDays = meta?.generated ? (now - Date.parse(meta.generated)) / 864e5 : 999;
  const stale = ageDays > (state.cfg?.events?.staleAfterDays ?? 10);
  $("#eventsMeta").innerHTML = `${sel.length} coming up · gathered by <a href="${h(
    state.cfg?.events?.sourceUrl || "#"
  )}" target="_blank" rel="noopener">${h(meta?.source || "una bulla")}</a>, refreshed ${
    ageDays < 1 ? "this morning" : `${Math.round(ageDays)} days ago`
  }`;
  $("#eventsFoot").innerHTML =
    (stale
      ? card(`<h2 class="card-h">This list is getting on a bit</h2>
          <p class="muted small">It was last refreshed ${Math.round(ageDays)} days ago, so here's the live calendar to be safe.</p>
          ${calEmbed()}`)
      : "") +
    card(`<h2 class="card-h">Where this comes from</h2>
      <p class="muted small">These listings are lovingly crowd-sourced by <a href="${h(state.cfg?.events?.sourceUrl)}" target="_blank" rel="noopener">una bulla</a> (thank you, Karan and Rodrigo) and refreshed here each morning. Plans do change, so it's worth a quick check with the venue before a long drive.</p>
      <div class="ev-actions" style="margin-top:10px">
        <a class="btn" href="${h(state.cfg?.events?.submitUrl || state.cfg?.events?.sourceUrl)}" target="_blank" rel="noopener">Know of one? Add it</a>
        <a class="btn ghost" href="https://calendar.google.com/calendar/u/0/r?cid=${encodeURIComponent(state.cfg?.events?.googleCalendarId || "")}" target="_blank" rel="noopener">Follow the whole calendar</a>
      </div>`);
}

const calEmbed = () => {
  const id = state.cfg?.events?.googleCalendarId;
  if (!id) return "";
  const src = new URL("https://calendar.google.com/calendar/embed");
  src.search = new URLSearchParams({
    src: id, ctz: TZ, mode: "AGENDA", showTitle: "0", showPrint: "0", showCalendars: "0", showTz: "1",
  });
  return `<iframe class="cal-embed" src="${h(src.toString())}" title="Bay Area Cuban dance calendar" loading="lazy"></iframe>`;
};

$$("#eventFilters .chip").forEach((b) =>
  b.addEventListener("click", () => {
    prefs.evFilter = b.dataset.ev; save();
    $$("#eventFilters .chip").forEach((x) => x.classList.toggle("is-on", x === b));
    renderEvents();
  })
);

/* one-event .ics so "add to calendar" works offline too */
document.addEventListener("click", (e) => {
  const b = e.target.closest("[data-ics]");
  if (!b) return;
  const ev = state.events.find((x) => x.id === b.dataset.ics);
  if (!ev) return;
  const z = (s) => s.replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const ics = [
    "BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Berkeley Rueda//EN", "BEGIN:VEVENT",
    `UID:${ev.id}`, `DTSTAMP:${z(new Date().toISOString())}`,
    `DTSTART:${z(ev.start)}`, `DTEND:${z(ev.end)}`,
    `SUMMARY:${(ev.title || "").replace(/[,;\\]/g, "\\$&")}`,
    `LOCATION:${(ev.location || "").replace(/[,;\\]/g, "\\$&")}`,
    `DESCRIPTION:${(ev.notes || "").replace(/\n/g, "\\n").replace(/[,;]/g, "\\$&")}`,
    "END:VEVENT", "END:VCALENDAR",
  ].join("\r\n");
  const url = URL.createObjectURL(new Blob([ics], { type: "text/calendar" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = `${(ev.title || "event").replace(/[^\w]+/g, "-").toLowerCase()}.ics`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 4000);
  toast("Saved — it's in your downloads");
});

/* ─────────────────────────────────── INFO ─────────────────────────────── */

const ICONS = {
  doc: "M7 3h7l5 5v13H7z", list: "M5 6h14M5 12h14M5 18h9",
  chat: "M4 5h16v10H9l-5 4z", calendar: "M4 6h16v14H4z",
};

function renderInfo() {
  const c = state.cfg;
  const nice = (hhmm) => {
    const [hh, mm] = hhmm.split(":").map(Number);
    const ampm = hh < 12 ? "am" : "pm";
    const h12 = hh % 12 === 0 ? 12 : hh % 12;
    return mm ? `${h12}:${String(mm).padStart(2, "0")}${ampm}` : `${h12}${ampm}`;
  };
  const sched = c.schedule
    .map((s) => `<li><strong>${h(nice(s.start))}–${h(nice(s.end))}</strong> — ${h(s.title)}${s.note ? `. ${h(s.note)}` : ""}</li>`)
    .join("");
  $("#infoBody").innerHTML = `
    ${card(`
      <h2>Come dance with us</h2>
      <div class="prose">
        <p>If you've never danced a step in your life, you're exactly who these classes are for. Turn up on your own or with a friend — you don't need a partner, you don't need special shoes, and you don't need to have any idea what you're doing. Someone will show you.</p>
        <p>It's free. Every week. Really.</p>
      </div>`, "hello")}

    ${card(`
      <h2 class="card-h">How a ${
        ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][c.schedule[0].day]
      } goes</h2>
      <div class="prose">
        <ul>${sched}</ul>
        <p>We dance outdoors on the lawn at ${h(c.location.name.split("—")[0].trim())}. Afterwards most of us wander over to the social together — come along, there's no pressure to dance a single song.</p>
      </div>`)}

    ${card(`
      <h2 class="card-h">What is rueda, anyway?</h2>
      <div class="prose">
        <p>Cuban salsa, danced in a circle. One person calls out a move, everybody dances it at the same moment, and partners pass around the ring — so in one song you dance with everyone. It's loud, it's a bit chaotic, and it's much easier to pick up than it looks, because you can always copy the person opposite you.</p>
      </div>`)}

    ${card(`
      <h2 class="card-h">Which class should I join?</h2>
      <div class="prose">
        <p><strong>Beginner</strong> — if you're new, start here. Always. Nobody will mind, and we were all there.</p>
        <p><strong>Intermediate</strong> — when the beginner moves feel comfortable and automatic in the circle.</p>
        <p><strong>Advanced</strong> — by invite. You're dancing all the intermediate moves in your main role, plus the beginner ones (and vacila, sombrero and setenta) in the other role too.</p>
        <p>Staying put for a while is a good thing, not a holding pattern — it's how the moves get smooth and how the whole circle keeps learning together. If you're unsure where you fit, just ask a teacher on the night.</p>
      </div>
      <div class="ev-actions" style="margin-top:4px">
        <a class="btn" href="${h(c.advancedSignupUrl || c.links[1]?.url || "#")}" target="_blank" rel="noopener">Sign up for advanced</a>
      </div>`)}

    ${card(`
      <h2 class="card-h">Handy links</h2>
      <div class="linklist">${c.links
        .map(
          (l) => `<a class="linkrow" href="${h(l.url)}" target="_blank" rel="noopener">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true" style="color:var(--coral-ink);flex:none"><path d="${ICONS[l.icon] || ICONS.doc}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linejoin="round"/></svg>
            <span>${h(l.label)}</span>
            <svg class="arr" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </a>`
        )
        .join("")}</div>`)}

    ${card(`
      <h2 class="card-h">Good places to watch moves</h2>
      <div class="linklist">${(c.videoSources || [])
        .map(
          (v) => `<a class="linkrow" href="${h(v.url)}" target="_blank" rel="noopener">
            <span>${h(v.name)}<small>${h(v.note)}</small></span>
            <svg class="arr" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </a>`
        )
        .join("")}</div>
      <p class="muted small" style="margin:11px 0 0">Every move in the app has a one-tap YouTube search, so you can always go looking. Names vary between groups, so if a search comes back odd, try the Spanish spelling.</p>`)}

    ${card(`
      <h2 class="card-h">Other folks to dance with</h2>
      <div class="prose"><p>We're part of a lovely wider scene — go say hello to these groups too.</p></div>
      <div class="linklist">${(c.otherGroups || [])
        .map(
          (g) => `<a class="linkrow" href="${h(g.url)}" target="_blank" rel="noopener">
            <span>${h(g.name)}<small>${h(g.note)}</small></span>
            <svg class="arr" viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path d="m9 6 6 6-6 6" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </a>`
        )
        .join("")}</div>`)}

    ${card(`
      <h2 class="card-h">Keep this on your phone</h2>
      <div class="prose">
        <p><strong>iPhone:</strong> open it in Safari, tap Share, then <em>Add to Home Screen</em>.</p>
        <p><strong>Android:</strong> open it in Chrome, tap the menu, then <em>Install app</em>.</p>
        <p>It'll open full screen like any other app, and it still works when the campus wifi doesn't.</p>
      </div>`)}

    ${card(`
      <h2 class="card-h">Thank yous</h2>
      <div class="prose">
        <p>The moves and levels here come straight from the group's own <a href="${h(
          state.movesMeta?.sourceUrl || c.links[0].url
        )}" target="_blank" rel="noopener">moves document</a> — built on what our teachers learned from Rueda con Ritmo and Salsa Vale Todo. Rueda has dialects, and this is simply ours.</p>
        <p>Event listings are kindly crowd-sourced by una bulla. Weather from Open-Meteo. There are no accounts and no tracking here — the moves you tick off are saved on your own phone and nowhere else.</p>
      </div>
      <div class="ev-actions"><button class="btn ghost" id="wipeBtn" type="button">Clear my ticks</button></div>`)}
  `;

  $("#wipeBtn").addEventListener("click", () => {
    learned.clear(); syncSets();
    toast("All reset — fresh start");
    renderMoves();
  });
}

/* ──────────────────────────────── start-up ────────────────────────────── */

// restore control values before first render
$$(".seg[data-level]").forEach((x) => {
  const on = x.dataset.level === prefs.level;
  x.classList.toggle("is-on", on);
  x.setAttribute("aria-selected", String(on));
});
$$("#eventFilters .chip").forEach((x) => x.classList.toggle("is-on", x.dataset.ev === prefs.evFilter));
syncFilterChips();

go(views.includes(location.hash.slice(1)) ? location.hash.slice(1) : "now");
boot().catch((e) => {
  $("#statusCard").innerHTML = `<p class="status-h">Something went wrong</p><p class="status-sub">We couldn't load the class details (${h(e.message)}). A refresh usually sorts it.</p>`;
});


if ("serviceWorker" in navigator) {
  window.addEventListener("load", () =>
    navigator.serviceWorker.register("sw.js").catch(() => {})
  );
}
