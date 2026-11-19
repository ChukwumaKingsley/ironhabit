/**
 * IRONHABIT — Google Drive Auto-Sync Endpoint (Passkey-Protected)
 *
 * Security:
 * - Every GET and POST request must include your Passkey.
 * - Uses constant-time string comparison (timingSafeEqualStr) and LockService concurrency guards.
 * - Skips trashed files when locating fitness-tracker-data.json in Google Drive.
 */

const FILE_NAME = 'fitness-tracker-data.json';
const SECRET_PASSKEY = 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY';

function timingSafeEqualStr(a, b) {
  const sa = String(a || '');
  const sb = String(b || '');
  const len = Math.max(sa.length, sb.length);
  let diff = sa.length ^ sb.length;
  for (let i = 0; i < len; i++) {
    const ca = i < sa.length ? sa.charCodeAt(i) : 0;
    const cb = i < sb.length ? sb.charCodeAt(i) : 0;
    diff |= (ca ^ cb);
  }
  return sa.length > 0 && diff === 0;
}

function isAuthorized(key) {
  const incoming = String(key || '').trim();
  if (incoming.length < 4) return false;

  const configured = String(SECRET_PASSKEY || '').trim();
  if (configured && configured !== 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY') {
    return timingSafeEqualStr(incoming, configured);
  }

  const lock = LockService.getScriptLock();
  lock.tryLock(5000);
  try {
    const props = PropertiesService.getScriptProperties();
    const bound = props.getProperty('BOUND_PASSKEY');
    if (!bound) {
      props.setProperty('BOUND_PASSKEY', incoming);
      return true;
    }
    return timingSafeEqualStr(incoming, bound);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}

function getOrCreateFile() {
  const files = DriveApp.getFilesByName(FILE_NAME);
  while (files.hasNext()) {
    const file = files.next();
    if (!file.isTrashed()) {
      return file;
    }
  }
  const initialPayload = JSON.stringify({ version: 2, updatedAt: 0, payload: null }, null, 2);
  return DriveApp.createFile(FILE_NAME, initialPayload, MimeType.PLAIN_TEXT);
}

function doGet(e) {
  const key = (e && e.parameter && e.parameter.key) ? e.parameter.key : '';
  if (!isAuthorized(key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing passkey (min 4 chars)' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const file = getOrCreateFile();
  const content = file.getBlob().getDataAsString();
  return ContentService
    .createTextOutput(content)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  const lock = LockService.getScriptLock();
  lock.tryLock(10000);
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const parsed = JSON.parse(raw);
    const key = (parsed && parsed.passkey) || (e && e.parameter && e.parameter.key) || '';
    if (!isAuthorized(key)) {
      return ContentService
        .createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing passkey (min 4 chars)' }))
        .setMimeType(ContentService.MimeType.JSON);
    }
    const toSave = {
      version: parsed.version || 2,
      updatedAt: parsed.updatedAt || Date.now(),
      payload: parsed.payload || null
    };
    const file = getOrCreateFile();
    file.setContent(JSON.stringify(toSave, null, 2));
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, updatedAt: toSave.updatedAt }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
