"""Convert the NAS database (expenses.db) into expenses-data.json for the Google/local editions."""
import json, sqlite3, sys
from datetime import datetime

def convert(path):
    c = sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    c.row_factory = sqlite3.Row
    tables = {r[0] for r in c.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    if "entries" not in tables or "categories" not in tables:
        raise SystemExit("This is not a Stroški database.")
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
    return {"app": "expenses", "format": 1, "saved_at": datetime.now().isoformat(timespec="seconds"), "source": "nas",
            "db": db, "backup": {"settings": bk, "last_auto": settings.get("backup_last_auto") or None}}

if __name__ == "__main__":
    out = convert(sys.argv[1])
    json.dump(out, open(sys.argv[2], "w", encoding="utf-8"), ensure_ascii=False)
    d = out["db"]
    print(f'{len(d["entries"])} entries, {len(d["categories"])} categories, {len(d["goals"])} goals, {len(d["recurring"])} templates, '
          f'{len(d["monthSettings"])} month settings, balance: {d.get("account")}')
