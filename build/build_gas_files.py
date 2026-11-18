"""Copy the Google Apps Script server files into dist/ with the version and repository filled in."""
import shutil

from common import DIST, REPO, VERSION, read, rep

code = read("gas/Code.gs")
code = rep(code, "'__APP_VERSION__'", f"'{VERSION}'")
code = rep(code, "'__GITHUB_REPO__'", f"'{REPO}'")
open(DIST + "Code.gs", "w", encoding="utf-8").write(code)
for name in ("appsscript.json", "appsscript-autoupdate.json"):
    shutil.copy("gas/" + name, DIST + name)
print(DIST + "Code.gs", len(code))
