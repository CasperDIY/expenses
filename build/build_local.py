"""Build dist/Expenses.html: one file opened in Chrome/Edge that keeps its data in a folder on the computer."""
from common import DIST, build_info, JSON_IMPORT_HTML, JSON_IMPORT_JS, NAS_DATA_CARD, SHELL_CSS, app_js, css, folder_backend, i18n_js, icon_uri, page_body, read, rep

be = folder_backend(read("src/demo-backend.js"))
layer = read("src/local-layer.js")

body = page_body()
body = rep(body, NAS_DATA_CARD, '''      <p class="hint">Vsi podatki so v mapi <b id="folder-name2"></b>: datoteka s podatki in podmapa <code>backups</code> z varnostnimi kopijami.</p>
      <div class="data-actions">
        <button type="button" class="ghost" id="local-csv">Izvozi CSV</button>
        <button type="button" class="ghost" id="local-change">Zamenjaj mapo</button>
      </div>''')
body = rep(body, "<main>", '<div class="local-bar"><span><span>Mapa:</span> <b id="folder-name">—</b></span><span id="save-state">Shranjeno v mapo</span></div>\n<main>')
body = rep(body, '      <p class="hint" id="bk-dir"></p>', JSON_IMPORT_HTML)

gate = f'''<div class="gate" id="gate" hidden>
  <div class="gate-card">
    <img src="{icon_uri}" alt="" width="48" height="48">
    <h1 translate="no">Expenses</h1>
    <div id="gate-body">
      <p>Izberi mapo na računalniku, kamor naj se shranjujejo tvoji podatki. Če v mapi že so podatki aplikacije Expenses (ali Stroški), se odprejo.</p>
      <p class="hint">Priporočilo: ustvari mapo, npr. <code>Dokumenti\\Expenses</code>, ali izberi mapo v OneDrivu/Google Drivu, da imaš podatke tudi v oblaku.</p>
      <div class="gate-actions">
        <button type="button" class="primary" id="gate-reopen" hidden></button>
        <button type="button" class="primary" id="gate-pick">Izberi mapo</button>
      </div>
      <p class="error" id="gate-msg" hidden></p>
    </div>
  </div>
</div>
'''

local_js = JSON_IMPORT_JS + '''
document.getElementById("local-csv").addEventListener("click", () => {
  const blob = new Blob([window.LOCAL.exportCsv()], { type: "text/csv;charset=utf-8" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `expenses-${todayISO}.csv`;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
});
twoStep(document.getElementById("local-change"), t("Potrdi zamenjavo mape"), () => window.LOCAL.changeFolder());
window.appReady.then(() => { document.getElementById("folder-name2").textContent = window.LOCAL.dir.name; });
'''

out = f"""<!doctype html>
<html lang="sl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="theme-color" content="#1f3a2e">
<title>Expenses</title>
<link rel="icon" href="{icon_uri}">
<style>
{css}
{SHELL_CSS}
</style>
</head>
<body>
{gate}{body}
{build_info('local')}
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
{local_js}
</script>
</body>
</html>
"""
open(DIST + "Expenses.html", "w", encoding="utf-8").write(out)
print(DIST + "Expenses.html", len(out))
