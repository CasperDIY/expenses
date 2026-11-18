"""Expenses – personal budget (income, bills, savings goals).

Python standard library only: http.server + sqlite3.
Configuration through environment variables:
  DB_PATH        database path (default /data/expenses.db)
  BACKUP_DIR     backup folder (default: "backups" next to the database)
  PORT           port (default 8080)
  APP_USER       login user name (empty: no login)
  APP_PASSWORD   login password
  API_TOKEN      token for /api/ha/summary (Home Assistant)
  PUID / PGID    user the server drops to when started as root (default 1000)

User-facing messages (ApiError) stay in Slovenian; the web client translates them (static/i18n.js).
"""
import base64
import csv
import hmac
import io
import json
import os
import re
import sqlite3
import threading
import zipfile
import xml.etree.ElementTree as ET
from calendar import monthrange
import time
from datetime import date, datetime, timedelta
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs, urlparse

DB_PATH = os.environ.get("DB_PATH") or "/data/expenses.db"
PORT = int(os.environ.get("PORT", "8080"))
APP_USER = os.environ.get("APP_USER", "")
APP_PASSWORD = os.environ.get("APP_PASSWORD", "")
API_TOKEN = os.environ.get("API_TOKEN", "")
STATIC_DIR = Path(__file__).parent / "static"
def _read_version():
    """The VERSION file is copied next to server.py in the Docker image; in a checkout it is one folder up."""
    for p in (Path(__file__).parent / "VERSION", Path(__file__).parent.parent / "VERSION"):
        if p.is_file():
            return p.read_text(encoding="utf-8").strip()
    return "dev"


APP_VERSION = _read_version()
# GitHub "owner/name" for the optional update check in Settings (set by the Docker image build)
GITHUB_REPO = os.environ.get("EXPENSES_REPO", "")
BACKUP_DIR = Path(os.environ.get("BACKUP_DIR") or (Path(DB_PATH).parent / "backups"))
# backup file names: expenses-YYYY-MM-DD_HHMMSS-<kind>.db
BACKUP_NAME_RE = re.compile(r"^expenses-(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})(\d{2})-(auto|manual|pre-restore)\.db$")

KINDS = ("income", "expense", "saving")
YM_RE = re.compile(r"^\d{4}-(0[1-9]|1[0-2])$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

_lock = threading.Lock()

SCHEMA = """
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
  budget REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#888888',
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS goals (
  id INTEGER PRIMARY KEY,
  name TEXT NOT NULL,
  target REAL NOT NULL,
  target_date TEXT,
  start_amount REAL NOT NULL DEFAULT 0,
  color TEXT NOT NULL DEFAULT '#2f855a',
  archived INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS recurring (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense','saving')),
  category_id INTEGER REFERENCES categories(id),
  goal_id INTEGER REFERENCES goals(id),
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  day INTEGER NOT NULL DEFAULT 1,
  start_ym TEXT NOT NULL,
  end_ym TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  auto_paid INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS recurring_generated (
  recurring_id INTEGER NOT NULL,
  ym TEXT NOT NULL,
  PRIMARY KEY (recurring_id, ym)
);
CREATE TABLE IF NOT EXISTS entries (
  id INTEGER PRIMARY KEY,
  date TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('income','expense','saving')),
  category_id INTEGER REFERENCES categories(id),
  goal_id INTEGER REFERENCES goals(id),
  description TEXT NOT NULL DEFAULT '',
  amount REAL NOT NULL,
  recurring_id INTEGER,
  paid INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_entries_date ON entries(date);
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS month_settings (
  ym TEXT PRIMARY KEY,
  carry_in INTEGER NOT NULL DEFAULT 1
);
"""

DEFAULT_CATEGORIES = [
    ("Plača", "income", "#2f855a"),
    ("Dodatni prihodki", "income", "#38a169"),
    ("Drugi prihodki", "income", "#68d391"),
    ("Stanovanje / najemnina", "expense", "#c05621"),
    ("Elektrika", "expense", "#d69e2e"),
    ("Voda in komunala", "expense", "#3182ce"),
    ("Internet in telefon", "expense", "#805ad5"),
    ("Hrana in gospodinjstvo", "expense", "#e53e3e"),
    ("Avto in gorivo", "expense", "#4a5568"),
    ("Zavarovanja", "expense", "#2c7a7b"),
    ("Zdravje", "expense", "#d53f8c"),
    ("Naročnine", "expense", "#6b46c1"),
    ("Prosti čas", "expense", "#dd6b20"),
    ("Oblačila", "expense", "#b7791f"),
    ("Drugo", "expense", "#718096"),
]


# ---------------------------------------------------------------- database
def connect():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    return conn


def init_db():
    Path(DB_PATH).parent.mkdir(parents=True, exist_ok=True)
    with connect() as conn:
        conn.executescript(SCHEMA)
        cols = {r[1] for r in conn.execute("PRAGMA table_info(recurring)")}
        if "auto_paid" not in cols:
            conn.execute("ALTER TABLE recurring ADD COLUMN auto_paid INTEGER NOT NULL DEFAULT 1")
        ecols = {r[1] for r in conn.execute("PRAGMA table_info(entries)")}
        if "source" not in ecols:
            conn.execute("ALTER TABLE entries ADD COLUMN source TEXT")
        gcols = {r[1] for r in conn.execute("PRAGMA table_info(goals)")}
        if "start_date" not in gcols:
            conn.execute("ALTER TABLE goals ADD COLUMN start_date TEXT")
        if conn.execute("SELECT COUNT(*) FROM categories").fetchone()[0] == 0:
            conn.executemany(
                "INSERT INTO categories (name, kind, color) VALUES (?,?,?)",
                DEFAULT_CATEGORIES,
            )


def rows(cur):
    return [dict(r) for r in cur.fetchall()]


# ---------------------------------------------------------------- helpers
class ApiError(Exception):
    def __init__(self, msg, status=400):
        super().__init__(msg)
        self.status = status


def r2(x):
    return round(float(x or 0) + 0.0, 2)


def ym_of(d):
    return d[:7]


def ym_add(ym, n):
    y, m = int(ym[:4]), int(ym[5:7])
    t = y * 12 + (m - 1) + n
    return f"{t // 12:04d}-{t % 12 + 1:02d}"


def months_between(a, b):
    """Number of months from a to b (b - a)."""
    return (int(b[:4]) - int(a[:4])) * 12 + int(b[5:7]) - int(a[5:7])


def today():
    return date.today()


def check_ym(ym):
    if not ym or not YM_RE.match(ym):
        raise ApiError("Neveljaven mesec (pričakovano LLLL-MM)")
    return ym


def num(v, name, allow_negative=False):
    try:
        x = float(str(v).replace(",", "."))
    except (TypeError, ValueError):
        raise ApiError(f"Neveljaven znesek: {name}")
    if not allow_negative and x < 0:
        raise ApiError(f"{name} ne sme biti negativen")
    return round(x, 2)


def opt_int(v):
    if v in (None, "", 0, "0"):
        return None
    return int(v)


# ---------------------------------------------------------------- recurring templates
def generate_recurring(conn, ym):
    """Create the entries of the recurring templates for month ym (only once)."""
    recs = conn.execute(
        "SELECT * FROM recurring WHERE active=1 AND start_ym<=? AND (end_ym IS NULL OR end_ym='' OR end_ym>=?)",
        (ym, ym),
    ).fetchall()
    y, m = int(ym[:4]), int(ym[5:7])
    last = monthrange(y, m)[1]
    for r in recs:
        done = conn.execute(
            "SELECT 1 FROM recurring_generated WHERE recurring_id=? AND ym=?",
            (r["id"], ym),
        ).fetchone()
        if done:
            continue
        d = f"{ym}-{min(max(int(r['day']), 1), last):02d}"
        t = today()
        if r["auto_paid"]:
            paid = 1 if d <= t.isoformat() else 0
        else:
            # manual confirmation: past months count as paid, current and future ones wait for confirmation
            paid = 1 if ym < t.strftime("%Y-%m") else 0
        conn.execute(
            "INSERT INTO entries (date, kind, category_id, goal_id, description, amount, recurring_id, paid)"
            " VALUES (?,?,?,?,?,?,?,?)",
            (d, r["kind"], r["category_id"], r["goal_id"], r["description"], r["amount"], r["id"], paid),
        )
        conn.execute(
            "INSERT INTO recurring_generated (recurring_id, ym) VALUES (?,?)", (r["id"], ym)
        )


def apply_auto_paid(conn):
    """Mark entries of auto-paid templates as paid once their due date has come."""
    conn.execute(
        """UPDATE entries SET paid=1 WHERE paid=0 AND date<=? AND recurring_id IN
           (SELECT id FROM recurring WHERE auto_paid=1)""",
        (today().isoformat(),),
    )


def generate_upto(conn, ym):
    """Fill in recurring entries for every month from the earliest template up to ym."""
    first = conn.execute("SELECT MIN(start_ym) FROM recurring WHERE active=1").fetchone()[0]
    if not first or first > ym:
        return
    cur = first
    while cur <= ym:
        generate_recurring(conn, cur)
        cur = ym_add(cur, 1)


# ---------------------------------------------------------------- goals
def goal_status(conn, g, ym):
    """Goal status at the end of month ym, plus how much has to be put aside this month."""
    start = f"{ym}-01"
    end = f"{ym}-31"
    before = conn.execute(
        "SELECT COALESCE(SUM(amount),0) FROM entries WHERE kind='saving' AND goal_id=? AND date<?",
        (g["id"], start),
    ).fetchone()[0]
    this_month = conn.execute(
        "SELECT COALESCE(SUM(amount),0) FROM entries WHERE kind='saving' AND goal_id=? AND date>=? AND date<=?",
        (g["id"], start, end),
    ).fetchone()[0]
    total_all = conn.execute(
        "SELECT COALESCE(SUM(amount),0) FROM entries WHERE kind='saving' AND goal_id=? AND date<=?",
        (g["id"], today().isoformat()),
    ).fetchone()[0]
    saved_before = g["start_amount"] + before
    saved_end = saved_before + this_month
    saved_now = g["start_amount"] + total_all
    target = g["target"]
    needed_month = 0.0
    months_left = None
    sym = (g["start_date"] or "")[:7] if "start_date" in g.keys() else ""
    not_started = bool(sym) and ym < sym
    monthly_plan = None
    if g["target_date"]:
        tym = g["target_date"][:7]
        months_left = months_between(ym, tym) + 1
        remaining_before = max(0.0, target - saved_before)
        if not_started:
            # before its start the goal reserves nothing; plan = remainder spread from start to deadline
            span = months_between(sym, tym) + 1
            monthly_plan = remaining_before / span if span >= 1 and remaining_before > 0 else 0.0
        elif months_left >= 1 and remaining_before > 0:
            needed_month = remaining_before / months_left
        elif months_left < 1:
            months_left = 0
    planned_left = max(0.0, needed_month - this_month)
    return {
        "id": g["id"],
        "name": g["name"],
        "color": g["color"],
        "target": r2(target),
        "target_date": g["target_date"],
        "start_date": g["start_date"] if "start_date" in g.keys() else None,
        "not_started": not_started,
        "monthly_plan": r2(monthly_plan) if monthly_plan is not None else None,
        "start_amount": r2(g["start_amount"]),
        "archived": g["archived"],
        "saved": r2(saved_end),
        "saved_total": r2(saved_now),
        "progress": round(min(1.0, saved_end / target), 4) if target > 0 else 0,
        "months_left": months_left,
        "needed_this_month": r2(needed_month),
        "contributed_this_month": r2(this_month),
        "planned_left": r2(planned_left),
        "reached": saved_end >= target > 0,
    }


# ---------------------------------------------------------------- carry-over between months
def carry_enabled(conn, ym):
    r = conn.execute("SELECT carry_in FROM month_settings WHERE ym=?", (ym,)).fetchone()
    return True if r is None else bool(r[0])


def compute_carry(conn, ym):
    """Carry-over into month ym = closing balance of the previous month (its balance + its own carry-over)."""
    if not carry_enabled(conn, ym):
        return 0.0
    first = conn.execute("SELECT MIN(substr(date,1,7)) FROM entries").fetchone()[0]
    if not first or first >= ym:
        return 0.0
    bal = {
        r["ym"]: r["b"]
        for r in conn.execute(
            """SELECT substr(date,1,7) AS ym,
                      SUM(CASE WHEN kind='income' THEN amount ELSE -amount END) AS b
               FROM entries WHERE date<? GROUP BY ym""",
            (f"{ym}-01",),
        )
    }
    off = {r[0] for r in conn.execute("SELECT ym FROM month_settings WHERE carry_in=0")}
    carry, cur = 0.0, first
    while cur < ym:
        cin = 0.0 if cur in off else carry
        carry = cin + bal.get(cur, 0.0)
        cur = ym_add(cur, 1)
    return carry


# ---------------------------------------------------------------- account balance
# Anchor = the real account balance at the end of a given day. From there (forwards and backwards) the balance is computed from the entries.
SIGNED = "CASE WHEN kind='income' THEN amount ELSE -amount END"


def get_account(conn):
    rows_ = dict(conn.execute("SELECT key, value FROM settings WHERE key IN ('account_amount','account_date')").fetchall())
    if "account_amount" not in rows_ or "account_date" not in rows_:
        return None
    return {"amount": float(rows_["account_amount"]), "date": rows_["account_date"]}


def set_account(conn, data):
    amount = num(data.get("amount"), "Stanje", allow_negative=True)
    d = str(data.get("date") or today().isoformat())
    if not DATE_RE.match(d):
        raise ApiError("Neveljaven datum")
    for k, v in (("account_amount", str(amount)), ("account_date", d)):
        conn.execute("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (k, v))
    return get_account(conn)


def balance_at(conn, acc, d, paid_only=False):
    """Account balance at the end of day d."""
    paid = " AND paid=1" if paid_only else ""
    if d >= acc["date"]:
        delta = conn.execute(f"SELECT COALESCE(SUM({SIGNED}),0) FROM entries WHERE date>? AND date<=?{paid}", (acc["date"], d)).fetchone()[0]
        return acc["amount"] + delta
    delta = conn.execute(f"SELECT COALESCE(SUM({SIGNED}),0) FROM entries WHERE date>? AND date<=?", (d, acc["date"])).fetchone()[0]
    return acc["amount"] - delta


def account_for_month(conn, ym):
    acc = get_account(conn)
    if not acc:
        return {"configured": False}
    t = today().isoformat()
    month_end = f"{ym}-{monthrange(int(ym[:4]), int(ym[5:7]))[1]:02d}"
    prev_end = f"{ym_add(ym, -1)}-{monthrange(int(ym_add(ym, -1)[:4]), int(ym_add(ym, -1)[5:7]))[1]:02d}"
    out = {
        "configured": True,
        "anchor_amount": r2(acc["amount"]),
        "anchor_date": acc["date"],
        "start": r2(balance_at(conn, acc, prev_end)),
        "end": r2(balance_at(conn, acc, month_end)),
        "now": None,
    }
    if ym == t[:7]:
        out["now"] = r2(balance_at(conn, acc, t, paid_only=True))
    return out


LANGS = ("sl", "en", "de")


def get_lang(conn):
    """Interface language last chosen on any device (kept with the data, so every browser opens in it)."""
    row = conn.execute("SELECT value FROM settings WHERE key='lang'").fetchone()
    return row[0] if row and row[0] in LANGS else None


def set_prefs(conn, data):
    lang = (data or {}).get("lang")
    if lang not in LANGS:
        raise ApiError("Neznan jezik")
    conn.execute("INSERT INTO settings (key, value) VALUES ('lang', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", (lang,))
    return {"lang": lang}


def set_month_settings(conn, data):
    ym = check_ym(str(data.get("ym", "")))
    carry = 0 if data.get("carry_in") in (False, 0, "0") else 1
    conn.execute(
        "INSERT INTO month_settings (ym, carry_in) VALUES (?,?) ON CONFLICT(ym) DO UPDATE SET carry_in=excluded.carry_in",
        (ym, carry),
    )
    return {"ym": ym, "carry_in": bool(carry)}


# ---------------------------------------------------------------- month
def month_summary(conn, ym):
    with _lock:
        # an empty (e.g. deleted) month the user opens is filled from the current templates
        if not conn.execute("SELECT 1 FROM entries WHERE substr(date,1,7)=? LIMIT 1", (ym,)).fetchone():
            conn.execute("DELETE FROM recurring_generated WHERE ym=?", (ym,))
        generate_upto(conn, ym)
        apply_auto_paid(conn)
        conn.commit()
    start, end = f"{ym}-01", f"{ym}-31"
    entries = rows(
        conn.execute(
            """SELECT e.*, c.name AS category_name, c.color AS category_color, g.name AS goal_name
               FROM entries e
               LEFT JOIN categories c ON c.id=e.category_id
               LEFT JOIN goals g ON g.id=e.goal_id
               WHERE e.date>=? AND e.date<=? ORDER BY e.date, e.id""",
            (start, end),
        )
    )
    totals = {k: 0.0 for k in KINDS}
    unpaid_expense = overdue_expense = 0.0
    overdue_count = 0
    tiso = today().isoformat()
    for e in entries:
        totals[e["kind"]] += e["amount"]
        if e["kind"] == "expense" and not e["paid"]:
            unpaid_expense += e["amount"]
            if e["date"] < tiso:
                overdue_expense += e["amount"]
                overdue_count += 1

    cats = rows(conn.execute("SELECT * FROM categories ORDER BY kind DESC, name"))
    spent = {}
    for e in entries:
        if e["category_id"]:
            spent[e["category_id"]] = spent.get(e["category_id"], 0) + e["amount"]
    categories = []
    budget_left_total = 0.0
    for c in cats:
        s = spent.get(c["id"], 0.0)
        if c["archived"] and not s:
            continue
        item = {**c, "spent": r2(s)}
        if c["kind"] == "expense" and c["budget"] > 0:
            item["remaining"] = r2(c["budget"] - s)
            budget_left_total += max(0.0, c["budget"] - s)
        categories.append(item)

    goals = [
        goal_status(conn, g, ym)
        for g in conn.execute("SELECT * FROM goals WHERE archived=0 ORDER BY id").fetchall()
    ]
    planned_savings = sum(g["planned_left"] for g in goals)

    carry_on = carry_enabled(conn, ym)
    carry_in = compute_carry(conn, ym)
    balance = totals["income"] - totals["expense"] - totals["saving"]
    available = carry_in + balance - planned_savings
    # free to spend = available minus the unspent part of category budgets
    free_to_spend = available - budget_left_total

    t = today()
    cur_ym = t.strftime("%Y-%m")
    y, m = int(ym[:4]), int(ym[5:7])
    days_in_month = monthrange(y, m)[1]
    if ym == cur_ym:
        days_left = days_in_month - t.day + 1
    elif ym > cur_ym:
        days_left = days_in_month
    else:
        days_left = 0
    per_day = available / days_left if days_left else None

    # whether the month can be filled from templates (e.g. after it was deleted)
    templates = conn.execute(
        "SELECT COUNT(*) FROM recurring WHERE active=1 AND start_ym<=? AND (end_ym IS NULL OR end_ym='' OR end_ym>=?)",
        (ym, ym),
    ).fetchone()[0]
    can_fill = templates > 0 and not any(e["recurring_id"] for e in entries)

    return {
        "ym": ym,
        "can_fill": can_fill,
        "entries": entries,
        "totals": {k: r2(v) for k, v in totals.items()},
        "balance": r2(balance),
        "carry_in": r2(carry_in),
        "carry_enabled": carry_on,
        "carry_from": ym_add(ym, -1),
        "account": account_for_month(conn, ym),
        "closing": r2(carry_in + balance),
        "unpaid_expense": r2(unpaid_expense),
        "overdue_expense": r2(overdue_expense),
        "overdue_count": overdue_count,
        "planned_savings": r2(planned_savings),
        "available": r2(available),
        "budget_left": r2(budget_left_total),
        "free_to_spend": r2(free_to_spend),
        "days_left": days_left,
        "per_day": r2(per_day) if per_day is not None else None,
        "categories": categories,
        "goals": goals,
    }


# ---------------------------------------------------------------- year / years
def year_summary(conn, y):
    months = [f"{y:04d}-{m:02d}" for m in range(1, 13)]
    # the overview does not create months; they are created when opened in the Month tab
    with _lock:
        apply_auto_paid(conn)
        conn.commit()
    data = {k: [0.0] * 12 for k in KINDS}
    for r in conn.execute(
        "SELECT substr(date,6,2) AS m, kind, SUM(amount) AS s FROM entries WHERE substr(date,1,4)=? GROUP BY m, kind",
        (f"{y:04d}",),
    ):
        data[r["kind"]][int(r["m"]) - 1] = r2(r["s"])
    cats = rows(
        conn.execute(
            """SELECT c.id, c.name, c.color, c.kind, SUM(e.amount) AS total
               FROM entries e JOIN categories c ON c.id=e.category_id
               WHERE substr(e.date,1,4)=? GROUP BY c.id ORDER BY total DESC""",
            (f"{y:04d}",),
        )
    )
    for c in cats:
        c["total"] = r2(c["total"])
    totals = {k: r2(sum(v)) for k, v in data.items()}
    # total savings per month (cumulative, all goals + starting amounts)
    start_amounts = conn.execute("SELECT COALESCE(SUM(start_amount),0) FROM goals").fetchone()[0]
    before = conn.execute(
        "SELECT COALESCE(SUM(amount),0) FROM entries WHERE kind='saving' AND date<?",
        (f"{y:04d}-01-01",),
    ).fetchone()[0]
    cum, acc = [], start_amounts + before
    for i in range(12):
        acc += data["saving"][i]
        cum.append(r2(acc))
    return {
        "year": y,
        "months": months,
        "series": data,
        "totals": totals,
        "balance": r2(totals["income"] - totals["expense"] - totals["saving"]),
        "savings_cumulative": cum,
        "categories": cats,
    }


def years_summary(conn):
    out = []
    for r in conn.execute(
        "SELECT substr(date,1,4) AS y, kind, SUM(amount) AS s FROM entries GROUP BY y, kind ORDER BY y"
    ):
        if not out or out[-1]["year"] != int(r["y"]):
            out.append({"year": int(r["y"]), "income": 0.0, "expense": 0.0, "saving": 0.0})
        out[-1][r["kind"]] = r2(r["s"])
    return out


# ---------------------------------------------------------------- CRUD
def save_entry(conn, data, eid=None):
    d = str(data.get("date", ""))
    if not DATE_RE.match(d):
        raise ApiError("Neveljaven datum")
    kind = data.get("kind")
    if kind not in KINDS:
        raise ApiError("Neveljavna vrsta")
    amount = num(data.get("amount"), "Znesek", allow_negative=(kind == "saving"))
    cat = opt_int(data.get("category_id"))
    goal = opt_int(data.get("goal_id"))
    if kind == "saving":
        cat = None
        if not goal:
            raise ApiError("Izberi cilj varčevanja")
    else:
        goal = None
        if not cat:
            raise ApiError("Izberi kategorijo")
    paid = 1 if data.get("paid", True) in (True, 1, "1", "true") else 0
    vals = (d, kind, cat, goal, str(data.get("description", ""))[:200], amount, paid)
    if eid:
        cur = conn.execute(
            "UPDATE entries SET date=?, kind=?, category_id=?, goal_id=?, description=?, amount=?, paid=? WHERE id=?",
            vals + (eid,),
        )
        if cur.rowcount == 0:
            raise ApiError("Ni najdeno", 404)
        return eid
    cur = conn.execute(
        "INSERT INTO entries (date, kind, category_id, goal_id, description, amount, paid) VALUES (?,?,?,?,?,?,?)",
        vals,
    )
    return cur.lastrowid


def save_category(conn, data, cid=None):
    name = str(data.get("name", "")).strip()
    if not name:
        raise ApiError("Ime je obvezno")
    kind = data.get("kind")
    if kind not in ("income", "expense"):
        raise ApiError("Neveljavna vrsta")
    budget = num(data.get("budget", 0) or 0, "Proračun")
    color = str(data.get("color") or "#888888")[:9]
    archived = 1 if data.get("archived") in (True, 1, "1") else 0
    if cid:
        conn.execute(
            "UPDATE categories SET name=?, kind=?, budget=?, color=?, archived=? WHERE id=?",
            (name, kind, budget, color, archived, cid),
        )
        return cid
    return conn.execute(
        "INSERT INTO categories (name, kind, budget, color) VALUES (?,?,?,?)",
        (name, kind, budget, color),
    ).lastrowid


def save_goal(conn, data, gid=None):
    name = str(data.get("name", "")).strip()
    if not name:
        raise ApiError("Ime je obvezno")
    target = num(data.get("target"), "Ciljni znesek")
    if target <= 0:
        raise ApiError("Ciljni znesek mora biti večji od 0")
    td = data.get("target_date") or None
    if td:
        td = str(td)
        if YM_RE.match(td):
            td = td + "-01"
        if not DATE_RE.match(td):
            raise ApiError("Neveljaven ciljni datum")
    sd = data.get("start_date") or None
    if sd:
        sd = str(sd)
        if YM_RE.match(sd):
            sd = sd + "-01"
        if not DATE_RE.match(sd):
            raise ApiError("Neveljaven začetek cilja")
        if td and sd[:7] > td[:7]:
            raise ApiError("Začetek cilja mora biti pred rokom")
    start = num(data.get("start_amount", 0) or 0, "Začetni znesek")
    color = str(data.get("color") or "#2f855a")[:9]
    archived = 1 if data.get("archived") in (True, 1, "1") else 0
    if gid:
        conn.execute(
            "UPDATE goals SET name=?, target=?, target_date=?, start_date=?, start_amount=?, color=?, archived=? WHERE id=?",
            (name, target, td, sd, start, color, archived, gid),
        )
        return gid
    return conn.execute(
        "INSERT INTO goals (name, target, target_date, start_date, start_amount, color) VALUES (?,?,?,?,?,?)",
        (name, target, td, sd, start, color),
    ).lastrowid


def save_recurring(conn, data, rid=None):
    kind = data.get("kind")
    if kind not in KINDS:
        raise ApiError("Neveljavna vrsta")
    amount = num(data.get("amount"), "Znesek")
    cat = opt_int(data.get("category_id"))
    goal = opt_int(data.get("goal_id"))
    if kind == "saving":
        cat = None
        if not goal:
            raise ApiError("Izberi cilj varčevanja")
    else:
        goal = None
        if not cat:
            raise ApiError("Izberi kategorijo")
    day = int(data.get("day") or 1)
    if not 1 <= day <= 31:
        raise ApiError("Dan mora biti med 1 in 31")
    start = check_ym(str(data.get("start_ym") or today().strftime("%Y-%m")))
    end = data.get("end_ym") or None
    if end:
        check_ym(end)
    active = 0 if data.get("active") in (False, 0, "0") else 1
    auto = 0 if data.get("auto_paid") in (False, 0, "0") else 1
    vals = (kind, cat, goal, str(data.get("description", ""))[:200], amount, day, start, end, active, auto)
    if rid:
        conn.execute(
            "UPDATE recurring SET kind=?, category_id=?, goal_id=?, description=?, amount=?, day=?, start_ym=?, end_ym=?, active=?, auto_paid=? WHERE id=?",
            vals + (rid,),
        )
        # also update this template's unpaid future entries
        conn.execute(
            "UPDATE entries SET kind=?, category_id=?, goal_id=?, description=?, amount=? WHERE recurring_id=? AND paid=0 AND date>?",
            (kind, cat, goal, vals[3], amount, rid, today().isoformat()),
        )
        return rid
    return conn.execute(
        "INSERT INTO recurring (kind, category_id, goal_id, description, amount, day, start_ym, end_ym, active, auto_paid) VALUES (?,?,?,?,?,?,?,?,?,?)",
        vals,
    ).lastrowid


# ---------------------------------------------------------------- month management
def months_list(conn):
    """All months that have entries or were already filled from templates."""
    yms = {r[0] for r in conn.execute("SELECT DISTINCT substr(date,1,7) FROM entries")}
    yms |= {r[0] for r in conn.execute("SELECT DISTINCT ym FROM recurring_generated")}
    stats = {}
    for r in conn.execute(
        """SELECT substr(date,1,7) AS ym, kind, COUNT(*) AS n, SUM(amount) AS s,
                  SUM(CASE WHEN recurring_id IS NOT NULL THEN 1 ELSE 0 END) AS nrec
           FROM entries GROUP BY ym, kind"""
    ):
        st = stats.setdefault(r["ym"], {"income": 0.0, "expense": 0.0, "saving": 0.0, "count": 0, "from_templates": 0})
        st[r["kind"]] = r2(r["s"])
        st["count"] += r["n"]
        st["from_templates"] += r["nrec"]
    cur = today().strftime("%Y-%m")
    out = []
    for ym in sorted(yms, reverse=True):
        st = stats.get(ym)
        if not st:  # empty (deleted) months are not listed
            continue
        acc = get_account(conn)
        if acc:
            st = {**st, "balance_end": r2(balance_at(conn, acc, f"{ym}-{monthrange(int(ym[:4]), int(ym[5:7]))[1]:02d}"))}
        out.append({**st, "ym": ym, "manual": st["count"] - st["from_templates"],
                    "status": "future" if ym > cur else "current" if ym == cur else "past"})
    return out


def refresh_month(conn, ym):
    """Remove template entries and recreate them from the current templates. Manual entries stay."""
    check_ym(ym)
    removed = conn.execute(
        "DELETE FROM entries WHERE recurring_id IS NOT NULL AND substr(date,1,7)=?", (ym,)
    ).rowcount
    conn.execute("DELETE FROM recurring_generated WHERE ym=?", (ym,))
    generate_recurring(conn, ym)
    added = conn.execute(
        "SELECT COUNT(*) FROM entries WHERE recurring_id IS NOT NULL AND substr(date,1,7)=?", (ym,)
    ).fetchone()[0]
    return {"ym": ym, "removed": removed, "added": added}


def delete_month(conn, ym):
    """Delete all entries of the month. Templates are marked as used so the month does not refill by itself."""
    check_ym(ym)
    removed = conn.execute("DELETE FROM entries WHERE substr(date,1,7)=?", (ym,)).rowcount
    conn.execute("DELETE FROM recurring_generated WHERE ym=?", (ym,))
    conn.execute(
        "INSERT INTO recurring_generated (recurring_id, ym) SELECT id, ? FROM recurring", (ym,)
    )
    return {"ym": ym, "removed": removed}


def export_json(c):
    """All data in the format of the Google/local editions (expenses-data.json)."""
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "entries" not in tables or "categories" not in tables:
        raise ApiError("Baza je nepopolna")
    cols = lambda t: {r[1] for r in c.execute(f"PRAGMA table_info({t})")}
    rows = lambda q: [dict(r) for r in c.execute(q)]
    i = lambda v: None if v in (None, "") else int(v)
    f = lambda v: round(float(v or 0), 2)

    cats = [{"id": r["id"], "name": r["name"], "kind": r["kind"], "budget": f(r["budget"]), "color": r["color"], "archived": int(r["archived"])}
            for r in rows("SELECT * FROM categories ORDER BY id")]
    goals = [{"id": r["id"], "name": r["name"], "target": f(r["target"]), "target_date": r["target_date"] or None, "start_date": (r["start_date"] if "start_date" in r else None) or None,
              "start_amount": f(r["start_amount"]), "color": r["color"], "archived": int(r["archived"])}
             for r in rows("SELECT * FROM goals ORDER BY id")] if "goals" in tables else []
    rc = cols("recurring") if "recurring" in tables else set()
    rec = [{"id": r["id"], "kind": r["kind"], "category_id": i(r["category_id"]), "goal_id": i(r["goal_id"]), "description": r["description"] or "",
            "amount": f(r["amount"]), "day": int(r["day"]), "start_ym": r["start_ym"], "end_ym": r["end_ym"] or None,
            "active": int(r["active"]), "auto_paid": int(r["auto_paid"]) if "auto_paid" in rc else 1}
           for r in rows("SELECT * FROM recurring ORDER BY id")] if rc else []
    ec = cols("entries")
    entries = []
    for r in rows("SELECT * FROM entries ORDER BY date, id"):
        e = {"id": r["id"], "date": r["date"], "kind": r["kind"], "category_id": i(r["category_id"]), "goal_id": i(r["goal_id"]),
             "description": r["description"] or "", "amount": f(r["amount"]), "recurring_id": i(r["recurring_id"]), "paid": int(r["paid"])}
        if "source" in ec and r["source"]:
            e["source"] = r["source"]
        entries.append(e)
    generated = {f'{r["recurring_id"]}|{r["ym"]}': 1 for r in rows("SELECT * FROM recurring_generated")} if "recurring_generated" in tables else {}
    month_settings = {r["ym"]: int(r["carry_in"]) for r in rows("SELECT * FROM month_settings")} if "month_settings" in tables else {}
    settings = {r["key"]: r["value"] for r in rows("SELECT * FROM settings")} if "settings" in tables else {}

    seq = {"categories": max([x["id"] for x in cats] or [0]), "goals": max([x["id"] for x in goals] or [0]),
           "recurring": max([x["id"] for x in rec] or [0]), "entries": max([x["id"] for x in entries] or [0])}
    db = {"categories": cats, "goals": goals, "recurring": rec, "generated": generated, "entries": entries, "seq": seq,
          "monthSettings": month_settings}
    if "account_amount" in settings and "account_date" in settings:
        db["account"] = {"amount": f(settings["account_amount"]), "date": settings["account_date"]}
    bk = {"frequency": "weekly", "weekday": "6", "monthday": "1", "time": "03:00", "keep": "8"}
    for k in bk:
        if "backup_" + k in settings:
            bk[k] = settings["backup_" + k]
    if settings.get("lang"):
        db["prefs"] = {"lang": settings["lang"]}
    return {"app": "expenses", "format": 1, "saved_at": datetime.now().isoformat(timespec="seconds"), "source": "nas",
            "db": db, "backup": {"settings": bk, "last_auto": settings.get("backup_last_auto") or None}}


def export_csv(conn):
    buf = io.StringIO()
    w = csv.writer(buf, delimiter=";")
    w.writerow(["datum", "vrsta", "kategorija", "cilj", "opis", "znesek", "placano"])
    names = {"income": "prihodek", "expense": "strošek", "saving": "varčevanje"}
    for r in conn.execute(
        """SELECT e.date, e.kind, c.name, g.name, e.description, e.amount, e.paid
           FROM entries e LEFT JOIN categories c ON c.id=e.category_id
           LEFT JOIN goals g ON g.id=e.goal_id ORDER BY e.date, e.id"""
    ):
        w.writerow([r[0], names[r[1]], r[2] or "", r[3] or "", r[4], f"{r[5]:.2f}".replace(".", ","), "da" if r[6] else "ne"])
    return "﻿" + buf.getvalue()


# ---------------------------------------------------------------- Excel import
NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main",
      "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
      "pr": "http://schemas.openxmlformats.org/package/2006/relationships"}


def read_xlsx(data):
    """Read an .xlsx without external libraries. Returns [{name, cells: {"B3": value}}]; formulas give their cached value."""
    try:
        z = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile:
        raise ApiError("Datoteka ni veljaven Excel (.xlsx)")
    names = set(z.namelist())
    if "xl/workbook.xml" not in names:
        raise ApiError("Datoteka ni veljaven Excel (.xlsx)")
    shared = []
    if "xl/sharedStrings.xml" in names:
        for si in ET.fromstring(z.read("xl/sharedStrings.xml")).findall("m:si", NS):
            shared.append("".join(t.text or "" for t in si.iter("{%s}t" % NS["m"])))
    rels = {}
    if "xl/_rels/workbook.xml.rels" in names:
        for r in ET.fromstring(z.read("xl/_rels/workbook.xml.rels")).findall("pr:Relationship", NS):
            t = r.get("Target", "")
            t = t.lstrip("/") if t.startswith("/") else "xl/" + t
            rels[r.get("Id")] = t
    out = []
    wb = ET.fromstring(z.read("xl/workbook.xml"))
    for sh in wb.findall("m:sheets/m:sheet", NS):
        path = rels.get(sh.get("{%s}id" % NS["r"]))
        if not path or path not in names:
            continue
        cells = {}
        root = ET.fromstring(z.read(path))
        for c in root.iter("{%s}c" % NS["m"]):
            ref, t = c.get("r"), c.get("t")
            v = c.find("m:v", NS)
            if t == "inlineStr":
                val = "".join(x.text or "" for x in c.iter("{%s}t" % NS["m"]))
            elif v is None or v.text is None:
                continue
            elif t == "s":
                val = shared[int(v.text)] if int(v.text) < len(shared) else ""
            elif t in ("str", "e"):
                val = v.text
            elif t == "b":
                val = v.text == "1"
            else:
                try:
                    val = float(v.text)
                except ValueError:
                    val = v.text
            if ref and val not in ("", None):
                cells[ref] = val
        out.append({"name": sh.get("name"), "cells": cells})
    return out


def import_commit(conn, data):
    """Import prepared months. Entries imported earlier for the same month are replaced; manual entries stay."""
    months = data.get("months") or []
    mapping = data.get("mapping") or {}
    carry_mode = data.get("carry_mode", "sheet")
    if not months:
        raise ApiError("Ni izbranih mesecev za uvoz")
    # categories (existing or new)
    cat_for = {}
    for group, target in mapping.items():
        kind = "income" if group == "income" else "expense"
        if isinstance(target, str) and target.startswith("new:"):
            name = target[4:].strip()[:60] or "Uvoz"
            row = conn.execute("SELECT id FROM categories WHERE lower(name)=lower(?) AND kind=?", (name, kind)).fetchone()
            if row:
                cat_for[group] = row[0]
                conn.execute("UPDATE categories SET archived=0 WHERE id=?", (row[0],))
            else:
                palette = ["#2c7a7b", "#b7791f", "#6b46c1", "#c05621", "#2b6cb0", "#d53f8c", "#4a5568", "#38a169", "#dd6b20", "#805ad5"]
                color = palette[len(cat_for) % len(palette)]
                cat_for[group] = conn.execute("INSERT INTO categories (name, kind, color) VALUES (?,?,?)", (name, kind, color)).lastrowid
        else:
            cid = opt_int(target)
            if not cid or not conn.execute("SELECT 1 FROM categories WHERE id=?", (cid,)).fetchone():
                raise ApiError(f"Izberi kategorijo za skupino {group}")
            cat_for[group] = cid
    added = replaced = 0
    done = []
    for m in months:
        ym = check_ym(str(m.get("ym", "")))
        replaced += conn.execute("DELETE FROM entries WHERE source='excel' AND substr(date,1,7)=?", (ym,)).rowcount
        for e in m.get("entries") or []:
            kind = e.get("kind")
            if kind not in ("income", "expense"):
                continue
            group = e.get("group")
            if group not in cat_for:
                raise ApiError(f"Manjka kategorija za skupino {group}")
            amount = num(e.get("amount"), "Znesek", allow_negative=True)
            if amount == 0:
                continue
            day = min(max(int(e.get("day") or 1), 1), monthrange(int(ym[:4]), int(ym[5:7]))[1])
            conn.execute(
                "INSERT INTO entries (date, kind, category_id, goal_id, description, amount, recurring_id, paid, source)"
                " VALUES (?,?,?,?,?,?,?,?,?)",
                (f"{ym}-{day:02d}", kind, cat_for[group], None, str(e.get("description") or "")[:200], amount, None, 1, "excel"),
            )
            added += 1
        # templates are not generated for this month any more (fixed costs would be doubled)
        conn.execute("DELETE FROM recurring_generated WHERE ym=?", (ym,))
        conn.execute("INSERT INTO recurring_generated (recurring_id, ym) SELECT id, ? FROM recurring", (ym,))
        conn.execute("DELETE FROM entries WHERE recurring_id IS NOT NULL AND substr(date,1,7)=?", (ym,))
        if carry_mode == "sheet":
            set_month_settings(conn, {"ym": ym, "carry_in": False})
        done.append(ym)
    templates = 0
    tpl = data.get("templates")
    if tpl and tpl.get("items"):
        start = check_ym(str(tpl.get("start_ym")))
        for e in tpl["items"]:
            group = e.get("group")
            if group not in cat_for:
                continue
            conn.execute(
                "INSERT INTO recurring (kind, category_id, goal_id, description, amount, day, start_ym, end_ym, active, auto_paid)"
                " VALUES (?,?,?,?,?,?,?,?,?,?)",
                ("expense", cat_for[group], None, str(e.get("description") or "")[:200],
                 num(e.get("amount"), "Znesek"), 1, start, None, 1, 1),
            )
            templates += 1
    return {"months": done, "added": added, "replaced": replaced, "templates": templates}


def imported_months(conn):
    return [r[0] for r in conn.execute("SELECT DISTINCT substr(date,1,7) FROM entries WHERE source='excel' ORDER BY 1")]


# ---------------------------------------------------------------- backups
BACKUP_DEFAULTS = {"frequency": "weekly", "weekday": "6", "monthday": "1", "time": "03:00", "keep": "8", "last_auto": ""}
FREQS = ("off", "daily", "weekly", "monthly")
WEEKDAYS = ["ponedeljek", "torek", "sreda", "četrtek", "petek", "sobota", "nedelja"]


def get_backup_settings(conn):
    out = dict(BACKUP_DEFAULTS)
    for k, v in conn.execute("SELECT key, value FROM settings WHERE key LIKE 'backup_%'"):
        out[k[7:]] = v
    return out


def save_backup_settings(conn, data):
    freq = data.get("frequency")
    if freq not in FREQS:
        raise ApiError("Neveljavna pogostost")
    weekday = int(data.get("weekday", 6))
    monthday = int(data.get("monthday", 1))
    keep = int(data.get("keep", 8))
    t = str(data.get("time", "03:00"))
    if not 0 <= weekday <= 6:
        raise ApiError("Neveljaven dan v tednu")
    if not 1 <= monthday <= 28:
        raise ApiError("Dan v mesecu mora biti med 1 in 28")
    if not 1 <= keep <= 365:
        raise ApiError("Število kopij mora biti med 1 in 365")
    if not re.match(r"^([01]\d|2[0-3]):[0-5]\d$", t):
        raise ApiError("Neveljavna ura (pričakovano HH:MM)")
    vals = {"frequency": freq, "weekday": str(weekday), "monthday": str(monthday), "time": t, "keep": str(keep),
            # the next automatic backup happens at the next slot, not right away
            "last_auto": datetime.now().isoformat(timespec="seconds")}
    for k, v in vals.items():
        conn.execute("INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                     ("backup_" + k, v))
    return backup_overview(conn)


def last_slot(st, now):
    """Last scheduled slot <= now (or None when switched off)."""
    if st["frequency"] == "off":
        return None
    hh, mm = map(int, st["time"].split(":"))
    slot = now.replace(hour=hh, minute=mm, second=0, microsecond=0)
    if st["frequency"] == "daily":
        return slot if slot <= now else slot - timedelta(days=1)
    if st["frequency"] == "weekly":
        slot -= timedelta(days=(slot.weekday() - int(st["weekday"])) % 7)
        return slot if slot <= now else slot - timedelta(days=7)
    # monthly
    slot = slot.replace(day=int(st["monthday"]))
    if slot > now:
        y, m = (slot.year, slot.month - 1) if slot.month > 1 else (slot.year - 1, 12)
        slot = slot.replace(year=y, month=m)
    return slot


def next_slot(st, now):
    s = last_slot(st, now)
    if s is None:
        return None
    if st["frequency"] == "daily":
        return s + timedelta(days=1)
    if st["frequency"] == "weekly":
        return s + timedelta(days=7)
    y, m = (s.year, s.month + 1) if s.month < 12 else (s.year + 1, 1)
    return s.replace(year=y, month=m)


def list_backups():
    if not BACKUP_DIR.is_dir():
        return []
    out = []
    for f in BACKUP_DIR.iterdir():
        m = BACKUP_NAME_RE.match(f.name)
        if f.is_file() and m:
            day, hh, mm, ss, kind = m.groups()
            out.append({"name": f.name, "size": f.stat().st_size, "kind": kind,
                        "created": f"{day}T{hh}:{mm}:{ss}"})
    return sorted(out, key=lambda b: b["created"], reverse=True)


def make_backup(kind="manual"):
    BACKUP_DIR.mkdir(parents=True, exist_ok=True)
    name = f"expenses-{datetime.now().strftime('%Y-%m-%d_%H%M%S')}-{kind}.db"
    target = BACKUP_DIR / name
    src = connect()
    dst = sqlite3.connect(target)
    try:
        src.backup(dst)
    finally:
        dst.close()
        src.close()
    return name


def prune_backups(keep):
    autos = [b for b in list_backups() if b["kind"] == "auto"]
    for b in autos[keep:]:
        try:
            (BACKUP_DIR / b["name"]).unlink()
        except OSError:
            pass


def backup_path(name):
    if not BACKUP_NAME_RE.match(name or ""):
        raise ApiError("Neveljavno ime kopije")
    f = BACKUP_DIR / name
    if not f.is_file():
        raise ApiError("Kopija ne obstaja", 404)
    return f


def restore_backup(name):
    f = backup_path(name)
    # check that the backup is a valid database
    try:
        chk = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
        chk.execute("SELECT COUNT(*) FROM entries").fetchone()
        chk.close()
    except sqlite3.Error:
        raise ApiError("Kopija ni veljavna baza podatkov")
    safety = make_backup("pre-restore")
    src = sqlite3.connect(f"file:{f}?mode=ro", uri=True)
    dst = connect()
    try:
        src.backup(dst)
    finally:
        src.close()
        dst.close()
    init_db()  # upgrade the schema if the backup is older
    return {"restored": name, "safety_backup": safety}


def backup_overview(conn):
    st = get_backup_settings(conn)
    nxt = next_slot(st, datetime.now())
    items = list_backups()
    return {
        "settings": {k: st[k] for k in ("frequency", "weekday", "monthday", "time", "keep")},
        "next_run": nxt.isoformat(timespec="minutes") if nxt else None,
        "last_auto": st.get("last_auto") or None,
        "dir": str(BACKUP_DIR),
        "backups": items,
        "total_size": sum(b["size"] for b in items),
    }


def run_scheduled_backup():
    """Called by the background thread; makes a backup when a slot is due."""
    conn = connect()
    try:
        st = get_backup_settings(conn)
        now = datetime.now()
        slot = last_slot(st, now)
        if slot is None:
            return None
        last = st.get("last_auto")
        if last and datetime.fromisoformat(last) >= slot:
            return None
        with _lock:
            name = make_backup("auto")
            conn.execute("INSERT INTO settings (key, value) VALUES ('backup_last_auto', ?) "
                         "ON CONFLICT(key) DO UPDATE SET value=excluded.value", (now.isoformat(timespec="seconds"),))
            conn.commit()
            prune_backups(int(st["keep"]))
        print(f"Automatic backup: {name}", flush=True)
        return name
    finally:
        conn.close()


def backup_scheduler():
    while True:
        try:
            run_scheduled_backup()
        except Exception as e:  # pragma: no cover
            print(f"Automatic backup failed: {e}", flush=True)
        time.sleep(60)


# ---------------------------------------------------------------- HTTP
MIME = {
    ".html": "text/html; charset=utf-8",
    ".js": "application/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".svg": "image/svg+xml",
    ".png": "image/png",
    ".json": "application/manifest+json",
}


class Handler(BaseHTTPRequestHandler):
    server_version = "Expenses/1.0"

    def log_message(self, fmt, *args):
        if os.environ.get("QUIET") != "1":
            super().log_message(fmt, *args)

    # -- helpers
    def send_json(self, obj, status=200):
        body = json.dumps(obj, ensure_ascii=False).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(body)

    def read_json(self):
        n = int(self.headers.get("Content-Length") or 0)
        if n > 1_000_000:
            raise ApiError("Prevelik zahtevek", 413)
        if not n:
            return {}
        try:
            return json.loads(self.rfile.read(n))
        except json.JSONDecodeError:
            raise ApiError("Neveljaven JSON")

    def token_ok(self, qs):
        if not API_TOKEN:
            return False
        auth = self.headers.get("Authorization", "")
        tok = auth[7:] if auth.startswith("Bearer ") else (qs.get("token", [""])[0])
        return hmac.compare_digest(tok, API_TOKEN)

    def auth_ok(self):
        if not APP_USER:
            return True
        auth = self.headers.get("Authorization", "")
        if not auth.startswith("Basic "):
            return False
        try:
            user, _, pw = base64.b64decode(auth[6:]).decode().partition(":")
        except Exception:
            return False
        return hmac.compare_digest(user, APP_USER) and hmac.compare_digest(pw, APP_PASSWORD)

    def deny(self):
        self.send_response(401)
        self.send_header("WWW-Authenticate", 'Basic realm="Expenses", charset="UTF-8"')
        self.send_header("Content-Length", "0")
        self.end_headers()

    # -- methods
    def do_GET(self):
        self.dispatch("GET")

    def do_POST(self):
        self.dispatch("POST")

    def do_PUT(self):
        self.dispatch("PUT")

    def do_DELETE(self):
        self.dispatch("DELETE")

    def dispatch(self, method):
        url = urlparse(self.path)
        path, qs = url.path, parse_qs(url.query)
        try:
            if path == "/api/ha/summary" and method == "GET":
                if not (self.token_ok(qs) or (not API_TOKEN and self.auth_ok())):
                    return self.deny() if not API_TOKEN else self.send_json({"error": "Neveljaven žeton"}, 401)
                return self.send_json(self.ha_summary())
            if path == "/health":
                return self.send_json({"ok": True, "version": APP_VERSION})
            if not self.auth_ok():
                return self.deny()
            if path.startswith("/api/"):
                return self.api(method, path[5:].strip("/").split("/"), qs)
            if method != "GET":
                raise ApiError("Ni dovoljeno", 405)
            return self.static(path)
        except ApiError as e:
            self.send_json({"error": str(e)}, e.status)
        except sqlite3.IntegrityError as e:
            self.send_json({"error": f"Napaka baze: {e}"}, 400)
        except Exception as e:  # pragma: no cover
            self.send_json({"error": f"Notranja napaka: {e}"}, 500)

    def static(self, path):
        if path in ("", "/"):
            path = "/index.html"
        f = (STATIC_DIR / path.lstrip("/")).resolve()
        if STATIC_DIR.resolve() not in f.parents or not f.is_file():
            f = STATIC_DIR / "index.html"
        data = f.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", MIME.get(f.suffix, "application/octet-stream"))
        self.send_header("Content-Length", str(len(data)))
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()
        self.wfile.write(data)

    def ha_summary(self):
        ym = today().strftime("%Y-%m")
        conn = connect()
        try:
            s = month_summary(conn, ym)
        finally:
            conn.close()
        goals = [{"name": g["name"], "saved": g["saved"], "target": g["target"], "percent": round(g["progress"] * 100, 1),
                  "needed_this_month": g["needed_this_month"]} for g in s["goals"]]
        last_backup = (list_backups() or [{}])[0].get("created")
        return {
            "month": ym, "income": s["totals"]["income"], "expenses": s["totals"]["expense"], "savings": s["totals"]["saving"],
            "carried_over": s["carry_in"], "month_end": s["closing"],
            "account_balance": s["account"].get("now"), "account_balance_month_end": s["account"].get("end"),
            "still_to_save": s["planned_savings"], "left_to_spend": s["available"], "free_to_spend": s["free_to_spend"],
            "per_day": s["per_day"], "unpaid_bills": s["unpaid_expense"], "overdue_bills": s["overdue_expense"],
            "overdue_count": s["overdue_count"], "days_left": s["days_left"], "last_backup": last_backup, "goals": goals,
        }

    def api(self, method, parts, qs):
        res = parts[0] if parts else ""
        if res == "backups":
            return self.backups_api(method, parts[1:])
        if res == "import" and len(parts) > 1 and parts[1] == "xlsx" and method == "POST":
            n = int(self.headers.get("Content-Length") or 0)
            if not n:
                raise ApiError("Prazna datoteka")
            if n > 20_000_000:
                raise ApiError("Datoteka je prevelika (največ 20 MB)", 413)
            return self.send_json({"sheets": read_xlsx(self.rfile.read(n))})
        rid = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else None
        conn = connect()
        try:
            out = self.route(conn, method, res, rid, qs)
            conn.commit()
        finally:
            conn.close()
        if isinstance(out, tuple) and out[0] in ("csv", "json"):
            body = out[1].encode("utf-8")
            self.send_response(200)
            if out[0] == "json":
                self.send_header("Content-Type", "application/json; charset=utf-8")
                self.send_header("Content-Disposition", 'attachment; filename="expenses-data.json"')
            else:
                self.send_header("Content-Type", "text/csv; charset=utf-8")
                self.send_header("Content-Disposition", f'attachment; filename="expenses-{today().isoformat()}.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        self.send_json(out)

    def backups_api(self, method, rest):
        name = rest[0] if rest else ""
        action = rest[1] if len(rest) > 1 else ""
        if method == "GET" and not name:
            conn = connect()
            try:
                return self.send_json(backup_overview(conn))
            finally:
                conn.close()
        if method == "PUT" and name == "settings":
            conn = connect()
            try:
                out = save_backup_settings(conn, self.read_json())
                conn.commit()
                return self.send_json(out)
            finally:
                conn.close()
        if method == "POST" and not name:
            with _lock:
                n = make_backup("manual")
            return self.send_json({"name": n})
        if method == "GET" and name:
            f = backup_path(name)
            data = f.read_bytes()
            self.send_response(200)
            self.send_header("Content-Type", "application/vnd.sqlite3")
            self.send_header("Content-Disposition", f'attachment; filename="{f.name}"')
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)
            return
        if method == "POST" and name and action == "restore":
            with _lock:
                return self.send_json(restore_backup(name))
        if method == "DELETE" and name:
            backup_path(name).unlink()
            return self.send_json({"ok": True})
        raise ApiError("Ni najdeno", 404)

    def route(self, conn, method, res, rid, qs):
        q = lambda k, d=None: qs.get(k, [d])[0]
        if res == "month" and method == "GET":
            return month_summary(conn, check_ym(q("ym", today().strftime("%Y-%m"))))
        if res == "year" and method == "GET":
            return year_summary(conn, int(q("y", today().year)))
        if res == "years" and method == "GET":
            return years_summary(conn)
        if res == "import" and method == "GET":
            return {"imported_months": imported_months(conn)}
        if res == "import" and method == "POST":
            with _lock:
                return import_commit(conn, self.read_json())
        if res == "prefs" and method == "PUT":
            return set_prefs(conn, self.read_json())
        if res == "account" and method == "PUT":
            return set_account(conn, self.read_json())
        if res == "month-settings" and method == "POST":
            return set_month_settings(conn, self.read_json())
        if res == "months":
            if method == "GET":
                return months_list(conn)
            if method == "POST":
                # {"action": "refresh"|"delete", "months": ["2026-11", ...]}
                data = self.read_json()
                action, yms = data.get("action"), data.get("months") or []
                if action not in ("refresh", "delete") or not isinstance(yms, list) or not yms:
                    raise ApiError("Izberi vsaj en mesec in dejanje")
                fn = refresh_month if action == "refresh" else delete_month
                with _lock:
                    results = [fn(conn, str(ym)) for ym in yms]
                return {"results": results}
        if res == "export.json" and method == "GET":
            return ("json", json.dumps(export_json(conn), ensure_ascii=False))
        if res == "export.csv" and method == "GET":
            return ("csv", export_csv(conn))
        if res == "meta" and method == "GET":
            return {
                "categories": rows(conn.execute("SELECT * FROM categories ORDER BY kind DESC, archived, name")),
                "goals": rows(conn.execute("SELECT * FROM goals ORDER BY archived, id")),
                "recurring": rows(conn.execute(
                    """SELECT r.*, c.name AS category_name, g.name AS goal_name FROM recurring r
                       LEFT JOIN categories c ON c.id=r.category_id LEFT JOIN goals g ON g.id=r.goal_id
                       ORDER BY r.active DESC, r.kind, r.day""")),
                "today": today().isoformat(),
                "version": APP_VERSION,
                "repo": GITHUB_REPO,
                "lang": get_lang(conn),
                "account": get_account(conn),
            }
        if res == "goals" and method == "GET":
            ym = today().strftime("%Y-%m")
            return [goal_status(conn, g, ym) for g in conn.execute("SELECT * FROM goals ORDER BY archived, id")]

        table = {"entries": save_entry, "categories": save_category, "goals": save_goal, "recurring": save_recurring}
        if res in table:
            if method == "POST":
                return {"id": table[res](conn, self.read_json())}
            if method == "PUT" and rid:
                return {"id": table[res](conn, self.read_json(), rid)}
            if method == "DELETE" and rid:
                return self.delete(conn, res, rid, qs)
        raise ApiError("Ni najdeno", 404)

    def delete(self, conn, res, rid, qs):
        if res == "entries":
            conn.execute("DELETE FROM entries WHERE id=?", (rid,))
        elif res == "categories":
            used = conn.execute(
                "SELECT (SELECT COUNT(*) FROM entries WHERE category_id=?) + (SELECT COUNT(*) FROM recurring WHERE category_id=?)",
                (rid, rid),
            ).fetchone()[0]
            if used:
                conn.execute("UPDATE categories SET archived=1 WHERE id=?", (rid,))
                return {"archived": True}
            conn.execute("DELETE FROM categories WHERE id=?", (rid,))
        elif res == "goals":
            used = conn.execute("SELECT COUNT(*) FROM entries WHERE goal_id=?", (rid,)).fetchone()[0]
            if used:
                conn.execute("UPDATE goals SET archived=1 WHERE id=?", (rid,))
                conn.execute("UPDATE recurring SET active=0 WHERE goal_id=?", (rid,))
                return {"archived": True}
            conn.execute("DELETE FROM recurring WHERE goal_id=?", (rid,))
            conn.execute("DELETE FROM goals WHERE id=?", (rid,))
        elif res == "recurring":
            # delete the template and its unpaid future entries; past ones stay
            conn.execute(
                "DELETE FROM entries WHERE recurring_id=? AND paid=0 AND date>?",
                (rid, today().isoformat()),
            )
            # past entries keep their link so "refresh from templates" can still remove them
            conn.execute("DELETE FROM recurring_generated WHERE recurring_id=?", (rid,))
            conn.execute("DELETE FROM recurring WHERE id=?", (rid,))
        return {"ok": True}


def prepare_data_dir():
    """Prepare the database folder. In Docker (root) set its owner, then drop privileges to PUID/PGID."""
    data_dir = Path(DB_PATH).parent
    try:
        data_dir.mkdir(parents=True, exist_ok=True)
        if hasattr(os, "getuid") and os.getuid() == 0:
            uid = int(os.environ.get("PUID", "1000"))
            gid = int(os.environ.get("PGID", "1000"))
            try:
                BACKUP_DIR.mkdir(parents=True, exist_ok=True)
                for p in [data_dir, *data_dir.glob(Path(DB_PATH).name + "*"), BACKUP_DIR, *BACKUP_DIR.glob("expenses-*.db")]:
                    os.chown(p, uid, gid)
                os.setgid(gid)
                os.setuid(uid)
            except OSError as e:
                # if the owner cannot be changed, stay root so the app still works
                print(f"Warning: cannot set the owner of {data_dir} ({e}); running as root.", flush=True)
        test = data_dir / ".write-test"
        test.write_text("ok")
        test.unlink()
    except OSError as e:
        print(
            f"ERROR: cannot write to {data_dir} ({e}).\n"
            "Check that the 'data' folder exists next to docker-compose.yml and is writable.",
            flush=True,
        )
        raise SystemExit(1)


def main():
    prepare_data_dir()
    init_db()
    threading.Thread(target=backup_scheduler, daemon=True).start()
    srv = ThreadingHTTPServer(("0.0.0.0", PORT), Handler)
    print(f"Expenses {APP_VERSION} running on http://0.0.0.0:{PORT}  (database: {DB_PATH})", flush=True)
    try:
        srv.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
