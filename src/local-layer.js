/* Local edition: data lives in a folder the user picks on their computer (File System Access API, Chrome/Edge). */
(function () {
  "use strict";
  // new folders get expenses-data.json; a folder from before the rename keeps its stroski-podatki.json
  const DATA_FILES = ["expenses-data.json", "stroski-podatki.json"];
  let DATA_FILE = DATA_FILES[0];
  const BK_DIR = "backups";
  const IDB_NAME = "stroski-lokalno", IDB_STORE = "kv";   // pre-rename name kept, so the chosen folder is still remembered
  // backup names: expenses-YYYY-MM-DD_HHMMSS-<kind>.json; "stroski-…" with Slovenian kinds is the pre-rename format
  const BK_RE = /^(?:expenses|stroski)-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})-(auto|manual|pre-restore|rocno|pred-obnovo)\.json$/;
  const LEGACY_KINDS = { rocno: "manual", "pred-obnovo": "pre-restore" };
  function parseBk(name) {
    const m = BK_RE.exec(name);
    return m ? { name, kind: LEGACY_KINDS[m[5]] || m[5], created: `${m[1]}T${m[2]}:${m[3]}:${m[4]}` } : null;
  }
  const T = (s, v) => (window.I18N ? window.I18N.t(s, v) : s);
  const L = (window.LOCAL = { dir: null, bkDir: null, ready: null, dirty: false, writing: null });

  /* ---- IndexedDB: remember the chosen folder ---- */
  function idb() {
    return new Promise((res, rej) => {
      const r = indexedDB.open(IDB_NAME, 1);
      r.onupgradeneeded = () => r.result.createObjectStore(IDB_STORE);
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
    });
  }
  async function idbGet(k) { try { const d = await idb(); return await new Promise((res) => { const q = d.transaction(IDB_STORE).objectStore(IDB_STORE).get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); } catch (e) { return null; } }
  async function idbSet(k, v) { try { const d = await idb(); await new Promise((res) => { const t = d.transaction(IDB_STORE, "readwrite"); t.objectStore(IDB_STORE).put(v, k); t.oncomplete = res; t.onerror = res; }); } catch (e) { /* not important */ } }

  /* ---- reading and writing files ---- */
  async function readText(dir, name) {
    try { return await (await (await dir.getFileHandle(name)).getFile()).text(); } catch (e) { if (e.name === "NotFoundError") return null; throw e; }
  }
  async function writeText(dir, name, text) {
    const fh = await dir.getFileHandle(name, { create: true });
    const w = await fh.createWritable();
    await w.write(text);
    await w.close();
  }
  L.backupDirLabel = () => (L.dir ? L.dir.name : "") + "/backups";
  L.writeBackup = (name, text) => L.bkDir && writeText(L.bkDir, name, text).catch((e) => warn(T("Varnostne kopije ni bilo mogoče zapisati: {e}", { e: e.message })));
  L.deleteBackup = (name) => L.bkDir && L.bkDir.removeEntry(name).catch(() => {});
  async function listBackups() {
    const out = [];
    for await (const [name, h] of L.bkDir.entries()) {
      const meta = h.kind === "file" && parseBk(name);
      if (!meta) continue;
      const text = await (await h.getFile()).text();
      out.push({ ...meta, size: text.length, data: text });
    }
    return out.sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  /* ---- saving (debounced, so several changes are written at once) ---- */
  let timer = null;
  L.persist = () => {
    if (!L.dir) return;
    L.dirty = true;
    clearTimeout(timer);
    timer = setTimeout(flush, 250);
  };
  async function flush() {
    if (!L.dir || !L.dirty) return;
    if (L.writing) { await L.writing; return flush(); }
    L.dirty = false;
    const text = JSON.stringify(L.snapshot(), null, 1);
    L.writing = writeText(L.dir, DATA_FILE, text)
      .then(() => setSaved(true))
      .catch((e) => { L.dirty = true; setSaved(false); warn(T("Shranjevanje ni uspelo: {e}", { e: e.message })); })
      .finally(() => { L.writing = null; });
    await L.writing;
  }
  window.addEventListener("beforeunload", (e) => { if (L.dirty || L.writing) { flush(); e.preventDefault(); e.returnValue = ""; } });

  function warn(msg) { const t = document.getElementById("toast"); if (t) { t.textContent = msg; t.classList.add("show"); setTimeout(() => t.classList.remove("show"), 5000); } }
  function setSaved(ok) { const el = document.getElementById("save-state"); if (el) { el.textContent = ok ? T("Shranjeno v mapo") : T("Ni shranjeno"); el.classList.toggle("bad", !ok); } }

  /* ---- start-up: choose the folder ---- */
  let resolveReady;
  window.appReady = new Promise((r) => (resolveReady = r));

  async function openDir(dir) {
    L.dir = dir;
    L.bkDir = await dir.getDirectoryHandle(BK_DIR, { create: true });
    let text = null;
    DATA_FILE = DATA_FILES[0];
    for (const f of DATA_FILES) { text = await readText(dir, f); if (text !== null) { DATA_FILE = f; break; } }
    let data = null;
    if (text) {
      try { data = JSON.parse(text); } catch (e) { throw new Error(T("Datoteka {f} v tej mapi je poškodovana. Obnovi jo iz mape {b}.", { f: DATA_FILE, b: BK_DIR })); }
    }
    L.restore(data, await listBackups());
    await idbSet("dir", dir);
    document.getElementById("folder-name").textContent = dir.name;
    document.getElementById("gate").hidden = true;
    if (!text) { L.dirty = true; await flush(); }
    resolveReady();
  }

  async function pick() {
    try {
      const dir = await window.showDirectoryPicker({ id: "expenses", mode: "readwrite", startIn: "documents" });
      await openDir(dir);
    } catch (e) {
      if (e.name !== "AbortError") gateMsg(e.message);
    }
  }
  async function reopen(dir) {
    try {
      if ((await dir.requestPermission({ mode: "readwrite" })) !== "granted") return gateMsg(T("Brez dovoljenja aplikacija ne more brati mape. Klikni znova in izberi Dovoli."));
      await openDir(dir);
    } catch (e) { gateMsg(e.message); }
  }
  function gateMsg(m) { const el = document.getElementById("gate-msg"); el.textContent = m; el.hidden = !m; }

  L.changeFolder = async () => { await flush(); await idbSet("dir", null); location.reload(); };

  document.addEventListener("DOMContentLoaded", async () => {
    const gate = document.getElementById("gate");
    if (!("showDirectoryPicker" in window)) {
      document.getElementById("gate-body").innerHTML = `<p>${T("Ta brskalnik ne omogoča shranjevanja v mapo. Odpri datoteko v <b>Google Chromu</b> ali <b>Microsoft Edgu</b> na računalniku.")}</p>`;
      return;
    }
    document.getElementById("gate-pick").addEventListener("click", pick);
    const saved = await idbGet("dir");
    if (saved) {
      const perm = await saved.queryPermission({ mode: "readwrite" }).catch(() => "denied");
      if (perm === "granted") { try { await openDir(saved); return; } catch (e) { gateMsg(e.message); } }
      const btn = document.getElementById("gate-reopen");
      btn.hidden = false;
      btn.textContent = T("Odpri mapo \"{n}\"", { n: saved.name });
      btn.addEventListener("click", () => reopen(saved));
      document.getElementById("gate-pick").textContent = T("Izberi drugo mapo");
      document.getElementById("gate-pick").className = "ghost";
    }
    gate.hidden = false;
  });
})();
