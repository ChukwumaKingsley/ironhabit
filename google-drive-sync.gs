/**
 * IRONHABIT — Password-Protected Google Drive Cloud Sync Script
 * =============================================================
 * Why does Google Apps Script ask for "Who has access: Anyone"?
 * Because Google blocks cross-domain browser fetch() requests from github.io
 * unless the endpoint is reachable without a Google cookie redirect.
 *
 * To make it 100% private and authenticated, this script enforces your own
 * SECRET_PASSKEY on every read (GET) and write (POST). Any request without
 * your exact passkey is rejected immediately.
 */

const FILE_NAME = 'fitness-tracker-data.json';

// Set your own secret passkey here (must match the Passkey you enter in the app):
const SECRET_PASSKEY = 'CHANGE_ME_TO_YOUR_SECRET_PASSKEY';

function isAuthorized(key) {
  return Boolean(
    SECRET_PASSKEY &&
    SECRET_PASSKEY !== 'CHANGE_ME_TO_YOUR_SECRET_PASSKEY' &&
    key === SECRET_PASSKEY
  );
}

function jsonResponse(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getOrCreateFile() {
  const files = DriveApp.getFilesByName(FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  const initialData = JSON.stringify({
    version: 2,
    updatedAt: 0,
    payload: null
  }, null, 2);
  return DriveApp.createFile(FILE_NAME, initialData, MimeType.PLAIN_TEXT);
}

function doGet(e) {
  try {
    const key = e && e.parameter ? e.parameter.key : '';
    if (!isAuthorized(key)) {
      return jsonResponse({ ok: false, error: 'Unauthorized: Invalid or missing passkey' });
    }
    const file = getOrCreateFile();
    const content = file.getBlob().getDataAsString();
    return ContentService
      .createTextOutput(content)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}

function doPost(e) {
  try {
    const raw = e && e.postData ? e.postData.contents : '';
    if (!raw) {
      return jsonResponse({ ok: false, error: 'Empty request body' });
    }
    const parsed = JSON.parse(raw);
    if (!isAuthorized(parsed.passkey)) {
      return jsonResponse({ ok: false, error: 'Unauthorized: Invalid or missing passkey' });
    }

    const toSave = {
      version: parsed.version || 2,
      updatedAt: parsed.updatedAt || Date.now(),
      payload: parsed.payload
    };

    const file = getOrCreateFile();
    file.setContent(JSON.stringify(toSave, null, 2));

    return jsonResponse({
      ok: true,
      updatedAt: toSave.updatedAt,
      fileName: FILE_NAME
    });
  } catch (err) {
    return jsonResponse({ ok: false, error: err.toString() });
  }
}
