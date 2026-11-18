"""Smoke tests for the NAS server: start it on a temporary database and call the API. Standard library only."""
import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def free_port():
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class ServerTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.TemporaryDirectory()
        cls.port = free_port()
        env = dict(os.environ, DB_PATH=os.path.join(cls.tmp.name, "stroski.db"), PORT=str(cls.port),
                   EXPENSES_REPO="example/expenses", APP_USER="", APP_PASSWORD="", API_TOKEN="secret")
        cls.proc = subprocess.Popen([sys.executable, str(ROOT / "app" / "server.py")], env=env,
                                    stdout=subprocess.PIPE, stderr=subprocess.STDOUT)
        for _ in range(100):
            try:
                cls.get("/health")
                return
            except OSError:
                time.sleep(0.1)
        raise RuntimeError("server did not start")

    @classmethod
    def tearDownClass(cls):
        cls.proc.terminate()
        cls.proc.wait(5)
        cls.proc.stdout.close()
        cls.tmp.cleanup()

    @classmethod
    def call(cls, method, path, body=None, headers=None):
        data = json.dumps(body).encode() if body is not None else None
        req = urllib.request.Request(f"http://127.0.0.1:{cls.port}{path}", data=data, method=method,
                                     headers={"Content-Type": "application/json", **(headers or {})})
        with urllib.request.urlopen(req, timeout=5) as r:
            raw = r.read()
            return json.loads(raw) if r.headers.get("Content-Type", "").startswith("application/json") else raw

    @classmethod
    def get(cls, path, **kw):
        return cls.call("GET", path, **kw)

    def test_health_reports_version_file(self):
        version = (ROOT / "VERSION").read_text().strip()
        self.assertEqual(self.get("/health")["version"], version)

    def test_meta_has_repo_for_update_check(self):
        meta = self.get("/api/meta")
        self.assertEqual(meta["repo"], "example/expenses")
        self.assertTrue(meta["categories"])

    def test_entry_changes_month_summary(self):
        meta = self.get("/api/meta")
        cat = next(c for c in meta["categories"] if c["kind"] == "expense")
        ym = meta["today"][:7]
        before = self.get(f"/api/month?ym={ym}")["totals"]["expense"]
        self.call("POST", "/api/entries", {"date": meta["today"], "kind": "expense", "amount": 12.5,
                                           "category_id": cat["id"], "description": "test", "paid": 1})
        after = self.get(f"/api/month?ym={ym}")["totals"]["expense"]
        self.assertAlmostEqual(after - before, 12.5)

    def test_home_assistant_needs_token(self):
        with self.assertRaises(urllib.error.HTTPError):
            self.get("/api/ha/summary")
        self.assertIn("na_voljo", self.get("/api/ha/summary", headers={"Authorization": "Bearer secret"}))

    def test_language_is_kept_with_the_data(self):
        self.call("PUT", "/api/prefs", {"lang": "de"})
        self.assertEqual(self.get("/api/meta")["lang"], "de")
        with self.assertRaises(urllib.error.HTTPError):
            self.call("PUT", "/api/prefs", {"lang": "xx"})

    def test_home_assistant_english_and_legacy_keys(self):
        d = self.get("/api/ha/summary", headers={"Authorization": "Bearer secret"})
        self.assertEqual(d["left_to_spend"], d["na_voljo"])
        self.assertIn("goals", d)

    def test_backups_from_before_the_rename_are_listed(self):
        bk = Path(self.tmp.name) / "backups"
        bk.mkdir(exist_ok=True)
        (bk / "stroski-2026-01-02_030405-rocno.db").write_bytes(b"")
        self.call("POST", "/api/backups")
        items = self.get("/api/backups")["backups"]
        old = next(b for b in items if b["name"].startswith("stroski-"))
        self.assertEqual((old["kind"], old["created"]), ("manual", "2026-01-02T03:04:05"))
        self.assertTrue(any(b["name"].startswith("expenses-") and b["kind"] == "manual" for b in items))

    def test_json_export(self):
        data = self.get("/api/export.json")
        if isinstance(data, bytes):
            data = json.loads(data)
        self.assertEqual(data["app"], "expenses")


if __name__ == "__main__":
    unittest.main()
