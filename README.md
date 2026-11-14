# IRONHABIT — Fitness & Gym Accountability App

A local-first Progressive Web App (PWA) for daily home exercise and weekly gym accountability, synced via a single JSON file (`fitness-tracker-data.json`) in your Google Drive.

## Project Files
- `index.html` — App shell, persistent dual-metric header, unobtrusive legend footer, and bottom navigation.
- `styles.css` — Architectural matte-carbon design system.
- `app.js` — Accountability engine, 7-day edit lock, SVG curve/bar charts (`Daily`, `Weekly`, `Monthly`, `All Time`), and Google Drive auto-sync.
- `google-drive-sync.gs` — 20-line Google Apps Script for zero-maintenance Google Drive sync.
- `manifest.json`, `sw.js`, `icon.svg` — Offline Service Worker and PWA manifest for mobile installation and APK packaging.

## 1. Run Locally or Deploy Free
- **Local:** Serve this folder with any static server (e.g. `npx serve .` or `python -m http.server 8080`) or open `index.html`.
- **Free Cloud Hosting (for Phone + Web access):** Drag and drop this folder onto [app.netlify.com/drop](https://app.netlify.com/drop) or push to **GitHub Pages**.

## 2. Install on Your Phone (PWA or `.apk`)
- **Direct Install (Android Chrome / iOS Safari):** Open your hosted URL on your phone and tap **Add to Home Screen / Install App**. It installs fullscreen with an app icon and works offline.
- **Standalone `.apk` File:** Paste your hosted URL into [PWABuilder.com](https://www.pwabuilder.com) and click **Package for Stores → Android → Download APK**.

## 3. Connect Google Drive Auto-Sync (Takes 90 Seconds)
1. In the app, go to **Goals → Copy Script** (or copy `google-drive-sync.gs`).
2. Go to [script.google.com](https://script.google.com) → **New project** → paste the code.
3. Click **Deploy → New deployment** → select type **Web app**.
4. Set **Execute as:** *Me* and **Who has access:** *Anyone* → click **Deploy**.
5. Copy the **Web app URL** and paste it into **Goals → Google Drive Auto-Sync** in the app.
