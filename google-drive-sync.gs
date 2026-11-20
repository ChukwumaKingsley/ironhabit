/**
 * IRONHABIT — Google Drive Auto-Sync Endpoint (Passkey-Protected + Dedicated Folder)
 *
 * Security & Storage Organization:
 * - Stores fitness-tracker-data.json inside a dedicated Google Drive directory (FOLDER_NAME = 'IronHabit').
 * - Automatically migrates any existing root-level fitness-tracker-data.json into the IronHabit folder.
 * - Every GET and POST request must include your Passkey (checked via constant-time timingSafeEqualStr).
 * - Uses LockService concurrency guards and skips trashed folders/files.
 */

const FOLDER_NAME = 'IronHabit';
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

function getOrCreateFolder() {
  const folderName = String(FOLDER_NAME || 'IronHabit').trim() || 'IronHabit';
  const folders = DriveApp.getFoldersByName(folderName);
  while (folders.hasNext()) {
    const folder = folders.next();
    if (!folder.isTrashed()) {
      return folder;
    }
  }
  return DriveApp.createFolder(folderName);
}

function getOrCreateFile() {
  const folder = getOrCreateFolder();

  // 1. Check inside the dedicated IronHabit directory first
  const folderFiles = folder.getFilesByName(FILE_NAME);
  while (folderFiles.hasNext()) {
    const file = folderFiles.next();
    if (!file.isTrashed()) {
      return file;
    }
  }

  // 2. If an older fitness-tracker-data.json exists in the root/base Drive directory, move it into the folder
  const allFiles = DriveApp.getFilesByName(FILE_NAME);
  while (allFiles.hasNext()) {
    const existing = allFiles.next();
    if (!existing.isTrashed()) {
      try {
        existing.moveTo(folder);
      } catch (_) {
        try {
          folder.addFile(existing);
          DriveApp.getRootFolder().removeFile(existing);
        } catch (__) {}
      }
      return existing;
    }
  }

  // 3. Otherwise create a fresh file directly inside the dedicated folder
  const initialPayload = JSON.stringify({ version: 2, updatedAt: 0, payload: null }, null, 2);
  return folder.createFile(FILE_NAME, initialPayload, MimeType.PLAIN_TEXT);
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
      .createTextOutput(JSON.stringify({ ok: true, updatedAt: toSave.updatedAt, folder: FOLDER_NAME }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    try { lock.releaseLock(); } catch (_) {}
  }
}
