/* Google Apps Script edition: data lives in Google Drive (folder "Expenses"). */
(function () {
  "use strict";
  const T = (s, v) => (window.I18N ? window.I18N.t(s, v) : s);
  const L = (window.LOCAL = { version: null, dirty: false, writing: null, blocked: false, folderName: "", folderUrl: "", sheetUrl: "" });

  const run = (fn, ...args) => new Promise((res, rej) => {
    google.script.run.withSuccessHandler(res).withFailureHandler((e) => rej(e instanceof Error ? e : new Error(String(e && e.message || e))))[fn](...args);
  });
  L.run = run;

  function warn(msg, ms = 6000) { const t = document.getElementById("toast"); if (t) { t.textContent = msg; t.classList.add("show"); clearTimeout(warn._t); warn._t = setTimeout(() => t.classList.remove("show"), ms); } }
  function setState(text, bad) { const el = document.getElementById("save-state"); if (el) { el.textContent = text; el.classList.toggle("bad", !!bad); } }

  /* ---- backups in Drive ---- */
  L.backupDirLabel = () => "Google Drive / " + (L.folderName || "Expenses") + " / backups";
  L.writeBackup = (name, text) => run("writeBackup", name, text).catch((e) => warn(T("Varnostne kopije ni bilo mogoče zapisati: {e}", { e: e.message })));
  L.deleteBackup = (name) => run("deleteBackup", name).catch(() => {});
  L.readBackup = (name) => run("readBackup", name);
  L.latestRelease = () => run("latestRelease");
  // backup names: expenses-YYYY-MM-DD_HHMMSS-<kind>.json
  const BK_RE = /^expenses-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})-(auto|manual|pre-restore)\.json$/;
  function parseBk(name) {
    const m = BK_RE.exec(name);
    return m ? { name, kind: m[5], created: `${m[1]}T${m[2]}:${m[3]}:${m[4]}` } : null;
  }
  function backupMeta(list) {
    return (list || []).map(({ name, size }) => {
      const meta = parseBk(name);
      return meta && { ...meta, size };
    }).filter(Boolean).sort((a, b) => (a.created < b.created ? 1 : -1));
  }

  /* ---- debounced saving ---- */
  let timer = null, sheetTimer = null;
  L.persist = () => {
    if (L.version === null || L.blocked) return;
    L.dirty = true;
    setState(T("Shranjujem …"));
    clearTimeout(timer);
    timer = setTimeout(flush, 700);
  };
  async function flush() {
    if (!L.dirty || L.blocked) return;
    if (L.writing) { await L.writing; return flush(); }
    L.dirty = false;
    const text = JSON.stringify(L.snapshot());
    L.writing = run("saveData", text, L.version)
      .then((r) => {
        if (r && r.conflict) {
          L.blocked = true;
          setState(T("Ni shranjeno"), true);
          conflict();
          return;
        }
        L.version = r.version;
        setState(L.dirty ? T("Shranjujem …") : T("Shranjeno v Google Drive"));
        clearTimeout(sheetTimer);
        sheetTimer = setTimeout(() => run("refreshSheet", window.I18N ? window.I18N.lang : "sl").then((u) => { if (u) L.sheetUrl = u; links(); }).catch(() => {}), 4000);
      })
      .catch((e) => { L.dirty = true; setState(T("Ni shranjeno"), true); warn(T("Shranjevanje ni uspelo: {e}. Poskusim znova …", { e: e.message })); clearTimeout(timer); timer = setTimeout(flush, 5000); })
      .finally(() => { L.writing = null; });
    await L.writing;
  }
  window.addEventListener("beforeunload", (e) => { if (L.dirty || L.writing) { flush(); e.preventDefault(); e.returnValue = ""; } });

  function conflict() {
    const gate = document.getElementById("gate");
    document.getElementById("gate-body").innerHTML =
      `<p><b>${T("Podatki so bili medtem spremenjeni na drugi napravi.")}</b></p>
       <p>${T("Da se nič ne prepiše, zadnja sprememba na tej napravi ni bila shranjena. Naloži najnovejše podatke in jo vnesi znova.")}</p>
       <div class="gate-actions"><button type="button" class="primary" id="gate-reload">${T("Naloži najnovejše podatke")}</button></div>`;
    gate.hidden = false;
    document.getElementById("gate-reload").addEventListener("click", reloadData);
  }

  /* ---- loading ---- */
  let resolveReady;
  window.appReady = new Promise((r) => (resolveReady = r));

  async function loadData() {
    const r = await run("loadAll");
    let data = null;
    if (r.text) {
      try { data = JSON.parse(r.text); } catch (e) { throw new Error(T("Datoteka {f} v Drivu je poškodovana. Obnovi jo iz mape backups.", { f: r.dataFile })); }
    }
    L.version = null; // do not save while restoring
    L.restore(data, backupMeta(r.backups));
    L.version = r.version;
    L.folderName = r.folderName; L.folderUrl = r.folderUrl; L.sheetUrl = r.sheetUrl; L.user = r.user || "";
    links();
    if (!r.text) { L.persist(); }
  }

  function links() {
    const set = (id, url) => { const a = document.getElementById(id); if (a) { a.href = url || "#"; a.hidden = !url; } };
    set("drive-folder", L.folderUrl);
    set("drive-sheet", L.sheetUrl);
    const n = document.getElementById("folder-name"); if (n) n.textContent = "Google Drive / " + (L.folderName || "Expenses") + (L.user ? " · " + L.user : "");
  }

  async function reloadData() {
    try {
      L.blocked = false; L.dirty = false;
      await loadData();
      document.getElementById("gate").hidden = true;
      setState(T("Shranjeno v Google Drive"));
      if (typeof window.S === "object") window.S.meta = null;
      await window.loadMeta(); await window.refresh();
    } catch (e) { warn(e.message); }
  }

  // when returning to the app (e.g. on a phone), check whether another device saved newer data
  document.addEventListener("visibilitychange", async () => {
    if (document.visibilityState !== "visible" || L.version === null || L.dirty || L.writing || L.blocked) return;
    try {
      const v = await run("getVersion");
      if (v !== L.version && !L.dirty && !L.writing) { await reloadData(); warn(T("Naloženi so najnovejši podatki z druge naprave."), 3000); }
    } catch (e) { /* offline */ }
  });

  document.addEventListener("DOMContentLoaded", async () => {
    try {
      await loadData();
      document.getElementById("gate").hidden = true;
      resolveReady();
    } catch (e) {
      document.getElementById("gate-body").innerHTML = `<p class="error">${String(e.message).replace(/[<>&]/g, "")}</p><div class="gate-actions"><button type="button" class="primary" id="gate-retry">${T("Poskusi znova")}</button></div>`;
      document.getElementById("gate-retry").addEventListener("click", async () => {
        document.getElementById("gate-body").innerHTML = `<p>${T("Nalagam podatke iz Google Drive …")}</p>`;
        try { await loadData(); document.getElementById("gate").hidden = true; resolveReady(); } catch (err) { warn(err.message); }
      });
    }
  });
})();
