"""Print the CHANGELOG.md section of one version (used as the GitHub release text)."""
import re
import sys

version = sys.argv[1]
text = open("CHANGELOG.md", encoding="utf-8").read()
m = re.search(rf"^## \[?{re.escape(version)}\]?.*?\n(.*?)(?=^## |\Z)", text, re.S | re.M)
notes = m.group(1).strip() if m else ""
print(notes or f"Expenses {version}")
print("""
---
**Update:** Docker – Container Manager → Image → Update, or `docker compose pull && docker compose up -d`.
Local – download `Expenses.html` below and replace the old file. Google – *Settings → Updates → Update now*, or paste `Code.gs` and `index.html` and deploy a new version.
Install instructions: see the README.""")
