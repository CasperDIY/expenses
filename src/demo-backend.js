/* Demo "server" in the browser – same logic as server.py, data in localStorage. */
(function () {
  "use strict";
  const KEY = "expenses-demo-v1";
  const KINDS = ["income", "expense", "saving"];
  const YM_RE = /^\d{4}-(0[1-9]|1[0-2])$/;
  const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
  const p2 = (n) => String(n).padStart(2, "0");
  const r2 = (x) => Math.round((+x || 0) * 100) / 100;
  const t0 = new Date();
  const TODAY = `${t0.getFullYear()}-${p2(t0.getMonth() + 1)}-${p2(t0.getDate())}`;
  const CUR_YM = TODAY.slice(0, 7);
  const ymAdd = (ym, n) => { const t = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + n; return `${Math.floor(t / 12)}-${p2((t % 12) + 1)}`; };
  const monthsBetween = (a, b) => (+b.slice(0, 4) - +a.slice(0, 4)) * 12 + (+b.slice(5, 7) - +a.slice(5, 7));
  const daysIn = (ym) => new Date(+ym.slice(0, 4), +ym.slice(5, 7), 0).getDate();

  class ApiError extends Error {}
  const fail = (m) => { throw new ApiError(m); };

  const CATS = [
    ["Plača", "income", "#2f855a"], ["Dodatni prihodki", "income", "#38a169"], ["Drugi prihodki", "income", "#68d391"],
    ["Stanovanje / najemnina", "expense", "#c05621"], ["Elektrika", "expense", "#d69e2e"], ["Voda in komunala", "expense", "#3182ce"],
    ["Internet in telefon", "expense", "#805ad5"], ["Hrana in gospodinjstvo", "expense", "#e53e3e"], ["Avto in gorivo", "expense", "#4a5568"],
    ["Zavarovanja", "expense", "#2c7a7b"], ["Zdravje", "expense", "#d53f8c"], ["Naročnine", "expense", "#6b46c1"],
    ["Prosti čas", "expense", "#dd6b20"], ["Oblačila", "expense", "#b7791f"], ["Drugo", "expense", "#718096"],
  ];

  let db;

  function save() { try { localStorage.setItem(KEY, JSON.stringify(db)); } catch (e) { /* no persistence */ } }
  function nextId(t) { db.seq[t] = (db.seq[t] || 0) + 1; return db.seq[t]; }

  function seed() {
    db = { categories: [], goals: [], recurring: [], generated: {}, entries: [], seq: {} };
    for (const [name, kind, color] of CATS) db.categories.push({ id: nextId("categories"), name, kind, budget: 0, color, archived: 0 });
    const cat = Object.fromEntries(db.categories.map((c) => [c.name, c.id]));
    cat_budget(cat["Hrana in gospodinjstvo"], 450);
    cat_budget(cat["Avto in gorivo"], 160);
    cat_budget(cat["Prosti čas"], 150);
    const y = t0.getFullYear();
    const g1 = saveGoal({ name: "Rezerva za nujne primere", target: 6000, target_date: `${y + 1}-09`, start_amount: 1000, color: "#2f855a" });
    saveGoal({ name: "Dopust", target: 1500, target_date: `${y + 1}-06`, start_amount: 0, color: "#d69e2e" });
    const start = `${y}-01`;
    const rec = [
      { kind: "income", category_id: cat["Plača"], description: "Plača", amount: 2100, day: 10 },
      { kind: "expense", category_id: cat["Stanovanje / najemnina"], description: "Najemnina", amount: 650, day: 1 },
      { kind: "expense", category_id: cat["Elektrika"], description: "Elektrika", amount: 75, day: 18 },
      { kind: "expense", category_id: cat["Voda in komunala"], description: "Komunala (položnica)", amount: 42, day: 18, auto_paid: false },
      { kind: "expense", category_id: cat["Internet in telefon"], description: "Internet + mobilni", amount: 39, day: 5 },
      { kind: "expense", category_id: cat["Zavarovanja"], description: "Zavarovanje avta", amount: 48, day: 15 },
      { kind: "expense", category_id: cat["Naročnine"], description: "Naročnine (glasba, filmi)", amount: 18, day: 20 },
    ];
    for (const r of rec) saveRecurring({ ...r, start_ym: start });
    saveRecurring({ kind: "saving", goal_id: g1, description: "Mesečno v rezervo", amount: 200, day: 11, start_ym: `${y}-03` });

    // random everyday expenses up to today
    let s = 7;
    const rnd = () => ((s = (s * 16807) % 2147483647) / 2147483647);
    const pick = (a) => a[Math.floor(rnd() * a.length)];
    const shops = ["Mercator", "Spar", "Lidl", "Hofer", "Tuš"];
    for (let m = 1; m <= 12; m++) {
      const ym = `${y}-${p2(m)}`;
      if (ym > CUR_YM) break;
      const last = ym === CUR_YM ? t0.getDate() : daysIn(ym);
      const add = (catName, desc, lo, hi, n) => {
        for (let i = 0; i < n; i++) {
          const d = `${ym}-${p2(1 + Math.floor(rnd() * last))}`;
          db.entries.push({ id: nextId("entries"), date: d, kind: "expense", category_id: cat[catName], goal_id: null, description: desc(), amount: r2(lo + rnd() * (hi - lo)), recurring_id: null, paid: 1 });
        }
      };
      add("Hrana in gospodinjstvo", () => pick(shops), 18, 85, 7);
      add("Avto in gorivo", () => "Gorivo", 45, 70, 2);
      add("Prosti čas", () => pick(["Kino", "Večerja", "Kava s prijatelji", "Bazen"]), 8, 60, 3);
      if (rnd() < 0.5) add("Oblačila", () => pick(["Čevlji", "Jakna", "Majice"]), 25, 90, 1);
      if (rnd() < 0.25) add("Zdravje", () => "Lekarna", 8, 35, 1);
      if (m === 6 || m === 12) db.entries.push({ id: nextId("entries"), date: `${ym}-${p2(Math.min(last, 15))}`, kind: "income", category_id: cat["Dodatni prihodki"], goal_id: null, description: m === 6 ? "Regres" : "Božičnica", amount: m === 6 ? 1250 : 600, recurring_id: null, paid: 1 });
    }
    db.account = { amount: 1850, date: `${y - 1}-12-31` };
    // example: carry-over switched off two months ago, the chain restarts there
    db.monthSettings = { [ymAdd(CUR_YM, -2)]: 0 };
    db.entries.push({ id: nextId("entries"), date: `${y}-04-02`, kind: "saving", category_id: null, goal_id: 2, description: "Prvi polog za dopust", amount: 150, recurring_id: null, paid: 1 });
    save();
  }
  function cat_budget(id, b) { db.categories.find((c) => c.id === id).budget = b; }

  function load() {
    try { const raw = localStorage.getItem(KEY); if (raw) { db = JSON.parse(raw); return; } } catch (e) { /* storage unavailable */ }
    seed();
  }

  /* ---------- recurring templates ---------- */
  function generate(ym) {
    const last = daysIn(ym);
    for (const r of db.recurring) {
      if (!r.active || r.start_ym > ym || (r.end_ym && r.end_ym < ym)) continue;
      const k = r.id + "|" + ym;
      if (db.generated[k]) continue;
      const d = `${ym}-${p2(Math.min(Math.max(r.day, 1), last))}`;
      const paid = r.auto_paid === 0 ? (ym < CUR_YM ? 1 : 0) : (d <= TODAY ? 1 : 0);
      db.entries.push({ id: nextId("entries"), date: d, kind: r.kind, category_id: r.category_id, goal_id: r.goal_id, description: r.description, amount: r.amount, recurring_id: r.id, paid });
      db.generated[k] = 1;
    }
  }
  function applyAutoPaid() {
    const auto = new Set(db.recurring.filter((r) => r.auto_paid !== 0).map((r) => r.id));
    for (const e of db.entries) if (!e.paid && e.date <= TODAY && auto.has(e.recurring_id)) e.paid = 1;
  }
  function generateUpto(ym) {
    const act = db.recurring.filter((r) => r.active).map((r) => r.start_ym).sort();
    if (!act.length || act[0] > ym) return;
    for (let c = act[0]; c <= ym; c = ymAdd(c, 1)) generate(c);
    save();
  }

  /* ---------- helpers ---------- */
  const num = (v, name, neg) => { const x = parseFloat(String(v ?? "").replace(",", ".")); if (!isFinite(x)) fail("Neveljaven znesek: " + name); if (!neg && x < 0) fail(name + " ne sme biti negativen"); return r2(x); };
  const optInt = (v) => (v === null || v === undefined || v === "" || +v === 0 ? null : +v);
  const inMonth = (e, ym) => e.date.slice(0, 7) === ym;
  const catById = (id) => db.categories.find((c) => c.id === id);
  const goalById = (id) => db.goals.find((g) => g.id === id);
  const sum = (arr) => arr.reduce((a, e) => a + e.amount, 0);

  function goalStatus(g, ym) {
    const sav = db.entries.filter((e) => e.kind === "saving" && e.goal_id === g.id);
    const before = sum(sav.filter((e) => e.date < ym + "-01"));
    const thisM = sum(sav.filter((e) => inMonth(e, ym)));
    const all = sum(sav.filter((e) => e.date <= TODAY));
    const savedBefore = g.start_amount + before, savedEnd = savedBefore + thisM;
    let needed = 0, monthsLeft = null, plan = null;
    const sym = (g.start_date || "").slice(0, 7), notStarted = !!sym && ym < sym;
    if (g.target_date) {
      const tym = g.target_date.slice(0, 7);
      monthsLeft = monthsBetween(ym, tym) + 1;
      const rem = Math.max(0, g.target - savedBefore);
      if (notStarted) { const span = monthsBetween(sym, tym) + 1; plan = span >= 1 && rem > 0 ? rem / span : 0; }
      else if (monthsLeft >= 1 && rem > 0) needed = rem / monthsLeft;
      else if (monthsLeft < 1) monthsLeft = 0;
    }
    return {
      id: g.id, name: g.name, color: g.color, target: r2(g.target), target_date: g.target_date,
      start_date: g.start_date || null, not_started: notStarted, monthly_plan: plan === null ? null : r2(plan), start_amount: r2(g.start_amount), archived: g.archived,
      saved: r2(savedEnd), saved_total: r2(g.start_amount + all), progress: g.target > 0 ? Math.min(1, savedEnd / g.target) : 0,
      months_left: monthsLeft, needed_this_month: r2(needed), contributed_this_month: r2(thisM), planned_left: r2(Math.max(0, needed - thisM)), reached: savedEnd >= g.target && g.target > 0,
    };
  }

  /* ---------- carry-over between months ---------- */
  const carryEnabled = (ym) => !(db.monthSettings && db.monthSettings[ym] === 0);
  function computeCarry(ym) {
    if (!carryEnabled(ym) || !db.entries.length) return 0;
    const first = db.entries.reduce((a, e) => (e.date < a ? e.date : a), "9999").slice(0, 7);
    if (first >= ym) return 0;
    const bal = {};
    for (const e of db.entries) {
      if (e.date >= ym + "-01") continue;
      const m = e.date.slice(0, 7);
      bal[m] = (bal[m] || 0) + (e.kind === "income" ? e.amount : -e.amount);
    }
    let carry = 0;
    for (let c = first; c < ym; c = ymAdd(c, 1)) carry = (carryEnabled(c) ? carry : 0) + (bal[c] || 0);
    return carry;
  }

  /* ---------- account balance ---------- */
  const signed = (e) => (e.kind === "income" ? e.amount : -e.amount);
  function balanceAt(acc, d, paidOnly) {
    if (d >= acc.date) return acc.amount + db.entries.filter((e) => e.date > acc.date && e.date <= d && (!paidOnly || e.paid)).reduce((a, e) => a + signed(e), 0);
    return acc.amount - db.entries.filter((e) => e.date > d && e.date <= acc.date).reduce((a, e) => a + signed(e), 0);
  }
  function accountForMonth(ym) {
    const acc = db.account;
    if (!acc) return { configured: false };
    const prev = ymAdd(ym, -1);
    return { configured: true, anchor_amount: r2(acc.amount), anchor_date: acc.date,
      start: r2(balanceAt(acc, `${prev}-${p2(daysIn(prev))}`)), end: r2(balanceAt(acc, `${ym}-${p2(daysIn(ym))}`)),
      now: ym === CUR_YM ? r2(balanceAt(acc, TODAY, true)) : null };
  }

  function month(ym) {
    if (!YM_RE.test(ym)) fail("Neveljaven mesec");
    // an empty (e.g. deleted) month the user opens is filled from the current templates
    if (!db.entries.some((e) => inMonth(e, ym))) for (const k of Object.keys(db.generated)) if (k.endsWith("|" + ym)) delete db.generated[k];
    generateUpto(ym);
    applyAutoPaid();
    const entries = db.entries.filter((e) => inMonth(e, ym)).sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id - b.id)).map((e) => {
      const c = catById(e.category_id), g = goalById(e.goal_id);
      return { ...e, category_name: c?.name ?? null, category_color: c?.color ?? null, goal_name: g?.name ?? null };
    });
    const totals = { income: 0, expense: 0, saving: 0 };
    let unpaid = 0, overdue = 0, overdueN = 0;
    const spent = {};
    for (const e of entries) {
      totals[e.kind] += e.amount;
      if (e.kind === "expense" && !e.paid) { unpaid += e.amount; if (e.date < TODAY) { overdue += e.amount; overdueN++; } }
      if (e.category_id) spent[e.category_id] = (spent[e.category_id] || 0) + e.amount;
    }
    let budgetLeft = 0;
    const categories = [];
    for (const c of db.categories) {
      const s = spent[c.id] || 0;
      if (c.archived && !s) continue;
      const item = { ...c, spent: r2(s) };
      if (c.kind === "expense" && c.budget > 0) { item.remaining = r2(c.budget - s); budgetLeft += Math.max(0, c.budget - s); }
      categories.push(item);
    }
    const goals = db.goals.filter((g) => !g.archived).map((g) => goalStatus(g, ym));
    const planned = goals.reduce((a, g) => a + g.planned_left, 0);
    const carryIn = computeCarry(ym);
    const balance = totals.income - totals.expense - totals.saving;
    const available = carryIn + balance - planned;
    const dim = daysIn(ym);
    const daysLeft = ym === CUR_YM ? dim - t0.getDate() + 1 : ym > CUR_YM ? dim : 0;
    const templates = db.recurring.filter((r) => r.active && r.start_ym <= ym && (!r.end_ym || r.end_ym >= ym)).length;
    return {
      ym, can_fill: templates > 0 && !entries.some((e) => e.recurring_id !== null), entries, totals: { income: r2(totals.income), expense: r2(totals.expense), saving: r2(totals.saving) },
      account: accountForMonth(ym), balance: r2(balance), carry_in: r2(carryIn), carry_enabled: carryEnabled(ym), carry_from: ymAdd(ym, -1), closing: r2(carryIn + balance),
      unpaid_expense: r2(unpaid), overdue_expense: r2(overdue), overdue_count: overdueN, planned_savings: r2(planned),
      available: r2(available), budget_left: r2(budgetLeft), free_to_spend: r2(available - budgetLeft),
      days_left: daysLeft, per_day: daysLeft ? r2(available / daysLeft) : null, categories, goals,
    };
  }

  function year(y) {
    const months = Array.from({ length: 12 }, (_, i) => `${y}-${p2(i + 1)}`);
    applyAutoPaid(); // the overview does not create new months
    const series = { income: Array(12).fill(0), expense: Array(12).fill(0), saving: Array(12).fill(0) };
    const cats = {};
    for (const e of db.entries) {
      if (e.date.slice(0, 4) !== String(y)) continue;
      series[e.kind][+e.date.slice(5, 7) - 1] += e.amount;
      if (e.category_id) cats[e.category_id] = (cats[e.category_id] || 0) + e.amount;
    }
    for (const k of KINDS) series[k] = series[k].map(r2);
    const totals = { income: r2(series.income.reduce((a, b) => a + b, 0)), expense: r2(series.expense.reduce((a, b) => a + b, 0)), saving: r2(series.saving.reduce((a, b) => a + b, 0)) };
    let acc = db.goals.reduce((a, g) => a + g.start_amount, 0) + sum(db.entries.filter((e) => e.kind === "saving" && e.date < `${y}-01-01`));
    const cum = series.saving.map((v) => r2((acc += v)));
    const categories = Object.entries(cats).map(([id, total]) => { const c = catById(+id); return { id: c.id, name: c.name, color: c.color, kind: c.kind, total: r2(total) }; }).sort((a, b) => b.total - a.total);
    return { year: y, months, series, totals, balance: r2(totals.income - totals.expense - totals.saving), savings_cumulative: cum, categories };
  }

  function years() {
    const out = {};
    for (const e of db.entries) {
      const y = +e.date.slice(0, 4);
      out[y] = out[y] || { year: y, income: 0, expense: 0, saving: 0 };
      out[y][e.kind] += e.amount;
    }
    return Object.values(out).sort((a, b) => a.year - b.year).map((r) => ({ year: r.year, income: r2(r.income), expense: r2(r.expense), saving: r2(r.saving) }));
  }

  /* ---------- CRUD ---------- */
  function targetOf(d) {
    let cat = optInt(d.category_id), goal = optInt(d.goal_id);
    if (d.kind === "saving") { cat = null; if (!goal) fail("Izberi cilj varčevanja"); }
    else { goal = null; if (!cat) fail("Izberi kategorijo"); }
    return { category_id: cat, goal_id: goal };
  }
  function saveEntry(d, id) {
    if (!DATE_RE.test(d.date || "")) fail("Neveljaven datum");
    if (!KINDS.includes(d.kind)) fail("Neveljavna vrsta");
    const row = { date: d.date, kind: d.kind, ...targetOf(d), description: String(d.description || "").slice(0, 200), amount: num(d.amount, "Znesek", d.kind === "saving"), paid: d.paid === false ? 0 : 1 };
    if (id) { const e = db.entries.find((x) => x.id === id); if (!e) fail("Ni najdeno"); Object.assign(e, row); return id; }
    const nid = nextId("entries");
    db.entries.push({ id: nid, recurring_id: null, ...row });
    return nid;
  }
  function saveCategory(d, id) {
    const name = String(d.name || "").trim(); if (!name) fail("Ime je obvezno");
    if (!["income", "expense"].includes(d.kind)) fail("Neveljavna vrsta");
    const row = { name, kind: d.kind, budget: num(d.budget || 0, "Proračun"), color: d.color || "#888888", archived: d.archived ? 1 : 0 };
    if (id) { Object.assign(catById(id), row); return id; }
    const nid = nextId("categories"); db.categories.push({ id: nid, ...row, archived: 0 }); return nid;
  }
  function saveGoal(d, id) {
    const name = String(d.name || "").trim(); if (!name) fail("Ime je obvezno");
    const target = num(d.target, "Ciljni znesek"); if (target <= 0) fail("Ciljni znesek mora biti večji od 0");
    let td = d.target_date || null;
    if (td) { if (YM_RE.test(td)) td += "-01"; if (!DATE_RE.test(td)) fail("Neveljaven ciljni datum"); }
    let sd = d.start_date || null;
    if (sd) { if (YM_RE.test(sd)) sd += "-01"; if (!DATE_RE.test(sd)) fail("Neveljaven začetek cilja"); if (td && sd.slice(0, 7) > td.slice(0, 7)) fail("Začetek cilja mora biti pred rokom"); }
    const row = { name, target, target_date: td, start_date: sd, start_amount: num(d.start_amount || 0, "Začetni znesek"), color: d.color || "#2f855a", archived: d.archived ? 1 : 0 };
    if (id) { Object.assign(goalById(id), row); return id; }
    const nid = nextId("goals"); db.goals.push({ id: nid, ...row, archived: 0 }); return nid;
  }
  function saveRecurring(d, id) {
    if (!KINDS.includes(d.kind)) fail("Neveljavna vrsta");
    const day = parseInt(d.day || 1, 10); if (!(day >= 1 && day <= 31)) fail("Dan mora biti med 1 in 31");
    const start = d.start_ym || CUR_YM; if (!YM_RE.test(start)) fail("Neveljaven mesec");
    const end = d.end_ym || null; if (end && !YM_RE.test(end)) fail("Neveljaven mesec");
    const row = { kind: d.kind, ...targetOf(d), description: String(d.description || "").slice(0, 200), amount: num(d.amount, "Znesek"), day, start_ym: start, end_ym: end, active: d.active === false ? 0 : 1, auto_paid: d.auto_paid === false ? 0 : 1 };
    if (id) {
      Object.assign(db.recurring.find((r) => r.id === id), row);
      for (const e of db.entries) if (e.recurring_id === id && !e.paid && e.date > TODAY) Object.assign(e, { kind: row.kind, category_id: row.category_id, goal_id: row.goal_id, description: row.description, amount: row.amount });
      return id;
    }
    const nid = nextId("recurring"); db.recurring.push({ id: nid, ...row }); return nid;
  }
  function del(res, id) {
    if (res === "entries") db.entries = db.entries.filter((e) => e.id !== id);
    else if (res === "categories") {
      if (db.entries.some((e) => e.category_id === id) || db.recurring.some((r) => r.category_id === id)) { catById(id).archived = 1; return { archived: true }; }
      db.categories = db.categories.filter((c) => c.id !== id);
    } else if (res === "goals") {
      if (db.entries.some((e) => e.goal_id === id)) { goalById(id).archived = 1; db.recurring.forEach((r) => { if (r.goal_id === id) r.active = 0; }); return { archived: true }; }
      db.recurring = db.recurring.filter((r) => r.goal_id !== id);
      db.goals = db.goals.filter((g) => g.id !== id);
    } else if (res === "recurring") {
      db.entries = db.entries.filter((e) => !(e.recurring_id === id && !e.paid && e.date > TODAY));
      for (const k of Object.keys(db.generated)) if (k.startsWith(id + "|")) delete db.generated[k];
      db.recurring = db.recurring.filter((r) => r.id !== id);
    }
    return { ok: true };
  }

  /* ---------- month management ---------- */
  function monthsList() {
    const yms = new Set(db.entries.map((e) => e.date.slice(0, 7)));
    for (const k of Object.keys(db.generated)) yms.add(k.split("|")[1]);
    return [...yms].sort().reverse().filter((ym) => db.entries.some((e) => inMonth(e, ym))).map((ym) => {
      const es = db.entries.filter((e) => inMonth(e, ym));
      const tot = (k) => r2(sum(es.filter((e) => e.kind === k)));
      const fromT = es.filter((e) => e.recurring_id !== null).length;
      return { ym, income: tot("income"), expense: tot("expense"), saving: tot("saving"), count: es.length, from_templates: fromT,
        ...(db.account ? { balance_end: r2(balanceAt(db.account, `${ym}-${p2(daysIn(ym))}`)) } : {}),
        manual: es.length - fromT, status: ym > CUR_YM ? "future" : ym === CUR_YM ? "current" : "past" };
    });
  }
  function refreshMonth(ym) {
    if (!YM_RE.test(ym)) fail("Neveljaven mesec");
    const before = db.entries.length;
    db.entries = db.entries.filter((e) => !(e.recurring_id !== null && inMonth(e, ym)));
    const removed = before - db.entries.length;
    for (const k of Object.keys(db.generated)) if (k.endsWith("|" + ym)) delete db.generated[k];
    generate(ym);
    return { ym, removed, added: db.entries.filter((e) => e.recurring_id !== null && inMonth(e, ym)).length };
  }
  function deleteMonth(ym) {
    if (!YM_RE.test(ym)) fail("Neveljaven mesec");
    const before = db.entries.length;
    db.entries = db.entries.filter((e) => !inMonth(e, ym));
    for (const k of Object.keys(db.generated)) if (k.endsWith("|" + ym)) delete db.generated[k];
    for (const r of db.recurring) db.generated[r.id + "|" + ym] = 1;
    return { ym, removed: before - db.entries.length };
  }

  /* ---------- backups (kept in the browser in the demo) ---------- */
  const BK_KEY = "expenses-demo-backups-v1";
  let bk = { settings: { frequency: "weekly", weekday: "6", monthday: "1", time: "03:00", keep: "8" }, last_auto: null, items: [] };
  try { const raw = localStorage.getItem(BK_KEY); if (raw) bk = JSON.parse(raw); } catch (e) { /* storage unavailable */ }
  const bkSave = () => { try { localStorage.setItem(BK_KEY, JSON.stringify(bk)); } catch (e) { /* full or blocked */ } };
  const stamp = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}${p2(d.getSeconds())}`;
  const isoLocal = (d) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}T${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
  function makeBk(kind) {
    const d = new Date();
    let name = `expenses-${stamp(d)}-${kind}.db`;
    while (bk.items.some((b) => b.name === name)) { d.setSeconds(d.getSeconds() + 1); name = `expenses-${stamp(d)}-${kind}.db`; }
    const data = JSON.stringify(db);
    bk.items.unshift({ name, kind, created: isoLocal(d), size: data.length, data });
    bk.items.sort((a, b) => (a.created < b.created ? 1 : -1));
    bkSave();
    return name;
  }
  function lastSlot(st, now) {
    if (st.frequency === "off") return null;
    const [hh, mm] = st.time.split(":").map(Number);
    const s = new Date(now); s.setHours(hh, mm, 0, 0);
    if (st.frequency === "daily") { if (s > now) s.setDate(s.getDate() - 1); return s; }
    if (st.frequency === "weekly") {
      const wd = (s.getDay() + 6) % 7; // Monday=0
      s.setDate(s.getDate() - ((wd - +st.weekday + 7) % 7));
      if (s > now) s.setDate(s.getDate() - 7);
      return s;
    }
    s.setDate(+st.monthday);
    if (s > now) s.setMonth(s.getMonth() - 1);
    return s;
  }
  function nextSlot(st, now) {
    const s = lastSlot(st, now); if (!s) return null;
    if (st.frequency === "daily") s.setDate(s.getDate() + 1);
    else if (st.frequency === "weekly") s.setDate(s.getDate() + 7);
    else s.setMonth(s.getMonth() + 1);
    return s;
  }
  function runScheduled() {
    const now = new Date(), slot = lastSlot(bk.settings, now);
    if (!slot || (bk.last_auto && new Date(bk.last_auto) >= slot)) return;
    makeBk("auto");
    bk.last_auto = isoLocal(now);
    const autos = bk.items.filter((b) => b.kind === "auto");
    const drop = new Set(autos.slice(+bk.settings.keep).map((b) => b.name));
    bk.items = bk.items.filter((b) => !drop.has(b.name));
    bkSave();
  }
  function bkOverview() {
    const n = nextSlot(bk.settings, new Date());
    const items = bk.items.map(({ data, ...rest }) => rest);
    return { settings: { ...bk.settings }, next_run: n ? isoLocal(n).slice(0, 16) : null, last_auto: bk.last_auto,
      dir: "demo: kopije so shranjene v tem brskalniku", backups: items, total_size: items.reduce((a, b) => a + b.size, 0) };
  }
  function bkRoute(method, rest, body) {
    const [name, action] = rest.map(decodeURIComponent);
    if (method === "GET" && !name) return bkOverview();
    if (method === "PUT" && name === "settings") {
      const d = body || {};
      if (!["off", "daily", "weekly", "monthly"].includes(d.frequency)) fail("Neveljavna pogostost");
      const md = +d.monthday, keep = +d.keep, wd = +d.weekday;
      if (!(md >= 1 && md <= 28)) fail("Dan v mesecu mora biti med 1 in 28");
      if (!(keep >= 1 && keep <= 365)) fail("Število kopij mora biti med 1 in 365");
      if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(d.time || "")) fail("Neveljavna ura (pričakovano HH:MM)");
      bk.settings = { frequency: d.frequency, weekday: String(wd), monthday: String(md), time: d.time, keep: String(keep) };
      bk.last_auto = isoLocal(new Date());
      bkSave();
      return bkOverview();
    }
    if (method === "POST" && !name) return { name: makeBk("manual") };
    const item = bk.items.find((b) => b.name === name);
    if (!item) fail("Kopija ne obstaja");
    if (method === "POST" && action === "restore") {
      const safety = makeBk("pre-restore");
      db = JSON.parse(item.data);
      save();
      return { restored: name, safety_backup: safety };
    }
    if (method === "DELETE") { bk.items = bk.items.filter((b) => b.name !== name); bkSave(); return { ok: true }; }
    fail("Ni najdeno");
  }

  /* ---------- Excel import ---------- */
  // dependency-free .xlsx reader: zip (DecompressionStream) + XML (DOMParser)
  async function unzip(buf) {
    const dv = new DataView(buf), u8 = new Uint8Array(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    if (eocd < 0) fail("Datoteka ni veljaven Excel (.xlsx)");
    const n = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const files = {};
    const dec = new TextDecoder();
    for (let i = 0; i < n; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) break;
      const method = dv.getUint16(p + 10, true), csize = dv.getUint32(p + 20, true);
      const nlen = dv.getUint16(p + 28, true), xlen = dv.getUint16(p + 30, true), clen = dv.getUint16(p + 32, true);
      const off = dv.getUint32(p + 42, true);
      const name = dec.decode(u8.subarray(p + 46, p + 46 + nlen));
      files[name] = { method, csize, off };
      p += 46 + nlen + xlen + clen;
    }
    return async (name) => {
      const f = files[name];
      if (!f) return null;
      const lh = f.off, start = lh + 30 + dv.getUint16(lh + 26, true) + dv.getUint16(lh + 28, true);
      const raw = u8.subarray(start, start + f.csize);
      if (f.method === 0) return dec.decode(raw);
      if (f.method !== 8) fail("Nepodprta oblika stiskanja v datoteki");
      const stream = new Blob([raw]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
      return new Response(stream).text();
    };
  }
  window.demoReadXlsx = async (file) => {
    const read = await unzip(await file.arrayBuffer());
    const xml = (t) => new DOMParser().parseFromString(t, "application/xml");
    const wbx = await read("xl/workbook.xml");
    if (!wbx) fail("Datoteka ni veljaven Excel (.xlsx)");
    const ssx = await read("xl/sharedStrings.xml");
    const shared = ssx ? [...xml(ssx).getElementsByTagName("si")].map((si) => [...si.getElementsByTagName("t")].map((t) => t.textContent).join("")) : [];
    const rels = {};
    const relx = await read("xl/_rels/workbook.xml.rels");
    if (relx) for (const r of xml(relx).getElementsByTagName("Relationship")) {
      const t = r.getAttribute("Target");
      rels[r.getAttribute("Id")] = t.startsWith("/") ? t.slice(1) : "xl/" + t;
    }
    const out = [];
    for (const sh of xml(wbx).getElementsByTagName("sheet")) {
      const rid = sh.getAttribute("r:id") || sh.getAttributeNS("http://schemas.openxmlformats.org/officeDocument/2006/relationships", "id");
      const txt = rels[rid] && (await read(rels[rid]));
      if (!txt) continue;
      const cells = {};
      for (const c of xml(txt).getElementsByTagName("c")) {
        const ref = c.getAttribute("r"), t = c.getAttribute("t"), v = c.getElementsByTagName("v")[0];
        let val;
        if (t === "inlineStr") val = [...c.getElementsByTagName("t")].map((x) => x.textContent).join("");
        else if (!v) continue;
        else if (t === "s") val = shared[+v.textContent] ?? "";
        else if (t === "str" || t === "e") val = v.textContent;
        else if (t === "b") val = v.textContent === "1";
        else { const f = parseFloat(v.textContent); val = isFinite(f) ? f : v.textContent; }
        if (ref && val !== "" && val != null) cells[ref] = val;
      }
      out.push({ name: sh.getAttribute("name"), cells });
    }
    return out;
  };
  const PALETTE = ["#2c7a7b", "#b7791f", "#6b46c1", "#c05621", "#2b6cb0", "#d53f8c", "#4a5568", "#38a169", "#dd6b20", "#805ad5"];
  function importCommit(d) {
    if (!d.months || !d.months.length) fail("Ni izbranih mesecev za uvoz");
    const catFor = {};
    for (const [group, target] of Object.entries(d.mapping || {})) {
      const kind = group === "income" ? "income" : "expense";
      if (String(target).startsWith("new:")) {
        const name = String(target).slice(4).trim() || "Uvoz";
        let c = db.categories.find((x) => x.kind === kind && x.name.toLowerCase() === name.toLowerCase());
        if (!c) { c = { id: nextId("categories"), name, kind, budget: 0, color: PALETTE[Object.keys(catFor).length % PALETTE.length], archived: 0 }; db.categories.push(c); }
        c.archived = 0;
        catFor[group] = c.id;
      } else {
        if (!catById(+target)) fail("Izberi kategorijo za skupino " + group);
        catFor[group] = +target;
      }
    }
    let added = 0, replaced = 0;
    const done = [];
    for (const m of d.months) {
      const ym = m.ym;
      if (!YM_RE.test(ym || "")) fail("Neveljaven mesec");
      const before = db.entries.length;
      db.entries = db.entries.filter((e) => !(inMonth(e, ym) && (e.source === "excel" || e.recurring_id !== null)));
      replaced += before - db.entries.length;
      for (const e of m.entries || []) {
        if (!catFor[e.group]) fail("Manjka kategorija za skupino " + e.group);
        const amount = num(e.amount, "Znesek", true);
        if (!amount) continue;
        db.entries.push({ id: nextId("entries"), date: `${ym}-${p2(Math.min(Math.max(+e.day || 1, 1), daysIn(ym)))}`, kind: e.kind, category_id: catFor[e.group], goal_id: null,
          description: String(e.description || "").slice(0, 200), amount, recurring_id: null, paid: 1, source: "excel" });
        added++;
      }
      for (const k of Object.keys(db.generated)) if (k.endsWith("|" + ym)) delete db.generated[k];
      for (const r of db.recurring) db.generated[r.id + "|" + ym] = 1;
      if (d.carry_mode === "sheet") { db.monthSettings = db.monthSettings || {}; db.monthSettings[ym] = 0; }
      done.push(ym);
    }
    let templates = 0;
    if (d.templates && d.templates.items) {
      for (const e of d.templates.items) {
        if (!catFor[e.group]) continue;
        db.recurring.push({ id: nextId("recurring"), kind: "expense", category_id: catFor[e.group], goal_id: null, description: String(e.description || "").slice(0, 200),
          amount: num(e.amount, "Znesek"), day: 1, start_ym: d.templates.start_ym, end_ym: null, active: 1, auto_paid: 1 });
        templates++;
      }
    }
    return { months: done, added, replaced: Math.max(0, replaced - 0), templates };
  }

  function route(method, path, body) {
    const [p, q] = path.split("?");
    const qs = new URLSearchParams(q || "");
    const [res, idStr] = p.split("/");
    runScheduled();
    if (res === "backups") return bkRoute(method, p.split("/").slice(1), body);
    const id = idStr ? +idStr : null;
    if (method === "GET") {
      if (res === "month") return month(qs.get("ym") || CUR_YM);
      if (res === "year") return year(+qs.get("y") || t0.getFullYear());
      if (res === "years") return years();
      if (res === "goals") return [...db.goals].sort((a, b) => a.archived - b.archived || a.id - b.id).map((g) => goalStatus(g, CUR_YM));
      if (res === "meta") return {
        categories: [...db.categories].sort((a, b) => (a.kind === b.kind ? a.archived - b.archived || a.name.localeCompare(b.name, "sl") : a.kind === "income" ? -1 : 1)),
        goals: [...db.goals].sort((a, b) => a.archived - b.archived || a.id - b.id),
        recurring: db.recurring.map((r) => ({ ...r, category_name: catById(r.category_id)?.name ?? null, goal_name: goalById(r.goal_id)?.name ?? null }))
          .sort((a, b) => b.active - a.active || a.kind.localeCompare(b.kind) || a.day - b.day),
        today: TODAY, account: db.account || null, lang: (db.prefs && db.prefs.lang) || null,
      };
    }
    if (res === "prefs" && method === "PUT") {
      const lang = (body || {}).lang;
      if (!["sl", "en", "de"].includes(lang)) fail("Neznan jezik");
      db.prefs = { ...(db.prefs || {}), lang };
      return { lang };
    }
    if (res === "account" && method === "PUT") {
      const d = body || {};
      const amount = num(d.amount, "Stanje", true);
      if (!DATE_RE.test(d.date || "")) fail("Neveljaven datum");
      db.account = { amount, date: d.date };
      return db.account;
    }
    if (res === "import" && method === "GET") return { imported_months: [...new Set(db.entries.filter((e) => e.source === "excel").map((e) => e.date.slice(0, 7)))].sort() };
    if (res === "import" && method === "POST") return importCommit(body || {});
    if (res === "month-settings" && method === "POST") {
      const ym = (body || {}).ym;
      if (!YM_RE.test(ym || "")) fail("Neveljaven mesec");
      db.monthSettings = db.monthSettings || {};
      db.monthSettings[ym] = body.carry_in === false ? 0 : 1;
      return { ym, carry_in: db.monthSettings[ym] === 1 };
    }
    if (res === "months") {
      if (method === "GET") return monthsList();
      if (method === "POST") {
        const { action, months } = body || {};
        if (!["refresh", "delete"].includes(action) || !Array.isArray(months) || !months.length) fail("Izberi vsaj en mesec in dejanje");
        return { results: months.map((ym) => (action === "refresh" ? refreshMonth(ym) : deleteMonth(ym))) };
      }
    }
    const fns = { entries: saveEntry, categories: saveCategory, goals: saveGoal, recurring: saveRecurring };
    if (fns[res]) {
      if (method === "POST") return { id: fns[res](body || {}) };
      if (method === "PUT" && id) return { id: fns[res](body || {}, id) };
      if (method === "DELETE" && id) return del(res, id);
    }
    fail("Ni najdeno");
  }

  load();
  window.demoApi = async (method, path, body) => {
    const out = route(method, path, body);
    save();
    return JSON.parse(JSON.stringify(out));
  };
  window.demoReset = () => { seed(); };
  if (!bk.items.length) { makeBk("auto"); bk.last_auto = isoLocal(new Date()); bkSave(); }
})();
