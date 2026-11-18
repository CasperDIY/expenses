"""Shared pieces for building the single-file editions (demo, local, Google Apps Script) from the NAS web app."""
import base64
import os
import re
import subprocess

STATIC = "app/static/"
DIST = "dist/"
os.makedirs(DIST, exist_ok=True)

# one version for every edition, from the VERSION file at the repository root
VERSION = open("VERSION", encoding="utf-8").read().strip()


def _repo():
    """GitHub "owner/name" used by the update check: GITHUB_REPOSITORY in Actions, else the git remote, else empty."""
    r = os.environ.get("GITHUB_REPOSITORY", "")
    if not r:
        try:
            url = subprocess.run(["git", "remote", "get-url", "origin"], capture_output=True, text=True).stdout.strip()
            m = re.search(r"github\.com[:/]([^/]+/[^/.]+)", url)
            r = m.group(1) if m else ""
        except OSError:
            pass
    return r


REPO = _repo()


def build_info(edition):
    """<script> that tells the page its edition, version and repository."""
    return (f'<script>window.LOCAL_MODE = true; window.APP_EDITION = "{edition}"; '
            f'window.APP_VERSION = "{VERSION}"; window.APP_REPO = "{REPO}";</script>')


def read(path):
    return open(path, encoding="utf-8").read()


def rep(s, a, b, n=1):
    """Replace exactly n occurrences, so a changed source is caught at build time instead of silently skipped."""
    assert s.count(a) == n, (a[:80], s.count(a))
    return s.replace(a, b)


html = read(STATIC + "index.html")
css = read(STATIC + "style.css")
app_js = read(STATIC + "app.js")
i18n_js = read(STATIC + "i18n.js")
icon_uri = "data:image/svg+xml;base64," + base64.b64encode(read(STATIC + "icon.svg").strip().encode()).decode()


def page_body():
    """Body of the NAS page without its <script> tags, with the icon inlined."""
    body = re.search(r"<body>\n(.*?)<script src=\"/i18n.js\"></script>", html, re.S).group(1)
    return rep(body, '<img src="/icon.svg" alt="">', f'<img src="{icon_uri}" alt="">')


# the NAS "Data" card (export links) that every single-file edition replaces with its own
NAS_DATA_CARD = '''      <p class="hint">Izvoz vseh vnosov (odpre se v Excelu).</p>
      <div class="data-actions">
        <a class="btn ghost" href="/api/export.csv">Izvozi CSV</a>
        <a class="btn ghost" href="/api/export.json">Izvozi za Google / lokalno (.json)</a>
      </div>
      <p class="hint">Datoteko .json uvoziš v Google ali lokalni različici: Nastavitve → Varnostne kopije → Uvozi podatke iz datoteke.</p>'''

# "import data from file (.json)" – used by the local and Google editions
JSON_IMPORT_HTML = '''      <p class="hint" id="bk-dir"></p>
      <div class="json-import">
        <label class="btn ghost file-btn" for="json-file">Uvozi podatke iz datoteke (.json)</label>
        <input type="file" id="json-file" accept=".json,application/json" hidden>
        <div id="json-preview" hidden></div>
      </div>'''

JSON_IMPORT_JS = r'''
(() => {
  let pending = null;
  const box = document.getElementById("json-preview");
  document.getElementById("json-file").addEventListener("change", async (ev) => {
    const f = ev.target.files[0]; ev.target.value = "";
    if (!f) return;
    try {
      const data = JSON.parse(await f.text());
      if (!data || data.app !== "expenses" || !data.db || !Array.isArray(data.db.entries)) throw new Error(t("To ni datoteka s podatki aplikacije Expenses."));
      pending = data;
      const d = data.db, months = new Set(d.entries.map((e) => e.date.slice(0, 7)));
      const summary = t("{e} vnosov v {m} mesecih, {c} kategorij, {g} ciljev, {r} ponavljajočih predlog", {
        e: d.entries.length, m: months.size, c: d.categories.length, g: (d.goals || []).length, r: (d.recurring || []).length,
      }) + (d.account ? ", " + t("stanje na računu") : "");
      box.innerHTML = `<p><b>${esc(f.name)}</b>: ${summary}.</p>
        <p class="hint">${t('Uvoz <b>zamenja vse trenutne podatke</b>. Trenutno stanje se prej shrani kot varnostna kopija "pred obnovitvijo", zato ga lahko vrneš.')}</p>
        <div class="imp-actions"><button type="button" class="ghost" id="json-cancel">${t("Prekliči")}</button><button type="button" class="primary" id="json-go">${t("Zamenjaj podatke")}</button></div>`;
      box.hidden = false;
      document.getElementById("json-cancel").onclick = () => { pending = null; box.hidden = true; };
      twoStep(document.getElementById("json-go"), t("Potrdi zamenjavo"), async () => {
        const r = window.LOCAL.replaceAll(pending);
        pending = null; box.hidden = true;
        S.meta = null; await loadMeta();
        toast(t("Uvoženih {n} vnosov. Prejšnji podatki so v varnostni kopiji.", { n: r.entries }));
        await renderSettings();
      });
    } catch (e) { box.hidden = true; toast(e.message); }
  });
})();
'''

SHELL_CSS = '''
.json-import { margin-top: .8rem; padding-top: .8rem; border-top: 1px solid var(--line); }
#json-preview { margin-top: .6rem; padding: .8rem; border-radius: 10px; background: var(--surface-2); border: 1px solid var(--line); }
#json-preview p { margin: 0 0 .5rem; }
.local-bar { display: flex; justify-content: space-between; gap: .4rem 1rem; flex-wrap: wrap; font-size: .82rem; color: var(--muted);
  background: var(--surface-2); border-bottom: 1px solid var(--line); padding-block: .35rem;
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.local-bar b { color: var(--text); font-weight: 600; }
#save-state.bad { color: var(--exp); font-weight: 600; }
.data-actions { display: flex; gap: .5rem; flex-wrap: wrap; }
code { font-size: .85em; background: var(--surface-2); border: 1px solid var(--line); border-radius: 5px; padding: .05rem .3rem; }
.gate { position: fixed; inset: 0; z-index: 100; display: grid; place-items: center; background: var(--bg);
  padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
.gate-card { width: min(460px, 100%); background: var(--surface); border: 1px solid var(--line); border-radius: 18px; padding: 1.6rem 1.5rem; box-shadow: var(--shadow); }
.gate-card img { border-radius: 12px; }
.gate-card h1 { margin: .6rem 0 .5rem; font-size: 1.5rem; color: var(--brand); }
.gate-card p { margin: 0 0 .8rem; }
.gate-actions { display: flex; flex-wrap: wrap; gap: .5rem; margin-top: 1rem; }
'''


def folder_backend(be):
    """Turn the demo's in-browser backend (localStorage) into one that keeps its data in window.LOCAL (a folder or Google Drive)."""
    be = rep(be, '/* Demo "server" in the browser – same logic as server.py, data in localStorage. */',
             '/* In-browser "server" – same logic as server.py, data kept by window.LOCAL. */')
    be = rep(be, '  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* no persistence */ } }',
             '  function save() { window.LOCAL.persist(); }')
    be = rep(be, '''  const BK_KEY = "expenses-demo-backups-v1";
  let bk = { settings: { frequency: "weekly", weekday: "6", monthday: "1", time: "03:00", keep: "8" }, last_auto: null, items: [] };
  try { const raw = localStorage.getItem(BK_KEY); if (raw) bk = JSON.parse(raw); } catch (e) { /* storage unavailable */ }
  const bkSave = () => { try { localStorage.setItem(BK_KEY, JSON.stringify(bk)); } catch (e) { /* full or blocked */ } };''',
             '''  let bk = { settings: { frequency: "weekly", weekday: "6", monthday: "1", time: "03:00", keep: "8" }, last_auto: null, items: [] };
  const bkSave = () => window.LOCAL.persist();''')
    # backups are separate .json files
    be = rep(be, 'let name = `expenses-${stamp(d)}-${kind}.db`;', 'let name = `expenses-${stamp(d)}-${kind}.json`;')
    be = rep(be, 'name = `expenses-${stamp(d)}-${kind}.db`; }', 'name = `expenses-${stamp(d)}-${kind}.json`; }')
    be = rep(be, '''    const data = JSON.stringify(db);
    bk.items.unshift({ name, kind, created: isoLocal(d), size: data.length, data });''', '''    const data = JSON.stringify({ app: "expenses", db, backup: { settings: bk.settings, last_auto: bk.last_auto } });
    bk.items.unshift({ name, kind, created: isoLocal(d), size: data.length, data });
    window.LOCAL.writeBackup(name, data);''')
    be = rep(be, '''    bk.items = bk.items.filter((b) => !drop.has(b.name));''', '''    bk.items = bk.items.filter((b) => !drop.has(b.name));
    drop.forEach((n) => window.LOCAL.deleteBackup(n));''')
    be = rep(be, '''    if (method === "DELETE") { bk.items = bk.items.filter((b) => b.name !== name); bkSave(); return { ok: true }; }''',
             '''    if (method === "DELETE") { bk.items = bk.items.filter((b) => b.name !== name); window.LOCAL.deleteBackup(name); return { ok: true }; }''')
    be = rep(be, '''      db = JSON.parse(item.data);''', '''      const parsed = JSON.parse(item.data);
      db = parsed && parsed.db ? parsed.db : parsed;''')
    be = rep(be, 'dir: "demo: kopije so shranjene v tem brskalniku",', 'dir: window.LOCAL.backupDirLabel(),')
    be = rep(be, '    try { const raw = localStorage.getItem(KEY); if (raw) { db = JSON.parse(raw); return; } } catch (e) { /* storage unavailable */ }\n', '')
    # start with no sample data: only the default categories
    be = rep(be, '''  load();
  window.demoApi = async (method, path, body) => {
    const out = route(method, path, body);
    save();
    return JSON.parse(JSON.stringify(out));
  };
  window.demoReset = () => { seed(); };
  if (!bk.items.length) { makeBk("auto"); bk.last_auto = isoLocal(new Date()); bkSave(); }''', '''  function emptyDb() {
    db = { categories: [], goals: [], recurring: [], generated: {}, entries: [], seq: {}, monthSettings: {} };
    for (const [name, kind, color] of CATS) db.categories.push({ id: nextId("categories"), name, kind, budget: 0, color, archived: 0 });
  }
  window.LOCAL.snapshot = () => ({ app: "expenses", format: 1, saved_at: new Date().toISOString(), db, backup: { settings: bk.settings, last_auto: bk.last_auto } });
  window.LOCAL.restore = (data, items) => {
    if (data && data.db) { db = data.db; if (data.backup) { bk.settings = data.backup.settings || bk.settings; bk.last_auto = data.backup.last_auto || null; } }
    else emptyDb();
    bk.items = items || [];
    if (!bk.items.length) { makeBk("auto"); bk.last_auto = isoLocal(new Date()); }
  };
  window.LOCAL.replaceAll = (data) => {
    if (!data || data.app !== "expenses" || !data.db || !Array.isArray(data.db.entries) || !Array.isArray(data.db.categories)) fail("To ni datoteka s podatki aplikacije Expenses.");
    const safety = makeBk("pre-restore");
    db = data.db;
    db.generated = db.generated || {}; db.seq = db.seq || {}; db.monthSettings = db.monthSettings || {};
    if (data.backup && data.backup.settings) bk.settings = data.backup.settings;
    save();
    return { entries: db.entries.length, safety };
  };
  window.LOCAL.exportCsv = () => {
    const T = window.I18N.t;
    const names = { income: T("prihodek"), expense: T("strošek"), saving: T("varčevanje") };
    const q = (v) => { const s = String(v ?? ""); return /[;"\\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    const head = ["datum", "vrsta", "kategorija", "cilj", "opis", "znesek", "placano"].map((h) => T(h));
    const rows = [head].concat(
      [...db.entries].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)).map((e) => [
        e.date, names[e.kind], catById(e.category_id)?.name || "", goalById(e.goal_id)?.name || "", e.description,
        e.amount.toFixed(2).replace(".", window.I18N.lang === "en" ? "." : ","), e.paid ? T("da") : T("ne")]));
    return "\\ufeff" + rows.map((r) => r.map(q).join(";")).join("\\r\\n");
  };
  window.demoApi = async (method, path, body) => {
    await window.appReady;
    const before = method === "GET" ? JSON.stringify(db) : null;
    const out = route(method, path, body);
    // a GET may create entries from templates or an automatic backup; save only if something changed
    if (method !== "GET" || JSON.stringify(db) !== before) save();
    return JSON.parse(JSON.stringify(out));
  };''')
    assert "localStorage" not in be, "localStorage left in backend"
    return be
