"use strict";

/* ================= helpers ================= */
const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const I18N = window.I18N;
const t = I18N.t, tm = I18N.tm, plural = I18N.plural;
let eur, eur0;
function setFormats() {
  eur = new Intl.NumberFormat(I18N.locale(), { style: "currency", currency: "EUR" });
  eur0 = new Intl.NumberFormat(I18N.locale(), { style: "currency", currency: "EUR", maximumFractionDigits: 0 });
}
setFormats();
const fmt = (v) => eur.format(v || 0);
const fmt0 = (v) => eur0.format(v || 0);
const monthName = (i) => I18N.months()[i];
const monthGen = (i) => I18N.monthsGen()[i];
const signed = (v) => (v > 0 ? "+ " : v < 0 ? "− " : "") + fmt(Math.abs(v));
const kindLabel = (k) => ({ income: t("Prihodek"), expense: t("Strošek"), saving: t("Varčevanje") }[k]);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const cssVar = (n) => getComputedStyle(document.documentElement).getPropertyValue(n).trim();

const pad = (n) => String(n).padStart(2, "0");
const now = new Date();
const todayISO = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
const curYM = todayISO.slice(0, 7);
const ymAdd = (ym, n) => {
  const x = +ym.slice(0, 4) * 12 + (+ym.slice(5, 7) - 1) + n;
  return `${Math.floor(x / 12)}-${pad((x % 12) + 1)}`;
};
const ymLabel = (ym) => `${monthName(+ym.slice(5, 7) - 1)} ${ym.slice(0, 4)}`;
const ymGen = (ym) => `${monthGen(+ym.slice(5, 7) - 1)} ${ym.slice(0, 4)}`;
const dateLabel = (d) => (I18N.lang === "en" ? `${+d.slice(8, 10)} ${I18N.monthsShort()[+d.slice(5, 7) - 1]}` : `${+d.slice(8, 10)}. ${+d.slice(5, 7)}.`);

async function api(method, path, body) {
  if (window.demoApi) return window.demoApi(method, path, body);
  const res = await fetch("/api/" + path, {
    method,
    headers: body ? { "Content-Type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t("Napaka {n}", { n: res.status }));
  return data;
}

function toast(msg) {
  const el = $("#toast");
  el.textContent = tm(msg);
  el.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove("show"), 3500);
}

/* ================= state ================= */
const S = { tab: "month", ym: curYM, year: now.getFullYear(), filter: "all", meta: null, month: null };

async function loadMeta() {
  S.meta = await api("GET", "meta");
  // the language is kept with the data, so every browser and device opens in the language chosen last
  if (!S.langSynced) {
    S.langSynced = true;
    if (S.meta.lang && S.meta.lang !== I18N.lang) I18N.setLang(S.meta.lang);
  }
}

/* ================= tabs ================= */
$$(".tabs button").forEach((b) =>
  b.addEventListener("click", () => {
    S.tab = b.dataset.tab;
    $$(".tabs button").forEach((x) => x.classList.toggle("active", x === b));
    $$(".tab").forEach((x) => x.classList.toggle("active", x.id === "tab-" + S.tab));
    refresh();
  })
);

async function refresh() {
  try {
    if (S.tab === "month") await renderMonth();
    else if (S.tab === "overview") await renderOverview();
    else if (S.tab === "goals") await renderGoals();
    else if (S.tab === "months") await renderMonths();
    else await renderSettings();
  } catch (e) {
    toast(e.message);
  }
}

/* ================= language ================= */
const langSel = $("#lang-select");
if (langSel) {
  langSel.value = I18N.lang;
  langSel.addEventListener("change", () => {
    I18N.setLang(langSel.value);
    api("PUT", "prefs", { lang: langSel.value }).catch((e) => toast(e.message));
  });
}
document.addEventListener("langchange", () => {
  setFormats();
  if (langSel) langSel.value = I18N.lang;
  updateBulk();
  if (IMP.data) renderImportPreview();
  refresh();
});

/* ================= month ================= */
$("#prev-month").onclick = () => { S.ym = ymAdd(S.ym, -1); renderMonth(); };
$("#next-month").onclick = () => { S.ym = ymAdd(S.ym, 1); renderMonth(); };
$("#today-month").onclick = () => { S.ym = curYM; renderMonth(); };
$$("#entry-filter button").forEach((b) =>
  b.addEventListener("click", () => {
    S.filter = b.dataset.f;
    $$("#entry-filter button").forEach((x) => x.classList.toggle("active", x === b));
    drawEntries();
  })
);
$("#add-entry").onclick = () => entryDialog();
$("#acc-edit").addEventListener("click", () => {
  const acc = (S.month && S.month.account) || {};
  openDialog(
    acc.configured ? t("Uskladi stanje na računu") : t("Stanje na računu"),
    `<p class="hint">${t("Vpiši dejansko stanje iz banke. Aplikacija od tega dne naprej (in nazaj) stanje računa sama: prišteje prihodke ter odšteje stroške in vplačila na cilje.")}</p>
     <div class="row2">
       <div class="field"><label for="f-acc">${t("Stanje na računu (€)")}</label><input id="f-acc" inputmode="decimal" required autofocus value="${acc.now ?? ""}" placeholder="0,00"></div>
       <div class="field"><label for="f-accd">${t("Na dan")}</label><input id="f-accd" type="date" required value="${todayISO}"></div>
     </div>
     <p class="hint">${t("Vpiši stanje po vseh plačilih, ki so na ta dan že vpisana in označena kot plačana.")}</p>
     ${acc.configured ? `<p class="hint">${t("Zadnja uskladitev: {a} na dan {d}.", { a: fmt(acc.anchor_amount), d: `${dateLabel(acc.anchor_date)} ${acc.anchor_date.slice(0, 4)}` })}</p>` : ""}`,
    async () => {
      await api("PUT", "account", { amount: val("f-acc"), date: val("f-accd") });
      toast(t("Stanje na računu shranjeno"));
    },
    null
  );
});
$("#carry-on").addEventListener("change", async (ev) => {
  try {
    await api("POST", "month-settings", { ym: S.ym, carry_in: ev.target.checked });
    toast(ev.target.checked ? t("Prenos iz prejšnjega meseca vklopljen") : t("Prenos izklopljen, mesec začne pri 0"));
    await renderMonth();
  } catch (e) { toast(e.message); }
});
$("#fill-month").onclick = async () => {
  try {
    const r = await api("POST", "months", { action: "refresh", months: [S.ym] });
    const n = r.results[0].added;
    toast(t("Dodano {n} {w} iz predlog", { n, w: plural(n, "vnos", "vnosa", "vnosi", "vnosov") }));
    await renderMonth();
  } catch (e) { toast(e.message); }
};

async function renderMonth() {
  const m = (S.month = await api("GET", "month?ym=" + S.ym));
  $("#month-title").textContent = ymLabel(S.ym);
  const av = $("#m-available");
  av.textContent = fmt(m.available);
  av.classList.toggle("neg", m.available < 0);
  $("#m-perday").textContent =
    m.days_left && m.per_day !== null
      ? t("≈ {a} na dan · še {n} {w}", { a: fmt(m.per_day), n: m.days_left, w: plural(m.days_left, "dan", "dneva", "dnevi", "dni") })
      : S.ym < curYM ? t("Mesec je zaključen") : "";
  $("#m-free").textContent = fmt(m.free_to_spend);
  $("#m-planned").textContent = fmt(m.planned_savings);
  const mu = $("#m-unpaid");
  mu.textContent = fmt(m.unpaid_expense) + (m.overdue_count ? ` · ${m.overdue_count} ${plural(m.overdue_count, "zapadel", "zapadla", "zapadli", "zapadlih")}` : "");
  mu.classList.toggle("alert", m.overdue_count > 0);
  $("#m-income").textContent = fmt(m.totals.income);
  $("#m-expense").textContent = fmt(m.totals.expense);
  $("#m-saving").textContent = fmt(m.totals.saving);
  $("#m-balance").textContent = fmt(m.balance);
  $("#fill-hint").hidden = !m.can_fill;

  // account balance
  const acc = m.account || {};
  const balB = (v) => `<b class="${v < 0 ? "neg" : ""}">${fmt(v)}</b>`;
  if (!acc.configured) {
    $("#acc-vals").innerHTML = `<p class="hint">${t("Vpiši, koliko imaš na računu, pa ga bo aplikacija sproti računala.")}</p>`;
    $("#acc-edit").textContent = t("Vpiši stanje");
  } else {
    $("#acc-vals").innerHTML =
      (acc.now !== null ? `<div><span>${t("Zdaj")}</span>${balB(acc.now)}</div>` : `<div><span>${t("Začetek meseca")}</span>${balB(acc.start)}</div>`) +
      `<div><span>${S.ym < curYM ? t("Ob koncu meseca") : t("Konec meseca (napoved)")}</span>${balB(acc.end)}</div>`;
    $("#acc-edit").textContent = t("Uskladi z banko");
  }

  // carry-over from the previous month
  const fromName = monthGen(+m.carry_from.slice(5, 7) - 1);
  $("#carry-on").checked = m.carry_enabled;
  $("#carry-label").textContent = t("Prenos iz {m}", { m: fromName });
  const mc = $("#m-carry");
  mc.textContent = m.carry_enabled ? signed(m.carry_in) : t("izklopljen");
  mc.classList.toggle("off", !m.carry_enabled);

  const row = (label, v, note, cls = "") =>
    `<tr class="${cls}"><td>${label}${note ? `<small>${note}</small>` : ""}</td><td>${v}</td></tr>`;
  const neg = (v) => (v ? "− " + fmt(v) : fmt(0));
  $("#calc-table").innerHTML =
    row(t("Prenos iz {m}", { m: fromName }), m.carry_enabled ? signed(m.carry_in) : t("izklopljen"),
      m.carry_enabled ? t("končno stanje prejšnjega meseca") : t("ta mesec začne pri 0")) +
    row(t("Prihodki"), "+ " + fmt(m.totals.income)) +
    row(t("Stroški"), neg(m.totals.expense)) +
    row(t("Že vplačano na cilje"), neg(m.totals.saving)) +
    row(t("Še za varčevanje ta mesec"), neg(m.planned_savings), t("rezervirano za cilje; vplačilo ga samo premakne v vrstico zgoraj")) +
    row(t("Še na voljo"), fmt(m.available), "", "total") +
    row(t("Neporabljeni proračuni kategorij"), neg(m.budget_left), t("nakup v kategoriji s proračunom zmanjša to vrstico"), "gap") +
    row(t("Prosto za druge stroške"), fmt(m.free_to_spend), "", "total") +
    row(t("Končno stanje meseca"), signed(m.closing), t("prenos + prihodki − stroški − vplačila; to gre v naslednji mesec"), "gap");
  drawEntries();

  // categories
  const cats = m.categories.filter((c) => c.kind === "expense" && (c.spent > 0 || c.budget > 0)).sort((a, b) => b.spent - a.spent);
  $("#cat-bars").innerHTML = cats.length
    ? cats
        .map((c) => {
          const max = c.budget > 0 ? c.budget : Math.max(...cats.map((x) => x.spent), 1);
          const pct = Math.min(100, (c.spent / max) * 100);
          const over = c.budget > 0 && c.spent > c.budget;
          const right = c.budget > 0
            ? over ? t("{a} · {b} čez", { a: fmt(c.spent), b: fmt(-c.remaining) }) : `${fmt(c.spent)} / ${fmt0(c.budget)}`
            : fmt(c.spent);
          return `<div class="bar-row ${over ? "over" : ""}">
            <div class="top-line"><span>${esc(c.name)}</span><span>${right}</span></div>
            <div class="track"><div class="fill" style="width:${pct}%;background:${over ? "var(--exp)" : esc(c.color)}"></div></div>
          </div>`;
        })
        .join("")
    : `<div class="empty">${t("Ta mesec še ni stroškov.")}</div>`;

  // goals
  $("#month-goals").innerHTML = m.goals.length
    ? m.goals.map((g) => `<div class="bar-row">
          <div class="top-line"><span>${esc(g.name)}${g.not_started ? ` <span class="badge future">${t("od {m}", { m: ymGen(g.start_date.slice(0, 7)) })}</span>` : ""}</span><span>${fmt(g.contributed_this_month)}${g.needed_this_month ? " / " + fmt(g.needed_this_month) : ""}</span></div>
          <div class="track"><div class="fill" style="width:${g.needed_this_month ? Math.min(100, (g.contributed_this_month / g.needed_this_month) * 100) : g.progress * 100}%;background:${esc(g.color)}"></div></div>
        </div>`).join("") +
      `<button class="ghost small" id="mg-add">${t("+ Vplačaj na cilj")}</button>` +
      (m.available > 0
        ? `<div class="leftover"><span>${t("Prosti ostanek:")} <b>${fmt(m.available)}</b></span>
           <button class="primary small" id="mg-leftover">${t("Prenesi ostanek na cilj")}</button></div>`
        : "")
    : `<div class="empty">${t("Ni ciljev. Dodaj jih v zavihku Cilji.")}</div>`;
  const mg = $("#mg-add");
  if (mg) mg.onclick = () => entryDialog({ kind: "saving" });
  const lo = $("#mg-leftover");
  if (lo) lo.onclick = () => {
    const last = `${S.ym}-${pad(new Date(+S.ym.slice(0, 4), +S.ym.slice(5, 7), 0).getDate())}`;
    entryDialog({ kind: "saving", amount: m.available, date: S.ym === curYM ? todayISO : last,
      description: t("Ostanek {m}", { m: monthGen(+S.ym.slice(5, 7) - 1) }) });
  };
}

function drawEntries() {
  const list = S.month.entries.filter((e) => S.filter === "all" || e.kind === S.filter);
  $("#entries").innerHTML = list.length
    ? list
        .slice()
        .reverse()
        .map((e) => {
          const color = e.kind === "saving" ? "var(--sav)" : e.category_color || "#888";
          const title = e.description || (e.kind === "saving" ? e.goal_name : e.category_name) || kindLabel(e.kind);
          const sub = [dateLabel(e.date), e.kind === "saving" ? "→ " + (e.goal_name || "") : e.category_name].filter(Boolean).join(" · ");
          const cls = { income: "inc", expense: "exp", saving: "sav" }[e.kind];
          const sign = e.kind === "income" ? "+" : e.kind === "expense" ? "−" : "";
          const state = e.kind === "income" ? t("pričakovano") : e.kind === "saving" ? t("še ne vplačano") : e.date < todayISO ? t("zapadlo") : t("neplačano");
          const badges = (e.recurring_id ? `<span class="badge">${t("ponavlja")}</span>` : "") +
            (!e.paid
              ? `<button type="button" class="badge warn pay-btn ${e.kind === "expense" && e.date < todayISO ? "overdue" : ""}" data-pay-entry="${e.id}"
                   title="${esc(t("Klikni dvakrat za označitev kot plačano"))}">${state}</button>`
              : "");
          return `<li data-id="${e.id}"><span class="dot" style="background:${esc(color)}"></span>
            <div><div class="t">${esc(title)}${badges}</div><div class="s">${esc(sub)}</div></div>
            <div class="a ${cls}">${sign}${fmt(Math.abs(e.amount))}</div></li>`;
        })
        .join("")
    : `<li class="empty" style="display:block;cursor:default">${t("Ni vnosov.")}</li>`;
  $$("[data-pay-entry]").forEach((b) => {
    const e = S.month.entries.find((x) => x.id === +b.dataset.payEntry);
    const ask = e.kind === "income" ? t("Potrdi: prejeto?") : e.kind === "saving" ? t("Potrdi: vplačano?") : t("Potrdi: plačano?");
    twoStep(b, ask, async () => {
      await api("PUT", "entries/" + e.id, { ...e, paid: true });
      toast(e.kind === "income" ? t("Označeno kot prejeto") : e.kind === "saving" ? t("Označeno kot vplačano") : t("Označeno kot plačano"));
      await renderMonth();
    });
  });
  $$("#entries li[data-id]").forEach((li) =>
    li.addEventListener("click", () => entryDialog(S.month.entries.find((e) => e.id === +li.dataset.id)))
  );
}

/* ================= overview ================= */
$("#prev-year").onclick = () => { S.year--; renderOverview(); };
$("#next-year").onclick = () => { S.year++; renderOverview(); };

async function renderOverview() {
  const [y, ys] = await Promise.all([api("GET", "year?y=" + S.year), api("GET", "years")]);
  $("#year-title").textContent = S.year;
  $("#y-income").textContent = fmt(y.totals.income);
  $("#y-expense").textContent = fmt(y.totals.expense);
  $("#y-saving").textContent = fmt(y.totals.saving);
  $("#y-balance").textContent = fmt(y.balance);
  const inc = cssVar("--inc"), exp = cssVar("--exp"), sav = cssVar("--sav");
  barChart($("#chart-months"), I18N.monthsShort(), [
    { name: t("Prihodki"), color: inc, values: y.series.income },
    { name: t("Stroški"), color: exp, values: y.series.expense },
    { name: t("Varčevanje"), color: sav, values: y.series.saving },
  ], (i) => ymLabel(y.months[i]), y.months.map((m) => m > curYM));
  lineChart($("#chart-savings"), I18N.monthsShort(), y.savings_cumulative, sav, (i) => ymLabel(y.months[i]));
  const ec = y.categories.filter((c) => c.kind === "expense");
  const max = Math.max(...ec.map((c) => c.total), 1);
  $("#chart-cats").innerHTML = ec.length
    ? ec.map((c) => `<div class="bar-row"><div class="top-line"><span>${esc(c.name)}</span><span>${fmt(c.total)} · ${t("{a}/mes", { a: fmt(c.total / 12) })}</span></div>
        <div class="track"><div class="fill" style="width:${(c.total / max) * 100}%;background:${esc(c.color)}"></div></div></div>`).join("")
    : `<div class="empty">${t("Ni podatkov za to leto.")}</div>`;
  if (ys.length) {
    barChart($("#chart-years"), ys.map((r) => String(r.year)), [
      { name: t("Prihodki"), color: inc, values: ys.map((r) => r.income) },
      { name: t("Stroški"), color: exp, values: ys.map((r) => r.expense) },
      { name: t("Varčevanje"), color: sav, values: ys.map((r) => r.saving) },
    ], (i) => String(ys[i].year), ys.map((r) => r.year > now.getFullYear()));
  } else $("#chart-years").innerHTML = `<div class="empty">${t("Ni podatkov.")}</div>`;
}

/* ================= charts (SVG) ================= */
function niceMax(v) {
  if (v <= 0) return 100;
  // four equal steps with a "round" step size
  const raw = v / 4, p = Math.pow(10, Math.floor(Math.log10(raw)));
  for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8, 10]) if (m * p >= raw) return m * p * 4;
  return 40 * p;
}
const shortNum = (v) => (Math.abs(v) >= 1000 ? (v / 1000).toLocaleString(I18N.locale(), { maximumFractionDigits: 1 }) + "k" : String(Math.round(v)));

function tipFor(svg, show) {
  let tip = $(".tip");
  if (!tip) { tip = document.createElement("div"); tip.className = "tip"; tip.hidden = true; document.body.appendChild(tip); }
  svg.addEventListener("mousemove", (ev) => {
    const html = show(ev);
    if (!html) { tip.hidden = true; return; }
    tip.innerHTML = html;
    tip.hidden = false;
    tip.style.left = Math.min(ev.clientX + 12, innerWidth - tip.offsetWidth - 8) + "px";
    tip.style.top = ev.clientY - tip.offsetHeight - 10 + "px";
  });
  svg.addEventListener("mouseleave", () => (tip.hidden = true));
}

function barChart(el, labels, series, labelFor, future = []) {
  const W = 760, H = 260, L = 46, R = 8, T = 10, B = 26;
  const max = niceMax(Math.max(...series.flatMap((s) => s.values), 0));
  const n = labels.length, gw = (W - L - R) / n, bw = Math.min(18, (gw * 0.75) / series.length);
  const y = (v) => T + (H - T - B) * (1 - v / max);
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = (max / 4) * i, yy = y(v);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${shortNum(v)}</text>`;
  }
  labels.forEach((lab, i) => {
    const cx = L + gw * i + gw / 2, x0 = cx - (bw * series.length) / 2;
    series.forEach((s, j) => {
      const v = s.values[i] || 0, h = (H - T - B) - (y(v) - T);
      if (v > 0) g += `<rect x="${x0 + j * bw + 1}" y="${y(v)}" width="${bw - 2}" height="${h}" rx="3" fill="${s.color}" opacity="${future[i] ? 0.45 : 1}"/>`;
    });
    g += `<text x="${cx}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`;
  });
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  const svg = $("svg", el);
  tipFor(svg, (ev) => {
    const r = svg.getBoundingClientRect(), x = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.floor((x - L) / gw);
    if (i < 0 || i >= n) return null;
    return `<b>${esc(labelFor(i))}</b>${future[i] ? ` (${t("napoved")})` : ""}<br>` + series.map((s) => `${s.name}: ${fmt(s.values[i])}`).join("<br>");
  });
}

function lineChart(el, labels, values, color, labelFor) {
  const W = 440, H = 250, L = 44, R = 12, T = 12, B = 26;
  const lo = Math.min(0, ...values), max = niceMax(Math.max(...values, 0) - lo) + lo;
  const n = labels.length, step = (W - L - R) / (n - 1);
  const x = (i) => L + step * i, y = (v) => T + (H - T - B) * (1 - (v - lo) / (max - lo || 1));
  let g = "";
  for (let i = 0; i <= 4; i++) {
    const v = lo + ((max - lo) / 4) * i, yy = y(v);
    g += `<line class="grid" x1="${L}" x2="${W - R}" y1="${yy}" y2="${yy}"/><text x="${L - 6}" y="${yy + 4}" text-anchor="end">${shortNum(v)}</text>`;
  }
  const pts = values.map((v, i) => `${x(i)},${y(v)}`).join(" ");
  g += `<polygon points="${x(0)},${y(lo)} ${pts} ${x(n - 1)},${y(lo)}" fill="${color}" opacity=".12"/>`;
  g += `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round"/>`;
  values.forEach((v, i) => (g += `<circle cx="${x(i)}" cy="${y(v)}" r="3" fill="${color}"/>`));
  labels.forEach((lab, i) => (g += `<text x="${x(i)}" y="${H - 8}" text-anchor="middle">${esc(lab)}</text>`));
  el.innerHTML = `<svg viewBox="0 0 ${W} ${H}" role="img">${g}</svg>`;
  const svg = $("svg", el);
  tipFor(svg, (ev) => {
    const r = svg.getBoundingClientRect(), xx = ((ev.clientX - r.left) / r.width) * W;
    const i = Math.round((xx - L) / step);
    if (i < 0 || i >= n) return null;
    return `<b>${esc(labelFor(i))}</b><br>${t("Prihranki")}: ${fmt(values[i])}`;
  });
}

/* ================= goals ================= */
$("#add-goal").onclick = () => goalDialog();

S.goalFilter = "active";
$$("#goal-filter button").forEach((b) => b.addEventListener("click", () => {
  S.goalFilter = b.dataset.gf;
  $$("#goal-filter button").forEach((x) => x.classList.toggle("active", x === b));
  renderGoals();
}));

async function renderGoals() {
  const all = await api("GET", "goals");
  const counts = { active: all.filter((g) => !g.archived).length, archived: all.filter((g) => g.archived).length, all: all.length };
  $$("#goal-filter button").forEach((b) => {
    b.textContent = { active: t("Aktivni"), archived: t("Arhivirani"), all: t("Vsi") }[b.dataset.gf] + ` (${counts[b.dataset.gf]})`;
  });
  const goals = all.filter((g) => S.goalFilter === "all" || (S.goalFilter === "archived" ? g.archived : !g.archived));
  const el = $("#goals-list");
  if (!goals.length) {
    const msg = !all.length
      ? t('Še nimaš ciljev. Dodaj npr. "Rezerva za nujne primere" ali "Dopust".')
      : S.goalFilter === "archived" ? t("Ni arhiviranih ciljev.") : t("Ni aktivnih ciljev. Dodaj novega z gumbom + Nov cilj.");
    el.innerHTML = `<div class="card empty" style="grid-column:1/-1">${esc(msg)}</div>`;
    return;
  }
  el.innerHTML = goals.map((g) => {
    const pct = Math.round(g.progress * 100);
    const td = g.target_date ? ymLabel(g.target_date.slice(0, 7)) : t("brez roka");
    const sd = g.start_date ? ymLabel(g.start_date.slice(0, 7)) : null;
    return `<div class="card goal-card" data-id="${g.id}" style="${g.archived ? "opacity:.55" : ""}">
      <div class="ring">${ring(g.progress, g.color)}<div>
        <h3>${esc(g.name)}${g.archived ? ` <span class="badge">${t("arhiviran")}</span>` : ""}${g.reached ? ` <span class="badge">${t("doseženo ✓")}</span>` : ""}${g.not_started && !g.archived ? ` <span class="badge future">${t("še ni začet")}</span>` : ""}</h3>
        <div class="hint" style="margin:0">${sd ? `${sd} – ` : t("Rok:") + " "}${td}</div></div></div>
      <div class="amt">${fmt0(g.saved_total)} <small>/ ${fmt0(g.target)}</small></div>
      <div class="track"><div class="fill" style="width:${pct}%;background:${esc(g.color)}"></div></div>
      <div class="meta">
        <div><span>${t("Manjka še")}</span>${fmt(Math.max(0, g.target - g.saved_total))}</div>
        <div><span>${g.not_started ? t("Na mesec od {m}", { m: ymGen(g.start_date.slice(0, 7)) }) : t("Potrebno na mesec")}</span>${!g.target_date ? "—" : g.not_started ? fmt(g.monthly_plan || 0) : fmt(g.needed_this_month)}</div>
        <div><span>${t("Ta mesec vplačano")}</span>${fmt(g.contributed_this_month)}</div>
        <div><span>${t("Mesecev do roka")}</span>${g.months_left ?? "—"}</div>
      </div>
      ${g.archived ? "" : `<div class="actions"><button class="primary small" data-pay="${g.id}">${t("+ Vplačaj")}</button><button class="ghost small" data-edit="${g.id}">${t("Uredi")}</button></div>`}
    </div>`;
  }).join("");
  $$("[data-pay]", el).forEach((b) => b.addEventListener("click", (e) => { e.stopPropagation(); entryDialog({ kind: "saving", goal_id: +b.dataset.pay }); }));
  $$(".goal-card", el).forEach((c) => c.addEventListener("click", () => goalDialog(goals.find((g) => g.id === +c.dataset.id))));
}

function ring(p, color) {
  const r = 20, c = 2 * Math.PI * r;
  return `<svg width="52" height="52" viewBox="0 0 52 52"><circle cx="26" cy="26" r="${r}" fill="none" stroke="var(--line)" stroke-width="6"/>
    <circle cx="26" cy="26" r="${r}" fill="none" stroke="${esc(color)}" stroke-width="6" stroke-linecap="round"
    stroke-dasharray="${c * Math.min(1, p)} ${c}" transform="rotate(-90 26 26)"/>
    <text x="26" y="30" text-anchor="middle" font-size="11" font-weight="700" fill="currentColor">${Math.round(p * 100)}%</text></svg>`;
}

/* ================= month management ================= */
S.sel = new Set();
S.months = [];

// button that needs a second click to confirm
function twoStep(btn, confirmLabel, action) {
  btn.addEventListener("click", async (ev) => {
    ev.stopPropagation();
    if (!btn.dataset.armed) {
      btn.dataset.armed = "1";
      btn.dataset.label = btn.textContent;
      btn.textContent = confirmLabel;
      clearTimeout(btn._t);
      btn._t = setTimeout(() => { delete btn.dataset.armed; btn.textContent = btn.dataset.label; }, 10000);
      return;
    }
    clearTimeout(btn._t);
    delete btn.dataset.armed;
    btn.textContent = btn.dataset.label;
    try { await action(); } catch (e) { toast(e.message); }
  });
}

const nMonths = (n) => `${n} ${plural(n, "mesec", "meseca", "meseci", "mesecev")}`;

async function monthAction(action, months) {
  const r = await api("POST", "months", { action, months });
  const n = r.results.length;
  if (action === "delete") {
    const removed = r.results.reduce((a, x) => a + x.removed, 0);
    const vn = `${removed} ${plural(removed, "vnos", "vnosa", "vnosi", "vnosov")}`;
    toast(n === 1 ? t("{m}: izbrisano {v}", { m: ymLabel(months[0]), v: vn }) : t("Izbrisano: {m} ({v})", { m: nMonths(n), v: vn }));
  } else {
    const added = r.results.reduce((a, x) => a + x.added, 0);
    const removedR = r.results.reduce((a, x) => a + x.removed, 0);
    toast(n === 1 ? t("{m} osvežen: odstranjenih {r}, dodanih {a} iz predlog", { m: ymLabel(months[0]), r: removedR, a: added }) : t("Osveženo: {m}", { m: nMonths(n) }));
  }
  months.forEach((m) => S.sel.delete(m));
  await renderMonths();
}

async function renderMonths() {
  S.months = await api("GET", "months");
  const known = new Set(S.months.map((m) => m.ym));
  [...S.sel].forEach((m) => { if (!known.has(m)) S.sel.delete(m); });
  const el = $("#months-list");
  if (!S.months.length) {
    el.innerHTML = `<li class="empty" style="display:block">${t("Še ni nobenega meseca z vnosi.")}</li>`;
  } else {
    el.innerHTML = S.months.map((m) => {
      const st = { future: `<span class="badge future">${t("prihodnji")}</span>`, current: `<span class="badge current">${t("tekoči")}</span>`, past: "" }[m.status];
      const info = m.count
        ? `${m.count} ${plural(m.count, "vnos", "vnosa", "vnosi", "vnosov")} · ${t("{n} iz predlog", { n: m.from_templates })} · ${m.manual} ${plural(m.manual, "ročni", "ročna", "ročni", "ročnih")}`
        : t("prazen");
      return `<li data-ym="${m.ym}" class="${S.sel.has(m.ym) ? "sel" : ""}">
        <input type="checkbox" id="mc-${m.ym}" aria-label="${esc(t("Označi {m}", { m: ymLabel(m.ym) }))}" ${S.sel.has(m.ym) ? "checked" : ""}>
        <div><button type="button" class="name" data-open="${m.ym}">${ymLabel(m.ym)}</button> ${st}<div class="s">${info}</div></div>
        <div class="sums"><div class="inc">+${fmt(m.income)}</div><div class="exp">−${fmt(m.expense + m.saving)}</div>${m.balance_end !== undefined ? `<div class="bal" title="${esc(t("Stanje na računu ob koncu meseca"))}">= ${fmt(m.balance_end)}</div>` : ""}</div>
        <div class="acts">
          <button type="button" class="ghost small" data-refresh="${m.ym}">${t("Osveži")}</button>
          <button type="button" class="ghost small danger" data-delete="${m.ym}" ${m.count ? "" : "disabled"}>${t("Izbriši")}</button>
        </div></li>`;
    }).join("");
  }
  $$("#months-list input[type=checkbox]").forEach((cb) => cb.addEventListener("change", () => {
    const ym = cb.closest("li").dataset.ym;
    cb.checked ? S.sel.add(ym) : S.sel.delete(ym);
    cb.closest("li").classList.toggle("sel", cb.checked);
    updateBulk();
  }));
  $$("[data-open]", el).forEach((b) => b.addEventListener("click", () => { S.ym = b.dataset.open; $('.tabs button[data-tab="month"]').click(); }));
  $$("[data-refresh]", el).forEach((b) => twoStep(b, t("Potrdi osvežitev"), () => monthAction("refresh", [b.dataset.refresh])));
  $$("[data-delete]", el).forEach((b) => twoStep(b, t("Potrdi brisanje"), () => monthAction("delete", [b.dataset.delete])));
  updateBulk();
}

function updateBulk() {
  const n = S.sel.size;
  $("#bulk-refresh").disabled = $("#bulk-delete").disabled = !n;
  if (!$("#bulk-refresh").dataset.armed) $("#bulk-refresh").textContent = n ? t("Osveži označene ({n})", { n }) : t("Osveži označene");
  if (!$("#bulk-delete").dataset.armed) $("#bulk-delete").textContent = n ? t("Izbriši označene ({n})", { n }) : t("Izbriši označene");
}

$$("#month-select button").forEach((b) => b.addEventListener("click", () => {
  S.sel.clear();
  const pick = { all: () => true, future: (m) => m.status === "future", nomanual: (m) => m.manual === 0, none: () => false }[b.dataset.sel];
  S.months.forEach((m) => { if (pick(m)) S.sel.add(m.ym); });
  if (b.dataset.sel === "nomanual") toast(S.sel.size
    ? t("Označeno: {m} brez ročnih vnosov", { m: nMonths(S.sel.size) })
    : t("Ni mesecev brez ročnih vnosov"));
  renderMonths();
}));
twoStep($("#bulk-refresh"), t("Potrdi osvežitev"), () => monthAction("refresh", [...S.sel].sort()));
twoStep($("#bulk-delete"), t("Potrdi brisanje"), () => monthAction("delete", [...S.sel].sort()));

/* ================= settings ================= */
$("#add-recurring").onclick = () => recurringDialog();
$("#add-category").onclick = () => categoryDialog();

/* ----- Excel import ----- */
// sheet names like "Oktober26", "Okt 2026", "October26" or "Oktober2026" (Slovenian, English or German month names)
const MONTH_KEYS = [["jan"], ["feb"], ["mar", "mär"], ["apr"], ["maj", "may", "mai"], ["jun"], ["jul"], ["avg", "aug"], ["sep"], ["okt", "oct"], ["nov"], ["dec", "dez"]];
const colNum = (s) => [...s].reduce((n, ch) => n * 26 + ch.charCodeAt(0) - 64, 0);
const normTxt = (v) => String(v ?? "").replace(/\s+/g, " ").trim();
const isNum = (v) => typeof v === "number" && isFinite(v);

function sheetMonth(name) {
  const m = normTxt(name).toLowerCase().match(/^([a-zčšžäöü]+)\s*[-_ ]?\s*(\d{2}|\d{4})?$/);
  if (!m) return null;
  const idx = MONTH_KEYS.findIndex((keys) => keys.includes(m[1].slice(0, 3)));
  if (idx < 0) return null;
  const y = m[2] ? (m[2].length === 2 ? 2000 + +m[2] : +m[2]) : now.getFullYear();
  return `${y}-${pad(idx + 1)}`;
}

// reads one monthly sheet laid out as: INCOME | FIXED COSTS | VARIABLE COSTS (one column pair per category)
function parseMonthSheet(cells) {
  const grid = {};
  let maxRow = 0, maxCol = 0;
  for (const [ref, v] of Object.entries(cells)) {
    const m = ref.match(/^([A-Z]+)(\d+)$/);
    if (!m) continue;
    const c = colNum(m[1]), r = +m[2];
    (grid[r] = grid[r] || {})[c] = v;
    maxRow = Math.max(maxRow, r); maxCol = Math.max(maxCol, c);
  }
  const get = (c, r) => (grid[r] || {})[c];
  const find = (re) => {
    for (let r = 1; r <= maxRow; r++) for (let c = 1; c <= maxCol; c++) if (typeof get(c, r) === "string" && re.test(normTxt(get(c, r)))) return { c, r };
    return null;
  };
  const inc = find(/^(prihodki|income|einnahmen)$/i);
  const fix = find(/^(fiksni\s+(odhodki|stro[sš]ki)|fixed\s+(costs|expenses)|fixkosten)$/i);
  const vari = find(/^(variabilni\s+(odhodki|stro[sš]ki)|variable\s+(costs|expenses)|variable\s+kosten)$/i);
  if (!inc && !fix && !vari) return null;
  const totalRe = /^(skupaj|total|summe|gesamt)/i;
  const findBelow = (c, r0, re) => { for (let r = r0 + 1; r <= maxRow; r++) if (typeof get(c, r) === "string" && re.test(normTxt(get(c, r)))) return r; return null; };
  const entries = [];
  const carryRe = /prej[sš]nj|previous|vormonat/i;
  const takeList = (h, kind, group) => {
    if (!h) return;
    const end = findBelow(h.c, h.r, totalRe) || h.r + 19;
    for (let r = h.r + 1; r < end; r++) {
      const amt = get(h.c + 1, r);
      if (!isNum(amt) || amt === 0) continue;
      const d = normTxt(get(h.c, r));
      entries.push({ kind, group, description: d, amount: Math.round(amt * 100) / 100, carry: kind === "income" && carryRe.test(d) });
    }
  };
  takeList(inc, "income", "income");
  takeList(fix, "expense", "fixed");
  const groups = [];
  if (vari) {
    const hr = vari.r + 1;
    for (let c = vari.c; c <= maxCol; c++) {
      const head = get(c, hr);
      if (typeof head !== "string" || !normTxt(head)) continue;
      const label = normTxt(head);
      const key = "var:" + label.toLowerCase();
      if (!groups.some((g) => g.key === key)) groups.push({ key, label });
      // read to the end of the sheet; skip the "total" row (entries below it are counted too)
      for (let r = hr + 1; r <= maxRow; r++) {
        if (/^(skupaj|total|summe|gesamt)$/i.test(normTxt(get(c, r)))) continue;
        const amt = get(c + 1, r);
        if (!isNum(amt) || amt === 0) continue;
        let d = normTxt(get(c, r));
        if (!d || (r === hr + 1 && d.startsWith("("))) d = label;   // subtitle row or no description
        entries.push({ kind: "expense", group: key, description: d, amount: Math.round(amt * 100) / 100 });
      }
    }
  }
  // totals from the spreadsheet, for comparison
  const valRight = (re) => { const f = find(re); return f && isNum(get(f.c + 1, f.r)) ? get(f.c + 1, f.r) : null; };
  return {
    entries, groups,
    excel: { income: valRight(/^(skupaj\s+prihodki|total\s+income|summe\s+einnahmen)$/i), expense: valRight(/^(skupaj\s+stro[sš]ki|total\s+(costs|expenses)|summe\s+(ausgaben|kosten))$/i) },
  };
}

function parseWorkbook(sheets) {
  const months = [], skipped = [], groupMap = new Map([["income", { key: "income", label: t("Prihodki"), kind: "income" }], ["fixed", { key: "fixed", label: t("Fiksni odhodki"), kind: "expense" }]]);
  for (const sh of sheets) {
    const ym = sheetMonth(sh.name);
    const p = ym && parseMonthSheet(sh.cells);
    if (!p) { skipped.push(sh.name); continue; }
    p.groups.forEach((g) => { if (!groupMap.has(g.key)) groupMap.set(g.key, { ...g, kind: "expense" }); });
    months.push({ ym, sheet: sh.name, ...p });
  }
  months.sort((a, b) => (a.ym < b.ym ? -1 : 1));
  return { months, skipped, groups: [...groupMap.values()] };
}

const IMP = { data: null };

async function readXlsxFile(file) {
  if (window.demoReadXlsx) return window.demoReadXlsx(file);
  const res = await fetch("/api/import/xlsx", { method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: file });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || t("Napaka {n}", { n: res.status }));
  return data.sheets;
}

$("#imp-file").addEventListener("change", async (ev) => {
  const file = ev.target.files[0];
  ev.target.value = "";
  if (!file) return;
  try {
    toast(t("Berem datoteko …"));
    const sheets = await readXlsxFile(file);
    const parsed = parseWorkbook(sheets);
    if (!parsed.months.length) throw new Error(t('V datoteki ni prepoznanih mesečnih listov (npr. "Oktober26" s stolpcem PRIHODKI).'));
    const [meta, prev] = await Promise.all([api("GET", "meta"), api("GET", "import")]);
    S.meta = meta;
    IMP.data = { ...parsed, file: file.name, already: new Set(prev.imported_months) };
    renderImportPreview();
  } catch (e) { toast(e.message); }
});
$("#imp-cancel").addEventListener("click", () => { IMP.data = null; $("#imp-preview").hidden = true; });

function impCarryMode() { return $("#imp-carry-auto").checked ? "auto" : "sheet"; }
function impEntries(m) { return m.entries.filter((e) => !(e.carry && impCarryMode() === "auto")); }

function renderImportPreview() {
  const d = IMP.data;
  $("#imp-preview").hidden = false;
  const sum = (arr, k) => arr.filter((e) => e.kind === k).reduce((a, e) => a + e.amount, 0);
  const near = (a, b) => b === null || Math.abs(a - b) < 0.01;
  $("#imp-months").innerHTML = `<tr><th></th><th>${t("Mesec")}</th><th>${t("List")}</th><th class="num">${t("Vnosov")}</th><th class="num">${t("Prihodki")}</th><th class="num">${t("Odhodki")}</th><th>${t("Primerjava z Excelom")}</th></tr>` +
    d.months.map((m, i) => {
      const es = impEntries(m), inc = sum(m.entries, "income"), exp = sum(m.entries, "expense");
      const okI = near(inc, m.excel.income), okE = near(exp, m.excel.expense);
      const cmp = m.excel.income === null && m.excel.expense === null ? `<span class="s">${t("ni vsot")}</span>`
        : okI && okE ? `<span class="ok">${t("✓ se ujema")}</span>`
        : `<span class="diff">Excel: ${!okI ? t("prihodki") + " " + fmt(m.excel.income) : ""}${!okI && !okE ? ", " : ""}${!okE ? t("odhodki") + " " + fmt(m.excel.expense) : ""}</span>`;
      return `<tr><td><input type="checkbox" class="imp-m" data-i="${i}" id="imp-m-${i}" checked aria-label="${esc(t("Uvozi {m}", { m: ymLabel(m.ym) }))}"></td>
        <td><label for="imp-m-${i}" style="text-transform:capitalize">${ymLabel(m.ym)}</label>${d.already.has(m.ym) ? ` <span class="badge warn">${t("že uvoženo, zamenja")}</span>` : ""}</td>
        <td class="s">${esc(m.sheet)}</td><td class="num">${es.length}</td><td class="num">${fmt(inc)}</td><td class="num">${fmt(exp)}</td><td>${cmp}</td></tr>`;
    }).join("");
  $("#imp-skipped").textContent = d.skipped.length ? t("Preskočeni listi (niso mesečni): {l}", { l: d.skipped.join(", ") }) : "";

  // categories
  const cats = S.meta.categories.filter((c) => !c.archived);
  const newNames = { income: [...new Set(d.groups.filter((g) => g.kind === "income").map((g) => g.label))], expense: [...new Set(d.groups.filter((g) => g.kind === "expense").map((g) => g.label))] };
  $("#imp-map").innerHTML = d.groups.map((g) => {
    const items = d.months.flatMap((m) => m.entries.filter((e) => e.group === g.key));
    if (!items.length) return "";
    const total = items.reduce((a, e) => a + e.amount, 0);
    const own = cats.filter((c) => c.kind === g.kind);
    const match = own.find((c) => c.name.toLowerCase() === g.label.toLowerCase());
    const opts = newNames[g.kind].filter((n) => !own.some((c) => c.name.toLowerCase() === n.toLowerCase()))
      .map((n) => `<option value="new:${esc(n)}" ${!match && n === g.label ? "selected" : ""}>${esc(t("Nova: {n}", { n }))}</option>`).join("") +
      `<optgroup label="${esc(t("Obstoječe kategorije"))}">${own.map((c) => `<option value="${c.id}" ${match && match.id === c.id ? "selected" : ""}>${esc(c.name)}</option>`).join("")}</optgroup>`;
    return `<div class="row"><div><b>${esc(g.label)}</b><span>${items.length} ${plural(items.length, "vnos", "vnosa", "vnosi", "vnosov")} · ${fmt(total)}</span></div>
      <select data-group="${esc(g.key)}" id="imp-g-${esc(g.key.replace(/[^a-z0-9]/gi, "_"))}" aria-label="${esc(t("Kategorija za {g}", { g: g.label }))}">${opts}</select></div>`;
  }).join("");

  // templates from the fixed costs of the last month
  const last = d.months[d.months.length - 1];
  const fixed = last.entries.filter((e) => e.group === "fixed");
  $("#imp-tpl-wrap").hidden = !fixed.length;
  $("#imp-tpl").checked = false;
  const existing = S.meta.recurring.filter((r) => r.active).length;
  $("#imp-tpl-label").textContent = t("Iz {n} fiksnih odhodkov za {m} ustvari ponavljajoče predloge od {s} naprej", { n: fixed.length, m: ymLabel(last.ym), s: ymGen(ymAdd(last.ym, 1)) }) +
    (existing ? " " + t("(imaš že {n} {w})", { n: existing, w: plural(existing, "aktivno predlogo", "aktivni predlogi", "aktivne predloge", "aktivnih predlog") }) : "");
  updateImpButton();
  $("#imp-preview").scrollIntoView({ behavior: "smooth", block: "start" });
}

function updateImpButton() {
  const n = $$(".imp-m:checked").length;
  $("#imp-go").textContent = n ? t("Uvozi {m}", { m: nMonths(n) }) : t("Izberi mesece");
  $("#imp-go").disabled = !n;
}
document.addEventListener("change", (ev) => {
  if (ev.target.matches(".imp-m")) updateImpButton();
  if (ev.target.name === "imp-carry" && IMP.data) renderImportPreview();
});

$("#imp-go").addEventListener("click", async () => {
  const d = IMP.data;
  if (!d) return;
  const chosen = $$(".imp-m:checked").map((cb) => d.months[+cb.dataset.i]);
  const mapping = {};
  $$("#imp-map select").forEach((s) => (mapping[s.dataset.group] = s.value));
  const last = d.months[d.months.length - 1];
  const body = {
    carry_mode: impCarryMode(),
    mapping,
    months: chosen.map((m) => ({ ym: m.ym, entries: impEntries(m).map(({ kind, group, description, amount }) => ({ kind, group, description, amount, day: 1 })) })),
    templates: $("#imp-tpl").checked
      ? { start_ym: ymAdd(last.ym, 1), items: last.entries.filter((e) => e.group === "fixed").map(({ group, description, amount }) => ({ group, description, amount })) }
      : null,
  };
  const btn = $("#imp-go");
  btn.disabled = true;
  try {
    const r = await api("POST", "import", body);
    IMP.data = null;
    $("#imp-preview").hidden = true;
    S.meta = null; await loadMeta();
    toast(t("Uvoženih {n} vnosov za {m}", { n: r.added, m: nMonths(r.months.length) }) +
      (r.replaced ? " " + t("(zamenjanih {n})", { n: r.replaced }) : "") + (r.templates ? ", " + t("{n} predlog", { n: r.templates }) : ""));
    S.ym = r.months[r.months.length - 1];
    await renderSettings();
  } catch (e) { toast(e.message); }
  btn.disabled = false;
});

/* ----- backups ----- */
const bkKind = (k) => ({ auto: ["A", t("samodejna")], manual: ["R", t("ročna")], "pre-restore": ["O", t("pred obnovitvijo")] }[k] || ["?", k]);
const fmtSize = (b) => (b >= 1048576 ? (b / 1048576).toLocaleString(I18N.locale(), { maximumFractionDigits: 1 }) + " MB" : Math.max(1, Math.round(b / 1024)) + " kB");
const fmtDT = (iso) => {
  const d = new Date(iso);
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  if (I18N.lang === "en") return `${d.getDate()} ${I18N.monthsShort()[d.getMonth()]} ${d.getFullYear()} at ${time}`;
  if (I18N.lang === "de") return `${d.getDate()}.${d.getMonth() + 1}.${d.getFullYear()} um ${time}`;
  return `${d.getDate()}. ${d.getMonth() + 1}. ${d.getFullYear()} ob ${time}`;
};
// "every Sunday" in each language; Slovenian needs the accusative and a gendered "vsak/vsako"
function backupWhen(st) {
  const wd = +st.weekday;
  if (st.frequency === "daily") return t("vsak dan");
  if (st.frequency === "monthly") return t("vsak {d}. v mesecu", { d: st.monthday });
  if (I18N.lang === "en") return "every " + ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday"][wd];
  if (I18N.lang === "de") return "jeden " + ["Montag", "Dienstag", "Mittwoch", "Donnerstag", "Freitag", "Samstag", "Sonntag"][wd];
  return `vsak${wd === 2 || wd >= 5 ? "o" : ""} ` + ["ponedeljek", "torek", "sredo", "četrtek", "petek", "soboto", "nedeljo"][wd];
}

function syncBkFields() {
  const f = $("#bk-freq").value;
  $("#bk-weekday-f").hidden = f !== "weekly";
  $("#bk-monthday-f").hidden = f !== "monthly";
  $("#bk-time-f").hidden = $("#bk-keep-f").hidden = f === "off";
}
$("#bk-freq").addEventListener("change", syncBkFields);

async function renderBackups() {
  const o = await api("GET", "backups");
  const st = o.settings;
  $("#bk-freq").value = st.frequency;
  $("#bk-weekday").value = st.weekday;
  $("#bk-monthday").value = st.monthday;
  $("#bk-time").value = st.time;
  $("#bk-keep").value = st.keep;
  syncBkFields();
  $("#bk-status").textContent = st.frequency === "off"
    ? t("Samodejne kopije so izklopljene.")
    : t("Samodejno {w} ob {h}. Naslednja: {n}. Hrani se zadnjih {k}.", { w: backupWhen(st), h: st.time, n: o.next_run ? fmtDT(o.next_run) : "—", k: st.keep });
  $("#bk-dir").textContent = o.backups.length
    ? t("{n} {w}, skupaj {s} · mapa: {d}", { n: o.backups.length, w: plural(o.backups.length, "kopija", "kopiji", "kopije", "kopij"), s: fmtSize(o.total_size), d: tm(o.dir) })
    : t("Mapa: {d}", { d: tm(o.dir) });
  const el = $("#bk-list");
  el.innerHTML = o.backups.length
    ? o.backups.map((b) => {
        const [ico, label] = bkKind(b.kind);
        const dl = window.LOCAL_MODE ? ""
          : window.demoApi
          ? `<button type="button" class="ghost small" disabled title="${esc(t("V demu prenos ni mogoč"))}">${t("Prenesi")}</button>`
          : `<a class="btn ghost" href="/api/backups/${encodeURIComponent(b.name)}">${t("Prenesi")}</a>`;
        return `<li><span class="bk-ico ${b.kind}" title="${esc(label)}">${ico}</span>
          <div><div class="t">${fmtDT(b.created)}</div><div class="s">${label} · ${fmtSize(b.size)}</div></div>
          <div class="acts">${dl}
            <button type="button" class="ghost small" data-restore="${esc(b.name)}">${t("Obnovi")}</button>
            <button type="button" class="ghost small danger" data-bkdel="${esc(b.name)}">${t("Izbriši")}</button>
          </div></li>`;
      }).join("")
    : `<li class="empty" style="display:block">${t('Še ni nobene kopije. Klikni "Naredi kopijo zdaj".')}</li>`;
  $$("[data-restore]", el).forEach((btn) => twoStep(btn, t("Potrdi obnovitev"), async () => {
    await api("POST", `backups/${encodeURIComponent(btn.dataset.restore)}/restore`);
    S.meta = null; await loadMeta();
    toast(t("Podatki obnovljeni. Prejšnje stanje je shranjeno kot kopija."));
    await renderSettings();
  }));
  $$("[data-bkdel]", el).forEach((btn) => twoStep(btn, t("Potrdi brisanje"), async () => {
    await api("DELETE", "backups/" + encodeURIComponent(btn.dataset.bkdel));
    toast(t("Kopija izbrisana"));
    await renderBackups();
  }));
}

$("#bk-now").addEventListener("click", async () => {
  const b = $("#bk-now");
  b.disabled = true;
  try {
    await api("POST", "backups");
    toast(t("Varnostna kopija narejena"));
    await renderBackups();
  } catch (e) { toast(e.message); }
  b.disabled = false;
});
$("#bk-form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  try {
    await api("PUT", "backups/settings", {
      frequency: $("#bk-freq").value, weekday: +$("#bk-weekday").value, monthday: +$("#bk-monthday").value,
      time: $("#bk-time").value || "03:00", keep: +$("#bk-keep").value || 8,
    });
    toast(t("Nastavitve varnostnih kopij shranjene"));
    await renderBackups();
  } catch (e) { toast(e.message); }
});

async function renderSettings() {
  await loadMeta();
  $("#app-version").textContent = t("Različica {v}", { v: UPD.version() || "demo" });
  renderUpdateCard();
  renderBackups().catch((e) => toast(e.message));
  const rec = S.meta.recurring;
  $("#recurring-list").innerHTML = rec.length
    ? rec.map((r) => {
        const cls = { income: "inc", expense: "exp", saving: "sav" }[r.kind];
        const target = r.kind === "saving" ? "→ " + (r.goal_name || "") : r.category_name;
        const period = t("vsak {d}. v mesecu · od {s}", { d: r.day, s: ymLabel(r.start_ym) }) + (r.end_ym ? " " + t("do {e}", { e: ymLabel(r.end_ym) }) : "");
        return `<li data-id="${r.id}" style="${r.active ? "" : "opacity:.5"}"><span class="dot" style="background:var(--${cls})"></span>
          <div><div class="t">${esc(r.description || target)}${r.active ? "" : `<span class="badge">${t("ustavljeno")}</span>`}${r.auto_paid === 0 ? `<span class="badge">${t("ročna potrditev")}</span>` : ""}</div><div class="s">${esc(kindLabel(r.kind))} · ${esc(target)} · ${esc(period)}</div></div>
          <div class="a ${cls}">${fmt(r.amount)}</div></li>`;
      }).join("")
    : `<li class="empty" style="display:block;cursor:default">${t("Dodaj plačo in redne račune, da se samodejno vpišejo vsak mesec.")}</li>`;
  $$("#recurring-list li[data-id]").forEach((li) => li.addEventListener("click", () => recurringDialog(rec.find((r) => r.id === +li.dataset.id))));

  const cats = S.meta.categories;
  $("#category-list").innerHTML = cats.map((c) => `<li data-id="${c.id}" style="${c.archived ? "opacity:.5" : ""}">
      <span class="dot" style="background:${esc(c.color)}"></span>
      <div><div class="t">${esc(c.name)}${c.archived ? `<span class="badge">${t("arhivirana")}</span>` : ""}</div><div class="s">${c.kind === "income" ? t("Prihodek") : t("Strošek")}</div></div>
      <div class="a">${c.kind === "expense" ? (c.budget > 0 ? t("{a}/mes", { a: fmt0(c.budget) }) : "—") : ""}</div></li>`).join("");
  $$("#category-list li[data-id]").forEach((li) => li.addEventListener("click", () => categoryDialog(cats.find((c) => c.id === +li.dataset.id))));
}

/* ================= dialogs ================= */
const dlg = $("#dlg");
let dlgSave = null, dlgDel = null;
$("#dlg-cancel").onclick = () => dlg.close();
$("#dlg-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  try {
    await dlgSave();
    dlg.close();
    await refresh();
  } catch (err) {
    $("#dlg-error").textContent = tm(err.message);
  }
});
$("#dlg-delete").onclick = async () => {
  const btn = $("#dlg-delete");
  if (!dlgDel) return;
  if (!btn.dataset.armed) {
    btn.dataset.armed = "1";
    btn.textContent = t("Klikni še enkrat za brisanje");
    return;
  }
  try {
    const r = await dlgDel();
    dlg.close();
    if (r && r.archived) toast(t("V uporabi — arhivirano namesto izbrisano"));
    await refresh();
  } catch (err) {
    $("#dlg-error").textContent = tm(err.message);
  }
};

function openDialog(title, html, save, del) {
  $("#dlg-title").textContent = title;
  $("#dlg-body").innerHTML = html;
  $("#dlg-error").textContent = "";
  $("#dlg-delete").hidden = !del;
  delete $("#dlg-delete").dataset.armed;
  $("#dlg-delete").textContent = t("Izbriši");
  dlgSave = save;
  dlgDel = del;
  dlg.showModal();
  const first = $("input[autofocus], input", dlg);
  if (first && matchMedia("(pointer:fine)").matches) first.focus();
}

const val = (id) => $("#" + id, dlg).value;
const options = (list, sel, empty) =>
  (empty ? `<option value="">${empty}</option>` : "") +
  list.map((o) => `<option value="${o.id}" ${o.id === sel ? "selected" : ""}>${esc(o.name)}</option>`).join("");

function kindSeg(kinds, active) {
  return `<div class="seg" id="f-kind">${kinds.map((k) => `<button type="button" data-v="${k}" class="${k === active ? "active" : ""}">${kindLabel(k)}</button>`).join("")}</div>`;
}

function wireKind(onChange) {
  $$("#f-kind button", dlg).forEach((b) =>
    b.addEventListener("click", () => {
      $$("#f-kind button", dlg).forEach((x) => x.classList.toggle("active", x === b));
      onChange(b.dataset.v);
    })
  );
}
const curKind = () => $("#f-kind button.active", dlg).dataset.v;

function targetFields(kind, catId, goalId) {
  const cats = S.meta.categories.filter((c) => (c.kind === kind && !c.archived) || c.id === catId);
  const goals = S.meta.goals.filter((g) => !g.archived || g.id === goalId);
  if (kind === "saving")
    return `<div class="field"><label>${t("Cilj")}</label><select id="f-goal" required>${options(goals, goalId, goals.length ? "" : t("— najprej dodaj cilj —"))}</select></div>`;
  return `<div class="field"><label>${t("Kategorija")}</label><select id="f-cat" required>${options(cats, catId || cats[0]?.id)}</select></div>`;
}

async function entryDialog(e = {}) {
  if (!S.meta) await loadMeta();
  const isNew = !e.id;
  const kind = e.kind || "expense";
  const defDate = e.date || (S.ym === curYM ? todayISO : `${S.ym}-01`);
  openDialog(
    isNew ? t("Nov vnos") : t("Uredi vnos"),
    `${kindSeg(["expense", "income", "saving"], kind)}
     <div class="row2">
       <div class="field"><label>${t("Znesek (€)")}</label><input id="f-amount" inputmode="decimal" required autofocus value="${e.amount ?? ""}" placeholder="0,00"></div>
       <div class="field"><label>${t("Datum")}</label><input id="f-date" type="date" required value="${defDate}"></div>
     </div>
     <div id="f-target">${targetFields(kind, e.category_id, e.goal_id)}</div>
     <div class="field"><label>${t("Opis")}</label><input id="f-desc" maxlength="200" value="${esc(e.description || "")}" placeholder="${esc(t("npr. Mercator, položnica …"))}"></div>
     <label class="check"><input type="checkbox" id="f-paid" ${e.paid === 0 ? "" : "checked"}> <span id="f-paid-l">${t("Plačano")}</span></label>
     ${kind === "saving" ? `<p class="hint">${t("Za dvig s cilja vpiši negativen znesek.")}</p>` : ""}`,
    async () => {
      const k = curKind();
      const body = {
        kind: k, amount: val("f-amount"), date: val("f-date"), description: val("f-desc"),
        paid: $("#f-paid", dlg).checked,
        category_id: k === "saving" ? null : val("f-cat"),
        goal_id: k === "saving" ? val("f-goal") : null,
      };
      if (isNew) await api("POST", "entries", body);
      else await api("PUT", "entries/" + e.id, body);
      toast(t("Shranjeno"));
    },
    isNew ? null : () => api("DELETE", "entries/" + e.id)
  );
  const setPaidLabel = (k) => ($("#f-paid-l", dlg).textContent = k === "income" ? t("Prejeto") : k === "saving" ? t("Vplačano") : t("Plačano"));
  setPaidLabel(kind);
  wireKind((k) => { $("#f-target", dlg).innerHTML = targetFields(k); setPaidLabel(k); });
}

function goalDialog(g = {}) {
  const isNew = !g.id;
  openDialog(
    isNew ? t("Nov cilj varčevanja") : t("Uredi cilj"),
    `<div class="field"><label>${t("Ime cilja")}</label><input id="f-name" required autofocus value="${esc(g.name || "")}" placeholder="${esc(t("npr. Rezerva, Dopust, Avto"))}"></div>
     <div class="field"><label>${t("Ciljni znesek (€)")}</label><input id="f-target" inputmode="decimal" required value="${g.target ?? ""}"></div>
     <div class="row2">
       <div class="field"><label>${t("Začetek (mesec)")}</label><input id="f-sdate" type="month" value="${(g.start_date || "").slice(0, 7)}"></div>
       <div class="field"><label>${t("Rok (mesec)")}</label><input id="f-tdate" type="month" value="${(g.target_date || "").slice(0, 7)}"></div>
     </div>
     <div class="row2">
       <div class="field"><label>${t("Že privarčevano (€)")}</label><input id="f-start" inputmode="decimal" value="${g.start_amount ?? 0}"></div>
       <div class="field"><label>${t("Barva")}</label><input id="f-color" type="color" value="${g.color || "#2f855a"}"></div>
     </div>
     ${isNew ? "" : `<label class="check"><input type="checkbox" id="f-arch" ${g.archived ? "checked" : ""}> ${t("Arhiviran")}</label>`}
     <p class="hint">${t("Z rokom aplikacija izračuna, koliko moraš dati na stran vsak mesec, in to odšteje od zneska, ki ga lahko porabiš. Z začetkom cilj do tega meseca ne rezervira ničesar; prazno = začne takoj.")}</p>`,
    async () => {
      const body = { name: val("f-name"), target: val("f-target"), target_date: val("f-tdate") || null, start_date: val("f-sdate") || null, start_amount: val("f-start") || 0, color: val("f-color"), archived: !isNew && $("#f-arch", dlg).checked };
      if (isNew) await api("POST", "goals", body);
      else await api("PUT", "goals/" + g.id, body);
      await loadMeta();
      toast(t("Cilj shranjen"));
    },
    isNew ? null : async () => { const r = await api("DELETE", "goals/" + g.id); await loadMeta(); return r; }
  );
}

async function recurringDialog(r = {}) {
  if (!S.meta) await loadMeta();
  const isNew = !r.id;
  const kind = r.kind || "expense";
  openDialog(
    isNew ? t("Nova ponavljajoča postavka") : t("Uredi ponavljajočo postavko"),
    `${kindSeg(["expense", "income", "saving"], kind)}
     <div class="field"><label>${t("Opis")}</label><input id="f-desc" maxlength="200" required autofocus value="${esc(r.description || "")}" placeholder="${esc(t("npr. Plača, Najemnina, Elektrika"))}"></div>
     <div class="row2">
       <div class="field"><label>${t("Znesek (€)")}</label><input id="f-amount" inputmode="decimal" required value="${r.amount ?? ""}"></div>
       <div class="field"><label>${t("Dan v mesecu")}</label><input id="f-day" type="number" min="1" max="31" required value="${r.day ?? 1}"></div>
     </div>
     <div id="f-target">${targetFields(kind, r.category_id, r.goal_id)}</div>
     <div class="row2">
       <div class="field"><label>${t("Od meseca")}</label><input id="f-start" type="month" required value="${r.start_ym || curYM}"></div>
       <div class="field"><label>${t("Do meseca (neobvezno)")}</label><input id="f-end" type="month" value="${r.end_ym || ""}"></div>
     </div>
     <label class="check"><input type="checkbox" id="f-auto" ${r.auto_paid === 0 ? "" : "checked"}> ${t("Samodejno označi kot plačano na dan zapadlosti")}</label>
     <p class="hint" style="margin-top:-.5rem">${t("Vklopljeno za trajnike in direktne bremenitve. Izklopi za položnice, ki jih plačaš sam: takrat te opomni, ko zapadejo.")}</p>
     ${isNew ? "" : `<label class="check"><input type="checkbox" id="f-active" ${r.active ? "checked" : ""}> ${t("Aktivno")}</label>`}
     <p class="hint">${t("Če se znesek spreminja (npr. elektrika), vpiši povprečje — dejanski znesek popraviš v posameznem mesecu.")}</p>`,
    async () => {
      const k = curKind();
      const body = {
        kind: k, description: val("f-desc"), amount: val("f-amount"), day: val("f-day"),
        start_ym: val("f-start"), end_ym: val("f-end") || null, active: isNew ? true : $("#f-active", dlg).checked, auto_paid: $("#f-auto", dlg).checked,
        category_id: k === "saving" ? null : val("f-cat"), goal_id: k === "saving" ? val("f-goal") : null,
      };
      if (isNew) await api("POST", "recurring", body);
      else await api("PUT", "recurring/" + r.id, body);
      toast(t("Shranjeno"));
    },
    isNew ? null : () => api("DELETE", "recurring/" + r.id)
  );
  wireKind((k) => ($("#f-target", dlg).innerHTML = targetFields(k)));
}

function categoryDialog(c = {}) {
  const isNew = !c.id;
  openDialog(
    isNew ? t("Nova kategorija") : t("Uredi kategorijo"),
    `${kindSeg(["expense", "income"], c.kind || "expense")}
     <div class="field"><label>${t("Ime")}</label><input id="f-name" required autofocus value="${esc(c.name || "")}"></div>
     <div class="row2">
       <div class="field" id="f-budget-wrap"><label>${t("Mesečni proračun (€)")}</label><input id="f-budget" inputmode="decimal" value="${c.budget ?? 0}"></div>
       <div class="field"><label>${t("Barva")}</label><input id="f-color" type="color" value="${c.color || "#718096"}"></div>
     </div>
     ${isNew ? "" : `<label class="check"><input type="checkbox" id="f-arch" ${c.archived ? "checked" : ""}> ${t("Arhivirana (skrita pri novih vnosih)")}</label>`}`,
    async () => {
      const body = { kind: curKind(), name: val("f-name"), budget: curKind() === "expense" ? val("f-budget") || 0 : 0, color: val("f-color"), archived: !isNew && $("#f-arch", dlg).checked };
      if (isNew) await api("POST", "categories", body);
      else await api("PUT", "categories/" + c.id, body);
      await loadMeta();
      toast(t("Shranjeno"));
    },
    isNew ? null : async () => { const r = await api("DELETE", "categories/" + c.id); await loadMeta(); return r; }
  );
  const sync = (k) => ($("#f-budget-wrap", dlg).style.visibility = k === "expense" ? "visible" : "hidden");
  sync(c.kind || "expense");
  wireKind(sync);
}

/* ================= start ================= */
/* ================= updates: optional check for a new release on GitHub ================= */
const UPD = {
  edition: () => window.APP_EDITION || "docker",
  version: () => window.APP_VERSION || (S.meta && S.meta.version) || "",
  repo: () => window.APP_REPO || (S.meta && S.meta.repo) || "",
  found: null,
};
function store(key, value) {
  try {
    if (value === undefined) return localStorage.getItem(key);
    if (value === null) localStorage.removeItem(key); else localStorage.setItem(key, value);
  } catch (e) { /* storage unavailable: the setting simply is not remembered */ }
  return null;
}
const verParts = (v) => String(v).replace(/^v/i, "").split(/[.+-]/).slice(0, 3).map((x) => parseInt(x, 10) || 0);
function isNewer(a, b) {
  const x = verParts(a), y = verParts(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i];
  return false;
}
const updEnabled = () => UPD.edition() !== "demo" && /^[\w.-]+\/[\w.-]+$/.test(UPD.repo());

async function latestRelease(force) {
  const key = "expenses-upd-cache";
  if (!force) {
    try {
      const c = JSON.parse(store(key) || "null");
      if (c && c.repo === UPD.repo() && Date.now() - c.at < 12 * 3600e3) return c.rel;
    } catch (e) { /* ignore a broken cache */ }
  }
  let rel;
  if (window.LOCAL && window.LOCAL.latestRelease) rel = await window.LOCAL.latestRelease();
  else {
    let r;
    try { r = await fetch(`https://api.github.com/repos/${UPD.repo()}/releases/latest`, { headers: { Accept: "application/vnd.github+json" } }); }
    catch (e) { throw new Error(t("GitHub trenutno ni dosegljiv ({s}).", { s: e.message })); }
    if (r.status === 404) throw new Error(t("Na GitHubu še ni objavljene različice."));
    if (!r.ok) throw new Error(t("GitHub trenutno ni dosegljiv ({s}).", { s: r.status }));
    const j = await r.json();
    rel = { tag: j.tag_name, url: j.html_url, notes: String(j.body || "").slice(0, 1500) };
  }
  rel.version = String(rel.tag).replace(/^v/i, "");
  store(key, JSON.stringify({ at: Date.now(), repo: UPD.repo(), rel }));
  return rel;
}

function updateHelp(rel) {
  const ed = UPD.edition(), repo = UPD.repo();
  const dl = (f) => `https://github.com/${repo}/releases/download/${encodeURIComponent(rel.tag)}/${f}`;
  if (ed === "local") {
    return `<ol><li>${t("Prenesi novo datoteko {f}.", { f: `<a href="${dl("Expenses.html")}">Expenses.html</a>` })}</li>
      <li>${t("Z njo zamenjaj staro datoteko in jo odpri. Podatki ostanejo v tvoji mapi.")}</li></ol>`;
  }
  if (ed === "google") {
    return `<p>${t("Samodejno (samo lastnik projekta, enkrat je treba vklopiti Apps Script API – glej navodila na GitHubu):")}</p>
      <div class="data-actions"><button type="button" class="primary" id="upd-self">${t("Posodobi zdaj")}</button></div>
      <p class="hint">${t("Ali ročno:")}</p>
      <ol><li>${t("Prenesi {a} in {b}.", { a: `<a href="${dl("Code.gs")}" target="_blank" rel="noopener">Code.gs</a>`, b: `<a href="${dl("index.html")}" target="_blank" rel="noopener">index.html</a>` })}</li>
      <li>${t("V projektu na script.google.com zamenjaj vsebino datotek s kodo in index.")}</li>
      <li>${t("Uvedi → Upravljaj uvedbe → svinčnik → Različica: Nova različica → Uvedi.")}</li></ol>`;
  }
  return `<ol><li>${t("Synology Container Manager: Slika → izberi sliko expenses → Posodobi. Kontejner se znova zažene sam.")}</li>
    <li>${t("Ali v terminalu, v mapi z docker-compose.yml:")} <code>docker compose pull &amp;&amp; docker compose up -d</code></li></ol>
    <p class="hint">${t("Podatki v mapi data ostanejo. Pred posodobitvijo lahko narediš varnostno kopijo.")}</p>`;
}

function showUpdate(rel, box) {
  box.innerHTML = `<p><b>${t("Na voljo je nova različica {v}", { v: esc(rel.version) })}</b> (${t("imaš {v}", { v: esc(UPD.version()) })}).
      <a href="${esc(rel.url)}" target="_blank" rel="noopener">${t("Kaj je novega")}</a></p>${updateHelp(rel)}`;
  box.hidden = false;
  const btn = box.querySelector("#upd-self");
  if (btn) twoStep(btn, t("Potrdi posodobitev"), async () => {
    btn.disabled = true; btn.textContent = t("Posodabljam …");
    try {
      const r = await window.LOCAL.run("selfUpdate", rel.tag);
      box.innerHTML = `<p><b>${t("Posodobljeno na {v}.", { v: esc(rel.version) })}</b> ${r.deployments
        ? t("Znova naloži stran, da se odpre nova različica.") : t("Ni bilo najdene uvedbe spletne aplikacije: uvedi novo različico ročno.")}</p>`;
    } catch (e) { btn.disabled = false; btn.textContent = t("Posodobi zdaj"); toast(e.message); }
  });
}

async function checkForUpdate(force) {
  const rel = await latestRelease(force);
  UPD.found = rel && isNewer(rel.version, UPD.version()) ? rel : null;
  return UPD.found;
}

function renderUpdateCard() {
  const card = $("#update-card");
  if (!card) return;
  card.hidden = !updEnabled();
  if (card.hidden) return;
  $("#upd-auto").checked = store("expenses-upd-auto") === "1";
  if (UPD.found) showUpdate(UPD.found, $("#upd-result"));
}

function renderUpdateBar() {
  const bar = $("#update-bar");
  if (!bar) return;
  const rel = UPD.found;
  if (!rel || store("expenses-upd-dismissed") === rel.version) { bar.hidden = true; return; }
  bar.innerHTML = `<span class="grow">${t("Na voljo je nova različica {v}", { v: esc(rel.version) })}</span>
    <button type="button" class="ghost" id="upd-how">${t("Kako posodobim?")}</button>
    <button type="button" class="ghost" id="upd-hide" aria-label="${t("Skrij")}">✕</button>`;
  bar.hidden = false;
  $("#upd-how").onclick = () => { const b = document.querySelector('.tabs button[data-tab="settings"]'); if (b) b.click(); setTimeout(() => $("#update-card").scrollIntoView({ behavior: "smooth" }), 150); };
  $("#upd-hide").onclick = () => { store("expenses-upd-dismissed", rel.version); bar.hidden = true; };
}

if ($("#upd-auto")) {
  $("#upd-auto").addEventListener("change", (ev) => {
    store("expenses-upd-auto", ev.target.checked ? "1" : null);
    if (ev.target.checked) checkForUpdate(false).then(renderUpdateBar).catch(() => {});
  });
  $("#upd-check").addEventListener("click", async () => {
    const b = $("#upd-check"), box = $("#upd-result");
    b.disabled = true;
    try {
      const rel = await checkForUpdate(true);
      if (rel) { showUpdate(rel, box); store("expenses-upd-dismissed", null); renderUpdateBar(); }
      else { box.innerHTML = `<p>${t("Imaš najnovejšo različico ({v}).", { v: esc(UPD.version()) })}</p>`; box.hidden = false; }
    } catch (e) { box.innerHTML = `<p class="error">${esc(e.message)}</p>`; box.hidden = false; }
    b.disabled = false;
  });
}
document.addEventListener("langchange", () => { renderUpdateBar(); });

(window.appReady || Promise.resolve()).then(() => loadMeta()).then(() => {
  // only when the user turned it on; never in the demo
  if (updEnabled() && store("expenses-upd-auto") === "1") checkForUpdate(false).then(renderUpdateBar).catch(() => {});
}).then(refresh).catch((e) => toast(e.message));
