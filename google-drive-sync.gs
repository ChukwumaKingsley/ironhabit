/**
 * IRONHABIT — Google Drive Auto-Sync Endpoint (Passkey-Protected)
 *
 * Security:
 * - Every GET and POST request must include your Passkey.
 * - If you set SECRET_PASSKEY below, it checks against that exact string.
 * - Even if you leave SECRET_PASSKEY as 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY',
 *   the script automatically binds and locks to the first non-empty Passkey
 *   you send from the IronHabit app (stored in ScriptProperties).
 */

const FILE_NAME = 'fitness-tracker-data.json';
const SECRET_PASSKEY = 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY';

function isAuthorized(key) {
  const incoming = String(key || '').trim();
  if (!incoming) return false;

  const configured = String(SECRET_PASSKEY || '').trim();
  if (configured && configured !== 'CHANGE_THIS_TO_YOUR_SECRET_PASSKEY') {
    return incoming === configured;
  }

  // Auto-bind on first authenticated request from the app
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
  if (files.hasNext()) {
    return files.next();
  }
  const initialPayload = JSON.stringify({ version: 2, updatedAt: 0, payload: null }, null, 2);
  return DriveApp.createFile(FILE_NAME, initialPayload, MimeType.PLAIN_TEXT);
}

function doGet(e) {
  const key = (e && e.parameter && e.parameter.key) ? e.parameter.key : '';
  if (!isAuthorized(key)) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: 'Unauthorized: invalid or missing passkey' }))
      .setMimeType(ContentService.MimeType.JSON);
  }
  const file = getOrCreateFile();
  const content = file.getBlob().getDataAsString();
  return ContentService
    .createTextOutput(content)
    .setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  try {
    const raw = (e && e.postData && e.postData.contents) ? e.postData.contents : '{}';
    const parsed = JSON.parse(raw);
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
    return ContentService
      .createTextOutput(JSON.stringify({ ok: true, updatedAt: toSave.updatedAt }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
