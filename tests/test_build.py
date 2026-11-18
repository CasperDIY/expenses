"""Build every edition and check that the version and the update check are in place."""
import os
import subprocess
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


class BuildTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        env = dict(os.environ, GITHUB_REPOSITORY="example/expenses")
        subprocess.run(["sh", str(ROOT / "build" / "all.sh")], check=True, env=env, cwd=ROOT, capture_output=True)
        cls.version = (ROOT / "VERSION").read_text().strip()

    def read(self, name):
        return (ROOT / "dist" / name).read_text(encoding="utf-8")

    def test_editions_carry_version_and_repo(self):
        for name, edition in (("Expenses.html", "local"), ("index.html", "google")):
            s = self.read(name)
            self.assertIn(f'window.APP_EDITION = "{edition}"', s)
            self.assertIn(f'window.APP_VERSION = "{self.version}"', s)
            self.assertIn('window.APP_REPO = "example/expenses"', s)
            self.assertIn('id="update-card"', s)

    def test_gas_code_is_filled_in(self):
        s = self.read("Code.gs")
        self.assertIn(f"const APP_VERSION = '{self.version}';", s)
        self.assertIn("const GITHUB_REPO = 'example/expenses';", s)
        self.assertNotIn("__APP_VERSION__", s)

    def test_google_page_has_only_allowed_meta(self):
        s = self.read("index.html")
        self.assertNotIn('name="viewport"', s)  # added by Code.gs; HtmlService rejects most meta tags in the file
        self.assertNotIn("apple-mobile-web-app", s)

    def test_demo_has_no_repo(self):
        s = self.read("demo.html")
        self.assertIn('window.APP_EDITION = "demo"', s)


if __name__ == "__main__":
    unittest.main()
