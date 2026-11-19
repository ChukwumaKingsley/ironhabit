/* ==========================================================================
   IRONHABIT — PRODUCTION APPLICATION ENGINE
   Local-First PWA + Authenticated Cloud Sync (Passkey Drive / Private GitHub Gist)
   + App Passkey Lock Gate + 7-Day Edit Lock
   ========================================================================== */

const STORAGE_KEY = 'ironhabit_state_v2';
const SESSION_UNLOCK_KEY = 'ironhabit_session_unlocked';
const EDIT_WINDOW_DAYS = 7;
const DEFAULT_PROFILE_NAME = 'Athlete';

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
    const day = d.getDay(); // 0=Sun..6=Sat (Sunday is first day of week)
    d.setDate(d.getDate() - day);
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
    const sunKey = getMondayKey(dateKey);
    const d = parseDateKey(addDays(sunKey, 3)); // Mid-week anchor so Sun-Sat share the same week number
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

  const DAY_LABELS_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
  const DEFAULT_CUSTOM_PATTERN = [1, 3, 5, 6, 2, 4, 0];

  function defaultDaysForCount(count) {
    const n = Math.max(1, Math.min(7, Number(count) || 1));
    return DEFAULT_CUSTOM_PATTERN.slice(0, n);
  }

  function normalizeDaysList(days, countFallback) {
    const raw = Array.isArray(days) ? days.map(Number).filter(n => Number.isInteger(n) && n >= 0 && n <= 6) : [];
    const unique = [];
    raw.forEach(d => {
      if (!unique.includes(d)) unique.push(d);
    });
    if (unique.length === 0) {
      return defaultDaysForCount(countFallback);
    }
    return unique;
  }

  function normalizeState(st) {
    if (!st || typeof st !== 'object') return createDefaultState();
    if (!st.profileName || st.profileName === 'Kingsley') {
      st.profileName = DEFAULT_PROFILE_NAME;
    }
    const targetGym = Math.max(1, Math.min(7, Number(st.weeklyGymTarget) || 4));
    st.weeklyGymTarget = targetGym;
    if (st.gymScheduleMode !== 'daily' && st.gymScheduleMode !== 'custom') {
      st.gymScheduleMode = targetGym >= 7 ? 'daily' : 'custom';
    }
    if (st.gymScheduleMode === 'daily') {
      st.weeklyGymTarget = 7;
      st.gymScheduleDays = [0, 1, 2, 3, 4, 5, 6];
    } else {
      st.gymScheduleDays = normalizeDaysList(st.gymScheduleDays, targetGym).slice(0, Math.max(1, targetGym));
    }
    if (!st.gymReschedules || typeof st.gymReschedules !== 'object' || Array.isArray(st.gymReschedules)) {
      st.gymReschedules = {};
    }
    const logDates = Object.keys(st.logs || {}).filter(k => /^\d{4}-\d{2}-\d{2}$/.test(k)).sort();
    let baselineDate = (st.trackingStartDate && /^\d{4}-\d{2}-\d{2}$/.test(st.trackingStartDate))
      ? st.trackingStartDate
      : toDateKey();
    if (logDates.length > 0 && logDates[0] < baselineDate) {
      baselineDate = logDates[0];
    }

    if (!st.targetHistory || typeof st.targetHistory !== 'object' || Array.isArray(st.targetHistory)) {
      st.targetHistory = {};
    }

    const needsV19Heal = !st.targetHistoryVersion || st.targetHistoryVersion < 2;

    st.exercises = (Array.isArray(st.exercises) ? st.exercises : []).map(ex => {
      const cleanTarget = Math.max(1, Number(ex.target) || 1);
      const rawHist = Array.isArray(st.targetHistory[ex.id]) ? st.targetHistory[ex.id] : [];
      const byDate = {};
      rawHist.forEach(item => {
        if (item && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number(item.target) > 0) {
          byDate[item.date] = Math.max(1, Number(item.target));
        }
      });
      const histDates = Object.keys(byDate).sort();
      if (histDates.length === 0) {
        st.targetHistory[ex.id] = [{ date: baselineDate, target: cleanTarget }];
      } else if (needsV19Heal && histDates.length === 1 && byDate[histDates[0]] !== cleanTarget) {
        // Recover from v19 bug where createDefaultState() seeded default targets (e.g. 50) over user targets (e.g. 30)
        const polluted = byDate[histDates[0]];
        st.targetHistory[ex.id] = [{ date: histDates[0], target: cleanTarget }];
        Object.keys(st.logs || {}).forEach(logKey => {
          const entry = st.logs[logKey];
          if (entry && entry.targets && entry.targets[ex.id] === polluted) {
            entry.targets[ex.id] = cleanTarget;
          }
        });
      } else {
        st.targetHistory[ex.id] = histDates.map(d => ({ date: d, target: byDate[d] }));
      }

      const mode = ex.scheduleMode === 'custom' ? 'custom' : 'daily';
      if (mode === 'daily') {
        return {
          ...ex,
          target: cleanTarget,
          scheduleMode: 'daily',
          scheduleTargetCount: 7,
          scheduleDays: [0, 1, 2, 3, 4, 5, 6]
        };
      }
      const days = normalizeDaysList(ex.scheduleDays, ex.scheduleTargetCount || 3);
      const count = Math.max(1, Math.min(6, Number(ex.scheduleTargetCount) || days.length));
      return {
        ...ex,
        target: cleanTarget,
        scheduleMode: 'custom',
        scheduleTargetCount: count,
        scheduleDays: days.slice(0, Math.max(1, count))
      };
    });

    const baselineSun = getMondayKey(baselineDate);
    const rawGymHist = Array.isArray(st.gymHistory) ? st.gymHistory : [];
    const gymByWeek = {};
    rawGymHist.forEach(item => {
      if (item && /^\d{4}-\d{2}-\d{2}$/.test(item.week)) {
        const wKey = getMondayKey(item.week);
        const t = Math.max(1, Math.min(7, Number(item.target) || 4));
        const m = item.mode === 'daily' || t >= 7 ? 'daily' : 'custom';
        gymByWeek[wKey] = {
          week: wKey,
          mode: m,
          target: m === 'daily' ? 7 : t,
          days: m === 'daily' ? [0, 1, 2, 3, 4, 5, 6] : normalizeDaysList(item.days, t).slice(0, t)
        };
      }
    });
    const gymWeeks = Object.keys(gymByWeek).sort();
    if (gymWeeks.length === 0) {
      st.gymHistory = [{
        week: baselineSun,
        mode: st.gymScheduleMode,
        target: st.weeklyGymTarget,
        days: [...st.gymScheduleDays]
      }];
    } else if (needsV19Heal && gymWeeks.length === 1) {
      // Recover from v19 bug where createDefaultState() seeded default [1,3,5,6] (4d) over user's gym schedule
      const only = gymByWeek[gymWeeks[0]];
      const curDaysSorted = [...st.gymScheduleDays].sort((a, b) => a - b).join(',');
      const onlyDaysSorted = [...(only.days || [])].sort((a, b) => a - b).join(',');
      if (only.mode !== st.gymScheduleMode || only.target !== st.weeklyGymTarget || onlyDaysSorted !== curDaysSorted) {
        st.gymHistory = [{
          week: gymWeeks[0],
          mode: st.gymScheduleMode,
          target: st.weeklyGymTarget,
          days: [...st.gymScheduleDays]
        }];
      } else {
        st.gymHistory = [only];
      }
    } else {
      st.gymHistory = gymWeeks.map(w => gymByWeek[w]);
    }
    st.targetHistoryVersion = 2;
    return st;
  }

  // --- Default State & Sample History Seeder ---
  function createDefaultState() {
    const today = toDateKey();
    const startDate = addDays(today, -28);
    return {
      version: 2,
      targetHistoryVersion: 0,
      updatedAt: 0,
      profileName: DEFAULT_PROFILE_NAME,
      themeMode: 'dark', // 'dark' | 'light' | 'system'
      remindersEnabled: false,
      morningReminderTime: '08:00',
      eveningReminderTime: '20:00',
      lastMorningNotifDate: '',
      lastEveningNotifDate: '',
      trackingStartDate: startDate,
      weeklyGymTarget: 4,
      gymScheduleMode: 'custom', // 'daily' | 'custom'
      gymScheduleDays: [1, 3, 5, 6], // Mon, Wed, Fri, Sat
      gymHistory: [],
      gymReschedules: {}, // { [weekSunKey]: [{ from, to }] }
      syncProvider: 'gdrive', // 'gdrive' (Passkey Google Drive) | 'gist' (Private GitHub Gist)
      syncUrl: '',
      syncPasskey: '',
      githubToken: '',
      gistId: '',
      appLockEnabled: false,
      biometricEnabled: false,
      biometricCredId: '',
      lastSyncedAt: null,
      exercises: [
        { id: 'pushups', name: 'Push-ups',   target: 50, unit: 'reps', scheduleMode: 'daily', scheduleTargetCount: 7, scheduleDays: [0, 1, 2, 3, 4, 5, 6] },
        { id: 'situps',  name: 'Sit-ups',    target: 50, unit: 'reps', scheduleMode: 'daily', scheduleTargetCount: 7, scheduleDays: [0, 1, 2, 3, 4, 5, 6] },
        { id: 'squats',  name: 'Air Squats', target: 40, unit: 'reps', scheduleMode: 'daily', scheduleTargetCount: 7, scheduleDays: [0, 1, 2, 3, 4, 5, 6] }
      ],
      targetHistory: {},
      logs: {}
    };
  }

  function stripSecrets(st) {
    const copy = { ...st };
    delete copy.syncPasskey;
    delete copy.githubToken;
    delete copy.biometricEnabled;
    delete copy.biometricCredId;
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
    const startDate = addDays(today, -60);
    st.trackingStartDate = startDate;
    st.logs = {};
    st.targetHistory = {};
    st.exercises.forEach(ex => {
      st.targetHistory[ex.id] = [{ date: startDate, target: ex.target }];
    });
    st.gymHistory = [{
      week: getMondayKey(startDate),
      mode: st.gymScheduleMode || 'custom',
      target: st.weeklyGymTarget || 4,
      days: Array.isArray(st.gymScheduleDays) ? [...st.gymScheduleDays] : [1, 3, 5, 6]
    }];
    st.targetHistoryVersion = 2;

    for (let offset = -60; offset <= 0; offset++) {
      const k = addDays(today, offset);
      const dt = parseDateKey(k);
      const dow = dt.getDay(); // 0..6
      const isGymDay = dow === 1 || dow === 3 || dow === 5 || (dow === 6 && offset % 2 === 0);

      const exValues = {};
      const exTargets = {};
      st.exercises.forEach((ex, idx) => {
        exTargets[ex.id] = ex.target;
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
        targets: exTargets,
        gym: offset === 0 ? false : isGymDay
      };
    }
  }

  let state = loadState();
  let hasUnsyncedLocalChanges = false;
  let isSessionLocked = Boolean(
    state.appLockEnabled &&
    (state.syncPasskey || (state.biometricEnabled && state.biometricCredId)) &&
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
    settingsOpen: false,
    settingsSection: 'profile', // 'profile' | 'reminders' | 'security' | 'sync' | 'data'
    showResetConfirm: false,
    confirmRemoveExId: null,
    deferredInstallPrompt: null
  };

  let syncTimer = null;

  let lastRenderedScreen = ui.screen;
  let lastRenderedActiveDate = ui.activeDate;
  let wasSettingsOpen = false;
  let settingsCloseTimer = null;
  let wasSessionLocked = isSessionLocked;
  let authGateCloseTimer = null;
  let lastHeaderMetrics = null;
  let pendingFx = null;

  function triggerPopClass(el, cls) {
    if (!el) return;
    el.classList.remove(cls);
    void el.offsetWidth;
    el.classList.add(cls);
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && Array.isArray(parsed.exercises)) {
          const merged = normalizeState({ ...createDefaultState(), ...parsed });
          if (merged.syncUrl && !merged.githubToken) {
            merged.syncProvider = 'gdrive';
          }
          if (!parsed.targetHistoryVersion || parsed.targetHistoryVersion < 2) {
            localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
          }
          return merged;
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
    if (syncCloud) {
      state.updatedAt = Date.now();
      hasUnsyncedLocalChanges = true;
    }
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
        syncTimer = null;
        pushToCloud(false);
      }, 350);
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

  function getEarliestTrackingDate() {
    const today = toDateKey();
    let earliest = (state.trackingStartDate && /^\d{4}-\d{2}-\d{2}$/.test(state.trackingStartDate))
      ? state.trackingStartDate
      : today;
    Object.keys(state.logs || {}).forEach(k => {
      if (/^\d{4}-\d{2}-\d{2}$/.test(k) && k < earliest) earliest = k;
    });
    return earliest;
  }

  function getExerciseTargetForDate(exOrId, dateKey) {
    const ex = typeof exOrId === 'string'
      ? state.exercises.find(e => e.id === exOrId)
      : exOrId;
    if (!ex) return 1;
    const log = dateKey && state.logs && state.logs[dateKey];
    if (log && log.targets && Number(log.targets[ex.id]) > 0) {
      return Math.max(1, Number(log.targets[ex.id]));
    }
    const hist = state.targetHistory && state.targetHistory[ex.id];
    if (dateKey && Array.isArray(hist) && hist.length > 0) {
      let chosen = hist[0];
      for (let i = 0; i < hist.length; i++) {
        if (hist[i].date <= dateKey) chosen = hist[i];
        else break;
      }
      if (chosen && Number(chosen.target) > 0) {
        return Math.max(1, Number(chosen.target));
      }
    }
    return Math.max(1, Number(ex.target) || 1);
  }

  function stampLogTargetForDate(log, ex, dateKey) {
    if (!log || !ex) return;
    if (!log.targets || typeof log.targets !== 'object') {
      log.targets = {};
    }
    if (!(Number(log.targets[ex.id]) > 0)) {
      log.targets[ex.id] = getExerciseTargetForDate(ex, dateKey);
    }
  }

  function recordTargetChange(exId, prevTarget, nextTarget, effectiveDate = toDateKey()) {
    if (!state.targetHistory || typeof state.targetHistory !== 'object') {
      state.targetHistory = {};
    }
    const list = Array.isArray(state.targetHistory[exId]) ? [...state.targetHistory[exId]] : [];
    const byDate = {};
    list.forEach(item => {
      if (item && /^\d{4}-\d{2}-\d{2}$/.test(item.date) && Number(item.target) > 0) {
        byDate[item.date] = Math.max(1, Number(item.target));
      }
    });
    const hasPriorAnchor = Object.keys(byDate).some(d => d < effectiveDate);
    if (!hasPriorAnchor && Number(prevTarget) > 0) {
      const earliest = getEarliestTrackingDate();
      const anchorDate = earliest < effectiveDate ? earliest : addDays(effectiveDate, -1);
      byDate[anchorDate] = Math.max(1, Number(prevTarget));
    }
    byDate[effectiveDate] = Math.max(1, Number(nextTarget) || 1);
    state.targetHistory[exId] = Object.keys(byDate).sort().map(d => ({ date: d, target: byDate[d] }));

    if (state.logs && state.logs[effectiveDate]) {
      if (!state.logs[effectiveDate].targets || typeof state.logs[effectiveDate].targets !== 'object') {
        state.logs[effectiveDate].targets = {};
      }
      state.logs[effectiveDate].targets[exId] = Math.max(1, Number(nextTarget) || 1);
    }
  }

  function getGymRuleForWeek(mondayKey) {
    const hist = Array.isArray(state.gymHistory) ? state.gymHistory : [];
    if (hist.length > 0) {
      let chosen = hist[0];
      for (let i = 0; i < hist.length; i++) {
        if (hist[i].week <= mondayKey) chosen = hist[i];
        else break;
      }
      if (chosen) return chosen;
    }
    return {
      week: mondayKey,
      mode: state.gymScheduleMode === 'daily' ? 'daily' : 'custom',
      target: Math.max(1, Math.min(7, Number(state.weeklyGymTarget) || 4)),
      days: getGymBaseDays()
    };
  }

  function recordGymRuleChange(prevRule, effectiveWeek = getMondayKey(toDateKey())) {
    if (!Array.isArray(state.gymHistory)) {
      state.gymHistory = [];
    }
    const byWeek = {};
    state.gymHistory.forEach(item => {
      if (item && /^\d{4}-\d{2}-\d{2}$/.test(item.week)) {
        byWeek[item.week] = item;
      }
    });
    const hasPriorWeek = Object.keys(byWeek).some(w => w < effectiveWeek);
    if (!hasPriorWeek && prevRule) {
      const earliestSun = getMondayKey(getEarliestTrackingDate());
      const anchorWeek = earliestSun < effectiveWeek ? earliestSun : addDays(effectiveWeek, -7);
      byWeek[anchorWeek] = {
        week: anchorWeek,
        mode: prevRule.mode,
        target: prevRule.target,
        days: [...prevRule.days]
      };
    }
    byWeek[effectiveWeek] = {
      week: effectiveWeek,
      mode: state.gymScheduleMode,
      target: state.weeklyGymTarget,
      days: [...state.gymScheduleDays]
    };
    state.gymHistory = Object.keys(byWeek).sort().map(w => byWeek[w]);
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

  function getExerciseScheduleDays(ex) {
    if (!ex || ex.scheduleMode !== 'custom') return [0, 1, 2, 3, 4, 5, 6];
    return normalizeDaysList(ex.scheduleDays, ex.scheduleTargetCount || 3);
  }

  function isExerciseDueOnDate(ex, dateKey) {
    const dow = parseDateKey(dateKey).getDay();
    return getExerciseScheduleDays(ex).includes(dow);
  }

  function getDueExercisesForDate(dateKey) {
    return state.exercises.filter(ex => isExerciseDueOnDate(ex, dateKey));
  }

  function formatScheduleSummary(mode, days, targetCount) {
    if (mode !== 'custom') return 'Daily (7d/wk)';
    const sorted = [...days].sort((a, b) => a - b);
    const names = sorted.map(d => DAY_LABELS_SHORT[d]).join(', ');
    const cnt = targetCount || sorted.length;
    return `${cnt}d/wk • ${names}`;
  }

  function isDayHomeMet(dateKey) {
    const due = getDueExercisesForDate(dateKey);
    if (due.length === 0) return false;
    return due.every(ex => getExerciseVal(dateKey, ex.id) >= getExerciseTargetForDate(ex, dateKey));
  }

  function hasAnyExerciseProgress(dateKey) {
    return state.exercises.some(ex => getExerciseVal(dateKey, ex.id) > 0);
  }

  function getDayStatus(dateKey) {
    const today = toDateKey();
    if (dateKey > today) return 'future';
    const due = getDueExercisesForDate(dateKey);
    if (due.length === 0) {
      if (hasAnyExerciseProgress(dateKey)) {
        const touched = state.exercises.filter(ex => getExerciseVal(dateKey, ex.id) > 0);
        return touched.every(ex => getExerciseVal(dateKey, ex.id) >= getExerciseTargetForDate(ex, dateKey)) ? 'green' : 'amber';
      }
      if (dateKey === today || dateKey >= state.trackingStartDate) {
        return 'rest';
      }
      return 'none';
    }
    if (due.every(ex => getExerciseVal(dateKey, ex.id) >= getExerciseTargetForDate(ex, dateKey))) return 'green';
    if (hasAnyExerciseProgress(dateKey)) return 'amber';
    const hasGym = Boolean(state.logs[dateKey] && state.logs[dateKey].gym);
    if (dateKey === today || dateKey >= state.trackingStartDate || hasGym) {
      return 'red';
    }
    return 'none';
  }

  function computeHomeStreaks() {
    const today = toDateKey();
    const keys = Object.keys(state.logs).concat([state.trackingStartDate, today]).sort();
    const earliest = keys[0] || today;

    let current = 0;
    const todayDue = getDueExercisesForDate(today);
    let cursor = (todayDue.length === 0 || isDayHomeMet(today)) ? today : addDays(today, -1);
    let safety = 0;
    while (cursor >= earliest && safety < 1500) {
      safety++;
      const due = getDueExercisesForDate(cursor);
      if (due.length === 0) {
        cursor = addDays(cursor, -1);
        continue;
      }
      if (isDayHomeMet(cursor)) {
        current++;
        cursor = addDays(cursor, -1);
      } else {
        break;
      }
    }

    let best = current;
    let run = 0;
    let scan = earliest;
    while (scan <= today) {
      const due = getDueExercisesForDate(scan);
      if (due.length > 0) {
        if (isDayHomeMet(scan)) {
          run++;
          if (run > best) best = run;
        } else {
          run = 0;
        }
      }
      scan = addDays(scan, 1);
    }
    return { current, best };
  }

  function getGymBaseDays() {
    if (state.gymScheduleMode === 'daily') return [0, 1, 2, 3, 4, 5, 6];
    return normalizeDaysList(state.gymScheduleDays, state.weeklyGymTarget || 4);
  }

  function getWeekGymSummary(mondayKey) {
    const today = toDateKey();
    const currentMon = getMondayKey(today);
    const rule = getGymRuleForWeek(mondayKey);
    const isDaily = rule.mode === 'daily';
    const baseWeekdays = isDaily ? [0, 1, 2, 3, 4, 5, 6] : normalizeDaysList(rule.days, rule.target || 4);
    const rawReschedules = (state.gymReschedules && Array.isArray(state.gymReschedules[mondayKey]))
      ? state.gymReschedules[mondayKey]
      : [];

    const days = [];
    for (let i = 0; i < 7; i++) {
      const k = addDays(mondayKey, i);
      const dow = parseDateKey(k).getDay();
      const eligible = k >= today || k >= state.trackingStartDate || mondayKey >= currentMon;
      const baseScheduled = baseWeekdays.includes(dow) && eligible;
      days.push({
        dateKey: k,
        dow,
        baseScheduled,
        scheduled: baseScheduled,
        rescheduledOutTo: null,
        rescheduledInFrom: null,
        visited: Boolean(state.logs[k] && state.logs[k].gym),
        missed: false,
        dueToday: false,
        upcoming: false,
        bonus: false,
        isFuture: k > today,
        isLocked: isDateLocked(k)
      });
    }

    const activeReschedules = [];
    rawReschedules.forEach(item => {
      if (!item || !item.from || !item.to) return;
      const fromSlot = days.find(d => d.dateKey === item.from);
      const toSlot = days.find(d => d.dateKey === item.to);
      if (fromSlot && toSlot && fromSlot.scheduled && !toSlot.scheduled) {
        fromSlot.scheduled = false;
        fromSlot.rescheduledOutTo = toSlot.dateKey;
        toSlot.scheduled = true;
        toSlot.rescheduledInFrom = fromSlot.dateKey;
        activeReschedules.push({ from: fromSlot.dateKey, to: toSlot.dateKey });
      }
    });

    let count = 0;
    let scheduledTotal = 0;
    let scheduledMet = 0;
    let missedCount = 0;

    days.forEach(slot => {
      if (slot.visited) count++;
      if (slot.scheduled) {
        scheduledTotal++;
        if (slot.visited) scheduledMet++;
        else if (slot.dateKey < today) slot.missed = true;
        else if (slot.dateKey === today) slot.dueToday = true;
        else slot.upcoming = true;
        if (slot.missed) missedCount++;
      } else if (slot.visited) {
        slot.bonus = true;
      }
    });

    const target = isDaily ? 7 : Math.max(1, Number(rule.target) || baseWeekdays.length || 4);
    const met = scheduledTotal > 0
      ? (missedCount === 0 && scheduledMet >= scheduledTotal && count >= Math.min(target, scheduledTotal))
      : (count >= target);

    let status = 'red';
    if (mondayKey > currentMon) status = 'future';
    else if (addDays(mondayKey, 6) < state.trackingStartDate && count === 0) status = 'none';
    else if (met) status = 'green';
    else if (count > 0) status = 'amber';

    return {
      mondayKey,
      count,
      target,
      scheduledTotal,
      scheduledMet,
      missedCount,
      activeReschedules,
      met,
      status,
      isCurrent: mondayKey === currentMon,
      days
    };
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

  // --- Smart Morning & Evening Goal-Aware Notifications ---
  function parseTimeMinutes(hhmm, fallbackMinutes) {
    if (!hhmm || typeof hhmm !== 'string' || !hhmm.includes(':')) return fallbackMinutes;
    const [h, m] = hhmm.split(':').map(Number);
    if (Number.isNaN(h) || Number.isNaN(m)) return fallbackMinutes;
    return h * 60 + m;
  }

  function buildGoalReminderPayload(slot, forceTest = false) {
    const today = toDateKey();
    const dueToday = getDueExercisesForDate(today);
    const unmet = dueToday.filter(ex => getExerciseVal(today, ex.id) < getExerciseTargetForDate(ex, today));
    const curMon = getMondayKey(today);
    const gymSum = getWeekGymSummary(curMon);
    const todayGymSlot = gymSum.days.find(d => d.dateKey === today);
    const visitedGymToday = Boolean(todayGymSlot && todayGymSlot.visited);
    const isScheduledGymToday = Boolean(todayGymSlot && todayGymSlot.scheduled);
    const hasUnresolvedMissedGym = gymSum.missedCount > 0;

    const homeDone = unmet.length === 0;
    const gymUrgent = (isScheduledGymToday && !visitedGymToday) || (hasUnresolvedMissedGym && !visitedGymToday);

    if (!forceTest && homeDone && !gymUrgent) {
      return null; // All goals due today met — stay silent
    }

    if (homeDone && gymSum.met) {
      return {
        title: 'IRONHABIT — All Goals Met',
        body: dueToday.length === 0
          ? `Rest day for home exercises • Weekly Gym target met (${gymSum.count}/${gymSum.target}d).`
          : `All ${dueToday.length} scheduled home targets complete • Weekly Gym target met (${gymSum.count}/${gymSum.target}d).`
      };
    }

    const unmetSummary = unmet
      .map(ex => `${ex.name} ${getExerciseVal(today, ex.id)}/${getExerciseTargetForDate(ex, today)}`)
      .join(', ');

    const gymStatusLine = visitedGymToday
      ? `Gym logged today (${gymSum.count}/${gymSum.target}d)`
      : isScheduledGymToday
        ? `GYM DAY DUE TODAY (${gymSum.count}/${gymSum.target}d)`
        : hasUnresolvedMissedGym
          ? `Missed gym this week — reschedule & log (${gymSum.count}/${gymSum.target}d)`
          : gymSum.met
            ? `Gym goal met (${gymSum.count}/${gymSum.target}d)`
            : `Gym: ${gymSum.count}/${gymSum.target}d (Rest today)`;

    if (slot === 'morning') {
      const title = isScheduledGymToday && !visitedGymToday
        ? 'IRONHABIT — Gym Day Scheduled Today'
        : 'IRONHABIT — Morning Target Check-In';
      const homePart = dueToday.length === 0
        ? 'Home exercises: Rest day today'
        : homeDone
          ? 'Scheduled home targets complete'
          : `${unmet.length}/${dueToday.length} scheduled targets due (${unmetSummary})`;
      return { title, body: `${homePart} • ${gymStatusLine}` };
    }

    const streaks = computeHomeStreaks();
    const title = isScheduledGymToday && !visitedGymToday
      ? 'IRONHABIT — Gym Check-In Due Tonight'
      : 'IRONHABIT — Evening Accountability Alert';
    const homePart = dueToday.length === 0
      ? 'Home exercises: Rest day today'
      : homeDone
        ? 'Scheduled home targets complete'
        : `${unmet.length} scheduled target(s) unfinished (${unmetSummary})${streaks.current > 0 ? ` — protect your ${streaks.current}d streak!` : ''}`;
    return { title, body: `${homePart} • ${gymStatusLine}` };
  }

  async function dispatchBrowserNotification(title, body) {
    showToast(body);
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    try {
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.showNotification) {
          await reg.showNotification(title, {
            body,
            icon: './icon.svg',
            badge: './icon.svg',
            tag: 'ironhabit-goal-reminder',
            renotify: true
          });
          return;
        }
      }
      new Notification(title, { body, icon: './icon.svg' });
    } catch (_) {}
  }

  function checkScheduledReminders() {
    if (!state.remindersEnabled) return;
    if (!('Notification' in window) || Notification.permission !== 'granted') return;

    const now = new Date();
    const today = toDateKey(now);
    const nowMinutes = now.getHours() * 60 + now.getMinutes();
    const morningMins = parseTimeMinutes(state.morningReminderTime || '08:00', 8 * 60);
    const eveningMins = parseTimeMinutes(state.eveningReminderTime || '20:00', 20 * 60);

    // Morning window: between morningReminderTime and eveningReminderTime (and before 2:00 PM)
    if (
      nowMinutes >= morningMins &&
      nowMinutes < Math.min(eveningMins, 14 * 60) &&
      state.lastMorningNotifDate !== today
    ) {
      state.lastMorningNotifDate = today;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      const payload = buildGoalReminderPayload('morning', false);
      if (payload) {
        dispatchBrowserNotification(payload.title, payload.body);
      }
    }

    // Evening window: at or after eveningReminderTime
    if (nowMinutes >= eveningMins && state.lastEveningNotifDate !== today) {
      state.lastEveningNotifDate = today;
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      const payload = buildGoalReminderPayload('evening', false);
      if (payload) {
        dispatchBrowserNotification(payload.title, payload.body);
      }
    }
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

  function bufferToBase64Url(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) {
      binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  }

  function base64UrlToBuffer(base64url) {
    const pad = '='.repeat((4 - (base64url.length % 4)) % 4);
    const base64 = (base64url + pad).replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
  }

  function supportsBiometricAuth() {
    return Boolean(window.PublicKeyCredential && navigator.credentials && navigator.credentials.create);
  }

  async function registerDeviceBiometrics() {
    if (!supportsBiometricAuth()) {
      throw new Error('Device biometrics require an HTTPS browser with WebAuthn support.');
    }
    const rpId = window.location.hostname || 'localhost';
    const challenge = crypto.getRandomValues(new Uint8Array(32));
    const userName = ((state.profileName || DEFAULT_PROFILE_NAME).trim() || 'athlete').toLowerCase();
    const displayName = (state.profileName || DEFAULT_PROFILE_NAME).trim() || DEFAULT_PROFILE_NAME;
    const userId = new Uint8Array(16).fill(1);

    const credential = await navigator.credentials.create({
      publicKey: {
        challenge,
        rp: { name: 'IRONHABIT', id: rpId },
        user: {
          id: userId,
          name: userName,
          displayName
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 }
        ],
        authenticatorSelection: {
          authenticatorAttachment: 'platform',
          userVerification: 'required',
          residentKey: 'preferred'
        },
        timeout: 60000
      }
    });
    if (!credential || !credential.rawId) {
      throw new Error('Biometric registration returned no credential.');
    }
    return bufferToBase64Url(credential.rawId);
  }

  let isBiometricPromptActive = false;

  async function verifyDeviceBiometrics(silentAuto = false) {
    if (!supportsBiometricAuth() || !state.biometricCredId) {
      if (!silentAuto) showToast('Biometric unlock is not configured on this device');
      return false;
    }
    if (isBiometricPromptActive) return false;
    isBiometricPromptActive = true;
    try {
      const rpId = window.location.hostname || 'localhost';
      const challenge = crypto.getRandomValues(new Uint8Array(32));
      const allowCredentials = state.biometricCredId
        ? [{
            type: 'public-key',
            id: base64UrlToBuffer(state.biometricCredId),
            transports: ['internal']
          }]
        : [];
      const assertion = await navigator.credentials.get({
        publicKey: {
          challenge,
          rpId,
          allowCredentials,
          userVerification: 'required',
          timeout: 60000
        }
      });
      if (assertion) {
        isSessionLocked = false;
        sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
        renderAuthGate();
        showToast('Unlocked with device biometrics');
        return true;
      }
      return false;
    } catch (err) {
      if (!silentAuto) {
        const msg = (err && err.name === 'NotAllowedError')
          ? 'Biometric prompt cancelled or timed out — try again or use Passkey'
          : 'Biometric verification unavailable — use Passkey / PIN';
        showToast(msg);
      }
      return false;
    } finally {
      isBiometricPromptActive = false;
    }
  }

  function updateLockHeader() {
    const lockBtn = document.getElementById('hdr-lock-btn');
    if (lockBtn) {
      const hasPass = Boolean(
        (state.syncPasskey && state.syncPasskey.trim()) ||
        (state.biometricEnabled && state.biometricCredId)
      );
      lockBtn.className = `icon-hdr-btn smooth-ui ${hasPass ? 'secured' : ''}`;
      lockBtn.title = hasPass ? 'Lock App Now' : 'Set App Passkey or Biometric Unlock in Profile & Settings';
    }
    const profBtn = document.getElementById('hdr-profile-btn');
    const profLbl = document.getElementById('hdr-profile-label');
    if (profBtn) {
      profBtn.className = `profile-hdr-btn smooth-ui ${ui.settingsOpen ? 'active' : ''}`;
    }
    if (profLbl) {
      profLbl.textContent = (state.profileName && state.profileName.trim()) ? state.profileName.trim() : 'Profile';
    }
  }

  function renderAuthGate() {
    const overlay = document.getElementById('auth-gate-overlay');
    if (!overlay) return;
    if (!isSessionLocked) {
      if (wasSessionLocked && overlay.style.display !== 'none') {
        wasSessionLocked = false;
        overlay.classList.remove('overlay-enter');
        overlay.classList.add('overlay-exit');
        const card = overlay.querySelector('.auth-gate-card');
        if (card) {
          card.classList.remove('drawer-enter');
          card.classList.add('drawer-exit');
        }
        if (authGateCloseTimer) clearTimeout(authGateCloseTimer);
        authGateCloseTimer = setTimeout(() => {
          authGateCloseTimer = null;
          if (!isSessionLocked) {
            overlay.style.display = 'none';
            overlay.innerHTML = '';
            overlay.classList.remove('overlay-exit');
          }
        }, 285);
      } else {
        wasSessionLocked = false;
        overlay.style.display = 'none';
        overlay.innerHTML = '';
        overlay.classList.remove('overlay-exit');
      }
      return;
    }
    if (authGateCloseTimer) {
      clearTimeout(authGateCloseTimer);
      authGateCloseTimer = null;
    }
    const isOpeningNow = !wasSessionLocked || overlay.style.display === 'none';
    wasSessionLocked = true;
    const bioReady = Boolean(state.biometricEnabled && state.biometricCredId);
    const passReady = Boolean(state.syncPasskey && state.syncPasskey.trim());

    overlay.classList.remove('overlay-exit');
    if (isOpeningNow) overlay.classList.add('overlay-enter');
    else overlay.classList.remove('overlay-enter');

    overlay.style.display = 'flex';
    overlay.innerHTML = `
      <div class="auth-gate-card ${isOpeningNow ? 'drawer-enter' : ''}">
        <div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;">
          <span class="brand-name">IRONHABIT</span>
          <span class="locked-tag">${bioReady ? 'BIOMETRIC LOCK' : 'PASSKEY LOCKED'}</span>
        </div>
        <div class="section-sub" style="margin-bottom:12px;">
          ${bioReady
            ? 'Verify with your device biometrics (Face ID, Touch ID, Fingerprint, or Windows Hello) to unlock your accountability logs.'
            : 'Enter your Passkey / PIN to unlock your accountability logs and cloud sync session.'}
        </div>
        ${bioReady ? `
          <button class="primary-btn smooth-ui"
                  style="width:100%;padding:10px 12px;margin-bottom:10px;display:flex;align-items:center;justify-content:center;gap:8px;font-size:0.8rem;"
                  onclick="App.UnlockWithBiometrics()">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
              <path d="M12 10a2 2 0 0 0-2 2c0 1.02-.1 2.51-.26 4"></path>
              <path d="M14 13.12c0 2.38 0 6.38-1 8.88"></path>
              <path d="M17.29 21.02c.12-.6.43-2.3.5-3.02"></path>
              <path d="M2 12a10 10 0 0 1 18-6"></path>
              <path d="M2 16h.01"></path>
              <path d="M21.8 16c.2-2 .131-5.354 0-6"></path>
              <path d="M5 19.5C5.5 18 6 15 6 12a6 6 0 0 1 .34-2"></path>
              <path d="M8.65 22c.21-.66.45-1.32.57-2"></path>
              <path d="M9 6.8a6 6 0 0 1 9 5.2v2"></path>
            </svg>
            <span>Unlock with Biometrics / Device Authenticator</span>
          </button>
        ` : ''}
        ${(passReady || !bioReady) ? `
          ${bioReady ? `<div class="section-sub" style="margin-bottom:6px;">Or unlock with Passkey / PIN</div>` : ''}
          <div style="display:flex;gap:6px;margin-bottom:8px;">
            <input id="unlock-passkey-input" type="password" class="text-input" style="flex:1;"
                   placeholder="Enter Passkey / PIN"
                   onkeydown="if(event.key==='Enter') App.UnlockSession()" />
            <button class="primary-btn smooth-ui" onclick="App.UnlockSession()">Unlock</button>
          </div>
        ` : ''}
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

  let isSyncInFlight = false;

  async function pushToCloud(manual = false) {
    if (syncTimer) {
      clearTimeout(syncTimer);
      syncTimer = null;
    }
    captureSettingsInputsIntoState();
    if (!isCloudConfigured(state)) {
      if (manual) {
        ui.settingsOpen = true;
        ui.settingsSection = 'sync';
        render();
        showToast(state.syncProvider === 'gdrive'
          ? 'Enter both your Passkey and Google Drive Script URL first'
          : 'Enter your GitHub Personal Access Token first');
      }
      return;
    }

    isSyncInFlight = true;
    ui.syncStatus = 'syncing';
    updateSyncHeader();

    if (!state.updatedAt) {
      state.updatedAt = Date.now();
    }
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
          cache: 'no-store',
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
        hasUnsyncedLocalChanges = false;
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
      } finally {
        isSyncInFlight = false;
      }
      return;
    }

    // Google Drive Passkey-Authenticated Sync
    try {
      const sep = state.syncUrl.includes('?') ? '&' : '?';
      const authUrl = `${state.syncUrl}${sep}key=${encodeURIComponent(state.syncPasskey || '')}&_t=${Date.now()}`;
      const body = JSON.stringify({
        passkey: state.syncPasskey,
        ...envelope
      });
      const res = await fetch(authUrl, {
        method: 'POST',
        cache: 'no-store',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body
      });
      const rawText = await res.text();
      let data = null;
      try {
        data = JSON.parse(rawText);
      } catch (_) {}

      if (!res.ok || !data || data.ok !== true) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        if (manual) {
          showToast((data && data.error) || 'Drive write failed — re-deploy New Version in Apps Script');
        }
        return;
      }
      hasUnsyncedLocalChanges = false;
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
    } finally {
      isSyncInFlight = false;
    }
  }

  async function pullFromCloud(opts = {}) {
    const { silent = false, onlyIfNewer = false, pushIfEmpty = false } = opts;

    if (!silent) {
      captureSettingsInputsIntoState();
    }
    if (!isCloudConfigured(state)) {
      if (!silent) {
        showToast(state.syncProvider === 'gdrive'
          ? 'Enter both your Passkey and Google Drive Script URL first'
          : 'Enter your GitHub Personal Access Token first');
      }
      return;
    }

    // If a local edit is currently waiting to push, flush it first so we never overwrite our own edit
    if (syncTimer || hasUnsyncedLocalChanges) {
      await pushToCloud(false);
      if (onlyIfNewer) return;
    }
    if (isSyncInFlight) return;

    isSyncInFlight = true;
    if (!silent) {
      ui.syncStatus = 'syncing';
      updateSyncHeader();
    }

    const preservedAuth = {
      syncProvider: state.syncProvider,
      syncUrl: state.syncUrl,
      syncPasskey: state.syncPasskey,
      githubToken: state.githubToken,
      gistId: state.gistId,
      appLockEnabled: state.appLockEnabled,
      biometricEnabled: state.biometricEnabled,
      biometricCredId: state.biometricCredId
    };

    if (state.syncProvider === 'gist') {
      try {
        const token = state.githubToken.trim();
        let gistId = (state.gistId || '').trim();
        if (!gistId) {
          gistId = await findExistingGistId(token);
        }
        if (!gistId) {
          isSyncInFlight = false;
          if (pushIfEmpty) {
            await pushToCloud(true);
            return;
          }
          ui.syncStatus = 'synced';
          updateSyncHeader();
          if (!silent) showToast('No private Gist found yet — click Sync Now to create one');
          return;
        }
        const res = await fetch(`https://api.github.com/gists/${gistId}?_t=${Date.now()}`, {
          cache: 'no-store',
          headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`
          }
        });
        if (!res.ok) throw new Error('GitHub read failed');
        const gist = await res.json();
        const fileObj = gist.files && gist.files['fitness-tracker-data.json'];
        if (!fileObj || !fileObj.content) {
          isSyncInFlight = false;
          if (pushIfEmpty) {
            await pushToCloud(true);
            return;
          }
          ui.syncStatus = 'synced';
          updateSyncHeader();
          if (!silent) showToast('Gist is empty — click Sync Now to push first');
          return;
        }
        const parsed = JSON.parse(fileObj.content);
        const payload = parsed.payload || parsed;
        const remoteUpdatedAt = Number(parsed.updatedAt || (payload && payload.updatedAt) || 0);
        if (payload && Array.isArray(payload.exercises)) {
          if (onlyIfNewer && remoteUpdatedAt <= Number(state.updatedAt || 0)) {
            ui.syncStatus = 'synced';
            updateSyncHeader();
            return;
          }
          state = normalizeState({
            ...createDefaultState(),
            ...payload,
            ...preservedAuth,
            gistId,
            updatedAt: remoteUpdatedAt || Date.now(),
            lastSyncedAt: Date.now()
          });
          hasUnsyncedLocalChanges = false;
          localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
          ui.syncStatus = 'synced';
          updateSyncHeader();
          render();
          if (!silent) showToast('Restored latest data from Private GitHub Gist');
        }
      } catch (e) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        if (!silent) showToast('Failed to pull from Private GitHub Gist');
      } finally {
        isSyncInFlight = false;
      }
      return;
    }

    // Google Drive Passkey-Authenticated Pull (Cache-Busted)
    try {
      const sep = state.syncUrl.includes('?') ? '&' : '?';
      const authUrl = `${state.syncUrl}${sep}key=${encodeURIComponent(state.syncPasskey || '')}&_t=${Date.now()}`;
      const res = await fetch(authUrl, { method: 'GET', cache: 'no-store' });
      const data = await res.json();
      if (data && data.ok === false) {
        ui.syncStatus = 'error';
        updateSyncHeader();
        if (!silent) showToast(data.error || 'Unauthorized: invalid passkey');
        return;
      }
      const remoteUpdatedAt = Number((data && data.updatedAt) || (data && data.payload && data.payload.updatedAt) || 0);
      if (data && data.payload && Array.isArray(data.payload.exercises)) {
        if (onlyIfNewer && remoteUpdatedAt <= Number(state.updatedAt || 0)) {
          ui.syncStatus = 'synced';
          updateSyncHeader();
          return;
        }
        state = normalizeState({
          ...createDefaultState(),
          ...data.payload,
          ...preservedAuth,
          updatedAt: remoteUpdatedAt || Date.now(),
          lastSyncedAt: Date.now()
        });
        hasUnsyncedLocalChanges = false;
        localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
        ui.syncStatus = 'synced';
        updateSyncHeader();
        render();
        if (!silent) showToast('Synced latest data from Google Drive');
      } else {
        isSyncInFlight = false;
        if (pushIfEmpty) {
          await pushToCloud(true);
          return;
        }
        ui.syncStatus = 'synced';
        updateSyncHeader();
        if (!silent) showToast('Drive file is empty — click Sync Now to push first');
      }
    } catch (e) {
      ui.syncStatus = 'error';
      updateSyncHeader();
      if (!silent) showToast('Failed to read from Google Drive URL');
    } finally {
      isSyncInFlight = false;
    }
  }

  function applyThemeMode() {
    const mode = state.themeMode || 'dark';
    let resolved = mode;
    if (mode === 'system') {
      const prefersLight = window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches;
      resolved = prefersLight ? 'light' : 'dark';
    }
    document.documentElement.setAttribute('data-theme', resolved);
    const metaTheme = document.querySelector('meta[name="theme-color"]');
    if (metaTheme) {
      metaTheme.setAttribute('content', resolved === 'light' ? '#FFFFFF' : '#0B0E14');
    }
  }

  if (window.matchMedia) {
    window.matchMedia('(prefers-color-scheme: light)').addEventListener('change', () => {
      if (state.themeMode === 'system') {
        applyThemeMode();
      }
    });
  }

  // --- Header Render ---
  function renderHeader() {
    const today = toDateKey();
    const dt = parseDateKey(today);
    const fullDate = dt.toLocaleDateString('en-US', {
      weekday: 'short',
      month: 'short',
      day: 'numeric',
      year: 'numeric'
    }).toUpperCase();
    const wk = getISOWeekNumber(today);
    document.getElementById('hdr-date-meta').textContent = `${fullDate} • W${wk}`;

    applyThemeMode();
    updateSyncHeader();
    updateLockHeader();

    const streaks = computeHomeStreaks();
    const hdrHomeStreakEl = document.getElementById('hdr-home-streak');
    hdrHomeStreakEl.textContent = String(streaks.current);
    document.getElementById('hdr-home-best').textContent = `Best: ${streaks.best}d`;

    const dueToday = getDueExercisesForDate(today);
    const avgPct = dueToday.length > 0
      ? Math.round(
          (dueToday.reduce((acc, ex) => acc + Math.min(1, getExerciseVal(today, ex.id) / Math.max(1, getExerciseTargetForDate(ex, today))), 0) /
            dueToday.length) * 100
        )
      : 100;
    const hdrHomeStatus = document.getElementById('hdr-home-status');
    if (dueToday.length === 0) {
      hdrHomeStatus.textContent = 'REST';
      hdrHomeStatus.className = 'tabular-nums text-sky';
    } else {
      hdrHomeStatus.textContent = `${avgPct}%`;
      hdrHomeStatus.className = `tabular-nums ${avgPct >= 100 ? 'text-emerald' : avgPct > 0 ? 'text-amber' : 'text-red'}`;
    }

    const curMon = getMondayKey(today);
    const gymSum = getWeekGymSummary(curMon);
    const gymStreak = computeGymWeeklyStreak();
    const hdrGymRatioEl = document.getElementById('hdr-gym-ratio');
    const gymRatioStr = `${gymSum.count}/${gymSum.target}`;
    hdrGymRatioEl.textContent = gymRatioStr;
    document.getElementById('hdr-gym-streak').textContent = `${gymStreak}w Streak`;

    const todayGymSlot = gymSum.days.find(d => d.dateKey === today);
    const hdrGymStatus = document.getElementById('hdr-gym-status');
    if (gymSum.met) {
      hdrGymStatus.textContent = 'Met';
      hdrGymStatus.className = 'tabular-nums text-emerald';
    } else if (gymSum.missedCount > 0) {
      hdrGymStatus.textContent = `${gymSum.missedCount} Missed`;
      hdrGymStatus.className = 'tabular-nums text-red';
    } else if (todayGymSlot && todayGymSlot.dueToday) {
      hdrGymStatus.textContent = 'Due Today';
      hdrGymStatus.className = 'tabular-nums text-sky';
    } else if (gymSum.count > 0) {
      hdrGymStatus.textContent = 'In Prog';
      hdrGymStatus.className = 'tabular-nums text-amber';
    } else {
      hdrGymStatus.textContent = '0 Logged';
      hdrGymStatus.className = 'tabular-nums text-red';
    }

    if (lastHeaderMetrics) {
      if (lastHeaderMetrics.streak !== streaks.current) {
        triggerPopClass(hdrHomeStreakEl, 'fx-hdr-pop');
      }
      if (lastHeaderMetrics.avgPct !== avgPct) {
        triggerPopClass(hdrHomeStatus, 'fx-hdr-pop');
      }
      if (lastHeaderMetrics.gymRatio !== gymRatioStr) {
        triggerPopClass(hdrGymRatioEl, 'fx-hdr-pop');
      }
    }
    lastHeaderMetrics = {
      streak: streaks.current,
      avgPct,
      gymRatio: gymRatioStr
    };
  }

  function renderTodayExerciseCard(ex, dateKey, isDue) {
    const current = getExerciseVal(dateKey, ex.id);
    const dayTarget = getExerciseTargetForDate(ex, dateKey);
    const pct = Math.min(100, Math.round((current / Math.max(1, dayTarget)) * 100));
    const tone = getMetricTone(current, dayTarget);
    const done = current >= dayTarget;
    const isBumpedEx = pendingFx && pendingFx.dateKey === dateKey &&
      ((pendingFx.type === 'ex-change' && pendingFx.exId === ex.id) || pendingFx.type === 'complete-all');
    const isTargetHitEx = pendingFx && pendingFx.dateKey === dateKey &&
      ((pendingFx.type === 'ex-change' && pendingFx.exId === ex.id && pendingFx.hitTarget) ||
       (pendingFx.type === 'complete-all' && pendingFx.hitIds && pendingFx.hitIds.includes(ex.id)));

    return `
      <div class="surface-inset ex-box ${isTargetHitEx ? 'fx-target-met' : ''}" data-ex-id="${ex.id}" style="${isDue ? '' : 'opacity:0.86;'}">
        <div class="ex-top-line">
          <div style="display:flex;align-items:center;gap:6px;min-width:0;flex-wrap:wrap;">
            <span class="ex-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ex.name)}</span>
            ${ex.scheduleMode === 'custom'
              ? (isDue ? '<span class="due-badge">Due</span>' : '<span class="rest-badge">Rest</span>')
              : ''}
            ${dayTarget !== ex.target ? `<span class="rest-badge" title="Target active on this date">Then ${dayTarget}</span>` : ''}
          </div>
          <div class="ex-input-group tabular-nums">
            <input type="number" min="0" value="${current}"
                   data-ex-id="${ex.id}"
                   class="num-input ${tone.text} tabular-nums ${isBumpedEx ? 'fx-val-pop' : ''}"
                   onchange="App.SetExactExercise('${dateKey}', '${ex.id}', this.value)" />
            <span class="${tone.text}" style="font-weight:600;">/ ${dayTarget} ${escapeHtml(ex.unit)}</span>
          </div>
        </div>

        <div class="progress-rail">
          <div class="progress-fill ${tone.bg}" data-ex-id="${ex.id}" data-target-pct="${pct}" style="width:${pct}%;"></div>
        </div>

        <div class="increment-grid">
          <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', -1)">-1</button>
          <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', 1)">+1</button>
          <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', 5)">+5</button>
          <button class="inc-btn tabular-nums smooth-ui" onclick="App.BumpExercise('${dateKey}', '${ex.id}', 10)">+10</button>
          <button class="inc-btn target-btn ${done ? 'met' : ''} tabular-nums smooth-ui"
                  onclick="App.SetExactExercise('${dateKey}', '${ex.id}', ${dayTarget})">
            ${dayTarget}
          </button>
        </div>
      </div>
    `;
  }

  // --- SCREEN 1: TODAY & 7-DAY EDITABLE LOGGING ---
  function renderTodayScreen() {
    const today = toDateKey();
    const dateKey = ui.activeDate;
    const isToday = dateKey === today;
    const oldestEditable = addDays(today, -EDIT_WINDOW_DAYS);
    const atOldestLimit = dateKey <= oldestEditable;

    const dueExercises = getDueExercisesForDate(dateKey);
    const optionalExercises = state.exercises.filter(ex => !isExerciseDueOnDate(ex, dateKey));
    const dueMetCount = dueExercises.filter(ex => getExerciseVal(dateKey, ex.id) >= getExerciseTargetForDate(ex, dateKey)).length;
    const dayStatus = getDayStatus(dateKey);

    const mondayKey = getMondayKey(dateKey);
    const weekGym = getWeekGymSummary(mondayKey);
    const dayNamesShort = DAY_LABELS_SHORT;
    const activeSlot = weekGym.days.find(d => d.dateKey === dateKey);
    const activeDayGym = Boolean(state.logs[dateKey] && state.logs[dateKey].gym);

    const editableMissedSlots = weekGym.days.filter(s => s.missed && !isDateLocked(s.dateKey));
    const upcomingScheduledSlots = weekGym.days.filter(s => s.scheduled && !s.visited && s.dateKey >= today);
    const shiftSources = [...editableMissedSlots, ...upcomingScheduledSlots];
    const openShiftTargets = weekGym.days.filter(s => !s.scheduled && !s.visited && diffDaysBetween(today, s.dateKey) <= EDIT_WINDOW_DAYS);

    const canQuickShiftToActive = Boolean(
      activeSlot &&
      !activeSlot.scheduled &&
      !activeSlot.visited &&
      !isDateLocked(dateKey) &&
      editableMissedSlots.length > 0
    );
    const quickSource = editableMissedSlots[0] || null;
    const defaultFromKey = (editableMissedSlots[0] || (activeSlot && activeSlot.scheduled && !activeSlot.visited ? activeSlot : shiftSources[0]) || {}).dateKey || '';
    const defaultToSlot = openShiftTargets.find(s => s.dateKey === today) ||
      openShiftTargets.find(s => s.dateKey === dateKey) ||
      openShiftTargets.find(s => s.dateKey > (defaultFromKey || today)) ||
      openShiftTargets[0];
    const defaultToKey = defaultToSlot ? defaultToSlot.dateKey : '';

    const splitSlideClass = (pendingFx && pendingFx.type === 'date-step')
      ? (pendingFx.dir > 0 ? 'fx-slide-next' : 'fx-slide-prev')
      : '';
    const isGymToggledForDate = pendingFx && pendingFx.type === 'gym-toggle' && pendingFx.dateKey === dateKey;

    const homeSquareClass = dayStatus === 'green'
      ? 'bg-emerald'
      : dayStatus === 'amber'
        ? 'bg-amber'
        : dayStatus === 'rest'
          ? 'bg-sky'
          : 'bg-red';

    return `
      <!-- Date Switcher Bar (Restricted to 7-Day Edit Window) -->
      <div class="surface-card date-nav-bar">
        <button class="step-btn smooth-ui ${atOldestLimit ? 'disabled' : ''}" onclick="App.StepActiveDate(-1)">
          &larr; Prev
        </button>
        <div style="display:flex;align-items:center;gap:8px;">
          <span class="tabular-nums" style="font-size:0.75rem;font-weight:700;color:var(--text-white);">${formatShortDate(dateKey)}</span>
          ${!isToday ? `<button class="jump-today-btn" onclick="App.JumpToToday()">Today</button>` : ''}
        </div>
        <button class="step-btn smooth-ui ${isToday ? 'disabled' : ''}" onclick="App.StepActiveDate(1)">
          Next &rarr;
        </button>
      </div>

      <div class="today-split ${splitSlideClass}">
        <!-- Daily Home Exercises -->
        <section class="surface-card card-pad ${pendingFx && pendingFx.type === 'complete-all' && pendingFx.dateKey === dateKey ? 'fx-target-met' : ''}">
          <div class="card-head">
            <div>
              <div class="section-heading">Daily Home Exercises</div>
              <div class="section-sub tabular-nums">
                ${dueExercises.length > 0
                  ? `${dueMetCount} of ${dueExercises.length} due targets complete`
                  : 'Scheduled Rest Day — all exercises optional today'}
              </div>
            </div>
            <div style="display:flex;align-items:center;gap:8px;">
              ${dueExercises.length > 0 && dueMetCount < dueExercises.length ? `
                <button class="step-btn smooth-ui" style="color:var(--emerald-400);border-color:rgba(16,185,129,0.4);"
                        onclick="App.CompleteAllForDate('${dateKey}')">
                  Complete Due
                </button>
              ` : ''}
              <span class="status-square ${homeSquareClass}"></span>
            </div>
          </div>

          ${dueExercises.length > 0 ? `
            <div class="stack-list">
              ${dueExercises.map(ex => renderTodayExerciseCard(ex, dateKey, true)).join('')}
            </div>
          ` : `
            <div class="surface-inset" style="padding:10px 12px;font-size:0.75rem;color:var(--text-slate-400);">
              No exercises scheduled for ${DAY_LABELS_SHORT[parseDateKey(dateKey).getDay()]}. Take your recovery or log optional bonus sets below.
            </div>
          `}

          ${optionalExercises.length > 0 ? `
            <div class="optional-divider">
              <span>Rest Day / Optional Today</span>
              <span>${optionalExercises.length} off schedule</span>
            </div>
            <div class="stack-list" style="margin-top:8px;">
              ${optionalExercises.map(ex => renderTodayExerciseCard(ex, dateKey, false)).join('')}
            </div>
          ` : ''}
        </section>

        <!-- Weekly Gym Attendance -->
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Weekly Gym Attendance</div>
              <div class="section-sub">
                ${state.gymScheduleMode === 'daily'
                  ? 'Committed Daily (7d/wk) • Strict Schedule'
                  : `Committed: ${formatScheduleSummary('custom', getGymBaseDays(), state.weeklyGymTarget)}`}
              </div>
            </div>
            <span class="tabular-nums ${weekGym.met ? 'text-emerald' : weekGym.missedCount > 0 ? 'text-red' : weekGym.count > 0 ? 'text-amber' : 'text-red'}"
                  style="font-size:0.75rem;font-weight:700;">
              ${weekGym.count}/${weekGym.target}
            </span>
          </div>

          <div class="week-7-grid">
            ${weekGym.days.map((slot, idx) => {
              const isSlotToggled = pendingFx && pendingFx.type === 'gym-toggle' && pendingFx.dateKey === slot.dateKey;
              let tileCls = 'week-day-btn smooth-ui';
              let tagHtml = '<span class="gym-slot-tag" style="opacity:0.45;">OFF</span>';
              if (slot.visited) {
                tileCls += ' visited';
                tagHtml = `<span class="gym-slot-tag text-sky">${slot.scheduled ? 'DONE' : 'BONUS'}</span>`;
              } else if (slot.missed) {
                tileCls += ' gym-missed';
                tagHtml = '<span class="gym-slot-tag text-red">MISS</span>';
              } else if (slot.rescheduledOutTo) {
                tileCls += ' gym-moved';
                tagHtml = '<span class="gym-slot-tag">MOVED</span>';
              } else if (slot.scheduled) {
                tileCls += ' gym-scheduled';
                tagHtml = `<span class="gym-slot-tag text-sky">${slot.rescheduledInFrom ? 'SHIFT' : 'DUE'}</span>`;
              }
              if (slot.dateKey === dateKey) tileCls += ' active-ring';
              if (slot.isFuture || slot.isLocked) tileCls += ' locked-day';
              if (isSlotToggled) tileCls += ' fx-gym-pop';

              return `
                <button class="${tileCls}"
                        data-date-key="${slot.dateKey}"
                        onclick="App.ToggleGym('${slot.dateKey}')">
                  <div>${dayNamesShort[idx]}</div>
                  <div><span class="gym-dot ${slot.visited ? 'on' : ''}"></span></div>
                  ${tagHtml}
                </button>
              `;
            }).join('')}
          </div>

          <button class="gym-action-btn ${activeDayGym ? 'visited' : ''} ${isGymToggledForDate ? 'fx-gym-btn-pulse' : ''} smooth-ui"
                  onclick="App.ToggleGym('${dateKey}')">
            ${activeDayGym
              ? `Gym Visited (${formatShortDate(dateKey)})`
              : (activeSlot && activeSlot.scheduled)
                ? `Log Scheduled Gym (${formatShortDate(dateKey)})`
                : `Log Gym Visit (${formatShortDate(dateKey)})`}
          </button>

          ${(canQuickShiftToActive || (shiftSources.length > 0 && openShiftTargets.length > 0) || weekGym.activeReschedules.length > 0) ? `
            <div class="resched-box ${editableMissedSlots.length > 0 ? 'resched-alert' : ''}">
              ${canQuickShiftToActive && quickSource ? `
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                  <span style="font-size:0.72rem;font-weight:600;color:var(--red-300);">
                    Missed ${DAY_LABELS_SHORT[quickSource.dow]} (${quickSource.dateKey.slice(5)}) gym
                  </span>
                  <button class="step-btn smooth-ui"
                          style="color:var(--sky-300);border-color:rgba(56,189,248,0.55);background:rgba(14,165,233,0.14);"
                          onclick="App.RescheduleGymDay('${quickSource.dateKey}', '${dateKey}')">
                    Shift ${DAY_LABELS_SHORT[quickSource.dow]} &rarr; ${isToday ? 'Today' : DAY_LABELS_SHORT[activeSlot.dow]}
                  </button>
                </div>
              ` : ''}

              ${(shiftSources.length > 0 && openShiftTargets.length > 0) ? `
                <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                  <span style="font-size:0.7rem;font-weight:700;color:var(--text-slate-400);text-transform:uppercase;">Reschedule:</span>
                  <select id="resched-from-${mondayKey}" class="text-input" style="padding:3px 6px;font-size:0.72rem;">
                    ${shiftSources.map(s => `
                      <option value="${s.dateKey}" ${s.dateKey === defaultFromKey ? 'selected' : ''}>
                        ${DAY_LABELS_SHORT[s.dow]} (${s.dateKey.slice(5)})${s.missed ? ' • Missed' : ''}
                      </option>
                    `).join('')}
                  </select>
                  <span style="font-size:0.75rem;color:var(--text-slate-500);">&rarr;</span>
                  <select id="resched-to-${mondayKey}" class="text-input" style="padding:3px 6px;font-size:0.72rem;">
                    ${openShiftTargets.map(s => `
                      <option value="${s.dateKey}" ${s.dateKey === defaultToKey ? 'selected' : ''}>
                        ${DAY_LABELS_SHORT[s.dow]} (${s.dateKey.slice(5)})${s.dateKey === today ? ' • Today' : ''}
                      </option>
                    `).join('')}
                  </select>
                  <button class="mini-btn smooth-ui"
                          style="color:var(--sky-300);border-color:rgba(56,189,248,0.45);"
                          onclick="App.RescheduleGymFromControls('${mondayKey}')">
                    Shift
                  </button>
                </div>
              ` : ''}

              ${weekGym.activeReschedules.length > 0 ? `
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                  ${weekGym.activeReschedules.map(r => {
                    const fDow = DAY_LABELS_SHORT[parseDateKey(r.from).getDay()];
                    const tDow = DAY_LABELS_SHORT[parseDateKey(r.to).getDay()];
                    return `
                      <span class="resched-pill tabular-nums">
                        <span>Moved ${fDow} &rarr; ${tDow}</span>
                        <button style="color:var(--text-slate-400);font-weight:700;"
                                onclick="App.UndoGymReschedule('${mondayKey}', '${r.to}')"
                                title="Revert reschedule">Undo</button>
                      </span>
                    `;
                  }).join('')}
                </div>
              ` : ''}
            </div>
          ` : ''}
        </section>
      </div>
    `;
  }

  // --- SCREEN 2: CALENDAR + 7-DAY EDIT LOCK INSPECTOR ---
  function renderCalendarScreen() {
    const today = toDateKey();
    const nowDt = parseDateKey(today);
    const year = ui.calYear;
    const month = ui.calMonth;
    const isCurrentMonth = year === nowDt.getFullYear() && month === nowDt.getMonth();
    const firstOfMonth = new Date(year, month, 1, 12, 0, 0);
    const monthTitle = firstOfMonth.toLocaleDateString('en-US', { month: 'long', year: 'numeric' });
    const startMon = getMondayKey(toDateKey(firstOfMonth));
    const lastOfMonth = new Date(year, month + 1, 0, 12, 0, 0);
    const lastKey = toDateKey(lastOfMonth);

    let monthMetDays = 0;
    let monthAmberDays = 0;
    let monthRedDays = 0;
    let monthGymVisits = 0;

    const weeks = [];
    let cursorMon = startMon;
    for (let w = 0; w < 6; w++) {
      const gymSum = getWeekGymSummary(cursorMon);
      const days = [];
      for (let d = 0; d < 7; d++) {
        const k = addDays(cursorMon, d);
        const dt = parseDateKey(k);
        const inMonth = dt.getMonth() === month;
        const st = getDayStatus(k);
        const gym = Boolean(state.logs[k] && state.logs[k].gym);
        if (inMonth && k <= today) {
          if (st === 'green') monthMetDays++;
          else if (st === 'amber') monthAmberDays++;
          else if (st === 'red') monthRedDays++;
          if (gym) monthGymVisits++;
        }
        const gymSlot = gymSum.days[d];
        days.push({
          dateKey: k,
          dayNum: dt.getDate(),
          inMonth,
          status: st,
          gym,
          gymScheduled: Boolean(gymSlot && gymSlot.scheduled),
          gymMissed: Boolean(gymSlot && gymSlot.missed),
          gymDueToday: Boolean(gymSlot && gymSlot.dueToday),
          isFuture: k > today
        });
      }
      weeks.push({ mondayKey: cursorMon, gymSum, days });
      cursorMon = addDays(cursorMon, 7);
      if (cursorMon > lastKey && w >= 3) break;
    }

    const selKey = ui.selectedCalDate;
    const locked = isDateLocked(selKey);
    const selStatus = getDayStatus(selKey);
    const selGym = Boolean(state.logs[selKey] && state.logs[selKey].gym);
    const selMonKey = getMondayKey(selKey);
    const selWeekGym = getWeekGymSummary(selMonKey);
    const selGymSlot = selWeekGym.days.find(d => d.dateKey === selKey);
    const selMissedToShift = (!locked && selGymSlot && !selGymSlot.scheduled && !selGymSlot.visited)
      ? selWeekGym.days.find(s => s.missed && !isDateLocked(s.dateKey))
      : null;
    const calMonthClass = (pendingFx && pendingFx.type === 'cal-month')
      ? (pendingFx.dir > 0 ? 'fx-slide-next' : 'fx-slide-prev')
      : '';
    const isCalSelect = pendingFx && pendingFx.type === 'cal-select' && pendingFx.dateKey === selKey;

    return `
      <div class="calendar-split">
      <!-- Calendar Grid Card -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div style="font-size:0.875rem;font-weight:700;color:var(--text-white);">${monthTitle}</div>
            <div class="section-sub">Entries older than 7 days are locked (read-only)</div>
          </div>
          <div style="display:flex;align-items:center;gap:4px;">
            ${(!isCurrentMonth || selKey !== today) ? `
              <button class="jump-today-btn" onclick="App.JumpCalToToday()">Today</button>
            ` : ''}
            <button class="step-btn" onclick="App.StepCalMonth(-1)">&larr;</button>
            <button class="step-btn" onclick="App.StepCalMonth(1)">&rarr;</button>
          </div>
        </div>

        <div class="cal-8-header">
          <div>SUN</div><div>MON</div><div>TUE</div><div>WED</div><div>THU</div><div>FRI</div><div>SAT</div>
          <div class="text-sky">GYM</div>
        </div>

        <div class="${calMonthClass}">
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
                  else if (d.status === 'rest') cls += ' rest';
                  if (!d.inMonth) cls += ' other-month';
                  if (d.dateKey === selKey) {
                    cls += ' selected';
                    if (isCalSelect) cls += ' fx-cell-select';
                  }

                  let gymMarker = '<span></span>';
                  if (d.gym) gymMarker = '<span class="cal-gym-dot"></span>';
                  else if (d.gymMissed) gymMarker = '<span class="cal-gym-miss-dot"></span>';
                  else if (d.gymDueToday) gymMarker = '<span class="cal-gym-due-dot"></span>';

                  return `
                    <button class="${cls}" onclick="${d.isFuture ? '' : `App.SelectCalDate('${d.dateKey}')`}">
                      <span class="tabular-nums" style="line-height:1;">${d.dayNum}</span>
                      ${gymMarker}
                    </button>
                  `;
                }).join('')}

                <div class="${wkCls}" title="${gs.missedCount > 0 ? `${gs.missedCount} scheduled gym day(s) missed` : ''}">
                  ${gs.status === 'future' || gs.status === 'none' ? '—' : `${gs.count}/${gs.target}${gs.missedCount > 0 ? '!' : ''}`}
                </div>
              </div>
            `;
          }).join('')}
        </div>

        <!-- Monthly Accountability Rollup Strip -->
        <div style="display:grid;grid-template-columns:repeat(4, 1fr);gap:6px;margin-top:10px;padding-top:10px;border-top:1px solid var(--border-card);">
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">Met Days</div>
            <div class="tabular-nums text-emerald" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${monthMetDays}d</div>
          </div>
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">Incomplete</div>
            <div class="tabular-nums text-amber" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${monthAmberDays}d</div>
          </div>
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">Missed (0)</div>
            <div class="tabular-nums text-red" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${monthRedDays}d</div>
          </div>
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">Gym Visits</div>
            <div class="tabular-nums text-sky" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${monthGymVisits}d</div>
          </div>
        </div>
      </section>

      <!-- Selected-Date Inspector / Editor Below Calendar -->
      <section class="surface-card card-pad ${isCalSelect ? 'fx-inspector-swap' : ''}">
        <div class="card-head">
          <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
            <span class="status-square ${selStatus === 'green' ? 'bg-emerald' : selStatus === 'amber' ? 'bg-amber' : selStatus === 'rest' ? 'bg-sky' : 'bg-red'}"></span>
            <span class="section-heading tabular-nums">${formatMonthDayYear(selKey)}</span>
            ${selStatus === 'rest' ? '<span class="rest-badge">Rest Day</span>' : ''}
            ${selGymSlot && selGymSlot.missed ? '<span class="locked-tag" style="color:var(--red-300);border-color:rgba(239,68,68,0.5);">GYM MISSED</span>' : ''}
            ${selGymSlot && selGymSlot.scheduled && !selGymSlot.missed ? '<span class="due-badge">Gym Scheduled</span>' : ''}
            ${selGymSlot && selGymSlot.rescheduledOutTo ? `<span class="rest-badge">Gym &rarr; ${DAY_LABELS_SHORT[parseDateKey(selGymSlot.rescheduledOutTo).getDay()]}</span>` : ''}
            ${locked ? `<span class="locked-tag">LOCKED (&gt;7D)</span>` : ''}
          </div>

          ${locked ? `
            <span class="step-btn" style="pointer-events:none;display:inline-flex;align-items:center;gap:6px;${selGym ? 'border-color:rgba(56,189,248,0.45);color:var(--sky-300);' : 'color:var(--text-slate-500);'}">
              <span style="width:8px;height:8px;border-radius:50%;background:${selGym ? 'var(--sky-400)' : '#475569'};"></span>
              <span>${selGym ? 'Gym Visited' : 'No Gym Visit'}</span>
            </span>
          ` : `
            <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
              ${selMissedToShift ? `
                <button class="step-btn smooth-ui"
                        style="color:var(--sky-300);border-color:rgba(56,189,248,0.5);"
                        onclick="App.RescheduleGymDay('${selMissedToShift.dateKey}', '${selKey}')">
                  Shift ${DAY_LABELS_SHORT[selMissedToShift.dow]} &rarr; Here
                </button>
              ` : ''}
              <button class="step-btn smooth-ui ${pendingFx && pendingFx.type === 'gym-toggle' && pendingFx.dateKey === selKey ? 'fx-gym-btn-pulse' : ''}"
                      style="display:inline-flex;align-items:center;gap:6px;${selGym ? 'background:rgba(14,165,233,0.2);border-color:var(--sky-400);color:var(--sky-300);' : ''}"
                      onclick="App.ToggleGym('${selKey}')">
                <span style="width:8px;height:8px;border-radius:50%;background:${selGym ? 'var(--sky-400)' : '#475569'};"></span>
                <span>${selGym ? 'Gym Visited' : 'Mark Gym Visit'}</span>
              </button>
            </div>
          `}
        </div>

        <div class="stack-list">
          ${state.exercises.map(ex => {
            const val = getExerciseVal(selKey, ex.id);
            const dayTarget = getExerciseTargetForDate(ex, selKey);
            const tone = getMetricTone(val, dayTarget);
            const met = val >= dayTarget;
            const isDue = isExerciseDueOnDate(ex, selKey);
            const isBumpedEx = pendingFx && pendingFx.dateKey === selKey &&
              pendingFx.type === 'ex-change' && pendingFx.exId === ex.id;
            const isTargetHitEx = isBumpedEx && pendingFx.hitTarget;

            return `
              <div class="surface-inset editor-row ${isTargetHitEx ? 'fx-target-met' : ''}" style="${isDue ? '' : 'opacity:0.78;'}">
                <div style="min-width:0;">
                  <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                    <span class="ex-title">${escapeHtml(ex.name)}</span>
                    ${ex.scheduleMode === 'custom'
                      ? (isDue ? '<span class="due-badge">Due</span>' : '<span class="rest-badge">Rest</span>')
                      : ''}
                    ${dayTarget !== ex.target ? `<span class="rest-badge" title="Target active on this date">Then ${dayTarget}</span>` : ''}
                  </div>
                  <div class="tabular-nums ${tone.text}" style="font-size:0.75rem;font-weight:600;">
                    ${val} / ${dayTarget} ${escapeHtml(ex.unit)}
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
                           class="num-input ${tone.text} tabular-nums ${isBumpedEx ? 'fx-val-pop' : ''}"
                           style="text-align:center;"
                           onchange="App.SetExactExercise('${selKey}', '${ex.id}', this.value)" />
                    <button class="mini-btn tabular-nums" onclick="App.BumpExercise('${selKey}', '${ex.id}', 1)">+1</button>
                    <button class="mini-btn tabular-nums" onclick="App.BumpExercise('${selKey}', '${ex.id}', 5)">+5</button>
                    <button class="mini-btn tabular-nums"
                            style="${met ? 'background:rgba(16,185,129,0.2);border-color:rgba(16,185,129,0.5);' : ''}color:var(--emerald-400);"
                            onclick="App.SetExactExercise('${selKey}', '${ex.id}', ${dayTarget})">
                      ${dayTarget}
                    </button>
                  </div>
                `}
              </div>
            `;
          }).join('')}
        </div>
      </section>
      </div>
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
        const t = getExerciseTargetForDate(ex, k);
        const isCurrent = i === 0;
        let hex = '#EF4444';
        if (v >= t) hex = '#10B981';
        else if (v > 0) hex = '#F59E0B';
        points.push({
          short: isCurrent ? 'Tdy' : String(dt.getDate()),
          v,
          target: t,
          isCurrent,
          hex
        });
      }
      return { subtitle: 'Daily total vs. target active that day', points };
    }

    if (period === 'weekly') {
      const curMon = getMondayKey(today);
      const points = [];
      for (let w = 6; w >= 0; w--) {
        const mKey = addDays(curMon, -w * 7);
        const wkNum = getISOWeekNumber(mKey);
        let sum = 0;
        let targetSum = 0;
        let daysCount = 0;
        for (let d = 0; d < 7; d++) {
          const k = addDays(mKey, d);
          if (k <= today) {
            sum += getExerciseVal(k, ex.id);
            targetSum += getExerciseTargetForDate(ex, k);
            daysCount++;
          }
        }
        const v = daysCount > 0 ? Math.round(sum / daysCount) : 0;
        const t = daysCount > 0 ? Math.round(targetSum / daysCount) : getExerciseTargetForDate(ex, today);
        const isCurrent = w === 0;
        let hex = '#EF4444';
        if (v >= t) hex = '#10B981';
        else if (v > 0) hex = '#F59E0B';
        points.push({ short: `W${wkNum}`, v, target: t, isCurrent, hex });
      }
      return { subtitle: 'Weekly daily-avg vs. target', points };
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
        let targetSum = 0;
        let count = 0;
        for (let day = 1; day <= lastDay; day++) {
          const k = toDateKey(new Date(yr, mo, day, 12, 0, 0));
          if (k <= today && k >= state.trackingStartDate) {
            sum += getExerciseVal(k, ex.id);
            targetSum += getExerciseTargetForDate(ex, k);
            count++;
          }
        }
        const v = count > 0 ? Math.round(sum / count) : 0;
        const t = count > 0 ? Math.round(targetSum / count) : getExerciseTargetForDate(ex, today);
        const isCurrent = m === 0;
        let hex = '#EF4444';
        if (v >= t) hex = '#10B981';
        else if (v > 0) hex = '#F59E0B';
        points.push({ short, v, target: t, isCurrent, hex });
      }
      return { subtitle: 'Monthly daily-avg vs. target', points };
    }

    // 'all': Divide range from trackingStartDate to today into 7 equal buckets
    const totalDays = Math.max(7, diffDaysBetween(today, state.trackingStartDate) + 1);
    const bucketSize = Math.max(1, Math.ceil(totalDays / 7));
    const points = [];
    for (let b = 6; b >= 0; b--) {
      const endKey = addDays(today, -b * bucketSize);
      const startKey = addDays(endKey, -(bucketSize - 1));
      let sum = 0;
      let targetSum = 0;
      let count = 0;
      let cursor = startKey;
      while (cursor <= endKey && cursor <= today) {
        if (cursor >= state.trackingStartDate) {
          sum += getExerciseVal(cursor, ex.id);
          targetSum += getExerciseTargetForDate(ex, cursor);
          count++;
        }
        cursor = addDays(cursor, 1);
      }
      const v = count > 0 ? Math.round(sum / count) : 0;
      const t = count > 0 ? Math.round(targetSum / count) : getExerciseTargetForDate(ex, today);
      const isCurrent = b === 0;
      const dt = parseDateKey(endKey);
      const short = dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
      let hex = '#EF4444';
      if (v >= t) hex = '#10B981';
      else if (v > 0) hex = '#F59E0B';
      points.push({ short, v, target: t, isCurrent, hex });
    }
    return { subtitle: 'All-time progression vs. target', points };
  }

  function renderChartsScreen() {
    const today = toDateKey();
    const activeEx = state.exercises.find(e => e.id === ui.chartExerciseId) || state.exercises[0];
    const currentTarget = getExerciseTargetForDate(activeEx, today);
    const periodData = buildChartSeries(activeEx, ui.chartPeriod);
    const series = periodData.points;

    const maxVal = Math.ceil(Math.max(currentTarget * 1.25, ...series.map(s => Math.max(s.v, s.target || 0)), 10) / 10) * 10;
    const hitCount = series.filter(s => s.v >= (s.target || currentTarget)).length;
    const hitRatePct = Math.round((hitCount / Math.max(1, series.length)) * 100);
    const periodAvg = Math.round(series.reduce((acc, s) => acc + s.v, 0) / Math.max(1, series.length));
    const avgTone = getMetricTone(periodAvg, currentTarget);
    const latestVal = series[series.length - 1].v;
    const latestTarget = series[series.length - 1].target || currentTarget;
    const latestTone = getMetricTone(latestVal, latestTarget);

    // Compute All-Time Daily PR for activeEx
    let allTimePR = 0;
    Object.keys(state.logs || {}).forEach(k => {
      const val = getExerciseVal(k, activeEx.id);
      if (val > allTimePR) allTimePR = val;
    });
    const prTone = getMetricTone(allTimePR, currentTarget);
    const curMon = getMondayKey(today);
    const gymWeeks = [];
    for (let w = 5; w >= 0; w--) {
      const mKey = addDays(curMon, -w * 7);
      const gs = getWeekGymSummary(mKey);
      gymWeeks.push({
        w: `W${getISOWeekNumber(mKey)}`,
        c: gs.count,
        t: gs.target,
        met: gs.met,
        missed: gs.missedCount,
        status: gs.status,
        current: w === 0
      });
    }

    return `
      <div class="charts-split">
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
            Latest: <strong class="${latestTone.text}">${latestVal} / ${latestTarget}</strong> • Hit <strong class="text-white">${hitCount}/${series.length}</strong>
          </span>
        </div>

        ${ui.chartStyle === 'area'
          ? renderSvgCurve(series, maxVal, currentTarget)
          : renderBarsPlot(series, maxVal, currentTarget)
        }

        <!-- Row 4: Period Avg • All-Time PR • Hit Rate Summary -->
        <div style="display:grid;grid-template-columns:repeat(3, 1fr);gap:6px;margin-top:10px;">
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">Period Avg</div>
            <div class="tabular-nums ${avgTone.text}" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${periodAvg} ${escapeHtml(activeEx.unit)}</div>
          </div>
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">All-Time PR</div>
            <div class="tabular-nums ${prTone.text}" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${allTimePR} ${escapeHtml(activeEx.unit)}</div>
          </div>
          <div class="surface-inset" style="padding:6px 4px;text-align:center;">
            <div style="font-size:0.65rem;color:var(--text-slate-500);text-transform:uppercase;">Hit Rate</div>
            <div class="tabular-nums ${hitRatePct >= 80 ? 'text-emerald' : hitRatePct > 0 ? 'text-amber' : 'text-red'}" style="font-size:0.85rem;font-weight:700;margin-top:1px;">${hitRatePct}%</div>
          </div>
        </div>
      </section>

      <div class="charts-side-stack">
      <!-- All Exercises — Today Snapshot -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <span class="section-heading">All Exercises — Today Snapshot</span>
          <span class="section-sub tabular-nums">${getDueExercisesForDate(today).length}/${state.exercises.length} due today</span>
        </div>
        <div class="snapshot-grid">
          ${state.exercises.map(ex => {
            const v = getExerciseVal(today, ex.id);
            const dayTarget = getExerciseTargetForDate(ex, today);
            const due = isExerciseDueOnDate(ex, today);
            const tone = getMetricTone(v, dayTarget);
            const isSel = ex.id === activeEx.id;
            const statusText = due
              ? `${v}/${dayTarget}`
              : (v > 0 ? `${v}/${dayTarget} OPT` : 'REST');
            const statusCls = due ? tone.text : (v > 0 ? 'text-sky' : 'text-muted');
            return `
              <button class="surface-inset snapshot-tile ${isSel ? 'active' : ''} smooth-ui"
                      onclick="App.SetChartExercise('${ex.id}')">
                <span style="font-size:0.75rem;font-weight:500;color:var(--text-slate-300);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">
                  ${escapeHtml(ex.name)}
                </span>
                <span class="tabular-nums ${statusCls}" style="font-size:0.75rem;font-weight:700;">
                  ${statusText}
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
          <span class="section-sub tabular-nums">${escapeHtml(formatScheduleSummary(state.gymScheduleMode, getGymBaseDays(), state.weeklyGymTarget))}</span>
        </div>
        <div class="gym-6-grid">
          ${gymWeeks.map(wk => {
            let cls = 'gym-wk-box tabular-nums ';
            if (wk.status === 'green' || wk.met) cls += 'green';
            else if (wk.status === 'amber') cls += 'amber';
            else if (wk.status === 'none') cls += '';
            else cls += 'red';
            return `
              <div class="${cls}" title="${wk.missed > 0 ? `${wk.missed} missed scheduled day(s)` : ''}">
                <div style="font-size:0.75rem;opacity:0.85;">${wk.w}</div>
                <div style="font-size:0.875rem;font-weight:700;margin-top:2px;">${wk.c}/${wk.t}${wk.missed > 0 ? '!' : ''}</div>
              </div>
            `;
          }).join('')}
        </div>
      </section>
      </div>
      </div>
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

          <line x1="${padL}" y1="${padT}" x2="${svgW - padR}" y2="${padT}" stroke="var(--border-inset)" stroke-width="1" />
          <line x1="${padL}" y1="${padT + plotH}" x2="${svgW - padR}" y2="${padT + plotH}" stroke="var(--border-card)" stroke-width="1" />

          <text x="${padL - 5}" y="${padT + 4}" text-anchor="end" fill="#64748B" font-size="12" font-weight="600">${maxVal}</text>
          <text x="${padL - 5}" y="${targetY + 4}" text-anchor="end" fill="var(--sky-400)" font-size="12" font-weight="700">${targetVal}</text>
          <text x="${padL - 5}" y="${padT + plotH + 4}" text-anchor="end" fill="#64748B" font-size="12" font-weight="600">0</text>

          <line x1="${padL}" y1="${targetY}" x2="${svgW - padR}" y2="${targetY}" stroke="var(--sky-400)" stroke-width="1.4" stroke-dasharray="4 4" />

          <path class="chart-area-path" d="${areaD}" fill="url(#splitArea)" />
          <path class="chart-line-path" pathLength="100" d="${d}" fill="none" stroke="var(--text-slate-300)" stroke-width="2" stroke-linecap="round" />

          ${pts.map((p, idx) => `
            <circle class="chart-pt" style="animation-delay:${Math.min(360, idx * 55)}ms;" cx="${p.x}" cy="${p.y}" r="${p.isCurrent ? 4.5 : 3.5}" fill="${p.hex}" stroke="var(--bg-inset)" stroke-width="1.8" />
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
              ${series.map((s, idx) => {
                const h = Math.max(4, Math.min(95, Math.round((s.v / maxVal) * 100)));
                return `
                  <div style="flex:1;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;z-index:1;">
                    <div class="chart-bar-fill" style="width:100%;max-width:20px;height:${h}%;background:${s.hex};border-radius:2px 2px 0 0;animation-delay:${idx * 40}ms;"></div>
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

  // --- SCREEN 4: GOALS (STRICTLY FITNESS TARGETS & SCHEDULES) ---
  function renderGoalsScreen() {
    const gymDays = getGymBaseDays();
    const isGymDaily = state.gymScheduleMode === 'daily';

    return `
      <div class="goals-split">
      <!-- 1. Home Exercise Targets & Schedules -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div class="section-heading">Home Exercise Targets &amp; Schedules</div>
            <div class="section-sub">Defaults to Daily; pick Custom to set days/wk &amp; specific weekdays (${state.exercises.length} configured)</div>
          </div>
        </div>

        <div class="stack-list" style="margin-bottom:12px;">
          ${state.exercises.map((ex, idx) => {
            const isConfirming = ui.confirmRemoveExId === ex.id;
            const isMoved = pendingFx && pendingFx.type === 'goal-move' && pendingFx.exId === ex.id;
            const isDaily = ex.scheduleMode !== 'custom';
            const schedDays = getExerciseScheduleDays(ex);
            const schedCount = isDaily ? 7 : Math.max(1, Math.min(6, Number(ex.scheduleTargetCount) || schedDays.length || 3));
            const schedLabel = formatScheduleSummary(ex.scheduleMode, schedDays, schedCount);

            return `
              <div class="surface-inset goal-ex-card ${isMoved ? 'fx-row-move' : ''}">
                <div style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap;">
                  <div style="display:flex;align-items:center;gap:6px;min-width:0;">
                    <div style="display:flex;flex-direction:column;gap:2px;">
                      <button class="mini-btn" style="padding:1px 5px;font-size:0.65rem;line-height:1;"
                              ${idx === 0 ? 'disabled' : ''}
                              onclick="App.MoveExercise('${ex.id}', -1)" title="Move Up">&uarr;</button>
                      <button class="mini-btn" style="padding:1px 5px;font-size:0.65rem;line-height:1;"
                              ${idx === state.exercises.length - 1 ? 'disabled' : ''}
                              onclick="App.MoveExercise('${ex.id}', 1)" title="Move Down">&darr;</button>
                    </div>
                    <span class="ex-title" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(ex.name)}</span>
                  </div>
                  <div class="editor-controls">
                    <input type="number" min="1" value="${ex.target}"
                           class="num-input text-emerald tabular-nums"
                           style="width:64px;padding:4px 8px;"
                           onchange="App.UpdateTarget('${ex.id}', this.value)" />
                    <span class="text-muted" style="font-size:0.75rem;width:32px;">${escapeHtml(ex.unit)}</span>
                    ${isConfirming ? `
                      <button class="mini-btn" style="color:var(--red-400);border-color:rgba(239,68,68,0.5);font-weight:700;"
                              onclick="App.RemoveExercise('${ex.id}')">Confirm?</button>
                    ` : `
                      <button class="mini-btn" style="color:var(--text-slate-500);"
                              onclick="App.RemoveExercise('${ex.id}')">Remove</button>
                    `}
                  </div>
                </div>

                <div class="sched-bar">
                  <span style="font-size:0.72rem;font-weight:600;color:var(--text-slate-400);">
                    Schedule: <strong style="color:var(--emerald-400);">${escapeHtml(schedLabel)}</strong>
                  </span>
                  <div class="seg-ctrl" style="padding:2px;">
                    <button class="seg-btn ${isDaily ? 'active' : ''}"
                            onclick="App.SetExerciseScheduleMode('${ex.id}', 'daily')">Daily</button>
                    <button class="seg-btn ${!isDaily ? 'active' : ''}"
                            onclick="App.SetExerciseScheduleMode('${ex.id}', 'custom')">Custom</button>
                  </div>
                </div>

                ${!isDaily ? `
                  <div class="sched-custom-panel">
                    <div class="sched-count-row">
                      <span style="font-size:0.7rem;font-weight:600;color:var(--text-slate-400);">Days / week</span>
                      <div style="display:flex;align-items:center;gap:4px;">
                        <button class="mini-btn" style="padding:2px 7px;"
                                ${schedCount <= 1 ? 'disabled' : ''}
                                onclick="App.SetExerciseScheduleCount('${ex.id}', ${schedCount - 1})">&minus;</button>
                        <input type="number" min="1" max="7" value="${schedCount}"
                               class="num-input text-emerald tabular-nums"
                               style="width:48px;padding:2px 6px;font-size:0.75rem;"
                               onchange="App.SetExerciseScheduleCount('${ex.id}', this.value)" />
                        <button class="mini-btn" style="padding:2px 7px;"
                                onclick="App.SetExerciseScheduleCount('${ex.id}', ${schedCount + 1})" title="${schedCount >= 6 ? '7 = Daily' : 'Increase days'}">+</button>
                      </div>
                      <span class="tabular-nums text-muted" style="font-size:0.68rem;">${schedDays.length}/${schedCount} weekdays</span>
                    </div>
                    <div class="day-7-pills">
                      ${DAY_LABELS_SHORT.map((lbl, dow) => `
                        <button class="day-pill ${schedDays.includes(dow) ? 'on' : ''}"
                                onclick="App.ToggleExerciseScheduleDay('${ex.id}', ${dow})">${lbl}</button>
                      `).join('')}
                    </div>
                  </div>
                ` : ''}
              </div>
            `;
          }).join('')}
        </div>

        <div class="surface-inset" style="padding:10px;">
          <div style="font-size:0.75rem;font-weight:600;color:var(--text-slate-300);margin-bottom:8px;">Add Exercise</div>
          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            <input id="new-ex-name" type="text" class="text-input" style="flex:1;min-width:130px;"
                   placeholder="Exercise name (e.g. Pull-ups)"
                   onkeydown="if(event.key==='Enter') App.AddExercise()" />
            <input id="new-ex-target" type="number" min="1" value="30" class="text-input tabular-nums" style="width:64px;font-weight:700;"
                   onkeydown="if(event.key==='Enter') App.AddExercise()" />
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

      <!-- 2. Weekly Gym Schedule -->
      <section class="surface-card card-pad">
        <div class="card-head">
          <div>
            <div class="section-heading">Weekly Gym Schedule</div>
            <div class="section-sub">Strict accountability — pick your committed gym days (same-week shifts allowed on Today/Calendar)</div>
          </div>
          <span class="text-sky tabular-nums" style="font-size:0.75rem;font-weight:700;">${escapeHtml(formatScheduleSummary(state.gymScheduleMode, gymDays, state.weeklyGymTarget))}</span>
        </div>

        <div class="sched-bar" style="padding-top:0;border-top:none;margin-bottom:10px;">
          <span style="font-size:0.72rem;font-weight:600;color:var(--text-slate-400);">Gym Frequency</span>
          <div class="seg-ctrl" style="padding:2px;">
            <button class="seg-btn ${isGymDaily ? 'active' : ''}"
                    onclick="App.SetGymScheduleMode('daily')">Daily (7d)</button>
            <button class="seg-btn ${!isGymDaily ? 'active' : ''}"
                    onclick="App.SetGymScheduleMode('custom')">Custom</button>
          </div>
        </div>

        ${isGymDaily ? `
          <div class="surface-inset" style="padding:10px;font-size:0.75rem;color:var(--text-slate-300);">
            Committed every day (<strong class="text-sky">Sun–Sat</strong>). Switch to <strong>Custom</strong> to pick specific gym days.
          </div>
        ` : `
          <div class="sched-custom-panel" style="gap:8px;padding:10px;">
            <div class="sched-count-row">
              <span style="font-size:0.72rem;font-weight:600;color:var(--text-slate-400);">Gym days / week</span>
              <div style="display:flex;align-items:center;gap:4px;">
                <button class="mini-btn" style="padding:2px 7px;"
                        ${state.weeklyGymTarget <= 1 ? 'disabled' : ''}
                        onclick="App.SetWeeklyGymTarget(${state.weeklyGymTarget - 1})">&minus;</button>
                <input type="number" min="1" max="7" value="${state.weeklyGymTarget}"
                       class="num-input text-sky tabular-nums"
                       style="width:48px;padding:2px 6px;font-size:0.75rem;"
                       onchange="App.SetWeeklyGymTarget(this.value)" />
                <button class="mini-btn" style="padding:2px 7px;"
                        onclick="App.SetWeeklyGymTarget(${state.weeklyGymTarget + 1})" title="${state.weeklyGymTarget >= 6 ? '7 = Daily' : 'Increase days'}">+</button>
              </div>
              <span class="tabular-nums text-sky" style="font-size:0.7rem;font-weight:700;">Committed ${gymDays.length}/${state.weeklyGymTarget} days</span>
            </div>

            <div class="week-7-grid" style="margin-bottom:2px;">
              ${[1, 2, 3, 4, 5, 6, 7].map(n => `
                <button class="week-day-btn ${state.weeklyGymTarget === n ? 'visited' : ''} tabular-nums smooth-ui"
                        style="padding:5px 0;font-weight:700;"
                        onclick="App.SetWeeklyGymTarget(${n})">
                  ${n}d
                </button>
              `).join('')}
            </div>

            <div style="font-size:0.7rem;font-weight:600;color:var(--text-slate-400);">Committed Gym Weekdays</div>
            <div class="day-7-pills">
              ${DAY_LABELS_SHORT.map((lbl, dow) => `
                <button class="day-pill ${gymDays.includes(dow) ? 'gym-on' : ''}"
                        onclick="App.ToggleGymScheduleDay(${dow})">${lbl}</button>
              `).join('')}
            </div>
          </div>
        `}
      </section>
      </div>
    `;
  }

  // --- PROFILE & SETTINGS OVERLAY PANEL (SEGMENTED TWO-PANE ARCHITECTURE) ---
  function renderSettingsScreen() {
    const cloudReady = isCloudConfigured(state);
    const hasPasskey = Boolean(state.syncPasskey && state.syncPasskey.trim());
    const bioActive = Boolean(state.biometricEnabled && state.biometricCredId);
    const logKeys = Object.keys(state.logs || {});
    const totalDaysLogged = logKeys.length;
    const totalGymVisits = logKeys.filter(k => state.logs[k] && state.logs[k].gym).length;
    const streaks = computeHomeStreaks();
    const sec = ui.settingsSection || 'profile';
    const lastSyncText = state.lastSyncedAt
      ? new Date(state.lastSyncedAt).toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: '2-digit',
          minute: '2-digit'
        })
      : 'Not synced yet';

    const navItems = [
      {
        id: 'profile',
        label: 'Profile & Display',
        shortLabel: 'Profile',
        sub: `${escapeHtml((state.profileName || DEFAULT_PROFILE_NAME).trim())} • ${(state.themeMode || 'dark').toUpperCase()}`,
        icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M20 21v-2a4 4 0 0 0-3-3.87"></path><path d="M4 21v-2a4 4 0 0 1 3-3.87"></path><circle cx="12" cy="7" r="4"></circle></svg>'
      },
      {
        id: 'reminders',
        label: 'Smart Reminders',
        shortLabel: 'Alerts',
        sub: state.remindersEnabled ? `${state.morningReminderTime || '08:00'} & ${state.eveningReminderTime || '20:00'}` : 'Off',
        icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>'
      },
      {
        id: 'security',
        label: 'Security & Lock',
        shortLabel: 'Security',
        sub: bioActive ? 'Biometrics' : hasPasskey ? 'Passkey' : 'Setup',
        icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><rect x="4" y="11" width="16" height="10" rx="1"></rect><path d="M8 11V7a4 4 0 0 1 8 0v4"></path></svg>'
      },
      {
        id: 'sync',
        label: 'Cloud Sync',
        shortLabel: 'Sync',
        sub: cloudReady ? (state.syncProvider === 'gist' ? 'Gist' : 'Drive') : 'Local',
        icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path></svg>'
      },
      {
        id: 'data',
        label: 'Data & Reset',
        shortLabel: 'Data',
        sub: `${totalDaysLogged}d logged`,
        icon: '<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="square"><ellipse cx="12" cy="5" rx="9" ry="3"></ellipse><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"></path><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"></path></svg>'
      }
    ];

    let contentHtml = '';

    if (sec === 'profile') {
      contentHtml = `
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Athlete Identity &amp; Overview</div>
              <div class="section-sub tabular-nums">Tracking since ${formatMonthDayYear(state.trackingStartDate || toDateKey())}</div>
            </div>
            ${ui.deferredInstallPrompt ? `
              <button class="step-btn smooth-ui" style="color:var(--emerald-400);border-color:rgba(16,185,129,0.45);"
                      onclick="App.PromptInstallApp()">
                Install App
              </button>
            ` : ''}
          </div>

          <div style="display:flex;flex-wrap:wrap;gap:6px;">
            <input id="profile-name-input" type="text" class="text-input" style="flex:1;min-width:160px;"
                   placeholder="Display Name / Handle"
                   value="${escapeHtml(state.profileName || DEFAULT_PROFILE_NAME)}"
                   onkeydown="if(event.key==='Enter') App.SaveProfileName()" />
            <button class="primary-btn smooth-ui" onclick="App.SaveProfileName()">Update Profile</button>
          </div>

          <div class="profile-stat-grid">
            <div class="surface-inset" style="padding:8px;text-align:center;">
              <div style="font-size:0.7rem;color:var(--text-slate-500);text-transform:uppercase;">Days Logged</div>
              <div class="tabular-nums text-white" style="font-size:0.95rem;font-weight:700;margin-top:2px;">${totalDaysLogged}</div>
            </div>
            <div class="surface-inset" style="padding:8px;text-align:center;">
              <div style="font-size:0.7rem;color:var(--text-slate-500);text-transform:uppercase;">Gym Visits</div>
              <div class="tabular-nums text-sky" style="font-size:0.95rem;font-weight:700;margin-top:2px;">${totalGymVisits}</div>
            </div>
            <div class="surface-inset" style="padding:8px;text-align:center;">
              <div style="font-size:0.7rem;color:var(--text-slate-500);text-transform:uppercase;">Best Streak</div>
              <div class="tabular-nums text-emerald" style="font-size:0.95rem;font-weight:700;margin-top:2px;">${streaks.best}d</div>
            </div>
          </div>
        </section>

        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Appearance &amp; Theme Mode</div>
              <div class="section-sub">Choose Dark, Light, or System Default</div>
            </div>
            <span class="text-sky" style="font-size:0.75rem;font-weight:600;text-transform:uppercase;">${escapeHtml(state.themeMode || 'dark')}</span>
          </div>
          <div class="segmented-pair" style="display:grid;grid-template-columns:repeat(3, 1fr);">
            <button class="seg-btn ${(state.themeMode || 'dark') === 'dark' ? 'active' : ''} smooth-ui" onclick="App.SetThemeMode('dark')">Dark</button>
            <button class="seg-btn ${state.themeMode === 'light' ? 'active' : ''} smooth-ui" onclick="App.SetThemeMode('light')">Light</button>
            <button class="seg-btn ${state.themeMode === 'system' ? 'active' : ''} smooth-ui" onclick="App.SetThemeMode('system')">System</button>
          </div>
        </section>
      `;
    } else if (sec === 'reminders') {
      contentHtml = `
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Goal-Aware Notification Schedule</div>
              <div class="section-sub">Morning check-in and evening accountability alerts</div>
            </div>
            <button class="step-btn smooth-ui"
                    style="${state.remindersEnabled ? 'border-color:var(--emerald-500);color:var(--emerald-400);' : ''}"
                    onclick="App.ToggleReminders()">
              ${state.remindersEnabled ? 'Reminders: ON' : 'Enable Reminders'}
            </button>
          </div>

          <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:8px;margin-bottom:8px;">
            <div class="surface-inset" style="padding:8px;">
              <div style="font-size:0.7rem;color:var(--text-slate-400);text-transform:uppercase;margin-bottom:4px;">Morning Check-In</div>
              <input id="rem-morning-input" type="time" class="text-input tabular-nums" style="width:100%;font-weight:700;"
                     value="${escapeHtml(state.morningReminderTime || '08:00')}"
                     onchange="App.SaveReminderSchedule()" />
            </div>
            <div class="surface-inset" style="padding:8px;">
              <div style="font-size:0.7rem;color:var(--text-slate-400);text-transform:uppercase;margin-bottom:4px;">Evening Accountability</div>
              <input id="rem-evening-input" type="time" class="text-input tabular-nums" style="width:100%;font-weight:700;"
                     value="${escapeHtml(state.eveningReminderTime || '20:00')}"
                     onchange="App.SaveReminderSchedule()" />
            </div>
          </div>

          <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:6px;">
            <button class="step-btn smooth-ui" onclick="App.SaveReminderSchedule()">Save Schedule</button>
            <button class="step-btn smooth-ui" style="color:var(--sky-400);" onclick="App.TestReminderNow()">Test Alert Now</button>
          </div>
        </section>

        <details class="settings-accordion">
          <summary class="settings-accordion-summary">
            <span>How Smart Reminders Work</span>
            <span class="accordion-chevron">&#9662;</span>
          </summary>
          <div class="settings-accordion-body">
            <div class="section-sub" style="line-height:1.5;">
              Notifications stay completely silent once your daily home targets are met (or when your weekly gym quota is on track). You only get nudged in the morning or evening when targets remain unfinished so alerts stay actionable rather than noisy.
            </div>
          </div>
        </details>
      `;
    } else if (sec === 'security') {
      contentHtml = `
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Device Biometric Unlock</div>
              <div class="section-sub">Face ID, Touch ID, Fingerprint, or Windows Hello</div>
            </div>
            <span class="${bioActive ? 'text-emerald' : 'text-amber'}" style="font-size:0.75rem;font-weight:600;">
              ${bioActive ? 'Biometrics Active' : 'Not Enrolled'}
            </span>
          </div>

          <div style="display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:8px;">
            <button class="primary-btn smooth-ui"
                    style="${bioActive ? 'background-color:var(--bg-inset);border:1px solid var(--emerald-500);color:var(--emerald-400);' : ''}"
                    onclick="App.ToggleBiometricAuth()">
              ${bioActive ? 'Biometrics: ON (Disable)' : 'Enable Biometric Unlock'}
            </button>

            <button class="step-btn smooth-ui"
                    style="${state.appLockEnabled ? 'border-color:var(--emerald-500);color:var(--emerald-400);' : ''}"
                    onclick="App.ToggleAppLock()">
              Require on Startup: ${state.appLockEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </section>

        <details class="settings-accordion" ${!bioActive ? 'open' : ''}>
          <summary class="settings-accordion-summary">
            <span>Secret Passkey / PIN (Fallback &amp; Cloud Sync Key)</span>
            <span class="accordion-chevron">&#9662;</span>
          </summary>
          <div class="settings-accordion-body">
            <div class="security-note-box">
              Static GitHub Pages only serves the UI shell — visitors with the public link only see their own isolated browser storage and <strong>cannot</strong> access or overwrite your data without your Secret Passkey or GitHub Token.
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;">
              <input id="sec-passkey-input" type="password" class="text-input" style="flex:1;min-width:160px;"
                     placeholder="Set Secret Passkey / PIN"
                     value="${escapeHtml(state.syncPasskey || '')}" />
              <button class="primary-btn smooth-ui" onclick="App.SavePasskeyOnly()">Save Passkey</button>
            </div>
          </div>
        </details>
      `;
    } else if (sec === 'sync') {
      contentHtml = `
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Cloud Sync Provider &amp; Connection</div>
              <div class="section-sub tabular-nums">Last Synced: ${escapeHtml(lastSyncText)}</div>
            </div>
            <span class="${cloudReady ? 'text-emerald' : 'text-muted'}" style="font-size:0.75rem;font-weight:600;">
              ${cloudReady ? (state.syncProvider === 'gist' ? 'Private Gist Ready' : 'Drive Auth Ready') : 'Local Only'}
            </span>
          </div>

          <div class="period-4-grid" style="grid-template-columns:repeat(2, 1fr);margin-bottom:10px;">
            <button class="seg-btn ${state.syncProvider === 'gist' ? 'active' : ''} smooth-ui"
                    onclick="App.SetSyncProvider('gist')">
              Private GitHub Gist
            </button>
            <button class="seg-btn ${state.syncProvider === 'gdrive' ? 'active' : ''} smooth-ui"
                    onclick="App.SetSyncProvider('gdrive')">
              Google Drive (Passkey)
            </button>
          </div>

          ${state.syncProvider === 'gist' ? `
            <div class="security-note-box">
              <strong>100% Private (No "Anyone" setting):</strong> Uses your GitHub Personal Access Token (<code>gist</code> scope, stored locally) to sync <code>fitness-tracker-data.json</code> over <code>Authorization: Bearer</code>.
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
              <strong>Passkey-Verified Google Drive Sync:</strong> Every <code>GET</code> &amp; <code>POST</code> request verifies your Secret Passkey from <strong>Security &amp; Lock</strong> inside your Apps Script.
            </div>
            <div style="display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px;">
              <input id="sync-url-input" type="url" class="text-input" style="flex:1;min-width:200px;"
                     placeholder="Paste Google Apps Script Web App URL (https://script.google.com/macros/s/.../exec)"
                     value="${escapeHtml(state.syncUrl || '')}" />
              <button class="primary-btn smooth-ui" onclick="App.SaveSyncUrl()">Save</button>
            </div>
          `}

          <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:6px;">
            <button class="step-btn" onclick="App.PushDriveManual()">Sync Now</button>
            <button class="step-btn" onclick="App.PullDriveManual()">Pull Cloud</button>
          </div>
        </section>

        <details class="settings-accordion">
          <summary class="settings-accordion-summary">
            <span>Google Apps Script Setup &amp; Protected Script Code</span>
            <span class="accordion-chevron">&#9662;</span>
          </summary>
          <div class="settings-accordion-body">
            <div class="section-sub" style="margin-bottom:10px;line-height:1.5;">
              1. Set your Secret Passkey in <strong>Security &amp; Lock</strong>.<br />
              2. Copy the pre-filled script below into <strong>script.google.com</strong>, deploy as a Web App (<em>Execute as: Me</em>), and paste the <code>/exec</code> URL above.
            </div>
            <button class="step-btn smooth-ui" style="width:100%;" onclick="App.CopyDriveScript()">Copy Protected Script</button>
          </div>
        </details>
      `;
    } else {
      contentHtml = `
        <section class="surface-card card-pad">
          <div class="card-head">
            <div>
              <div class="section-heading">Manual JSON Backup &amp; Restore</div>
              <div class="section-sub">Export a local snapshot or import an existing backup</div>
            </div>
          </div>
          <div style="display:grid;grid-template-columns:repeat(2, 1fr);gap:6px;">
            <button class="step-btn" onclick="App.ExportJson()">Export JSON Backup</button>
            <label class="step-btn" style="text-align:center;cursor:pointer;">
              Import JSON Backup
              <input type="file" accept=".json" style="display:none;" onchange="App.ImportJson(event)" />
            </label>
          </div>
        </section>

        <details class="settings-accordion danger-accordion" ${ui.showResetConfirm ? 'open' : ''}>
          <summary class="settings-accordion-summary" style="color:var(--red-400);">
            <span>Danger Zone — Wipe All Entries</span>
            <span class="accordion-chevron">&#9662;</span>
          </summary>
          <div class="settings-accordion-body">
            <div class="section-sub tabular-nums" style="margin-bottom:8px;">
              Permanently deletes all ${totalDaysLogged} logged days and restarts tracking from Today.
            </div>
            ${!ui.showResetConfirm ? `
              <button class="step-btn smooth-ui" style="color:var(--red-400);border-color:rgba(239,68,68,0.4);" onclick="App.OpenResetConfirm()">
                Unlock Reset...
              </button>
            ` : `
              <div class="danger-confirm-box" style="margin-top:0;">
                <div style="font-size:0.75rem;color:var(--text-slate-200);font-weight:600;margin-bottom:8px;">
                  Security Verification Required: Type <code class="text-red">RESET</code> ${hasPasskey ? 'and enter your Secret Passkey' : ''} to permanently wipe all entries.
                </div>
                <div style="display:flex;flex-wrap:wrap;gap:6px;">
                  <input id="reset-confirm-word" type="text" class="text-input" style="flex:1;min-width:130px;"
                         placeholder="Type RESET in all caps" />
                  ${hasPasskey ? `
                    <input id="reset-confirm-passkey" type="password" class="text-input" style="flex:1;min-width:130px;"
                           placeholder="Enter Secret Passkey" />
                  ` : ''}
                  <button class="danger-btn smooth-ui" onclick="App.ConfirmWipeAllData()">
                    Confirm Permanent Wipe
                  </button>
                  <button class="step-btn smooth-ui" onclick="App.CancelResetConfirm()">
                    Cancel
                  </button>
                </div>
              </div>
            `}
          </div>
        </details>
      `;
    }

    return `
      <div class="settings-drawer" onclick="event.stopPropagation()">
        <div class="settings-drawer-header">
          <div>
            <div class="brand-name" style="font-size:0.85rem;">SETTINGS &amp; ACCOUNT</div>
            <div class="section-sub">Segmented configuration &amp; device preferences</div>
          </div>
          <button class="step-btn smooth-ui" onclick="App.CloseSettings()">&#10005; Close</button>
        </div>

        <div class="settings-split-layout">
          <nav class="settings-side-nav">
            ${navItems.map(item => `
              <button class="settings-nav-btn smooth-ui ${sec === item.id ? 'active' : ''}"
                      data-settings-tab="${item.id}"
                      onclick="App.SetSettingsSection('${item.id}')">
                <span class="settings-nav-icon">${item.icon}</span>
                <span class="settings-nav-text">
                  <span class="settings-nav-label settings-nav-label-full">${item.label}</span>
                  <span class="settings-nav-label settings-nav-label-short">${item.shortLabel}</span>
                  <span class="settings-nav-sub tabular-nums">${item.sub}</span>
                </span>
              </button>
            `).join('')}
          </nav>

          <div class="settings-content-pane">
            ${contentHtml}
          </div>
        </div>
      </div>
    `;
  }

  let lastRenderedSettingsSection = null;

  function renderSettingsOverlay() {
    const overlay = document.getElementById('settings-overlay');
    if (!overlay) return;
    if (!ui.settingsOpen) {
      if (wasSettingsOpen && overlay.style.display !== 'none') {
        wasSettingsOpen = false;
        overlay.classList.remove('overlay-enter');
        overlay.classList.add('overlay-exit');
        const drawer = overlay.querySelector('.settings-drawer');
        if (drawer) {
          drawer.classList.remove('drawer-enter');
          drawer.classList.add('drawer-exit');
        }
        if (settingsCloseTimer) clearTimeout(settingsCloseTimer);
        settingsCloseTimer = setTimeout(() => {
          settingsCloseTimer = null;
          if (!ui.settingsOpen) {
            overlay.style.display = 'none';
            overlay.innerHTML = '';
            overlay.classList.remove('overlay-exit');
            lastRenderedSettingsSection = null;
          }
        }, 285);
      } else {
        wasSettingsOpen = false;
        overlay.style.display = 'none';
        overlay.innerHTML = '';
        overlay.classList.remove('overlay-exit');
        lastRenderedSettingsSection = null;
      }
      return;
    }

    if (settingsCloseTimer) {
      clearTimeout(settingsCloseTimer);
      settingsCloseTimer = null;
    }
    const isOpeningNow = !wasSettingsOpen || overlay.style.display === 'none';
    const currentSec = ui.settingsSection || 'profile';
    const isSectionSwitch = wasSettingsOpen && lastRenderedSettingsSection && lastRenderedSettingsSection !== currentSec;
    wasSettingsOpen = true;

    const prevNav = overlay.querySelector('.settings-side-nav');
    const prevPane = overlay.querySelector('.settings-content-pane');
    const prevNavLeft = prevNav ? prevNav.scrollLeft : 0;
    const prevNavTop = prevNav ? prevNav.scrollTop : 0;
    const sameSection = lastRenderedSettingsSection === currentSec;
    const prevPaneTop = (sameSection && prevPane) ? prevPane.scrollTop : 0;

    overlay.classList.remove('overlay-exit');
    if (isOpeningNow) overlay.classList.add('overlay-enter');
    else overlay.classList.remove('overlay-enter');

    overlay.style.display = 'flex';
    overlay.innerHTML = renderSettingsScreen();
    lastRenderedSettingsSection = currentSec;

    const nextDrawer = overlay.querySelector('.settings-drawer');
    if (nextDrawer && isOpeningNow) {
      nextDrawer.classList.add('drawer-enter');
    }

    const nextNav = overlay.querySelector('.settings-side-nav');
    if (nextNav) {
      nextNav.scrollLeft = prevNavLeft;
      nextNav.scrollTop = prevNavTop;
      const activeBtn = nextNav.querySelector('.settings-nav-btn.active');
      if (activeBtn && typeof activeBtn.scrollIntoView === 'function') {
        activeBtn.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      }
    }
    const nextPane = overlay.querySelector('.settings-content-pane');
    if (nextPane) {
      if (sameSection) {
        nextPane.scrollTop = prevPaneTop;
      } else if (isSectionSwitch) {
        triggerPopClass(nextPane, 'pane-enter');
      }
    }
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
    renderSettingsOverlay();
    const main = document.getElementById('main-view');
    if (!main) return;

    const prevWidths = {};
    if (ui.screen === 'today' && lastRenderedScreen === 'today' && lastRenderedActiveDate === ui.activeDate) {
      main.querySelectorAll('.progress-fill[data-ex-id]').forEach(el => {
        const id = el.getAttribute('data-ex-id');
        if (id) prevWidths[id] = el.style.width || '0%';
      });
    }

    if (ui.screen === 'calendar') main.innerHTML = renderCalendarScreen();
    else if (ui.screen === 'charts') main.innerHTML = renderChartsScreen();
    else if (ui.screen === 'goals') main.innerHTML = renderGoalsScreen();
    else {
      ui.screen = 'today';
      main.innerHTML = renderTodayScreen();
    }

    if (ui.screen !== lastRenderedScreen) {
      const tabOrder = ['today', 'calendar', 'charts', 'goals'];
      const prevIdx = tabOrder.indexOf(lastRenderedScreen);
      const nextIdx = tabOrder.indexOf(ui.screen);
      main.classList.remove('fx-screen-right', 'fx-screen-left');
      void main.offsetWidth;
      main.classList.add(nextIdx >= prevIdx ? 'fx-screen-right' : 'fx-screen-left');
    } else {
      main.classList.remove('fx-screen-right', 'fx-screen-left');
    }

    if (Object.keys(prevWidths).length > 0) {
      const fills = main.querySelectorAll('.progress-fill[data-ex-id]');
      const animateList = [];
      fills.forEach(el => {
        const id = el.getAttribute('data-ex-id');
        const targetPct = el.getAttribute('data-target-pct');
        if (id && prevWidths[id] !== undefined && targetPct !== null) {
          const oldW = prevWidths[id];
          const newW = `${targetPct}%`;
          if (oldW !== newW) {
            el.style.transition = 'none';
            el.style.width = oldW;
            animateList.push({ el, newW });
          }
        }
      });
      if (animateList.length > 0) {
        void main.offsetWidth;
        animateList.forEach(({ el, newW }) => {
          el.style.transition = '';
          el.style.width = newW;
        });
      }
    }

    lastRenderedScreen = ui.screen;
    lastRenderedActiveDate = ui.activeDate;
    pendingFx = null;

    ['today', 'calendar', 'charts', 'goals'].forEach(s => {
      const btn = document.getElementById('dock-' + s);
      if (btn) {
        btn.className = `nav-tab-btn smooth-ui ${ui.screen === s ? 'active' : ''}`;
      }
    });
  }

  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && ui.settingsOpen) {
      captureSettingsInputsIntoState();
      ui.settingsOpen = false;
      ui.showResetConfirm = false;
      render();
    }
  });

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    ui.deferredInstallPrompt = e;
    if (ui.settingsOpen) render();
  });

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js?v=20').then((reg) => {
        if (reg && reg.update) reg.update();
      }).catch(() => {});
    });
  }

  function isUserTypingInInput() {
    const active = document.activeElement;
    if (!active || !active.tagName) return false;
    return ['INPUT', 'SELECT', 'TEXTAREA'].includes(active.tagName.toUpperCase());
  }

  window.addEventListener('DOMContentLoaded', () => {
    render();
    checkScheduledReminders();
    if (isCloudConfigured(state)) {
      pullFromCloud({ silent: true, onlyIfNewer: true });
    }
    if (isSessionLocked && state.biometricEnabled && state.biometricCredId) {
      setTimeout(() => verifyDeviceBiometrics(true), 180);
    }
  });

  // Automatically sync across PC & Phone whenever tab/app gains focus or every 10s
  window.addEventListener('focus', () => {
    checkScheduledReminders();
    if (isCloudConfigured(state) && !isUserTypingInInput()) {
      pullFromCloud({ silent: true, onlyIfNewer: true });
    }
  });

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      checkScheduledReminders();
      if (isCloudConfigured(state) && !isUserTypingInInput()) {
        pullFromCloud({ silent: true, onlyIfNewer: true });
      }
    }
  });

  setInterval(() => {
    checkScheduledReminders();
    if (document.visibilityState === 'visible' && isCloudConfigured(state) && !isUserTypingInInput()) {
      pullFromCloud({ silent: true, onlyIfNewer: true });
    }
  }, 10000);

  return {
    SetScreen(scr) {
      if (scr === 'settings') {
        ui.settingsOpen = true;
      } else {
        ui.screen = scr;
        ui.settingsOpen = false;
      }
      ui.showResetConfirm = false;
      ui.confirmRemoveExId = null;
      render();
    },
    OpenSettings(sec) {
      if (sec) ui.settingsSection = sec;
      ui.settingsOpen = true;
      ui.showResetConfirm = false;
      render();
    },
    CloseSettings() {
      captureSettingsInputsIntoState();
      ui.settingsOpen = false;
      ui.showResetConfirm = false;
      render();
    },
    ToggleSettings(sec) {
      if (ui.settingsOpen) {
        captureSettingsInputsIntoState();
      } else if (sec) {
        ui.settingsSection = sec;
      }
      ui.settingsOpen = !ui.settingsOpen;
      ui.showResetConfirm = false;
      render();
    },
    SetSettingsSection(sec) {
      captureSettingsInputsIntoState();
      ui.settingsSection = sec;
      ui.showResetConfirm = false;
      render();
    },
    StepActiveDate(delta) {
      const today = toDateKey();
      const oldest = addDays(today, -EDIT_WINDOW_DAYS);
      const next = addDays(ui.activeDate, delta);
      if (next >= oldest && next <= today) {
        ui.activeDate = next;
        pendingFx = { type: 'date-step', dir: delta };
        render();
      }
    },
    JumpToToday() {
      pendingFx = { type: 'date-step', dir: 1 };
      ui.activeDate = toDateKey();
      render();
    },
    CompleteAllForDate(dateKey) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const dueExercises = getDueExercisesForDate(dateKey);
      if (dueExercises.length === 0) {
        showToast('Rest day — no scheduled exercises due');
        return;
      }
      const log = getDayLog(dateKey);
      const hitIds = [];
      dueExercises.forEach(ex => {
        const dayTarget = getExerciseTargetForDate(ex, dateKey);
        stampLogTargetForDate(log, ex, dateKey);
        const cur = Number(log.exercises[ex.id]) || 0;
        if (cur < dayTarget) {
          log.exercises[ex.id] = dayTarget;
          hitIds.push(ex.id);
        }
      });
      pendingFx = { type: 'complete-all', dateKey, hitIds };
      saveState(true);
      showToast(`All ${dueExercises.length} due target${dueExercises.length === 1 ? '' : 's'} marked complete`);
    },
    BumpExercise(dateKey, exId, delta) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const log = getDayLog(dateKey);
      const prevVal = Number(log.exercises[exId]) || 0;
      const nextVal = Math.max(0, prevVal + delta);
      log.exercises[exId] = nextVal;
      const exObj = state.exercises.find(e => e.id === exId);
      const dayTarget = exObj ? getExerciseTargetForDate(exObj, dateKey) : 1;
      if (exObj) stampLogTargetForDate(log, exObj, dateKey);
      const hitTarget = Boolean(exObj && prevVal < dayTarget && nextVal >= dayTarget);
      pendingFx = { type: 'ex-change', exId, dateKey, hitTarget };
      saveState(true);
    },
    SetExactExercise(dateKey, exId, val) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const log = getDayLog(dateKey);
      const prevVal = Number(log.exercises[exId]) || 0;
      const nextVal = Math.max(0, Number(val) || 0);
      log.exercises[exId] = nextVal;
      const exObj = state.exercises.find(e => e.id === exId);
      const dayTarget = exObj ? getExerciseTargetForDate(exObj, dateKey) : 1;
      if (exObj) stampLogTargetForDate(log, exObj, dateKey);
      const hitTarget = Boolean(exObj && prevVal < dayTarget && nextVal >= dayTarget);
      pendingFx = { type: 'ex-change', exId, dateKey, hitTarget };
      saveState(true);
    },
    ToggleGym(dateKey) {
      if (isDateLocked(dateKey)) {
        showToast('Locked: entries older than 7 days cannot be edited');
        return;
      }
      const log = getDayLog(dateKey);
      log.gym = !log.gym;
      pendingFx = { type: 'gym-toggle', dateKey };
      saveState(true);
    },
    StepCalMonth(delta) {
      const d = new Date(ui.calYear, ui.calMonth + delta, 1);
      ui.calYear = d.getFullYear();
      ui.calMonth = d.getMonth();
      pendingFx = { type: 'cal-month', dir: delta };
      render();
    },
    JumpCalToToday() {
      const now = new Date();
      ui.calYear = now.getFullYear();
      ui.calMonth = now.getMonth();
      ui.selectedCalDate = toDateKey(now);
      pendingFx = { type: 'cal-select', dateKey: ui.selectedCalDate };
      render();
    },
    SelectCalDate(dateKey) {
      if (dateKey <= toDateKey()) {
        ui.selectedCalDate = dateKey;
        pendingFx = { type: 'cal-select', dateKey };
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
        const prevTarget = Math.max(1, Number(ex.target) || 1);
        const nextTarget = Math.max(1, Number(val) || 1);
        recordTargetChange(exId, prevTarget, nextTarget, toDateKey());
        ex.target = nextTarget;
        saveState(true);
        showToast(`Updated ${ex.name} target to ${ex.target} ${ex.unit} (from Today forward)`);
      }
    },
    MoveExercise(id, delta) {
      const idx = state.exercises.findIndex(e => e.id === id);
      if (idx < 0) return;
      const nextIdx = idx + delta;
      if (nextIdx < 0 || nextIdx >= state.exercises.length) return;
      const copy = [...state.exercises];
      const [moved] = copy.splice(idx, 1);
      copy.splice(nextIdx, 0, moved);
      state.exercises = copy;
      ui.confirmRemoveExId = null;
      pendingFx = { type: 'goal-move', exId: id };
      saveState(true);
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
      state.exercises.push({
        id,
        name,
        target,
        unit,
        scheduleMode: 'daily',
        scheduleTargetCount: 7,
        scheduleDays: [0, 1, 2, 3, 4, 5, 6]
      });
      if (!state.targetHistory || typeof state.targetHistory !== 'object') {
        state.targetHistory = {};
      }
      state.targetHistory[id] = [{ date: toDateKey(), target }];
      ui.confirmRemoveExId = null;
      pendingFx = { type: 'goal-move', exId: id };
      saveState(true);
      showToast(`Added ${name} (${target} ${unit} • Daily)`);
    },
    RemoveExercise(id) {
      if (state.exercises.length <= 1) {
        showToast('Keep at least 1 daily exercise');
        return;
      }
      if (ui.confirmRemoveExId !== id) {
        ui.confirmRemoveExId = id;
        render();
        showToast('Tap Confirm? to remove exercise');
        return;
      }
      ui.confirmRemoveExId = null;
      state.exercises = state.exercises.filter(e => e.id !== id);
      if (state.targetHistory && state.targetHistory[id]) {
        delete state.targetHistory[id];
      }
      if (ui.chartExerciseId === id) {
        ui.chartExerciseId = state.exercises[0].id;
      }
      saveState(true);
      showToast('Exercise removed');
    },
    SetExerciseScheduleMode(exId, mode) {
      const ex = state.exercises.find(e => e.id === exId);
      if (!ex) return;
      if (mode === 'daily') {
        ex.scheduleMode = 'daily';
        ex.scheduleTargetCount = 7;
        ex.scheduleDays = [0, 1, 2, 3, 4, 5, 6];
        saveState(true);
        showToast(`${ex.name}: Daily schedule`);
      } else {
        const cnt = (ex.scheduleTargetCount >= 1 && ex.scheduleTargetCount <= 6) ? ex.scheduleTargetCount : 3;
        const base = (Array.isArray(ex.scheduleDays) && ex.scheduleDays.length < 7)
          ? ex.scheduleDays
          : defaultDaysForCount(cnt);
        ex.scheduleMode = 'custom';
        ex.scheduleTargetCount = cnt;
        ex.scheduleDays = normalizeDaysList(base, cnt).slice(0, cnt);
        while (ex.scheduleDays.length < cnt) {
          const next = DEFAULT_CUSTOM_PATTERN.find(d => !ex.scheduleDays.includes(d));
          if (next === undefined) break;
          ex.scheduleDays.push(next);
        }
        saveState(true);
        showToast(`${ex.name}: Custom ${formatScheduleSummary('custom', ex.scheduleDays, cnt)}`);
      }
    },
    SetExerciseScheduleCount(exId, count) {
      const ex = state.exercises.find(e => e.id === exId);
      if (!ex) return;
      const raw = Math.round(Number(count) || 3);
      if (raw >= 7) {
        App.SetExerciseScheduleMode(exId, 'daily');
        return;
      }
      const c = Math.max(1, Math.min(6, raw));
      const base = (ex.scheduleMode === 'custom' && Array.isArray(ex.scheduleDays) && ex.scheduleDays.length < 7)
        ? ex.scheduleDays
        : defaultDaysForCount(c);
      const nextDays = normalizeDaysList(base, c).slice(0, c);
      while (nextDays.length < c) {
        const next = DEFAULT_CUSTOM_PATTERN.find(d => !nextDays.includes(d));
        if (next === undefined) break;
        nextDays.push(next);
      }
      ex.scheduleMode = 'custom';
      ex.scheduleTargetCount = c;
      ex.scheduleDays = nextDays;
      saveState(true);
      showToast(`${ex.name}: ${c}d/wk (${nextDays.slice().sort((a, b) => a - b).map(d => DAY_LABELS_SHORT[d]).join(', ')})`);
    },
    ToggleExerciseScheduleDay(exId, dow) {
      const ex = state.exercises.find(e => e.id === exId);
      if (!ex) return;
      const d = Number(dow);
      if (!Number.isInteger(d) || d < 0 || d > 6) return;
      const targetCount = Math.max(1, Math.min(6, Number(ex.scheduleTargetCount) || 3));
      let days = (ex.scheduleMode === 'custom' && Array.isArray(ex.scheduleDays))
        ? normalizeDaysList(ex.scheduleDays, targetCount)
        : defaultDaysForCount(targetCount);
      if (days.includes(d)) {
        if (days.length <= 1) {
          showToast('Keep at least 1 scheduled day');
          return;
        }
        days = days.filter(x => x !== d);
      } else {
        while (days.length >= targetCount) days.shift();
        days.push(d);
      }
      ex.scheduleMode = 'custom';
      ex.scheduleTargetCount = targetCount;
      ex.scheduleDays = days;
      saveState(true);
    },
    SetGymScheduleMode(mode) {
      const prevRule = {
        mode: state.gymScheduleMode,
        target: state.weeklyGymTarget,
        days: [...(state.gymScheduleDays || [])]
      };
      if (mode === 'daily') {
        state.gymScheduleMode = 'daily';
        state.weeklyGymTarget = 7;
        state.gymScheduleDays = [0, 1, 2, 3, 4, 5, 6];
        recordGymRuleChange(prevRule);
        saveState(true);
        showToast('Gym schedule: Daily (7d/wk)');
      } else {
        const cnt = (state.weeklyGymTarget >= 1 && state.weeklyGymTarget <= 6) ? state.weeklyGymTarget : 4;
        const base = (Array.isArray(state.gymScheduleDays) && state.gymScheduleDays.length < 7)
          ? state.gymScheduleDays
          : defaultDaysForCount(cnt);
        const nextDays = normalizeDaysList(base, cnt).slice(0, cnt);
        while (nextDays.length < cnt) {
          const next = DEFAULT_CUSTOM_PATTERN.find(d => !nextDays.includes(d));
          if (next === undefined) break;
          nextDays.push(next);
        }
        state.gymScheduleMode = 'custom';
        state.weeklyGymTarget = cnt;
        state.gymScheduleDays = nextDays;
        recordGymRuleChange(prevRule);
        saveState(true);
        showToast(`Gym schedule: ${formatScheduleSummary('custom', nextDays, cnt)}`);
      }
    },
    SetWeeklyGymTarget(n) {
      const raw = Math.round(Number(n) || 4);
      if (raw >= 7) {
        App.SetGymScheduleMode('daily');
        return;
      }
      const prevRule = {
        mode: state.gymScheduleMode,
        target: state.weeklyGymTarget,
        days: [...(state.gymScheduleDays || [])]
      };
      const c = Math.max(1, Math.min(6, raw));
      const base = (state.gymScheduleMode === 'custom' && Array.isArray(state.gymScheduleDays) && state.gymScheduleDays.length < 7)
        ? state.gymScheduleDays
        : defaultDaysForCount(c);
      const nextDays = normalizeDaysList(base, c).slice(0, c);
      while (nextDays.length < c) {
        const next = DEFAULT_CUSTOM_PATTERN.find(d => !nextDays.includes(d));
        if (next === undefined) break;
        nextDays.push(next);
      }
      state.gymScheduleMode = 'custom';
      state.weeklyGymTarget = c;
      state.gymScheduleDays = nextDays;
      recordGymRuleChange(prevRule);
      saveState(true);
      showToast(`Weekly gym schedule: ${formatScheduleSummary('custom', nextDays, c)}`);
    },
    ToggleGymScheduleDay(dow) {
      const d = Number(dow);
      if (!Number.isInteger(d) || d < 0 || d > 6) return;
      const prevRule = {
        mode: state.gymScheduleMode,
        target: state.weeklyGymTarget,
        days: [...(state.gymScheduleDays || [])]
      };
      const targetCount = Math.max(1, Math.min(6, Number(state.weeklyGymTarget) || 4));
      let days = (state.gymScheduleMode === 'custom' && Array.isArray(state.gymScheduleDays))
        ? normalizeDaysList(state.gymScheduleDays, targetCount)
        : defaultDaysForCount(targetCount);
      if (days.includes(d)) {
        if (days.length <= 1) {
          showToast('Keep at least 1 scheduled gym day');
          return;
        }
        days = days.filter(x => x !== d);
      } else {
        while (days.length >= targetCount) days.shift();
        days.push(d);
      }
      state.gymScheduleMode = 'custom';
      state.weeklyGymTarget = targetCount;
      state.gymScheduleDays = days;
      recordGymRuleChange(prevRule);
      saveState(true);
    },
    RescheduleGymDay(fromDate, toDate) {
      if (!fromDate || !toDate || fromDate === toDate) return;
      const today = toDateKey();
      if (diffDaysBetween(today, fromDate) > EDIT_WINDOW_DAYS || diffDaysBetween(today, toDate) > EDIT_WINDOW_DAYS) {
        showToast('Locked: entries older than 7 days cannot be rescheduled');
        return;
      }
      const monKey = getMondayKey(fromDate);
      if (monKey !== getMondayKey(toDate)) {
        showToast('Gym reschedules must stay within the same Sun–Sat week');
        return;
      }
      const weekGym = getWeekGymSummary(monKey);
      const fromSlot = weekGym.days.find(s => s.dateKey === fromDate);
      const toSlot = weekGym.days.find(s => s.dateKey === toDate);
      if (!fromSlot || !fromSlot.scheduled) {
        showToast('Selected source day is not a scheduled gym day');
        return;
      }
      if (fromSlot.visited) {
        showToast('Cannot reschedule an already visited gym day');
        return;
      }
      if (!toSlot || toSlot.scheduled || toSlot.visited) {
        showToast('Target day must be an unscheduled, unvisited day this week');
        return;
      }
      if (!state.gymReschedules || typeof state.gymReschedules !== 'object') {
        state.gymReschedules = {};
      }
      const list = Array.isArray(state.gymReschedules[monKey]) ? [...state.gymReschedules[monKey]] : [];
      const chainIdx = list.findIndex(r => r && r.to === fromDate);
      if (chainIdx >= 0) {
        const origFrom = list[chainIdx].from;
        if (origFrom === toDate) {
          list.splice(chainIdx, 1);
        } else {
          list[chainIdx] = { from: origFrom, to: toDate };
        }
      } else {
        list.push({ from: fromDate, to: toDate });
      }
      if (list.length > 0) state.gymReschedules[monKey] = list;
      else delete state.gymReschedules[monKey];

      pendingFx = { type: 'gym-toggle', dateKey: toDate };
      saveState(true);
      const fDow = DAY_LABELS_SHORT[parseDateKey(fromDate).getDay()];
      const tDow = DAY_LABELS_SHORT[parseDateKey(toDate).getDay()];
      showToast(`Shifted gym commitment: ${fDow} → ${tDow}`);
    },
    RescheduleGymFromControls(mondayKey) {
      const fromEl = document.getElementById('resched-from-' + mondayKey);
      const toEl = document.getElementById('resched-to-' + mondayKey);
      if (!fromEl || !toEl || !fromEl.value || !toEl.value) return;
      App.RescheduleGymDay(fromEl.value, toEl.value);
    },
    UndoGymReschedule(mondayKey, toDate) {
      if (!state.gymReschedules || !Array.isArray(state.gymReschedules[mondayKey])) return;
      const entry = state.gymReschedules[mondayKey].find(r => r && r.to === toDate);
      const today = toDateKey();
      if (entry && (diffDaysBetween(today, entry.from) > EDIT_WINDOW_DAYS || diffDaysBetween(today, entry.to) > EDIT_WINDOW_DAYS)) {
        showToast('Locked: entries older than 7 days cannot be modified');
        return;
      }
      const nextList = state.gymReschedules[mondayKey].filter(r => !(r && r.to === toDate));
      if (nextList.length > 0) state.gymReschedules[mondayKey] = nextList;
      else delete state.gymReschedules[mondayKey];
      pendingFx = { type: 'gym-toggle', dateKey: toDate };
      saveState(true);
      showToast('Gym reschedule reverted');
    },
    SaveProfileName() {
      const el = document.getElementById('profile-name-input');
      const name = (el ? el.value : '').trim();
      state.profileName = name || DEFAULT_PROFILE_NAME;
      saveState(true);
      showToast(`Profile updated: ${state.profileName}`);
    },
    async PromptInstallApp() {
      if (!ui.deferredInstallPrompt) return;
      try {
        ui.deferredInstallPrompt.prompt();
        await ui.deferredInstallPrompt.userChoice;
      } catch (_) {}
      ui.deferredInstallPrompt = null;
      render();
    },
    SetThemeMode(mode) {
      state.themeMode = ['dark', 'light', 'system'].includes(mode) ? mode : 'dark';
      applyThemeMode();
      saveState(true);
      showToast(`Display mode: ${state.themeMode.toUpperCase()}`);
    },
    async ToggleReminders() {
      if (!state.remindersEnabled) {
        if (!('Notification' in window)) {
          showToast('Browser notifications are not supported on this device');
          return;
        }
        let perm = Notification.permission;
        if (perm !== 'granted') {
          perm = await Notification.requestPermission();
        }
        if (perm !== 'granted') {
          showToast('Allow browser notification permission to enable reminders');
          return;
        }
        state.remindersEnabled = true;
        saveState(true);
        showToast(`Smart Reminders ON (${state.morningReminderTime || '08:00'} & ${state.eveningReminderTime || '20:00'})`);
        checkScheduledReminders();
      } else {
        state.remindersEnabled = false;
        saveState(true);
        showToast('Smart Reminders turned OFF');
      }
    },
    SaveReminderSchedule() {
      const mEl = document.getElementById('rem-morning-input');
      const eEl = document.getElementById('rem-evening-input');
      if (mEl && mEl.value) state.morningReminderTime = mEl.value;
      if (eEl && eEl.value) state.eveningReminderTime = eEl.value;
      saveState(true);
      showToast(`Schedule saved: ${state.morningReminderTime} & ${state.eveningReminderTime}`);
      checkScheduledReminders();
    },
    async TestReminderNow() {
      if ('Notification' in window && Notification.permission !== 'granted') {
        await Notification.requestPermission();
      }
      const hour = new Date().getHours();
      const slot = hour < 14 ? 'morning' : 'evening';
      const payload = buildGoalReminderPayload(slot, true);
      if (payload) {
        await dispatchBrowserNotification(payload.title, payload.body);
      }
    },
    SetSyncProvider(provider) {
      state.syncProvider = provider === 'gdrive' ? 'gdrive' : 'gist';
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(false);
    },
    SavePasskeyOnly() {
      const passEl = document.getElementById('sec-passkey-input');
      state.syncPasskey = passEl ? passEl.value.trim() : '';
      if (state.syncPasskey || (state.biometricEnabled && state.biometricCredId)) {
        sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
      } else {
        state.appLockEnabled = false;
      }
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(false);
      showToast(state.syncPasskey ? 'Secret Passkey saved' : 'Passkey cleared');
    },
    async ToggleBiometricAuth() {
      if (state.biometricEnabled && state.biometricCredId) {
        state.biometricEnabled = false;
        state.biometricCredId = '';
        if (!state.syncPasskey) {
          state.appLockEnabled = false;
        }
        saveState(false);
        showToast('Device biometric unlock disabled');
        return;
      }
      try {
        const credId = await registerDeviceBiometrics();
        state.biometricCredId = credId;
        state.biometricEnabled = true;
        state.appLockEnabled = true;
        sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
        saveState(false);
        showToast('Device biometric unlock enabled');
      } catch (err) {
        const msg = (err && err.name === 'NotAllowedError')
          ? 'Biometric setup cancelled or blocked by device authenticator'
          : (err && err.message) || 'Device biometrics unavailable in this browser';
        showToast(msg);
      }
    },
    async UnlockWithBiometrics() {
      await verifyDeviceBiometrics(false);
    },
    ToggleAppLock() {
      const passEl = document.getElementById('sec-passkey-input');
      if (passEl && passEl.value.trim()) {
        state.syncPasskey = passEl.value.trim();
      }
      if (!state.syncPasskey && !(state.biometricEnabled && state.biometricCredId)) {
        showToast('Enter a Secret Passkey or enable Biometric Unlock first');
        return;
      }
      state.appLockEnabled = !state.appLockEnabled;
      sessionStorage.setItem(SESSION_UNLOCK_KEY, '1');
      saveState(false);
      showToast(state.appLockEnabled ? 'Startup Lock enabled' : 'Startup Lock disabled');
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
        const card = document.querySelector('#auth-gate-overlay .auth-gate-card');
        triggerPopClass(card, 'fx-shake');
        showToast('Incorrect Passkey / PIN');
      }
    },
    HeaderLockClick() {
      const hasLockCred = Boolean(
        (state.syncPasskey && state.syncPasskey.trim()) ||
        (state.biometricEnabled && state.biometricCredId)
      );
      if (hasLockCred) {
        isSessionLocked = true;
        sessionStorage.removeItem(SESSION_UNLOCK_KEY);
        renderAuthGate();
      } else {
        ui.settingsOpen = true;
        ui.settingsSection = 'security';
        render();
        showToast('Enable Biometric Unlock or set a Passkey in Security & Lock');
      }
    },
    SaveGistConfig() {
      const tokEl = document.getElementById('github-token-input');
      const idEl = document.getElementById('gist-id-input');
      state.githubToken = tokEl ? tokEl.value.trim() : '';
      state.gistId = idEl ? idEl.value.trim() : '';
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(false);
      if (isCloudConfigured(state)) {
        pullFromCloud({ silent: false, onlyIfNewer: false, pushIfEmpty: true });
      } else {
        showToast('Cleared GitHub Token');
      }
    },
    SaveSyncUrl() {
      const el = document.getElementById('sync-url-input');
      const passEl = document.getElementById('sec-passkey-input');
      state.syncUrl = el ? el.value.trim() : '';
      if (passEl && passEl.value.trim()) {
        state.syncPasskey = passEl.value.trim();
      }
      ui.syncStatus = isCloudConfigured(state) ? 'synced' : 'local';
      saveState(false);
      if (state.syncUrl && !state.syncPasskey) {
        showToast('URL saved — also set your Secret Passkey above');
      } else if (isCloudConfigured(state)) {
        pullFromCloud({ silent: false, onlyIfNewer: false, pushIfEmpty: true });
      } else {
        showToast('Switched to Local mode');
      }
    },
    PushDriveManual() {
      pushToCloud(true);
    },
    PullDriveManual() {
      pullFromCloud({ silent: false, onlyIfNewer: false });
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
        ui.settingsOpen = true;
        ui.settingsSection = 'sync';
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
            state = normalizeState({
              ...createDefaultState(),
              ...payload,
              syncProvider: state.syncProvider,
              syncUrl: state.syncUrl,
              syncPasskey: state.syncPasskey,
              githubToken: state.githubToken,
              gistId: state.gistId,
              appLockEnabled: state.appLockEnabled,
              biometricEnabled: state.biometricEnabled,
              biometricCredId: state.biometricCredId
            });
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
    OpenResetConfirm() {
      ui.showResetConfirm = true;
      render();
    },
    CancelResetConfirm() {
      ui.showResetConfirm = false;
      render();
    },
    ConfirmWipeAllData() {
      const wordEl = document.getElementById('reset-confirm-word');
      const typedWord = wordEl ? wordEl.value.trim() : '';
      if (typedWord !== 'RESET') {
        showToast('Type RESET in all caps to confirm');
        return;
      }
      if (state.syncPasskey && state.syncPasskey.trim()) {
        const passEl = document.getElementById('reset-confirm-passkey');
        const typedPass = passEl ? passEl.value.trim() : '';
        if (typedPass !== state.syncPasskey.trim()) {
          showToast('Incorrect Secret Passkey — wipe aborted');
          return;
        }
      }
      const today = toDateKey();
      state.logs = {};
      state.gymReschedules = {};
      state.trackingStartDate = today;
      state.targetHistory = {};
      state.exercises.forEach(ex => {
        state.targetHistory[ex.id] = [{ date: today, target: ex.target }];
      });
      state.gymHistory = [{
        week: getMondayKey(today),
        mode: state.gymScheduleMode,
        target: state.weeklyGymTarget,
        days: [...(state.gymScheduleDays || [])]
      }];
      state.targetHistoryVersion = 2;
      ui.activeDate = today;
      ui.selectedCalDate = today;
      ui.showResetConfirm = false;
      saveState(true);
      showToast('All entries wiped — Day 1 starts today');
    }
  };
})();
