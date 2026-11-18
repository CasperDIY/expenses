/**
 * Expenses – Google Apps Script edition.
 * The data lives in the user's Google Drive, in the folder "Expenses":
 *   expenses-data.json    – all data
 *   backups/              – backups
 *   Expenses – overview   – Google Sheet with every entry (view only, refreshed after each save)
 * User-facing error messages stay in Slovenian; the web page translates them (i18n).
 */
// filled in when the release is built (build/build_gas_files.py)
const APP_VERSION = '__APP_VERSION__';
const GITHUB_REPO = '__GITHUB_REPO__';

const APP_FOLDER = 'Expenses';
const DATA_FILE = 'expenses-data.json';
const BK_FOLDER = 'backups';
const SHEET_TITLE = 'Expenses – overview';
const BK_NAME_RE = /^expenses-\d{4}-\d{2}-\d{2}_\d{6}-(auto|manual|pre-restore)\.json$/;

function doGet() {
  return HtmlService.createHtmlOutputFromFile('index')
    .setTitle('Expenses')
    .addMetaTag('viewport', 'width=device-width, initial-scale=1, viewport-fit=cover');
}

/* ---------- folders and files ---------- */
function props_() { return PropertiesService.getScriptProperties(); }

function folder_() {
  const id = props_().getProperty('FOLDER_ID');
  if (id) {
    let f = null;
    try { f = DriveApp.getFolderById(id); } catch (e) {
      // the folder exists but this user has no access: do not create a new one (everyone would get separate data)
      throw new Error('Nimaš dostopa do podatkovne mape v Google Drivu. Lastnik naj ti jo deli z dovoljenjem "Urejevalec" (' +
        Session.getActiveUser().getEmail() + ').');
    }
    if (!f.isTrashed()) return f;
  }
  const root = DriveApp.getRootFolder();
  const found = root.getFoldersByName(APP_FOLDER);
  const f = found.hasNext() ? found.next() : root.createFolder(APP_FOLDER);
  props_().setProperty('FOLDER_ID', f.getId());
  return f;
}

function bkFolder_() {
  const parent = folder_();
  const it = parent.getFoldersByName(BK_FOLDER);
  return it.hasNext() ? it.next() : parent.createFolder(BK_FOLDER);
}

function fileIn_(folder, name) {
  const it = folder.getFilesByName(name);
  while (it.hasNext()) { const f = it.next(); if (!f.isTrashed()) return f; }
  return null;
}

/** The data file in the app folder (file is null until the first save). */
function dataFile_(folder) {
  return { file: fileIn_(folder, DATA_FILE), name: DATA_FILE };
}

function version_() { return props_().getProperty('VERSION') || '0'; }

/* ---------- API for the web page ---------- */
function loadAll() {
  const folder = folder_();
  const data = dataFile_(folder), file = data.file;
  return {
    dataFile: data.name,
    text: file ? file.getBlob().getDataAsString('UTF-8') : null,
    version: version_(),
    backups: listBackups(),
    folderName: folder.getName(),
    folderUrl: folder.getUrl(),
    sheetUrl: sheetUrl_(),
    user: Session.getActiveUser().getEmail(),
  };
}

function getVersion() { return version_(); }

/** Save the data. Returns {conflict:true} when another device saved in the meantime. */
function saveData(text, baseVersion) {
  JSON.parse(text); // never store broken data
  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const cur = version_();
    if (String(baseVersion) !== cur) return { conflict: true, version: cur };
    const folder = folder_();
    const data = dataFile_(folder);
    if (data.file) data.file.setContent(text);
    else folder.createFile(data.name, text, 'application/json');
    const next = String(Number(cur) + 1);
    props_().setProperty('VERSION', next);
    return { version: next };
  } finally {
    lock.releaseLock();
  }
}

/** Refresh the Google Sheet with all entries (called by the page after saving; a failure does not affect the data). */
const SHEET_TEXT = {
  sl: { head: ['Datum', 'Mesec', 'Vrsta', 'Kategorija', 'Cilj', 'Opis', 'Znesek', 'Plačano'], sheet: 'Vnosi', kinds: { income: 'prihodek', expense: 'strošek', saving: 'varčevanje' }, yes: 'da', no: 'ne' },
  en: { head: ['Date', 'Month', 'Type', 'Category', 'Goal', 'Description', 'Amount', 'Paid'], sheet: 'Entries', kinds: { income: 'income', expense: 'expense', saving: 'savings' }, yes: 'yes', no: 'no' },
  de: { head: ['Datum', 'Monat', 'Art', 'Kategorie', 'Ziel', 'Beschreibung', 'Betrag', 'Bezahlt'], sheet: 'Buchungen', kinds: { income: 'Einnahme', expense: 'Ausgabe', saving: 'Sparen' }, yes: 'ja', no: 'nein' },
};

function refreshSheet(lang) {
  const L = SHEET_TEXT[lang] || SHEET_TEXT.sl;
  const file = dataFile_(folder_()).file;
  if (!file) return null;
  const data = JSON.parse(file.getBlob().getDataAsString('UTF-8'));
  const db = data.db || data;
  const cats = {}, goals = {};
  (db.categories || []).forEach(function (c) { cats[c.id] = c.name; });
  (db.goals || []).forEach(function (g) { goals[g.id] = g.name; });
  const kinds = L.kinds;
  const entries = (db.entries || []).slice().sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id; });
  const rows = [L.head];
  entries.forEach(function (e) {
    const sign = e.kind === 'income' ? 1 : -1;
    rows.push([e.date, e.date.slice(0, 7), kinds[e.kind] || e.kind, cats[e.category_id] || '', goals[e.goal_id] || '',
      e.description || '', sign * Number(e.amount), e.paid ? L.yes : L.no]);
  });
  const ss = sheet_();
  const sh = ss.getSheets()[0];
  sh.setName(L.sheet);
  sh.clearContents();
  sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
  sh.getRange(2, 7, Math.max(1, rows.length - 1), 1).setNumberFormat('#,##0.00 "€"');
  sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
  sh.setFrozenRows(1);
  return ss.getUrl();
}

function sheet_() {
  const id = props_().getProperty('SHEET_ID');
  if (id) {
    try { const f = DriveApp.getFileById(id); if (!f.isTrashed()) return SpreadsheetApp.openById(id); } catch (e) { /* deleted */ }
  }
  const ss = SpreadsheetApp.create(SHEET_TITLE);
  DriveApp.getFileById(ss.getId()).moveTo(folder_());
  props_().setProperty('SHEET_ID', ss.getId());
  return ss;
}

function sheetUrl_() {
  const id = props_().getProperty('SHEET_ID');
  return id ? 'https://docs.google.com/spreadsheets/d/' + id + '/edit' : null;
}

/* ---------- backups ---------- */
function listBackups() {
  const out = [];
  const it = bkFolder_().getFiles();
  while (it.hasNext()) {
    const f = it.next();
    if (f.isTrashed() || !BK_NAME_RE.test(f.getName())) continue;
    out.push({ name: f.getName(), size: f.getSize() });
  }
  return out;
}

function writeBackup(name, text) {
  if (!BK_NAME_RE.test(name)) throw new Error('Neveljavno ime kopije');
  const folder = bkFolder_();
  const old = fileIn_(folder, name);
  if (old) old.setContent(text);
  else folder.createFile(name, text, 'application/json');
  return true;
}

function readBackup(name) {
  if (!BK_NAME_RE.test(name)) throw new Error('Neveljavno ime kopije');
  const f = fileIn_(bkFolder_(), name);
  if (!f) throw new Error('Kopija ne obstaja');
  return f.getBlob().getDataAsString('UTF-8');
}

function deleteBackup(name) {
  if (!BK_NAME_RE.test(name)) throw new Error('Neveljavno ime kopije');
  const f = fileIn_(bkFolder_(), name);
  if (f) f.setTrashed(true);
  return true;
}

/* ---------- export ---------- */
function exportCsv(csv, name) {
  if (!/^expenses-\d{4}-\d{2}-\d{2}\.csv$/.test(name)) throw new Error('Neveljavno ime');
  const folder = folder_();
  const old = fileIn_(folder, name);
  if (old) old.setTrashed(true);
  return folder.createFile(name, csv, 'text/csv').getUrl();
}

/* ---------- updates (optional) ----------
 * latestRelease(): the newest release on GitHub (needs the "connect to an external service" permission).
 * selfUpdate(tag): replaces Code.gs and index with the files of that release and points the web app
 * deployment to the new version. It needs the Apps Script API (script.google.com/home/usersettings) and the
 * scopes from appsscript-autoupdate.json; only the owner of the project can run it. */
function latestRelease() {
  if (!/^[\w.-]+\/[\w.-]+$/.test(GITHUB_REPO)) throw new Error('Repozitorij za posodobitve ni nastavljen.');
  const r = UrlFetchApp.fetch('https://api.github.com/repos/' + GITHUB_REPO + '/releases/latest',
    { muteHttpExceptions: true, headers: { Accept: 'application/vnd.github+json' } });
  const code = r.getResponseCode();
  if (code === 404) throw new Error('Na GitHubu še ni objavljene različice.');
  if (code !== 200) throw new Error('GitHub trenutno ni dosegljiv (' + code + ').');
  const j = JSON.parse(r.getContentText());
  return { tag: j.tag_name, url: j.html_url, notes: String(j.body || '').slice(0, 1500) };
}

function appInfo() {
  let url = null;
  try { url = ScriptApp.getService().getUrl(); } catch (e) { /* not deployed */ }
  return { version: APP_VERSION, repo: GITHUB_REPO, url: url };
}

function selfUpdate(tag) {
  if (!/^v?\d+\.\d+\.\d+[\w.-]*$/.test(String(tag))) throw new Error('Neveljavna različica');
  const lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    const token = ScriptApp.getOAuthToken();
    const base = 'https://script.googleapis.com/v1/projects/' + ScriptApp.getScriptId();
    const call = function (method, url, body) {
      const r = UrlFetchApp.fetch(url, {
        method: method, contentType: 'application/json', muteHttpExceptions: true,
        headers: { Authorization: 'Bearer ' + token }, payload: body ? JSON.stringify(body) : undefined,
      });
      const code = r.getResponseCode(), text = r.getContentText();
      if (code >= 300) throw apiError_(code, text);
      return text ? JSON.parse(text) : {};
    };
    const asset = function (name) {
      const r = UrlFetchApp.fetch('https://github.com/' + GITHUB_REPO + '/releases/download/' + encodeURIComponent(tag) + '/' + name,
        { muteHttpExceptions: true, followRedirects: true });
      if (r.getResponseCode() !== 200) throw new Error('Datoteke ' + name + ' ni bilo mogoče prenesti z GitHuba (' + r.getResponseCode() + ').');
      return r.getContentText('UTF-8');
    };
    const code = asset('Code.gs'), html = asset('index.html');
    if (code.indexOf('function selfUpdate(') < 0 || html.indexOf('</html>') < 0) throw new Error('Prenesene datoteke niso pravilne.');

    // replace only our two files, keep the manifest (scopes, web app settings) and anything the owner added
    const cur = call('get', base + '/content');
    let codeDone = false, htmlDone = false;
    const files = cur.files.map(function (f) {
      const out = { name: f.name, type: f.type, source: f.source };
      if (f.type === 'SERVER_JS' && f.source.indexOf('function saveData(') >= 0) { out.source = code; codeDone = true; }
      if (f.type === 'HTML' && f.name === 'index') { out.source = html; htmlDone = true; }
      return out;
    });
    if (!codeDone || !htmlDone) throw new Error('V projektu ni datotek aplikacije Expenses (koda in "index").');
    call('put', base + '/content', { files: files });

    const ver = call('post', base + '/versions', { description: 'Expenses ' + tag });
    const deps = (call('get', base + '/deployments').deployments || []).filter(function (d) {
      return d.deploymentConfig && d.deploymentConfig.versionNumber &&
        (d.entryPoints || []).some(function (e) { return e.entryPointType === 'WEB_APP'; });
    });
    deps.forEach(function (d) {
      call('put', base + '/deployments/' + d.deploymentId, { deploymentConfig: {
        scriptId: ScriptApp.getScriptId(), versionNumber: ver.versionNumber,
        manifestFileName: 'appsscript', description: 'Expenses ' + tag } });
    });
    return { version: tag, deployments: deps.length };
  } finally {
    lock.releaseLock();
  }
}

function apiError_(code, text) {
  if (/SERVICE_DISABLED|has not been used|not enabled the Apps Script API|usersettings/i.test(text)) {
    return new Error('Vklopi Google Apps Script API na script.google.com/home/usersettings in poskusi znova.');
  }
  if (/SCOPE_INSUFFICIENT|insufficient authentication scopes/i.test(text)) {
    return new Error('Manjkajo dovoljenja za samodejno posodobitev: v projekt dodaj appsscript.json za samodejne posodobitve (glej navodila).');
  }
  if (code === 403 || code === 404) return new Error('Posodobi lahko samo lastnik projekta.');
  return new Error('Posodobitev ni uspela (' + code + ').');
}
