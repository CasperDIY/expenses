"""Build gas/index.html for the Google Apps Script edition (data in Google Drive, served by Code.gs)."""
from common import DIST, build_info, JSON_IMPORT_HTML, JSON_IMPORT_JS, NAS_DATA_CARD, SHELL_CSS, app_js, css, folder_backend, i18n_js, icon_uri, page_body, read, rep

be = folder_backend(read("src/demo-backend.js"))
be = rep(be, '/* In-browser "server" – same logic as server.py, data kept by window.LOCAL. */',
         '/* In-browser "server" – same logic as server.py, data in Google Drive. */')
# backups are listed from Drive without their content; it is fetched only when one is restored
be = rep(be, '''  window.demoApi = async (method, path, body) => {
    await window.appReady;''', '''  window.LOCAL.needData = (name) => { const it = bk.items.find((b) => b.name === name); return it && !it.data ? it : null; };
  window.demoApi = async (method, path, body) => {
    await window.appReady;
    const rm = method === "POST" && path.match(/^backups\\/([^/]+)\\/restore$/);
    if (rm) { const it = window.LOCAL.needData(decodeURIComponent(rm[1])); if (it) it.data = await window.LOCAL.readBackup(it.name); }''')
layer = read("src/gas-layer.js")

body = page_body()
body = rep(body, NAS_DATA_CARD, '''      <p class="hint">Vsi podatki so v tvojem Google Drivu v mapi <b>Expenses</b>: datoteka s podatki, varnostne kopije v podmapi <code>backups</code> in preglednica z vsemi vnosi (samo za ogled).</p>
      <div class="data-actions">
        <a class="btn ghost" id="drive-folder" target="_blank" rel="noopener" hidden>Odpri mapo v Drivu</a>
        <a class="btn ghost" id="drive-sheet" target="_blank" rel="noopener" hidden>Odpri preglednico</a>
        <button type="button" class="ghost" id="local-csv">Izvozi CSV v Drive</button>
      </div>''')
body = rep(body, "<main>", '<div class="local-bar"><span><b id="folder-name">Google Drive</b></span><span id="save-state">Shranjeno v Google Drive</span></div>\n<main>')
body = rep(body, '      <p class="hint" id="bk-dir"></p>', JSON_IMPORT_HTML)

gate = f'''<div class="gate" id="gate">
  <div class="gate-card">
    <img src="{icon_uri}" alt="" width="48" height="48">
    <h1 translate="no">Expenses</h1>
    <div id="gate-body"><p>Nalagam podatke iz Google Drive …</p></div>
  </div>
</div>
'''

gas_js = JSON_IMPORT_JS + '''
document.getElementById("local-csv").addEventListener("click", async () => {
  const b = document.getElementById("local-csv");
  b.disabled = true;
  try {
    await window.LOCAL.run("exportCsv", window.LOCAL.exportCsv(), `expenses-${todayISO}.csv`);
    toast(t("CSV je shranjen v mapo aplikacije v Drivu"));
  } catch (e) { toast(e.message); }
  b.disabled = false;
});
'''

out = f"""<!doctype html>
<html lang="sl">
<head>
<base target="_top">
<meta charset="utf-8">
<meta name="theme-color" content="#1f3a2e">
<style>
{css}
{SHELL_CSS}
</style>
</head>
<body>
{gate}{body}
{build_info('google')}
<script>
{i18n_js}
</script>
<script>
{layer}
</script>
<script>
{be}
</script>
<script>
{app_js}
{gas_js}
</script>
</body>
</html>
"""
open(DIST + "index.html", "w", encoding="utf-8").write(out)
print(DIST + "index.html", len(out))
