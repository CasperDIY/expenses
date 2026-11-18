"""Build dist/demo.html: the demo with sample data kept in the browser (also published on GitHub Pages)."""
from common import DIST, VERSION, icon_uri, NAS_DATA_CARD, app_js, css, i18n_js, page_body, read, rep

be = read("src/demo-backend.js")
body = page_body()
body = rep(body, NAS_DATA_CARD, '''      <p class="hint">To je demo: podatki so primeri in se hranijo samo v tem brskalniku. Na tvojem strežniku je tu gumb za izvoz v CSV.</p>
      <button class="ghost" id="demo-reset" type="button">Ponastavi primere podatkov</button>''')
body = rep(body, "<main>", '<div class="demo-bar">Demo različica s primeri podatkov. Spremembe se shranijo samo v tem brskalniku.</div>\n<main>')

extra_css = """
.demo-bar { background: var(--surface-2); border-bottom: 1px solid var(--line); color: var(--muted); font-size: .84rem; text-align: center;
  padding-block: .4rem; padding-left: max(16px, env(safe-area-inset-left, 0px)); padding-right: max(16px, env(safe-area-inset-right, 0px)); }
"""
reset_js = """
(function () {
  const b = document.getElementById("demo-reset");
  if (!b) return;
  b.addEventListener("click", async () => {
    if (!b.dataset.armed) { b.dataset.armed = "1"; b.textContent = t("Klikni še enkrat za ponastavitev"); return; }
    window.demoReset(); delete b.dataset.armed; b.textContent = t("Ponastavi primere podatkov");
    await loadMeta(); toast(t("Primeri podatkov so ponastavljeni")); refresh();
  });
})();
"""
out = f"""<!doctype html>
<html lang="sl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>Expenses – demo</title>
<link rel="icon" href="{icon_uri}">
<style>
{css}
{extra_css}
</style>
</head>
<body>
{body}
<script>window.APP_EDITION = "demo"; window.APP_VERSION = "{VERSION}";</script>
<script>
{i18n_js}
</script>
<script>
{be}
</script>
<script>
{app_js}
{reset_js}
</script>
</body>
</html>
"""
open(DIST + "demo.html", "w", encoding="utf-8").write(out)
print(DIST + "demo.html", len(out))
