# IRONHABIT — Fitness & Gym Accountability PWA

A local-first Progressive Web App (PWA) built for strict daily home exercise and weekly gym accountability. Works offline out of the box, supports responsive desktop sidebar and mobile bottom-bar layouts, and optionally syncs across devices using your own private cloud storage.

---

## Core Accountability Model

- **Per-Exercise & Weekly Gym Schedules (`Daily` or `Custom`):**
  - Home exercises default to **Daily (7d/wk)** or can be switched to **Custom** (`1–6 days/wk`) with specific committed weekdays (`Sun–Sat`).
  - Weekly Gym Attendance supports **Daily (7d)** or **Custom** committed weekdays (`Sun–Sat`).
- **Strict Ironclad Evaluation & Same-Week Gym Rescheduling:**
  - A day turns **Green** when all exercises scheduled for that day meet their target, **Amber** when partially completed, and **Red** when missed (`0`).
  - Unscheduled exercises and full rest days are marked **Rest** in neutral muted gray rather than penalizing your status or breaking streaks.
  - A gym week turns **Green** only when all committed gym days for that Sunday–Saturday week are completed. If an unavoidable conflict comes up on a committed gym day, you can shift that slot to another open day within the **same Sunday–Saturday week** (with one-tap undo).
- **Point-in-Time Historical Target Preservation:**
  - Updating an exercise target or weekly gym schedule applies from **Today (or the current week) forward**. Past logged sessions continue to evaluate against the target that was active on the date they were logged.
- **7-Day Edit Window Lock:**
  - Entries within the last 7 days can be logged or adjusted; dates older than 7 days lock automatically as read-only history.

---

## Views & Capabilities

1. **Today:** Quick increment controls (`-1`, `+1`, `+5`, `+10`, one-tap target completion), separate **Due** vs. **Rest Day / Optional** sections, and the interactive Sunday–Saturday **Weekly Gym Attendance** strip with same-week rescheduling.
2. **Calendar:** Sunday-first monthly accountability grid with per-day status colors, gym visit/due/missed indicators, a weekly `GYM` summary column, monthly rollup counters, and a 7-day editable date inspector.
3. **Charts:** Scalable `Curve` and `Bars` visualizations across `Daily`, `Weekly`, `Monthly`, and `All Time` ranges, plus Period Average, All-Time PR, Hit Rate, Today Snapshot, and a 6-week Gym Consistency strip.
4. **Goals:** Configure exercise targets, units (`reps`, `sec`, `min`, `sets`), display order, and `Daily` / `Custom` weekday schedules for home exercises and weekly gym attendance.
5. **Settings & Account Overlay:**
   - **Profile & Display:** Custom display handle, lifetime summary stats, and `Dark` / `Light` / `System` theme modes.
   - **Smart Reminders:** Goal-aware morning check-in and evening accountability browser notifications that stay silent once due goals are met.
   - **Security & Lock:** Optional startup lock using **Device Biometrics (WebAuthn)** (Face ID, Touch ID, Fingerprint, Windows Hello) and/or a **Secret Passkey / PIN**.
   - **Cloud Sync:** Optional cross-device sync via **Passkey-Protected Google Drive** (Google Apps Script) or **Private GitHub Gist**.
   - **Data & Reset:** One-click manual JSON backup export, JSON restore, and protected full-reset controls.

---

## Project Structure

- `index.html` — App shell, persistent dual-metric header (`Home Streak` and `Gym Weekly`), navigation dock/sidebar, and modal overlays.
- `styles.css` — Responsive dark/light design system, status tokens, and motion transitions.
- `app.js` — Local-first state engine, historical target/schedule ledger, SVG chart renderer, WebAuthn lock gate, reminder scheduler, and cloud sync client.
- `google-drive-sync.gs` — Passkey-verified Google Apps Script template for self-hosted Google Drive sync.
- `manifest.json`, `sw.js`, `icon.svg` — PWA manifest, offline-capable network-first service worker, and vector app icon.

---

## Run Locally or Self-Host

- **Local Static Server:** Serve the project folder with any static HTTP server (for example `npx serve .` or `python -m http.server 8080`).
- **Static Cloud Hosting:** Host on **GitHub Pages**, **Netlify**, or **Cloudflare Pages** over HTTPS (HTTPS is required for Service Workers, Web Notifications, and WebAuthn Biometrics).
- **Install as an App (PWA):** Open the HTTPS URL on Android, iOS, Windows, or macOS and select **Install App / Add to Home Screen**.

---

## Optional Cloud Sync Setup & Security Best Practices

By default, all data stays locally in your browser. If you enable cross-device sync, your credentials and sync endpoints are stored only on your device and are never committed to the repository.

### Option A: Private GitHub Gist
1. Generate a GitHub Personal Access Token with only the **`gist`** scope.
2. Open **Settings → Cloud Sync**, select **Private GitHub Gist**, paste your token, and click **Save**.
3. The app creates and syncs a private `fitness-tracker-data.json` Gist over `Authorization: Bearer`.

### Option B: Passkey-Protected Google Drive (Apps Script)
1. Open **Settings → Security & Lock** and set a strong **Secret Passkey**.
2. Open **Settings → Cloud Sync → Google Drive (Passkey)** and click **Copy Protected Script** (or copy `google-drive-sync.gs` and replace `CHANGE_THIS_TO_YOUR_SECRET_PASSKEY` with your Secret Passkey before deploying).
3. At [script.google.com](https://script.google.com), create a new project, paste the script, and click **Deploy → New deployment → Web app** (*Execute as: Me*, *Who has access: Anyone*).
4. Paste the resulting `/exec` Web App URL into **Settings → Cloud Sync** and click **Save**.

### Security Hygiene for Self-Hosters
- **Never commit secrets:** Keep your Secret Passkey, Google Apps Script `/exec` URL, GitHub token, Gist ID, and exported JSON backups out of public repositories.
- **Set your passkey before deploying Apps Script:** Pre-filling `SECRET_PASSKEY` before deploying ensures your endpoint is locked to your passkey from the moment it goes live.
- **Treat your Web App URL and Passkey like credentials:** Use a strong passkey (distinct from your primary account passwords) and rotate your Apps Script deployment or GitHub token if shared on an untrusted device.
