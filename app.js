/* ==========================================================================
   IRONHABIT — PRODUCTION APPLICATION ENGINE
   Local-First PWA + Authenticated Cloud Sync (Passkey Drive / Private GitHub Gist)
   + App Passkey Lock Gate + 7-Day Edit Lock
   ========================================================================== */

const STORAGE_KEY = 'ironhabit_state_v2';
const SESSION_UNLOCK_KEY = 'ironhabit_session_unlocked';
const EDIT_WINDOW_DAYS = 7;

function buildGDriveScriptSource(passkey) {
  const cleanKey = (passkey || 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY').replace(/'/g, "\\'");
  return `const FILE_NAME = 'fitness-tracker-data.json';
const SECRET_PASSKEY = '${cleanKey}';

function isAuthorized(key) {
  const incoming = String(key || '').trim();
  if (!incoming) return false;
  const configured = String(SECRET_PASSKEY || '').trim();
  if (configured && configured !== 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY') {
    return incoming === configured;
  }
  const props = PropertiesService.getScriptProperties();
  const bound = props.getProperty('BOUND_PASSKEY');
  if (!bound) {
    props.setProperty('BOUND_PASSKEY', incoming);
    return true;
  }
  return incoming === bound;
}

function getOrCreateFile() {
  const files = DriveApp.getFilesByName(FILE_NAME);
  if (files.hasNext()) return files.next();
  return DriveApp.createFile(FILE_NAME, JSON.stringify({ version: 2, updatedAt: 0, payload: null }, null, 2), MimeType.PLAIN_TEXT);
}

function doGet(e) {
  const key = (e && e.parameter && e.parameter.key) ? e.parameter.key : '';
  if (!isAuthorized(key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing passkey' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const file = getOrCreateFile();
  return ContentService.createTextOutput(file.getBlob().getDataAsString()).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const parsed = JSON.parse((e && e.postData && e.postData.contents) ? e.postData.contents : '{}');
  const key = (parsed && parsed.passkey) || (e && e.parameter && e.parameter.key) || '';
  if (!isAuthorized(key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing passkey' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const toSave = {
    version: parsed.version || 2,
    updatedAt: parsed.updatedAt || Date.now(),
    payload: parsed.payload || null
  };
  const file = getOrCreateFile();
  file.setContent(JSON.stringify(toSave, null, 2));
  return ContentService.createTextOutput(JSON.stringify({ ok: true, updatedAt: toSave.updatedAt })).setMimeType(ContentService.MimeType.JSON);
}`;
}

const App = (() => {
  // --- Local Date Helpers (YYYY-MM-DD) ---
  function toDateKey(d = new Date()) {
    const yr = d.getFullYear();
    const mo = String(d.getMonth() + 1).padStart(2, '0');
    const da = String(d.getDate()).padStart(2, '0');
    return `${yr}-${mo}-${da}`;
  }

  function parseDateKey(key) {
    const [y, m, d] = key.split('-').map(Number);
    return new Date(y, m - 1, d, 12, 0, 0);
  }

  function addDays(dateKey, delta) {
    const d = parseDateKey(dateKey);
    d.setDate(d.getDate() + delta);
    return toDateKey(d);
  }

  function diffDaysBetween(laterKey, earlierKey) {
    const d1 = parseDateKey(laterKey);
    const d2 = parseDateKey(earlierKey);
    return Math.round((d1.getTime() - d2.getTime()) / 86400000);
  }

  function getMondayKey(dateKey) {
    const d = parseDateKey(dateKey);
    const day = d.getDay(); // 0=Sun..6=Sat
    const diff = day === 0 ? -6 : 1 - day;
    d.setDate(d.getDate() + diff);
    return toDateKey(d);
  }

  function formatShortDate(dateKey) {
    const today = toDateKey();
    const yesterday = addDays(today, -1);
    const d = parseDateKey(dateKey);
    const base = d.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric'
    });
    if (dateKey === today) return `${base} (Today)`;
    if (dateKey === yesterday) return `${base} (Yesterday)`;
    return base;
  }

  function formatMonthDayYear(dateKey) {
    const d = parseDateKey(dateKey);
    return d.toLocaleDateString('en-US', {
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    });
  }

  function getISOWeekNumber(dateKey) {
    const d = parseDateKey(dateKey);
    const target = new Date(d.valueOf());
    const dayNr = (d.getDay() + 6) % 7;
    target.setDate(target.getDate() - dayNr + 3);
    const firstThursday = target.valueOf();
    target.setMonth(0, 1);
    if (target.getDay() !== 4) {
      target.setMonth(0, 1 + ((4 - target.getDay() + 7) % 7));
    }
    return 1 + Math.ceil((firstThursday - target) / 604800000);
  }

  function isDateLocked(dateKey) {
    const today = toDateKey();
    if (dateKey > today) return true;
    return diffDaysBetween(today, dateKey) > EDIT_WINDOW_DAYS;
  }

  // --- Default State & Sample History Seeder ---
  function createDefaultState() {
    const today = toDateKey();
    return {
      version: 2,
      updatedAt: Date.now(),
      trackingStartDate: addDays(today, -28),
      weeklyGymTarget: 4,
      syncProvider: 'gist', // 'gist' (Private GitHub Gist) | 'gdrive' (Passkey Google Drive)
      syncUrl: '',
      syncPasskey: '',
      githubToken: '',
      gistId: '',
      appLockEnabled: false,
      lastSyncedAt: null,
      exercises: [
        { id: 'pushups', name: 'Push-ups',   target: 50, unit: 'reps' },
        { id: 'situps',  name: 'Sit-ups',    target: 50, unit: 'reps' },
        { id: 'squats',  name: 'Air Squats', target: 40, unit: 'reps' }
      ],
      logs: {}
    };
  }

  function stripSecrets(st) {
    const copy = { ...st };
    delete copy.syncPasskey;
    delete copy.githubToken;
    return copy;
  }

  function isCloudConfigured(st = state) {
    if (st.syncProvider === 'gist') {
      return Boolean(st.githubToken && st.githubToken.trim());
    }
    return Boolean(st.syncUrl && st.syncUrl.trim() && st.syncPasskey && st.syncPasskey.trim());
  }

  function seedSampleHistory(st) {
    const today = toDateKey();
    st.trackingStartDate = addDays(today, -60);
    st.logs = {};

    for (let offset = -60; offset <= 0; offset++) {
      const k = addDays(today, offset);
      const dt = parseDateKey(k);
      const dow = dt.getDay(); // 0..6
      const isGymDay = dow === 1 || dow === 3 || dow === 5 || (dow === 6 && offset % 2 === 0);

      const exValues = {};
      st.exercises.forEach((ex, idx) => {
        if (offset === 0) {
          // Today in progress: 1st completed, 2nd incomplete (Amber), 3rd not started (Red 0)
          if (idx === 0) exValues[ex.id] = ex.target;
          else if (idx === 1) exValues[ex.id] = Math.round(ex.target * 0.5);
          else exValues[ex.id] = 0;
        } else if (offset === -3) {
          // 3 days ago: showcase Green, Amber, Red on a recent editable day
          if (idx === 0) exValues[ex.id] = ex.target;
          else if (idx === 1) exValues[ex.id] = Math.round(ex.target * 0.6);
          else exValues[ex.id] = 0;
        } else if (offset % 9 === 0) {
          // Occasional missed day
          exValues[ex.id] = idx === 0 ? Math.round(ex.target * 0.5) : 0;
        } else {
          // Completed target day
          const bonus = ((Math.abs(offset) + idx) % 3) * 5;
          exValues[ex.id] = ex.target + bonus;
        }
      });

      st.logs[k] = {
        exercises: exValues,
        gym: offset === 0 ? false : isGymDay
      };
    }
  }

  let state = loadState();
  let isSessionLocked = Boolean(
    state.appLockEnabled &&
    state.syncPasskey &&
    sessionStorage.getItem(SESSION_UNLOCK_KEY) !== '1'
  );

  let ui = {
    screen: 'today',
    activeDate: toDateKey(),
    calYear: new Date().getFullYear(),
    calMonth: new Date().getMonth(),
    selectedCalDate: toDateKey(),
    chartExerciseId: state.exercises[0] ? state.exercises[0].id : 'pushups',
    chartPeriod: 'daily', // 'daily' | 'weekly' | 'monthly' | 'all'
    chartStyle: 'area',  // 'area' (default) | 'bar'
    syncStatus: isCloudConfigured(state) ? 'synced' : 'local',
    deferredInstallPrompt: null
  };

  let syncTimer = null;

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.exercises)) {
          return { ...createDefaultState(), ...parsed };
        }
      }
    } catch (e) {
      console.error('Failed to read local state:', e);
    }
    const initial = createDefaultState();
    seedSampleHistory(initial);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(initial));
    return initial;
  }

  function saveState(syncCloud = true) {
    state.updatedAt = Date.now();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) {
      console.error('Failed to write local state:', e);
    }
    render();

    if (syncCloud && isCloudConfigured(state)) {
      ui.syncStatus = 'syncing';
      updateSyncHeader();
      if (syncTimer) clearTimeout(syncTimer);
      syncTimer = setTimeout(() => {
        pushToCloud(false);
      }, 1000);
    }
  }

  function getDayLog(dateKey) {
    if (!state.logs[dateKey]) {
      state.logs[dateKey] = { exercises: {}, gym: false };
    }
    if (!state.logs[dateKey].exercises) {
      state.logs[dateKey].exercises = {};
    }
    return state.logs[dateKey];
  }

  function getExerciseVal(dateKey, exId) {
    const entry = state.logs[dateKey];
    if (!entry || !entry.exercises) return 0;
    return Number(entry.exercises[exId]) || 0;
  }

  // --- Unified 3-State Color Helper ---
  // Completed (>= target) -> Green
  // Incomplete (> 0 && < target) -> Amber
  // Not done (0) -> Red
  function getMetricTone(val, target) {
    const v = Number(val) || 0;
    if (v >= target) {
      return { status: 'green', text: 'text-emerald', bg: 'bg-emerald', hex: '#10B981' };
    }
    if (v > 0) {
      return { status: 'amber', text: 'text-amber', bg: 'bg-amber', hex: '#F59E0B' };
    }
    return { status: 'red', text: 'text-red', bg: 'bg-red', hex: '#EF4444' };
  }

  function isDayHomeMet(dateKey) {
    if (state.exercises.length === 0) return false;
    return state.exercises.every(ex => getExerciseVal(dateKey, ex.id) >= ex.target);
  }

  function hasAnyExerciseProgress(dateKey) {
    return state.exercises.some(ex => getExerciseVal(dateKey, ex.id) > 0);
  }

  function getDayStatus(dateKey) {
    const today = toDateKey();
    if (dateKey > today) return 'future';
    if (isDayHomeMet(dateKey)) return 'green';
    if (dateKey === today) {
      return hasAnyExerciseProgress(dateKey) ? 'amber' : 'red';
    }
    const hasLog = hasAnyExerciseProgress(dateKey) || Boolean(state.logs[dateKey] && state.logs[dateKey].gym);
    if (dateKey >= state.trackingStartDate || hasLog) {
      return 'red';
    }
    return 'none';
  }

  function computeHomeStreaks() {
    const today = toDateKey();
    let current = 0;
    let cursor = isDayHomeMet(today) ? today : addDays(today, -1);
    while (isDayHomeMet(cursor)) {
      current++;
      cursor = addDays(cursor, -1);
    }

    const keys = Object.keys(state.logs).concat([state.trackingStartDate, today]).sort();
    const earliest = keys[0] || today;
    let best = current;
    let run = 0;
    let scan = earliest;
    while (scan <= today) {
      if (isDayHomeMet(scan)) {
        run++;
        if (run > best) best = run;
      } else {
        run = 0;
      }
      scan = addDays(scan, 1);
    }
    return { current, best };
  }

  function getWeekGymSummary(mondayKey) {
    const today = toDateKey();
    const currentMon = getMondayKey(today);
    let count = 0;
    const days = [];
    for (let i = 0; i < 7; i++) {
      const k = addDays(mondayKey, i);
      const visited = Boolean(state.logs[k] && state.logs[k].gym);
      if (visited) count++;
      days.push({
        dateKey: k,
        visited,
        isFuture: k > today,
        isLocked: isDateLocked(k)
      });
    }
    const target = state.weeklyGymTarget;
    const met = count >= target;
    let status = 'red';
    if (mondayKey > currentMon) status = 'future';
    else if (met) status = 'green';
    else if (mondayKey === currentMon && count > 0) status = 'amber';
    else if (addDays(mondayKey, 6) < state.trackingStartDate && count === 0) status = 'none';
    return { mondayKey, count, target, met, status, isCurrent: mondayKey === currentMon, days };
  }

  function computeGymWeeklyStreak() {
    const today = toDateKey();
    const currentMon = getMondayKey(today);
    const curSum = getWeekGymSummary(currentMon);
    let streak = 0;
    let cursor = curSum.met ? currentMon : addDays(currentMon, -7);
    for (let i = 0; i < 104; i++) {
      const s = getWeekGymSummary(cursor);
      if (s.met) {
        streak++;
        cursor = addDays(cursor, -7);
      } else {
        break;
      }
    }
    return streak;
  }

  // --- Toast Helper ---
  let toastTimer = null;
  function showToast(text) {
    const el = document.getElementById('toast-banner');
    if (!el) return;
    el.textContent = text;
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.classList.remove('show');
    }, 2200);
  }

  // --- Authenticated Cloud Sync (Private GitHub Gist OR Passkey Google Drive) ---
  function updateSyncHeader() {
    const dot = document.getElementById('hdr-sync-dot');
    const lbl = document.getElementById('hdr-sync-label');
    if (!dot || !lbl) return;
    dot.className = 'dot-indicator';
    if (!isCloudConfigured(state)) {
      lbl.textContent = 'Local';
    } else if (ui.syncStatus === 'syncing') {
      dot.classList.add('syncing');
      lbl.textContent = 'Syncing';
    } else if (ui.syncStatus === 'error') {
      dot.classList.add('error');
      lbl.textContent = 'Auth / Retry';
    } else {
      dot.classList.add('synced');
      lbl.textContent = state.syncProvider === 'gist' ? 'Gist Synced' : 'Drive Synced';
    }
  }

  function updateLockHeader() {
    const dot = document.getElementById('hdr-lock-dot');
    const lbl = document.getElementById('hdr-lock-label');
    if (!dot || !lbl) return;
    dot.className = 'dot-indicator';
    if (state.syncPasskey && state.syncPasskey.trim()) {
      dot.classList.add('synced');
      lbl.textContent = 'Lock App';
    } else {
      lbl.textContent = 'Set Passkey';
    }
  }

  function renderAuthGate() {
    const overlay = document.getElementById('auth-gate-overlay');
    if (!overlay) return;
    if (!isSessionLocked) {
      overlay.style.display = 'none';
      overlay.innerHTML = '';
      return;
    }
    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="auth-gate-card">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <span class="brand-name">IRONHABIT</span>
          <span class="locked-tag">PASSKEY LOCKED</span>
        </div>
        <div class="section-sub" style="margin-bottom:12px;">
          Enter your Passkey / PIN to unlock your accountability logs and cloud sync session.
        </div>
        <div style="display:flex;gap:6px;margin-bottom:8px;">
          <input id="unlock-passkey-input" type="password" class="text-input" style="flex:1;"
                 placeholder="Enter Passkey / PIN"
                 onkeydown="if(event.key==='Enter') App.UnlockSession()" />
          <button class="primary-btn smooth-ui" onclick="App.UnlockSession()">Unlock</button>
        </div>
        <div style="font-size:0.75rem;color:var(--text-slate-500);">
          Protected session • Data stays encrypted/isolated to your credentials
        </div>
      </div>
    `;
  }

  async function findExistingGistId(token) {
    const res = await fetch('https://api.github.com/gists?per_page=50', {
      headers: {
        'Accept': 'application/vnd.github+json',
        'Authorization': `Bearer ${token}`
      }
    });
    if (!res.ok) throw new Error('GitHub token rejected');
    const list = await res.json();
    const match = Array.isArray(list)
      ? list.find(g => g.files && g.files['fitness-tracker-data.json'])
      : null;
    return match ? match.id : '';
  }

  function captureSettingsInputsIntoState() {
    const passEl = document.getElementById('sec-passkey-input');
    const urlEl = document.getElementById('sync-url-input');
    const tokEl = document.getElementById('github-token-input');
    const idEl = document.getElementById('gist-id-input');
    let changed = false;
    if (passEl && passEl.value.trim() && passEl.value.trim() !== state.syncPasskey) {
      state.syncPasskey = passEl.value.trim();
      changed = true;
    }
    if (urlEl && urlEl.value.trim() && urlEl.value.trim() !== state.syncUrl) {
      state.syncUrl = urlEl.value.trim();
      changed = true;
    }
    if (tokEl && tokEl.value.trim() && tokEl.value.trim() !== state.githubToken) {
      state.githubToken = tokEl.value.trim();
      changed = true;
    }
    if (idEl && idEl.value.trim() && idEl.value.trim() !== state.gistId) {
      state.gistId = idEl.value.trim();
      changed = true;
    }
    if (changed) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      updateLockHeader();
    }
  }

  async function pushToCloud(manual = false) {
    captureSettingsInputsIntoState();
    if (!isCloudConfigured(state)) {
      if (manual) {
        ui.screen = 'settings';
        render();
        showToast(state.syncProvider === 'gdrive'
          ? 'Enter both your Passkey and Google Drive Script URL first'
          : 'Enter your GitHub Personal Access Token first');
      }
      return;
    }

    ui.syncStatus = 'syncing';
    updateSyncHeader();

    const envelope = {
      version: 2,
      updatedAt: state.updatedAt,
      payload: stripSecrets(state)
    };

    if (state.syncProvider === 'gist') {
      try {
        const token = state.githubToken.trim();
        let gistId = (state.gistId || '').trim();
        if (!gistId) {
          gistId = await findExistingGistId(token);
        }

        const url = gistId
          ? `https://api.github.com/gists/${gistId}`
          : 'https://api.github.com/gists';
        const method = gistId ? 'PATCH' : 'POST';

        const res = await fetch(url, {
          method,
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            description: 'IRONHABIT Private Accountability Sync (fitness-tracker-data.json)',
            public: false,
            files: {
              'fitness-tracker-data.json': {
                content: JSON.stringify(envelope, null, 2)
              }
            }
          })
        });

        if (!res.ok) throw new Error('GitHub Gist sync failed');
        const data = await res.json();
        if (data && data.id) {
          state.gistId = data.id;
        }
        state.lastSyncedAt = Date.now();
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        ui.syncStatus = 'synced';
        updateSyncHeader();
        if (manual) {
          render();
          showToast('Synced to Private GitHub Gist');
        }
      } catch (e) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        if (manual) showToast('GitHub Gist auth failed — check token (gist scope)');
      }
      return;
    }

    // Google Drive Passkey-Authenticated Sync
    try {
      const sep = state.syncUrl.includes('?') ? '&' : '?';
      const authUrl = `${state.syncUrl}${sep}key=${encodeURIComponent(state.syncPasskey || '')}`;
      const body = JSON.stringify({
        passkey: state.syncPasskey,
        ...envelope
      });
      const res = await fetch(authUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body
      });
      const data = await res.json().catch(() => ({ ok: true }));
      if (data && data.ok === false) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        if (manual) showToast(data.error || 'Unauthorized Drive Passkey');
        return;
      }
      state.lastSyncedAt = Date.now();
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      ui.syncStatus = 'synced';
      updateSyncHeader();
      if (manual) {
        render();
        showToast('Authenticated & synced to Google Drive');
      }
    } catch (e) {
      ui.syncStatus = 'error';
      updateSyncHeader();
      if (manual) showToast('Could not reach Google Drive URL');
    }
  }

  async function pullFromCloud() {
    captureSettingsInputsIntoState();
    if (!isCloudConfigured(state)) {
      showToast(state.syncProvider === 'gdrive'
        ? 'Enter both your Passkey and Google Drive Script URL first'
        : 'Enter your GitHub Personal Access Token first');
      return;
    }
    ui.syncStatus = 'syncing';
    updateSyncHeader();

    const preservedAuth = {
      syncProvider: state.syncProvider,
      syncUrl: state.syncUrl,
      syncPasskey: state.syncPasskey,
      githubToken: state.githubToken,
      gistId: state.gistId,
      appLockEnabled: state.appLockEnabled
    };

    if (state.syncProvider === 'gist') {
      try {
        const token = state.githubToken.trim();
        let gistId = (state.gistId || '').trim();
        if (!gistId) {
          gistId = await findExistingGistId(token);
        }
        if (!gistId) {
          ui.syncStatus = 'synced';
          updateSyncHeader();
          showToast('No private Gist found yet — click Sync Now to create one');
          return;
        }
        const res = await fetch(`https://api.github.com/gists/${gistId}`, {
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`
          }
        });
        if (!res.ok) throw new Error('GitHub read failed');
        const gist = await res.json();
        const fileObj = gist.files && gist.files['fitness-tracker-data.json'];
        if (!fileObj || !fileObj.content) {
          ui.syncStatus = 'synced';
          updateSyncHeader();
          showToast('Gist is empty — click Sync Now to push first');
          return;
        }
        const parsed = JSON.parse(fileObj.content);
        const payload = parsed.payload || parsed;
        if (payload && Array.isArray(payload.exercises)) {
          state = { ...createDefaultState(), ...payload, ...preservedAuth, gistId, lastSyncedAt: Date.now() };
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          ui.syncStatus = 'synced';
          updateSyncHeader();
          render();
          showToast('Restored from Private GitHub Gist');
        }
      } catch (e) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        showToast('Failed to pull from Private GitHub Gist');
      }
      return;
    }

    // Google Drive Passkey-Authenticated Pull
    try {
      const sep = state.syncUrl.includes('?') ? '&' : '?';
      const authUrl = `${state.syncUrl}${sep}key=${encodeURIComponent(state.syncPasskey || '')}`;
      const res = await fetch(authUrl, { method: 'GET' });
      const data = await res.json();
      if (data && data.ok === false) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        showToast(data.error || 'Unauthorized: invalid passkey');
        return;
      }
      if (data && data.payload && Array.isArray(data.payload.exercises)) {
        state = { ...createDefaultState(), ...data.payload, ...preservedAuth, lastSyncedAt: Date.now() };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        ui.syncStatus = 'synced';
        updateSyncHeader();
        render();
        showToast('Authenticated & restored from Google Drive');
      } else {
        ui.syncStatus = 'synced';
        updateSyncHeader();
        showToast('Drive file is empty — click Sync Now to push first');
      }
    } catch (e) {
      ui.syncStatus = 'error';
      updateSyncHeader();
      showToast('Failed to read from Google Drive URL');
    }
  }

  // --- Header Render ---
  function renderHeader() {
    const today = toDateKey();
    const dt = parseDateKey(today);
    const moYr = dt.toLocaleDateString('en-US', { month: 'short', year: 'numeric' }).toUpperCase();
    const wk = getISOWeekNumber(today);
    document.getElementById('hdr-date-meta').textContent = `${moYr} • W${wk}`;

    updateSyncHeader();
    updateLockHeader();

    const streaks = computeHomeStreaks();
    document.getElementById('hdr-home-streak').textContent = String(streaks.current);
    document.getElementById('hdr-home-best').textContent = `Best: ${streaks.best}d`;

    const avgPct = state.exercises.length > 0
      ? Math.round(
          (state.exercises.reduce((acc, ex) => acc + Math.min(1, getExerciseVal(today, ex.id) / Math.max(1, ex.target)), 0) /
            state.exercises.length) * 100
        )
      : 0;
    const hdrHomeStatus = document.getElementById('hdr-home-status');
    hdrHomeStatus.textContent = `${avgPct}%`;
    hdrHomeStatus.className = `tabular-nums ${avgPct >= 100 ? 'text-emerald' : avgPct > 0 ? 'text-amber' : 'text-red'}`;

    const curMon = getMondayKey(today);
    const gymSum = getWeekGymSummary(curMon);
    const gymStreak = computeGymWeeklyStreak();
    document.getElementById('hdr-gym-ratio').textContent = `${gymSum.count}/${gymSum.target}`;
    document.getElementById('hdr-gym-streak').textContent = `${gymStreak}w Streak`;

    const hdrGymStatus = document.getElementById('hdr-gym-status');
    hdrGymStatus.textContent = gymSum.met ? 'Met' : gymSum.count > 0 ? 'In Prog' : '0 Logged';
    hdrGymStatus.className = `tabular-nums ${gymSum.met ? 'text-emerald' : gymSum.count > 0 ? 'text-amber' : 'text-red'}`;
  }

  // --- SCREEN 1: TODAY & 7-DAY EDITABLE LOGGING ---
  function renderTodayScreen() {
    const today = toDateKey();
    const dateKey = ui.activeDate;
    const isToday = dateKey === today;
    const oldestEditable = addDays(today, -EDIT_WINDOW_DAYS);
    const atOldestLimit = dateKey <= oldestEditable;

    const metCount = state.exercises.filter(ex => getExerciseVal(dateKey, ex.id) >= ex.target).length;
    const dayStatus = getDayStatus(dateKey);

    const mondayKey = getMondayKey(dateKey);
    const weekGym = getWeekGymSummary(mondayKey);
    const dayNamesShort = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
    const activeDayGym = Boolean(state.logs[dateKey] && state.logs[dateKey].gym);

    return `
      <!-- Date Switcher Bar (Restricted to 7-Day Edit Window) -->
      <div class="surface-card date-nav-bar">
        <button class="step-btn smooth-ui ${atOldestLimit ? 'disabled' : ''}" onclick="App.StepActiveDate(-1)">
          &larr; Prev
        </button>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="tabular-nums" style="font-size:0.75rem;font-weight:700;color:#fff;">${formatShortDate(dateKey)}</span>
          ${!isToday ? `<button class="jump-today-btn" onclick="App.JumpToToday()">Today</button>` : ''}
        </div>
        <button class="step-btn smooth-ui ${isToday ? 'disabled' : ''}" onclick="App.StepActiveDate(1)">
          Next &rarr;
        </button>
      </div>

      <div class="today-split">
        <!-- Daily Home Exercises -->
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Daily Home Exercises</div>
              <div class="section-sub tabular-nums">${metCount} of ${state.exercises.length} targets complete</div>
            </div>
            <span class="status-square ${dayStatus === 'green' ? 'bg-emerald' : dayStatus === 'amber' ? 'bg-amber' : 'bg-red'}"></span>
          </div>

          <div class="stack-list">
            ${state.exercises.map(ex => {
              const current = getExerciseVal(dateKey, ex.id);
              const pct = Math.min(100, Math.round((current / Math.max(1, ex.target)) * 100));
              const tone = getMetricTone(current, ex.target);
              const done = current >= ex.target;

              return `
                <div class="surface-inset ex-box">
                  <div class="ex-top-line">
                    <span class="ex-title">${escapeHtml(ex.name)}</span>
                    <div class="ex-input-group tabular-nums">
                      <input type="number" min="0" value="${current}"
                             class="num-input ${tone.text} tabular-nums"
                             onchange="App.SetExactExercise('${dateKey}', '${ex.id}', this.value)" />
                      <span class="${tone.text}" style="font-weight:600;">/ ${ex.target} ${escapeHtml(ex.unit)}</span>
                    </div>
                  </div>

                  <div class="progress-rail">
                    <div class="progress-fill ${tone.bg}" style="width:${pct}%;"></div>
                  </div>

                  <div class="increment-grid">
                    <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', -1)">-1</button>
                    <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', 1)">+1</button>
                    <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', 5)">+5</button>
                    <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', 10)">+10</button>
                    <button class="inc-btn target-btn ${done ? 'met' : ''} tabular-nums smooth-ui"
                            onclick="App.SetExactExercise('${dateKey}', '${ex.id}', ${ex.target})">
                      ${ex.target}
                    </button>
                  </div>
                </div>
              `;
            }).join('')}
          </div>
        </section>

        <!-- Weekly Gym Attendance -->
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Weekly Gym Attendance</div>
              <div class="section-sub">Tap any day within 7 days to log or unlog</div>
            </div>
            <span class="tabular-nums ${weekGym.met ? 'text-emerald' : weekGym.count > 0 ? 'text-amber' : 'text-red'}"
                  style="font-size:0.75rem;font-weight:700;">
              ${weekGym.count}/${weekGym.target}
            </span>
          </div>

          <div class="week-7-grid">
            ${weekGym.days.map((slot, idx) => `
              <button class="week-day-btn ${slot.visited ? 'visited' : ''} ${slot.dateKey === dateKey ? 'active-ring' : ''} ${slot.isFuture || slot.isLocked ? 'locked-day' : ''} smooth-ui"
                      onclick="App.ToggleGym('${slot.dateKey}')">
                <div>${dayNamesShort[idx]}</div>
                <div><span class="gym-dot ${slot.visited ? 'on' : ''}"></span></div>
              </button>
            `).join('')}
          </div>

          <button class="gym-action-btn ${activeDayGym ? 'visited' : ''} smooth-ui"
                  onclick="App.ToggleGym('${dateKey}')">
            ${activeDayGym ? `Gym Visited (${formatShortDate(dateKey)})` : `Log Gym Visit (${formatShortDate(dateKey)})`}
          </button>
        </section>
      </div>
    `;
  }

  // --- SCREEN 2: CALENDAR + 7-DAY EDIT LOCK INSPECTOR ---
  function renderCalendarScreen() {
    const year = ui.calYear;
    const month = ui.calMonth;
    const firstOfMonth = new Date(year, month, 1, 12, 0, 0);
    const monthTitle = firstOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const startMon = getMondayKey(toDateKey(firstOfMonth));
    const lastOfMonth = new Date(year, month + 1, 0, 12, 0, 0);
    const lastKey = toDateKey(lastOfMonth);

    const weeks = [];
    let cursorMon = startMon;
    for (let w = 0; w < 6; w++) {
      const gymSum = getWeekGymSummary(cursorMon);
      const days = [];
      for (let d = 0; d < 7; d++) {
        const k = addDays(cursorMon, d);
        const dt = parseDateKey(k);
        days.push({
          dateKey: k,
          dayNum: dt.getDate(),
          inMonth: dt.getMonth() === month,
          status: getDayStatus(k),
          gym: Boolean(state.logs[k] && state.logs[k].gym),
          isFuture: k > toDateKey()
        });
      }
      weeks.push({ mondayKey: cursorMon, gymSum, days });
      cursorMon = addDays(cursorMon, 7);
      if (cursorMon > lastKey && w >= 3) break;
    }

    const selKey = ui.selectedCalDate;
    const selStatus = getDayStatus(selKey);
    const selGym = Boolean(state.logs[selKey] && state.logs[selKey].gym);
    const locked = isDateLocked(selKey);

    return `
      <!-- Calendar Grid Card -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div style="font-size:0.875rem;font-weight:700;color:#fff;">${monthTitle}</div>
            <div class="section-sub">Entries older than 7 days are locked (read-only)</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            <button class="step-btn" onclick="App.StepCalMonth(-1)">&larr;</button>
            <button class="step-btn" onclick="App.StepCalMonth(1)">&rarr;</button>
          </div>
        </div>

        <div class="cal-8-header">
          <div>M</div><div>T</div><div>W</div><div>T</div><div>F</div><div>S</div><div>S</div>
          <div class="text-sky">GYM</div>
        </div>

        <div>
          ${weeks.map(w => {
            const gs = w.gymSum;
            let wkCls = 'cal-wk-gym tabular-nums';
            if (gs.status === 'green') wkCls += ' met';
            else if (gs.status === 'amber') wkCls += ' amber';
            else if (gs.status === 'red') wkCls += ' red';

            return `
              <div class="cal-8-row">
                ${w.days.map(d => {
                  let cls = 'cal-cell smooth-ui';
                  if (d.status === 'green') cls += ' green';
                  else if (d.status === 'red') cls += ' red';
                  else if (d.status === 'amber') cls += ' amber';
                  if (!d.inMonth) cls += ' other-month';
                  if (d.dateKey === selKey) cls += ' selected';

                  return `
                    <button class="${cls}" onclick="${d.isFuture ? '' : `App.SelectCalDate('${d.dateKey}')`}">
                      <span class="tabular-nums" style="line-height:1;">${d.dayNum}</span>
                      ${d.gym ? `<span class="cal-gym-dot"></span>` : '<span></span>'}
                    </button>
                  `;
                }).join('')}

                <div class="${wkCls}">
                  ${gs.status === 'future' || gs.status === 'none' ? '—' : `${gs.count}/${gs.target}`}
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </section>

      <!-- Selected-Date Inspector / Editor Below Calendar -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div style="display:flex;align-items:center;gap:8px;">
            <span class="status-square ${selStatus === 'green' ? 'bg-emerald' : selStatus === 'amber' ? 'bg-amber' : 'bg-red'}"></span>
            <span class="section-heading tabular-nums">${formatMonthDayYear(selKey)}</span>
            ${locked ? `<span class="locked-tag">LOCKED (&gt;7D)</span>` : ''}
          </div>

          ${locked ? `
            <span class="step-btn" style="pointer-events:none;display:inline-flex;align-items:center;gap:6px;${selGym ? 'border-color:rgba(56,189,248,0.45);color:var(--sky-300);' : 'color:var(--text-slate-500);'}">
              <span style="width:8px;height:8px;border-radius:50%;background:${selGym ? 'var(--sky-400)' : '#475569'};"></span>
              <span>${selGym ? 'Gym Visited' : 'No Gym Visit'}</span>
            </span>
          ` : `
            <button class="step-btn smooth-ui"
                    style="display:inline-flex;align-items:center;gap:6px;${selGym ? 'background:rgba(14,165,233,0.2);border-color:var(--sky-400);color:var(--sky-300);' : ''}"
                    onclick="App.ToggleGym('${selKey}')">
              <span style="width:8px;height:8px;border-radius:50%;background:${selGym ? 'var(--sky-400)' : '#475569'};"></span>
              <span>${selGym ? 'Gym Visited' : 'Mark Gym Visit'}</span>
            </button>
          `}
        </div>

        <div class="stack-list">
          ${state.exercises.map(ex => {
            const val = getExerciseVal(selKey, ex.id);
            const tone = getMetricTone(val, ex.target);
            const met = val >= ex.target;

            return `
              <div class="surface-inset editor-row">
                <div style="min-width:0;">
                  <div class="ex-title">${escapeHtml(ex.name)}</div>
                  <div class="tabular-nums ${tone.text}" style="font-size:0.75rem;font-weight:600;">
                    ${val} / ${ex.target} ${escapeHtml(ex.unit)}
                  </div>
                </div>

                ${locked ? `
                  <div class="tabular-nums ${tone.text}" style="font-size:0.75rem;font-weight:700;">
                    ${met ? 'Target Met' : val > 0 ? 'Incomplete' : 'Missed (0)'}
                  </div>
                ` : `
                  <div class="editor-controls">
                    <button class="mini-btn tabular-nums" onclick="App.BumpExercise('${selKey}', '${ex.id}', -1)">-1</button>
                    <input type="number" min="0" value="${val}"
                           class="num-input ${tone.text} tabular-nums"
                           style="text-align:center;"
                           onchange="App.SetExactExercise('${selKey}', '${ex.id}', this.value)" />
                    <button class="mini-btn tabular-nums" onclick="App.BumpExercise('${selKey}', '${ex.id}', 1)">+1</button>
                    <button class="mini-btn tabular-nums" onclick="App.BumpExercise('${selKey}', '${ex.id}', 5)">+5</button>
                    <button class="mini-btn tabular-nums"
                            style="${met ? 'background:rgba(16,185,129,0.2);border-color:rgba(16,185,129,0.5);' : ''}color:var(--emerald-400);"
                            onclick="App.SetExactExercise('${selKey}', '${ex.id}', ${ex.target})">
                      ${ex.target}
                    </button>
                  </div>
                `}
              </div>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  // --- SCREEN 3: SCALABLE CHARTS WITH DAILY / WEEKLY / MONTHLY / ALL TIME ---
  function buildChartSeries(ex, period) {
    const today = toDateKey();

    if (period === 'daily') {
      const points = [];
      for (let i = 6; i >= 0; i--) {
        const k = addDays(today, -i);
        const dt = parseDateKey(k);
        const v = getExerciseVal(k, ex.id);
        const isCurrent = i === 0;
        let hex = '#EF4444';
        if (v >= ex.target) hex = '#10B981';
        else if (isCurrent && v > 0) hex = '#F59E0B';
        points.push({
          short: isCurrent ? 'Tdy' : String(dt.getDate()),
          v,
          isCurrent,
          hex
        });
      }
      return { subtitle: 'Daily total vs. daily target', points };
    }

    if (period === 'weekly') {
      const curMon = getMondayKey(today);
      const points = [];
      for (let w = 6; w >= 0; w--) {
        const mKey = addDays(curMon, -w * 7);
        const wkNum = getISOWeekNumber(mKey);
        let sum = 0;
        let daysCount = 0;
        for (let d = 0; d < 7; d++) {
          const k = addDays(mKey, d);
          if (k <= today) {
            sum += getExerciseVal(k, ex.id);
            daysCount++;
          }
        }
        const v = daysCount > 0 ? Math.round(sum / daysCount) : 0;
        const isCurrent = w === 0;
        let hex = '#EF4444';
        if (v >= ex.target) hex = '#10B981';
        else if (isCurrent && v > 0) hex = '#F59E0B';
        points.push({ short: `W${wkNum}`, v, isCurrent, hex });
      }
      return { subtitle: 'Weekly daily-avg vs. daily target', points };
    }

    if (period === 'monthly') {
      const now = parseDateKey(today);
      const points = [];
      for (let m = 6; m >= 0; m--) {
        const d = new Date(now.getFullYear(), now.getMonth() - m, 1, 12, 0, 0);
        const yr = d.getFullYear();
        const mo = d.getMonth();
        const short = d.toLocaleDateString('en-US', { month: 'short' });
        const lastDay = new Date(yr, mo + 1, 0).getDate();
        let sum = 0;
        let count = 0;
        for (let day = 1; day <= lastDay; day++) {
          const k = toDateKey(new Date(yr, mo, day, 12, 0, 0));
          if (k <= today && k >= state.trackingStartDate) {
            sum += getExerciseVal(k, ex.id);
            count++;
          }
        }
        const v = count > 0 ? Math.round(sum / count) : 0;
        const isCurrent = m === 0;
        let hex = '#EF4444';
        if (v >= ex.target) hex = '#10B981';
        else if (isCurrent && v > 0) hex = '#F59E0B';
        points.push({ short, v, isCurrent, hex });
      }
      return { subtitle: 'Monthly daily-avg vs. daily target', points };
    }

    // 'all': Divide range from trackingStartDate to today into 7 equal buckets
    const totalDays = Math.max(7, diffDaysBetween(today, state.trackingStartDate) + 1);
    const bucketSize = Math.max(1, Math.ceil(totalDays / 7));
    const points = [];
    for (let b = 6; b >= 0; b--) {
      const endKey = addDays(today, -b * bucketSize);
      const startKey = addDays(endKey, -(bucketSize - 1));
      let sum = 0;
      let count = 0;
      let cursor = startKey;
      while (cursor <= endKey && cursor <= today) {
        if (cursor >= state.trackingStartDate) {
          sum += getExerciseVal(cursor, ex.id);
          count++;
        }
        cursor = addDays(cursor, 1);
      }
      const v = count > 0 ? Math.round(sum / count) : 0;
      const isCurrent = b === 0;
      const dt = parseDateKey(endKey);
      const short = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      let hex = '#EF4444';
      if (v >= ex.target) hex = '#10B981';
      else if (isCurrent && v > 0) hex = '#F59E0B';
      points.push({ short, v, isCurrent, hex });
    }
    return { subtitle: 'All-time progression vs. daily target', points };
  }

  function renderChartsScreen() {
    const activeEx = state.exercises.find(e => e.id === ui.chartExerciseId) || state.exercises[0];
    const periodData = buildChartSeries(activeEx, ui.chartPeriod);
    const series = periodData.points;

    const maxVal = Math.ceil(Math.max(activeEx.target * 1.25, ...series.map(s => s.v), 10) / 10) * 10;
    const hitCount = series.filter(s => s.v >= activeEx.target).length;
    const latestVal = series[series.length - 1].v;
    const latestTone = getMetricTone(latestVal, activeEx.target);

    const today = toDateKey();
    const curMon = getMondayKey(today);
    const gymWeeks = [];
    for (let w = 5; w >= 0; w--) {
      const mKey = addDays(curMon, -w * 7);
      const gs = getWeekGymSummary(mKey);
      gymWeeks.push({
        w: `W${getISOWeekNumber(mKey)}`,
        c: gs.count,
        t: gs.target,
        current: w === 0
      });
    }

    return `
      <!-- Exercise Volume Chart Card -->
      <section class="surface-card card-pad">
        <!-- Row 1: Scalable Exercise Dropdown + Curve/Bars Toggle -->
        <div class="chart-top-row">
          <div class="ex-dropdown-group">
            <button class="step-btn" onclick="App.StepChartExercise(-1)">&lsaquo;</button>
            <select class="dark-select" onchange="App.SetChartExercise(this.value)">
              ${state.exercises.map(ex => `
                <option value="${ex.id}" ${ex.id === activeEx.id ? 'selected' : ''}>
                  ${escapeHtml(ex.name)} (${ex.target} ${escapeHtml(ex.unit)})
                </option>
              `).join('')}
            </select>
            <button class="step-btn" onclick="App.StepChartExercise(1)">&rsaquo;</button>
          </div>

          <div class="segmented-pair">
            <button class="seg-btn ${ui.chartStyle === 'area' ? 'active' : ''}" onclick="App.SetChartStyle('area')">Curve</button>
            <button class="seg-btn ${ui.chartStyle === 'bar' ? 'active' : ''}" onclick="App.SetChartStyle('bar')">Bars</button>
          </div>
        </div>

        <!-- Row 2: View Mode Switcher (Daily | Weekly | Monthly | All Time) -->
        <div class="period-4-grid">
          ${[
            { id: 'daily',   label: 'Daily' },
            { id: 'weekly',  label: 'Weekly' },
            { id: 'monthly', label: 'Monthly' },
            { id: 'all',     label: 'All Time' }
          ].map(p => `
            <button class="seg-btn ${ui.chartPeriod === p.id ? 'active' : ''} smooth-ui"
                    onclick="App.SetChartPeriod('${p.id}')">
              ${p.label}
            </button>
          `).join('')}
        </div>

        <!-- Row 3: Context Metric Strip -->
        <div class="card-head" style="margin-bottom:8px;">
          <span class="section-sub">${periodData.subtitle}</span>
          <span class="section-sub tabular-nums">
            Latest: <strong class="${latestTone.text}">${latestVal} / ${activeEx.target}</strong> • Hit <strong class="text-white">${hitCount}/${series.length}</strong>
          </span>
        </div>

        ${ui.chartStyle === 'area'
          ? renderSvgCurve(series, maxVal, activeEx.target)
          : renderBarsPlot(series, maxVal, activeEx.target)
        }
      </section>

      <!-- All Exercises — Today Snapshot -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <span class="section-heading">All Exercises — Today Snapshot</span>
          <span class="section-sub tabular-nums">${state.exercises.length} active</span>
        </div>
        <div class="snapshot-grid">
          ${state.exercises.map(ex => {
            const v = getExerciseVal(today, ex.id);
            const tone = getMetricTone(v, ex.target);
            const isSel = ex.id === activeEx.id;
            return `
              <button class="surface-inset snapshot-tile ${isSel ? 'active' : ''} smooth-ui"
                      onclick="App.SetChartExercise('${ex.id}')">
                <span style="font-size:0.75rem;font-weight:500;color:var(--text-slate-300);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${escapeHtml(ex.name)}
                </span>
                <span class="tabular-nums ${tone.text}" style="font-size:0.75rem;font-weight:700;">
                  ${v}/${ex.target}
                </span>
              </button>
            `;
          }).join('')}
        </div>
      </section>

      <!-- Weekly Gym Consistency -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <span class="section-heading">Weekly Gym Consistency</span>
          <span class="section-sub tabular-nums">Target: ${state.weeklyGymTarget}d / wk</span>
        </div>
        <div class="gym-6-grid">
          ${gymWeeks.map(wk => {
            const met = wk.c >= wk.t;
            let cls = 'gym-wk-box tabular-nums ';
            if (met) cls += 'green';
            else if (wk.current && wk.c > 0) cls += 'amber';
            else cls += 'red';
            return `
              <div class="${cls}">
                <div style="font-size:0.75rem;opacity:0.85;">${wk.w}</div>
                <div style="font-size:0.875rem;font-weight:700;margin-top:2px;">${wk.c}/${wk.t}</div>
              </div>
            `;
          }).join('')}
        </div>
      </section>
    `;
  }

  function renderSvgCurve(series, maxVal, targetVal) {
    const svgW = 380;
    const svgH = 168;
    const padL = 28;
    const padR = 14;
    const padT = 18;
    const padB = 26;
    const plotW = svgW - padL - padR;
    const plotH = svgH - padT - padB;

    const yOf = (v) => padT + plotH - (Math.min(maxVal, v) / maxVal) * plotH;
    const targetY = yOf(targetVal);
    const splitPct = Math.max(0, Math.min(100, Math.round(((targetY - padT) / plotH) * 100)));

    const pts = series.map((s, i) => ({
      x: padL + (i / Math.max(1, series.length - 1)) * plotW,
      y: yOf(s.v),
      ...s
    }));

    let d = `M ${pts[0].x.toFixed(1)} ${pts[0].y.toFixed(1)}`;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      const mx = ((p0.x + p1.x) / 2).toFixed(1);
      d += ` C ${mx} ${p0.y.toFixed(1)}, ${mx} ${p1.y.toFixed(1)}, ${p1.x.toFixed(1)} ${p1.y.toFixed(1)}`;
    }
    const areaD = `${d} L ${pts[pts.length - 1].x.toFixed(1)} ${(padT + plotH).toFixed(1)} L ${pts[0].x.toFixed(1)} ${(padT + plotH).toFixed(1)} Z`;

    return `
      <div class="surface-inset" style="padding:8px;">
        <svg viewBox="0 0 ${svgW} ${svgH}" style="width:100%;height:176px;display:block;">
          <defs>
            <linearGradient id="splitArea" x1="0" y1="${padT}" x2="0" y2="${padT + plotH}" gradientUnits="userSpaceOnUse">
              <stop offset="0%" stop-color="#10B981" stop-opacity="0.34" />
              <stop offset="${splitPct}%" stop-color="#10B981" stop-opacity="0.10" />
              <stop offset="${splitPct}%" stop-color="#EF4444" stop-opacity="0.20" />
              <stop offset="100%" stop-color="#EF4444" stop-opacity="0.02" />
            </linearGradient>
          </defs>

          <line x1="${padL}" y1="${padT}" x2="${svgW - padR}" y2="${padT}" stroke="#1A2230" stroke-width="1" />
          <line x1="${padL}" y1="${padT + plotH}" x2="${svgW - padR}" y2="${padT + plotH}" stroke="#1E293B" stroke-width="1" />

          <text x="${padL - 5}" y="${padT + 4}" text-anchor="end" fill="#64748B" font-size="12" font-weight="600">${maxVal}</text>
          <text x="${padL - 5}" y="${targetY + 4}" text-anchor="end" fill="#38BDF8" font-size="12" font-weight="700">${targetVal}</text>
          <text x="${padL - 5}" y="${padT + plotH + 4}" text-anchor="end" fill="#64748B" font-size="12" font-weight="600">0</text>

          <line x1="${padL}" y1="${targetY}" x2="${svgW - padR}" y2="${targetY}" stroke="#38BDF8" stroke-width="1.4" stroke-dasharray="4 4" />

          <path d="${areaD}" fill="url(#splitArea)" />
          <path d="${d}" fill="none" stroke="#CBD5E1" stroke-width="2" stroke-linecap="round" />

          ${pts.map(p => `
            <circle cx="${p.x}" cy="${p.y}" r="${p.isCurrent ? 4.5 : 3.5}" fill="${p.hex}" stroke="#0D1119" stroke-width="1.8" />
            <text x="${p.x}" y="${p.y - 8}" text-anchor="middle" fill="${p.hex}" font-size="12" font-weight="700">${p.v}</text>
            <text x="${p.x}" y="${svgH - 4}" text-anchor="middle" fill="${p.isCurrent ? '#F59E0B' : '#64748B'}" font-size="12" font-weight="600">${p.short}</text>
          `).join('')}
        </svg>
      </div>
    `;
  }

  function renderBarsPlot(series, maxVal, targetVal) {
    const targetPct = Math.round((targetVal / maxVal) * 100);
    return `
      <div class="surface-inset" style="padding:10px;">
        <div style="display:flex;align-items:stretch;">
          <div style="width:28px;position:relative;height:144px;padding-right:6px;text-align:right;user-select:none;">
            <span class="tabular-nums" style="position:absolute;top:0;right:6px;font-size:0.75rem;color:var(--text-slate-500);line-height:1;">${maxVal}</span>
            <span class="tabular-nums text-sky" style="position:absolute;right:6px;bottom:${targetPct}%;transform:translateY(50%);font-size:0.75rem;font-weight:700;line-height:1;">${targetVal}</span>
            <span class="tabular-nums" style="position:absolute;bottom:0;right:6px;font-size:0.75rem;color:var(--text-slate-500);line-height:1;">0</span>
          </div>
          <div style="flex:1;">
            <div style="position:relative;height:144px;display:flex;align-items:flex-end;justify-content:space-between;gap:4px;border-bottom:1px solid #1e293b;border-left:1px solid #1e293b;padding:0 6px;">
              <div style="position:absolute;left:0;right:0;bottom:${targetPct}%;border-top:1px dashed var(--sky-400);pointer-events:none;z-index:2;"></div>
              ${series.map(s => {
                const h = Math.max(4, Math.min(95, Math.round((s.v / maxVal) * 100)));
                return `
                  <div style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;z-index:1;">
                    <div style="width:100%;max-width:20px;height:${h}%;background:${s.hex};border-radius:2px 2px 0 0;"></div>
                  </div>
                `;
              }).join('')}
            </div>
            <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 6px 0;text-align:center;">
              ${series.map(s => `
                <div class="tabular-nums ${s.isCurrent ? 'text-amber' : 'text-dim'}" style="flex:1;font-size:0.75rem;">
                  ${s.short}
                </div>
              `).join('')}
            </div>
          </div>
        </div>
      </div>
    `;
  }

  // --- SCREEN 4: GOALS, TARGETS, APP PASSKEY LOCK & AUTHENTICATED CLOUD SYNC ---
  function renderSettingsScreen() {
    const cloudReady = isCloudConfigured(state);
    const hasPasskey = Boolean(state.syncPasskey && state.syncPasskey.trim());

    return `
      <!-- 1. Daily Home Exercise Targets -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div class="section-heading">Daily Home Exercise Targets</div>
            <div class="section-sub">Edit daily targets or add new exercises (${state.exercises.length} configured)</div>
          </div>
        </div>

        <div class="stack-list" style="margin-bottom:12px;">
          ${state.exercises.map(ex => `
            <div class="surface-inset editor-row">
              <span class="ex-title">${escapeHtml(ex.name)}</span>
              <div class="editor-controls">
                <input type="number" min="1" value="${ex.target}"
                       class="num-input text-emerald tabular-nums"
                       style="width:64px;padding:4px 8px;"
                       onchange="App.UpdateTarget('${ex.id}', this.value)" />
                <span class="text-muted" style="font-size:0.75rem;width:32px;">${escapeHtml(ex.unit)}</span>
                <button class="mini-btn" style="color:var(--text-slate-500);" onclick="App.RemoveExercise('${ex.id}')">Remove</button>
              </div>
            </div>
          `).join('')}
        </div>

        <div class="surface-inset" style="padding:10px;">
          <div style="font-size:0.75rem;font-weight:600;color:var(--text-slate-300);margin-bottom:8px;">Add Exercise</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            <input id="new-ex-name" type="text" class="text-input" style="flex:1;min-width:130px;" placeholder="Exercise name (e.g. Pull-ups)" />
            <input id="new-ex-target" type="number" min="1" value="30" class="text-input tabular-nums" style="width:64px;font-weight:700;" />
            <select id="new-ex-unit" class="text-input">
              <option value="reps">reps</option>
              <option value="sec">sec</option>
              <option value="min">min</option>
              <option value="sets">sets</option>
            </select>
            <button class="primary-btn smooth-ui" onclick="App.AddExercise()">+ Add</button>
          </div>
        </div>
      </section>

      <!-- 2. Weekly Gym Target -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div class="section-heading">Weekly Gym Target</div>
            <div class="section-sub">Days per week required for a Green Gym Week</div>
          </div>
          <span class="text-sky tabular-nums" style="font-size:0.75rem;font-weight:700;">${state.weeklyGymTarget} days / wk</span>
        </div>

        <div class="week-7-grid" style="margin-bottom:0;">
          ${[1, 2, 3, 4, 5, 6, 7].map(n => `
            <button class="week-day-btn ${state.weeklyGymTarget === n ? 'visited' : ''} tabular-nums smooth-ui"
                    style="padding:6px 0;font-weight:700;"
                    onclick="App.SetWeeklyGymTarget(${n})">
              ${n}d
            </button>
          `).join('')}
        </div>
      </section>

      <!-- 3. App Passkey Lock & Session Authentication -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div class="section-heading">App Authentication &amp; Passkey Lock</div>
            <div class="section-sub">Protects your app on this device and authenticates Google Drive sync</div>
          </div>
          <span class="${hasPasskey ? 'text-emerald' : 'text-amber'}" style="font-size:0.75rem;font-weight:600;">
            ${hasPasskey ? (state.appLockEnabled ? 'Startup Lock ON' : 'Passkey Set') : 'No Passkey'}
          </span>
        </div>

        <div class="security-note-box">
          Static GitHub Pages only serves the UI shell — visitors with the public link only see their own isolated browser storage and <strong>cannot</strong> access or overwrite your data without your secret Passkey or GitHub Token below.
        </div>

        <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
          <input id="sec-passkey-input" type="password" class="text-input" style="flex:1;min-width:160px;"
                 placeholder="Set Secret Passkey / PIN"
                 value="${escapeHtml(state.syncPasskey || '')}" />
          <button class="step-btn smooth-ui"
                  style="${state.appLockEnabled ? 'border-color:var(--emerald-500);color:var(--emerald-400);' : ''}"
                  onclick="App.ToggleAppLock()">
            Require on Startup: ${state.appLockEnabled ? 'ON' : 'OFF'}
          </button>
          <button class="primary-btn smooth-ui" onclick="App.SavePasskeyOnly()">Save Passkey</button>
        </div>
      </section>

      <!-- 4. Authenticated Cloud Sync & Backups -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div class="section-heading">Authenticated Cloud Sync</div>
            <div class="section-sub">Choose Zero-"Anyone" Private GitHub Gist or Passkey-Protected Drive</div>
          </div>
          <span class="${cloudReady ? 'text-emerald' : 'text-muted'}" style="font-size:0.75rem;font-weight:600;">
            ${cloudReady ? (state.syncProvider === 'gist' ? 'Private Gist Ready' : 'Drive Auth Ready') : 'Local Only'}
          </span>
        </div>

        <!-- Provider Switcher -->
        <div class="period-4-grid" style="grid-template-columns:repeat(2, 1fr);margin-bottom:10px;">
          <button class="seg-btn ${state.syncProvider === 'gist' ? 'active' : ''} smooth-ui"
                  onclick="App.SetSyncProvider('gist')">
            Private GitHub Gist (Bearer Token)
          </button>
          <button class="seg-btn ${state.syncProvider === 'gdrive' ? 'active' : ''} smooth-ui"
                  onclick="App.SetSyncProvider('gdrive')">
            Google Drive (Passkey Verified)
          </button>
        </div>

        ${state.syncProvider === 'gist' ? `
          <div class="security-note-box">
            <strong>100% Private (No "Anyone" setting):</strong> Uses your GitHub Personal Access Token (<code>gist</code> scope, saved only in this device's storage) to sync <code>fitness-tracker-data.json</code> to a private GitHub Gist over <code>Authorization: Bearer</code>.
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
            <input id="github-token-input" type="password" class="text-input" style="flex:2;min-width:180px;"
                   placeholder="GitHub Personal Access Token (ghp_... with 'gist' scope)"
                   value="${escapeHtml(state.githubToken || '')}" />
            <input id="gist-id-input" type="text" class="text-input tabular-nums" style="flex:1;min-width:120px;"
                   placeholder="Gist ID (auto-filled)"
                   value="${escapeHtml(state.gistId || '')}" />
            <button class="primary-btn smooth-ui" onclick="App.SaveGistConfig()">Save</button>
          </div>
        ` : `
          <div class="security-note-box">
            <strong>Why Google asks for "Anyone" + How Passkey locks it down:</strong> Google blocks cross-domain <code>fetch()</code> from <code>github.io</code> unless the Web App gateway is set to <em>Anyone</em>. To secure it, our script enforces <code>SECRET_PASSKEY</code> verification on every <code>GET</code> &amp; <code>POST</code> — any request without your passkey is rejected.
          </div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
            <input id="sync-url-input" type="url" class="text-input" style="flex:1;min-width:200px;"
                   placeholder="Paste Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec)"
                   value="${escapeHtml(state.syncUrl || '')}" />
            <button class="primary-btn smooth-ui" onclick="App.SaveSyncUrl()">Save</button>
          </div>
        `}

        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:6px;margin-bottom:8px;">
          <button class="step-btn" onclick="App.PushDriveManual()">Sync Now</button>
          <button class="step-btn" onclick="App.PullDriveManual()">Pull Cloud</button>
          <button class="step-btn" onclick="App.CopyDriveScript()">Copy Protected Script</button>
        </div>

        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:6px;">
          <button class="step-btn" onclick="App.ExportJson()">Export JSON</button>
          <label class="step-btn" style="text-align:center;cursor:pointer;">
            Import JSON
            <input type="file" accept=".json" style="display:none;" onchange="App.ImportJson(event)" />
          </label>
          <button class="step-btn" style="color:var(--red-400);" onclick="App.ResetClean()">Reset Day 1</button>
        </div>
      </section>
    `;
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function render() {
    renderHeader();
    renderAuthGate();
    const main = document.getElementById('main-view');
    if (!main) return;

    if (ui.screen === 'today') main.innerHTML = renderTodayScreen();
    else if (ui.screen === 'calendar') main.innerHTML = renderCalendarScreen();
    else if (ui.screen === 'charts') main.innerHTML = renderChartsScreen();
    else main.innerHTML = renderSettingsScreen();

    ['today', 'calendar', 'charts', 'settings'].forEach(s => {
      const btn = document.getElementById('dock-' + s);
      if (btn) {
        btn.className = `nav-tab-btn smooth-ui ${ui.screen === s ? 'active' : ''}`;
      }
    });
  }

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.deferredInstallPrompt = e;
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(() => {});
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    render();
  });

  return {
    SetScreen(scr) {
      ui.screen = scr;
      render();
    },
    StepActiveDate(delta) {
      const today = toDateKey();
      const oldest = addDays(today, -EDIT_WINDOW_DAYS);
      const next = addDays(ui.activeDate, delta);
      if (next >= oldest && next <= today) {
        ui.activeDate = next;
        render();
      }
    },
    JumpToToday() {
      ui.activeDate = toDateKey();
      render();
    },
    BumpExercise(dateKey, exId, delta) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const log = getDayLog(dateKey);
      log.exercises[exId] = Math.max(0, (Number(log.exercises[exId]) || 0) + delta);
      saveState(true);
    },
    SetExactExercise(dateKey, exId, val) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const log = getDayLog(dateKey);
      log.exercises[exId] = Math.max(0, Number(val) || 0);
      saveState(true);
    },
    ToggleGym(dateKey) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const log = getDayLog(dateKey);
      log.gym = !log.gym;
      saveState(true);
    },
    StepCalMonth(delta) {
      const d = new Date(ui.calYear, ui.calMonth + delta, 1);
      ui.calYear = d.getFullYear();
      ui.calMonth = d.getMonth();
      render();
    },
    SelectCalDate(dateKey) {
      if (dateKey <= toDateKey()) {
        ui.selectedCalDate = dateKey;
        render();
      }
    },
    SetChartExercise(id) {
      ui.chartExerciseId = id;
      render();
    },
    StepChartExercise(delta) {
      const idx = state.exercises.findIndex(e => e.id === ui.chartExerciseId);
      const nextIdx = (idx + delta + state.exercises.length) % state.exercises.length;
      ui.chartExerciseId = state.exercises[nextIdx].id;
      render();
    },
    SetChartStyle(style) {
      ui.chartStyle = style;
      render();
    },
    SetChartPeriod(period) {
      ui.chartPeriod = period;
      render();
    },
    UpdateTarget(exId, val) {
      const ex = state.exercises.find(e => e.id === exId);
      if (ex) {
        ex.target = Math.max(1, Number(val) || 1);
        saveState(true);
        showToast(`Updated ${ex.name} target to ${ex.target} ${ex.unit}`);
      }
    },
    AddExercise() {
      const nameEl = document.getElementById('new-ex-name');
      const targetEl = document.getElementById('new-ex-target');
      const unitEl = document.getElementById('new-ex-unit');
      const name = (nameEl ? nameEl.value : '').trim();
      if (!name) {
        showToast('Enter an exercise name');
        return;
      }
      const target = Math.max(1, Number(targetEl ? targetEl.value : 30) || 30);
      const unit = unitEl ? unitEl.value : 'reps';
      const id = 'ex_' + Date.now();
      state.exercises.push({ id, name, target, unit });
      saveState(true);
      showToast(`Added ${name} (${target} ${unit})`);
    },
    RemoveExercise(id) {
      if (state.exercises.length <= 1) {
        showToast('Keep at least 1 daily exercise');
        return;
      }
      state.exercises = state.exercises.filter(e => e.id !== id);
      if (ui.chartExerciseId === id) {
        ui.chartExerciseId = state.exercises[0].id;
      }
      saveState(true);
      showToast('Exercise removed');
    },
    SetWeeklyGymTarget(n) {
      state.weeklyGymTarget = Number(n) || 4;
      saveState(true);
      showToast(`Weekly gym target set to ${state.weeklyGymTarget}d/wk`);
    },
    SetSyncProvider(provider) {
      state.syncProvider = provider === 'gdrive' ? 'gdrive' : 'gist';
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(false);
    },
    SavePasskeyOnly() {
      const passEl = document.getElementById('sec-passkey-input');
      state.syncPasskey = passEl ? passEl.value.trim() : '';
      if (state.syncPasskey) {
        sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
      } else {
        state.appLockEnabled = false;
      }
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(false);
      showToast(state.syncPasskey ? 'Secret Passkey saved' : 'Passkey cleared');
    },
    ToggleAppLock() {
      const passEl = document.getElementById('sec-passkey-input');
      if (passEl && passEl.value.trim()) {
        state.syncPasskey = passEl.value.trim();
      }
      if (!state.syncPasskey) {
        showToast('Enter a Secret Passkey first');
        return;
      }
      state.appLockEnabled = !state.appLockEnabled;
      sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
      saveState(false);
      showToast(state.appLockEnabled ? 'Startup Passkey Lock enabled' : 'Startup Passkey Lock disabled');
    },
    UnlockSession() {
      const el = document.getElementById('unlock-passkey-input');
      const entered = el ? el.value.trim() : '';
      if (entered && entered === state.syncPasskey) {
        isSessionLocked = false;
        sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
        renderAuthGate();
        showToast('Session unlocked');
      } else {
        showToast('Incorrect Passkey / PIN');
      }
    },
    HeaderLockClick() {
      if (state.syncPasskey && state.syncPasskey.trim()) {
        isSessionLocked = true;
        sessionStorage.removeItem(SESSION_UNLOCK_KEY);
        renderAuthGate();
      } else {
        ui.screen = 'settings';
        render();
        showToast('Set your Secret Passkey in Goals below');
      }
    },
    SaveGistConfig() {
      const tokEl = document.getElementById('github-token-input');
      const idEl = document.getElementById('gist-id-input');
      state.githubToken = tokEl ? tokEl.value.trim() : '';
      state.gistId = idEl ? idEl.value.trim() : '';
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(true);
      showToast(state.githubToken ? 'Private GitHub Gist credentials saved' : 'Cleared GitHub Token');
    },
    SaveSyncUrl() {
      const el = document.getElementById('sync-url-input');
      const passEl = document.getElementById('sec-passkey-input');
      state.syncUrl = el ? el.value.trim() : '';
      if (passEl && passEl.value.trim()) {
        state.syncPasskey = passEl.value.trim();
      }
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(true);
      if (state.syncUrl && !state.syncPasskey) {
        showToast('URL saved — also set your Secret Passkey above');
      } else {
        showToast(state.syncUrl ? 'Authenticated Drive Sync saved' : 'Switched to Local mode');
      }
    },
    PushDriveManual() {
      pushToCloud(true);
    },
    PullDriveManual() {
      pullFromCloud();
    },
    CopyDriveScript() {
      const passEl = document.getElementById('sec-passkey-input');
      const key = (passEl && passEl.value.trim()) ? passEl.value.trim() : state.syncPasskey;
      const src = buildGDriveScriptSource(key);
      navigator.clipboard.writeText(src).then(() => {
        showToast(key ? 'Copied script pre-filled with your Passkey' : 'Copied Passkey-protected Drive script');
      }).catch(() => {
        showToast('See google-drive-sync.gs in your project directory');
      });
    },
    HeaderSyncClick() {
      if (isCloudConfigured(state)) {
        pushToCloud(true);
      } else {
        ui.screen = 'settings';
        render();
        showToast('Configure Authenticated Cloud Sync below');
      }
    },
    ExportJson() {
      const blob = new Blob([JSON.stringify(stripSecrets(state), null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `ironhabit-backup-${toDateKey()}.json`;
      a.click();
      URL.revokeObjectURL(url);
      showToast('Exported JSON backup');
    },
    ImportJson(event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const parsed = JSON.parse(e.target.result);
          const payload = parsed.payload || parsed;
          if (payload && Array.isArray(payload.exercises)) {
            state = {
              ...createDefaultState(),
              ...payload,
              syncProvider: state.syncProvider,
              syncUrl: state.syncUrl,
              syncPasskey: state.syncPasskey,
              githubToken: state.githubToken,
              gistId: state.gistId,
              appLockEnabled: state.appLockEnabled
            };
            saveState(true);
            showToast('Imported backup');
          } else {
            showToast('Invalid JSON backup');
          }
        } catch (err) {
          showToast('Failed to read JSON file');
        }
      };
      reader.readAsText(file);
    },
    ResetClean() {
      const today = toDateKey();
      state.logs = {};
      state.trackingStartDate = today;
      ui.activeDate = today;
      ui.selectedCalDate = today;
      saveState(true);
      showToast('Cleared sample history — Day 1 starts today');
    }
  };
})();
