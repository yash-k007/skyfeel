# Skyfeel — Phase 1 (MVP)

A private mood + weather journal that runs on Android and iPhone as an installable web app (PWA).
No account, no server, no tracking. Entries never leave the user's phone.

## What's included

| File | What it does |
| --- | --- |
| `index.html` | The app shell, with a strict Content Security Policy |
| `app.js` | All app logic: mood logging, weather, calendar, insights, settings |
| `styles.css` | Look and feel, light and dark mode |
| `sw.js` | Service worker: lets the app open offline (caches only the app's own files) |
| `manifest.webmanifest` + `icons/` | Makes it installable with a proper home-screen icon |
| `privacy.html` | Privacy policy (add a contact email before publishing) |

## Features in this version

- Log mood (5 levels), tags and a short note, for today or any past day
- Weather attached automatically (Open-Meteo), with backfill for days saved offline
- Location by city search or approximate GPS (rounded to ~1 km), or none at all
- Mood calendar with weather icons and a streak counter
- Insights: mood by weather type, temperature and weekday, plus a friendly summary line
- Daily reminder via a repeating event in the phone's own calendar (no server needed), plus an in-app nudge
- Export (JSON, CSV), import a backup, delete one entry or everything
- Works offline after the first visit

## Try it on your computer

You need Python 3 (already on most Macs and Linux; free from python.org for Windows).

```
cd skyfeel
python3 -m http.server 8000
```

Open http://localhost:8000 in Chrome. Use the browser's phone view (F12 → device toolbar) to see it as on a phone.

## Put it online for free (GitHub Pages)

1. Create a free account at github.com.
2. Click **New repository**, name it `skyfeel`, set it to **Public**, and create it.
3. Click **uploading an existing file**, drag in everything inside the `skyfeel` folder (including the `icons` folder), and click **Commit changes**.
4. Go to **Settings → Pages**. Under "Branch", pick `main` and `/ (root)`, then **Save**.
5. After a minute your app is live at `https://<your-username>.github.io/skyfeel/`.

GitHub Pages serves over HTTPS, which the app needs for installation, location and offline mode.

## Install it on a phone

- **Android (Chrome):** open the link → menu ⋮ → **Install app** (or "Add to Home screen").
- **iPhone (Safari):** open the link → Share → **Add to Home Screen**.

## Updating the app later

When you change any file, also bump the version in `sw.js` (`const CACHE = 'skyfeel-v1.0.1'`) so phones download the new version instead of the cached one.

## Security and privacy review (done before release)

| Check | Result |
| --- | --- |
| Where user data is stored | Only in the browser's local storage on the device. No server exists. |
| Who can read the data | Only the person holding the phone. Not the app's maker, not GitHub, not Claude. |
| Network destinations | Only `api.open-meteo.com` and `geocoding-api.open-meteo.com`, enforced by the Content Security Policy |
| What is sent | Rounded coordinates (~1 km) or a typed city name. Never moods, tags or notes. No cookies. |
| Code injection (XSS) | All user text is rendered as plain text; tested with a malicious note, nothing executed |
| Third-party code | None. No libraries, no CDNs, no analytics, no ads |
| Malicious backup files | Imports are size-limited and every field is validated; tested with invalid dates, future dates, oversized notes, fake tags and prototype-pollution attempts — all rejected or cleaned |
| CSV export | Text cells are protected against spreadsheet formula injection |
| Permissions | Location only, only when the user taps "Use my location", low accuracy |
| Offline cache | Caches only the app's own files; weather responses are never stored by the service worker |

Limits worth knowing: if someone has unlocked access to the phone itself, they can open the app like any other. Clearing browser data or uninstalling erases entries, so users should export backups.

## Legal notes (EU / Italy)

- Mood data is sensitive under GDPR, which is why Skyfeel never collects it: processing happens only on the user's device.
- Open-Meteo's free API is for **non-commercial use** (under 10,000 calls/day) and requires attribution, which is shown in Settings. A commercial version needs their paid plan.
- Add a contact email to `privacy.html` before sharing the app publicly.
- This is a personal journal, not a medical device: avoid health claims in any description.
- Not legal advice: have a privacy lawyer review the policy if you ever monetise or start collecting data.

Weather data by [Open-Meteo.com](https://open-meteo.com/) (CC BY 4.0).
