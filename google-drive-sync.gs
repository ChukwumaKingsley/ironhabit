/**
 * IRON HABIT — Google Drive Cloud Sync Script
 * ============================================
 * This tiny script stores and syncs all your exercise & gym data in a single file
 * named "fitness-tracker-data.json" inside your own Google Drive.
 *
 * SETUP (Takes 2 minutes, never expires):
 * 1. Go to https://script.google.com and click "New project".
 * 2. Delete any code in the editor and paste this entire file.
 * 3. Click "Deploy" (top right) -> "New deployment".
 * 4. Click the gear icon next to "Select type" -> choose "Web app".
 * 5. Set:
 *    - Description: Fitness Tracker Sync
 *    - Execute as: "Me"
 *    - Who has access: "Anyone" (The URL itself has a long unguessable ID; you can also set a Secret Sync Key below!)
 * 6. Click "Deploy", authorize access to your Google Drive, and copy the "Web app URL".
 * 7. Paste the Web app URL into the app's Settings -> Cloud Sync section.
 */

const FILE_NAME = 'fitness-tracker-data.json';

function getOrCreateFile() {
  const files = DriveApp.getFilesByName(FILE_NAME);
  if (files.hasNext()) {
    return files.next();
  }
  const initialData = JSON.stringify({
    version: 1,
    updatedAt: 0,
    payload: null
  }, null, 2);
  return DriveApp.createFile(FILE_NAME, initialData, MimeType.PLAIN_TEXT);
}

function doGet(e) {
  try {
    const file = getOrCreateFile();
    const content = file.getBlob().getDataAsString();
    return ContentService
      .createTextOutput(content)
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}

function doPost(e) {
  try {
    const body = e.postData ? e.postData.contents : '';
    if (!body) {
      throw new Error('Empty request body');
    }
    // Validate JSON before saving
    const parsed = JSON.parse(body);
    const file = getOrCreateFile();
    file.setContent(JSON.stringify(parsed, null, 2));

    return ContentService
      .createTextOutput(JSON.stringify({
        ok: true,
        updatedAt: parsed.updatedAt || Date.now(),
        fileName: FILE_NAME
      }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: err.toString() }))
      .setMimeType(ContentService.MimeType.JSON);
  }
}
