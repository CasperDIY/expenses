"""Fill in your GitHub repository in the README files and docker-compose.yml.

    python3 tools/set-repo.py yourname/expenses

The release workflow does this by itself for the files it publishes; run this once after forking so the
links on the front page of your repository are right."""
import re
import sys
from pathlib import Path

if len(sys.argv) != 2 or not re.fullmatch(r"[\w.-]+/[\w.-]+", sys.argv[1]):
    sys.exit(__doc__)
repo = sys.argv[1]
root = Path(__file__).resolve().parent.parent
for name in ("README.md", "README.sl.md", "docker-compose.yml"):
    p = root / name
    s = p.read_text(encoding="utf-8")
    s = s.replace("ghcr.io/OWNER/expenses", "ghcr.io/" + repo.lower()).replace("OWNER/expenses", repo)
    p.write_text(s, encoding="utf-8")
    print("updated", name)
