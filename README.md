# Berkeley Rueda

A little web app for the Berkeley Rueda de Casino group: whether we're dancing
tonight and where, all the moves we teach with notes and videos, and what else
is on around the Bay. It's a plain static site — put it on GitHub Pages and
anyone can add it to their phone's home screen, where it behaves like a normal
app.

Light, warm and pastel by default, with a soft dark mode behind the sun button
for late nights. No build step, no dependencies, no accounts, no tracking.

---

## Put it online (about five minutes)

1. Make a repo on GitHub — call it `rueda`, or anything you like.
2. Upload everything in this folder, keeping the structure. From a terminal:
   ```bash
   cd /path/to/this/folder
   git init -b main
   git add .
   git commit -m "Berkeley Rueda app"
   git remote add origin https://github.com/YOUR-NAME/rueda.git
   git push -u origin main
   ```
3. On GitHub: **Settings → Pages → Source: Deploy from a branch → `main` / `root`**.
4. A minute later it's live at `https://YOUR-NAME.github.io/rueda/`.
5. Share the link. On iPhone: Safari → Share → **Add to Home Screen**.
   On Android: Chrome → menu → **Install app**.

Everything uses relative paths, so it's equally happy in a sub-folder, on a
custom domain, or served locally with `python3 -m http.server`.

---

## Looking after it

### Cancelling a class, moving it, or telling everyone something

Edit **`data/status.json`**. The Welcome tab has a small form that writes the
snippet for you — fill it in, tap *Copy it*, paste, commit.

```json
{
  "updated": "2026-11-12",
  "notices": [
    { "date": "2026-11-12", "state": "cancelled",
      "title": "No class tonight — rain",
      "note": "Back next Thursday. Comal is still on if you fancy it!" },

    { "date": "2026-11-19", "state": "moved",
      "title": "Indoors this week",
      "note": "Hearst Gym, same times.",
      "mapsUrl": "https://maps.google.com/?q=Hearst+Gym+Berkeley" }
  ]
}
```

- `"cancelled"` turns the Tonight card soft coral and says there's no class.
- `"moved"` or `"note"` adds a gentle heads-up above the evening's schedule.
- `date` is the day of the class, `YYYY-MM-DD`.
- Old notices are ignored; tidy them away whenever you like.

### Times, location, links

All in **`data/config.json`** — the class blocks, the social afterwards, the map
pin, the WhatsApp invite, the other groups. `day` is `0`=Sunday … `4`=Thursday,
and times are 24-hour `"HH:MM"` (the app shows them as `6pm`).

Add a session by adding an object to `schedule`. Set `"atLocation": false` for
anything that isn't on the VLSB lawn, so it's left out of the outdoor weather
warning.

### Moves and videos

**`data/moves.json`** holds 132 moves taken from the group's own
[Levels & Moves document](https://docs.google.com/document/d/1lu0E78OzwgbZ-Fw74yhmrpKr_KAt_aCk6QeL6SqYxTQ/edit),
keeping its levels, sections and variation tree.

```jsonc
{
  "id": "int-setenta",
  "name": "Setenta",
  "level": "intermediate",       // beginner | intermediate | advanced
  "section": "Open position",
  "family": null,                // parent move; variations nest underneath
  "note": "first 8 count in place",
  "search": "rueda de casino Setenta tutorial",
  "yt": null                     // ← a YouTube video id goes here
}
```

Every move already has a one-tap YouTube *search*, so nothing is ever a dead
link. To pin a particular demo, set `"yt"` to the video id — the bit after `v=`:

```
https://www.youtube.com/watch?v=XYZ123abcd  →  "yt": "XYZ123abcd"
https://youtu.be/XYZ123abcd?t=95            →  "yt": "XYZ123abcd?t=95"
```

It then plays inside the app. Nice places to go looking:
[rueda.casino](https://www.youtube.com/@ruedacasino/videos),
[DanceInTime](https://danceintime.com/info/rueda-steps-manual),
[ruedawiki.org](https://ruedawiki.org/).

---

## How the events list stays fresh

The Dancing tab shows the Bay Area Cuban-dance calendar that
[una bulla](https://www.unabulla.com/sf) keeps (thank you, Karan and Rodrigo).

Google serves that calendar without CORS headers, so a browser can't read it
directly. Instead `.github/workflows/update-events.yml` runs
`scripts/fetch-events.mjs` **every morning at about 5:17am Pacific**: it fetches
the `.ics`, expands the recurring socials into real dates for the next 70 days,
tidies the titles (`[EB: 💃🏽] AHÍ NAMA ($10)` → title + area + price), and commits
`data/events.json` if anything changed. Fast, styled, works offline, no upkeep.

- **Switch it on:** the workflow needs write access — *Settings → Actions →
  General → Workflow permissions → Read and write permissions*. Then run it once
  by hand from the **Actions** tab.
- **Run it yourself:** `node scripts/fetch-events.mjs --days 70` (Node 18+).
- **A different calendar:** change `events.googleCalendarId` in `data/config.json`.
- If the saved list ever goes stale, the app notices and shows the live Google
  Calendar instead.

---

## What's in it

| Tab | What you'll find |
|---|---|
| **Tonight** | Are we dancing right now, or how long until we are? A countdown, the evening's schedule, the map pin, what to wear (it pulls the forecast for class time, since we're on a lawn), anything you've announced, and other dancing happening tonight. |
| **Moves** | All 132 moves, searchable, filtered by level, with variations tucked under their parent. Tap one for the notes from class and a video. Tick off the ones you've got — the rings show how you're getting on. |
| **Dancing** | Socials, live bands and classes around the Bay, grouped by day, filterable by area / free / live music / Cuban. Each one saves to your calendar. |
| **Welcome** | The warm introduction for newcomers, how the levels work, every link, other groups to dance with, install instructions, and the notice form for organisers. |

Ticked-off moves live in your own browser — nothing is sent anywhere, and
nothing is shared between people.

## Files

```
index.html              the shell
app.css                 one stylesheet, pastel light + soft dark
app.js                  all the logic (plain ES module)
sw.js                   service worker: offline + instant launch
manifest.webmanifest    makes it installable
data/config.json        ← times, location, links   (edit me)
data/status.json        ← cancellations, notices   (edit me)
data/moves.json         ← the moves and videos     (edit me)
data/events.json        refreshed every morning — no need to touch
scripts/fetch-events.mjs              the calendar importer
.github/workflows/update-events.yml   runs it daily
icons/                  app icons
```

## Thank yous

The moves, the levels and the wording about moving up come from the group's own
Levels & Moves document, built on what the teachers learned from Rueda con Ritmo
and Salsa Vale Todo. Event listings from una bulla, weather from Open-Meteo.
Everything else is plain HTML, CSS and JavaScript.
