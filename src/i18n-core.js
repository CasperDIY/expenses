/* Internationalisation: Slovenian is the source language, English and German are translations.
 * The dictionary (I18N_TR) maps the Slovenian text to [English, German]; it is generated into this file at build time. */
"use strict";
(function () {
  const LANGS = ["sl", "en", "de"];
  const LOCALE = { sl: "sl-SI", en: "en-IE", de: "de-DE" };
  const MONTHS = {
    sl: ["januar", "februar", "marec", "april", "maj", "junij", "julij", "avgust", "september", "oktober", "november", "december"],
    en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
    de: ["Januar", "Februar", "März", "April", "Mai", "Juni", "Juli", "August", "September", "Oktober", "November", "Dezember"],
  };
  const MSHORT = {
    sl: ["jan", "feb", "mar", "apr", "maj", "jun", "jul", "avg", "sep", "okt", "nov", "dec"],
    en: ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"],
    de: ["Jan", "Feb", "Mär", "Apr", "Mai", "Jun", "Jul", "Aug", "Sep", "Okt", "Nov", "Dez"],
  };
  // Slovenian genitive ("od januarja"); English and German use the plain month name
  const MGEN = {
    sl: ["januarja", "februarja", "marca", "aprila", "maja", "junija", "julija", "avgusta", "septembra", "oktobra", "novembra", "decembra"],
    en: MONTHS.en, de: MONTHS.de,
  };

  const TR = window.I18N_TR || {};
  const PL = window.I18N_PL || {};
  const PATTERNS = window.I18N_PATTERNS || [];
  const norm = (s) => String(s).replace(/\s+/g, " ").trim();

  function detect() {
    // "stroski-lang" is the key used before the project was renamed
    try { const s = localStorage.getItem("expenses-lang") || localStorage.getItem("stroski-lang"); if (LANGS.includes(s)) return s; } catch (e) { /* storage unavailable */ }
    const nav = (navigator.language || "sl").slice(0, 2).toLowerCase();
    return LANGS.includes(nav) ? nav : "sl";
  }

  const I = (window.I18N = { lang: detect(), LANGS, LOCALE });

  /** Translate a Slovenian source string; {name} placeholders are filled from vars. */
  I.t = function (sl, vars) {
    let s = sl;
    if (I.lang !== "sl") {
      const e = TR[norm(sl)];
      if (e) s = e[I.lang === "en" ? 0 : 1];
    }
    if (vars) s = s.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? vars[k] : m));
    return s;
  };

  /** Translate a message that may come from the server (errors); falls back to known patterns. */
  I.tm = function (msg) {
    if (I.lang === "sl" || !msg) return msg;
    const e = TR[norm(msg)];
    if (e) return e[I.lang === "en" ? 0 : 1];
    for (const [re, en, de] of PATTERNS) {
      const m = String(msg).match(re);
      if (m) return (I.lang === "en" ? en : de).replace(/\$(\d)/g, (x, i) => I.tm(m[+i] || ""));
    }
    return msg;
  };

  /** Slovenian has four plural forms (1, 2, 3–4, 5+); English and German two. */
  I.plural = function (n, one, two, few, many) {
    if (I.lang === "sl") return n % 100 === 1 ? one : n % 100 === 2 ? two : n % 100 === 3 || n % 100 === 4 ? few : many;
    const f = PL[one];
    if (!f) return n === 1 ? one : many;
    const pair = f[I.lang === "en" ? 0 : 1];
    return n === 1 ? pair[0] : pair[1];
  };

  I.months = () => MONTHS[I.lang];
  I.monthsShort = () => MSHORT[I.lang];
  I.monthsGen = () => MGEN[I.lang];
  I.locale = () => LOCALE[I.lang];

  /* ---- static page text: remember the Slovenian original once, then swap ---- */
  const INLINE = new Set(["B", "CODE", "I", "EM", "STRONG"]);
  const SKIP = new Set(["SCRIPT", "STYLE", "SVG", "TEMPLATE", "TEXTAREA", "SELECT"]);
  const ATTRS = ["placeholder", "title", "aria-label", "label"];
  let records = null;

  function capture(root) {
    const out = [];
    const walk = (el) => {
      if (SKIP.has(String(el.tagName).toUpperCase()) && el.tagName !== "SELECT") return;
      if (el.getAttribute && el.getAttribute("translate") === "no") return;   // brand names etc.
      for (const a of ATTRS) {
        const v = el.getAttribute && el.getAttribute(a);
        if (v && TR[norm(v)]) out.push({ el, attr: a, sl: v });
      }
      const kids = [...el.childNodes];
      const hasInline = kids.some((k) => k.nodeType === 1 && INLINE.has(k.tagName));
      const onlyInline = kids.every((k) => k.nodeType === 3 || (k.nodeType === 1 && INLINE.has(k.tagName)));
      if (hasInline && onlyInline && TR[norm(el.innerHTML)]) {
        out.push({ el, html: true, sl: el.innerHTML });
        return;
      }
      for (const k of kids) {
        if (k.nodeType === 3) {
          const s = norm(k.nodeValue);
          if (s && TR[s]) out.push({ node: k, sl: k.nodeValue });
        } else if (k.nodeType === 1) {
          if (k.tagName === "SELECT") { [...k.querySelectorAll("option, optgroup")].forEach(walk); continue; }
          walk(k);
        }
      }
    };
    walk(root);
    return out;
  }

  I.applyStatic = function () {
    if (!records) records = capture(document.body);
    for (const r of records) {
      const tr = I.lang === "sl" ? null : TR[norm(r.sl)];
      const val = tr ? tr[I.lang === "en" ? 0 : 1] : null;
      if (r.attr) r.el.setAttribute(r.attr, val || r.sl);
      else if (r.html) r.el.innerHTML = val || r.sl;
      else {
        const lead = r.sl.match(/^\s*/)[0], trail = r.sl.match(/\s*$/)[0];
        r.node.nodeValue = val ? lead + val + trail : r.sl;
      }
    }
    document.documentElement.lang = I.lang;
  };

  I.setLang = function (lang) {
    if (!LANGS.includes(lang)) return;
    I.lang = lang;
    try { localStorage.setItem("expenses-lang", lang); } catch (e) { /* storage unavailable */ }
    I.applyStatic();
    document.dispatchEvent(new CustomEvent("langchange"));
  };

  window.t = I.t;
  window.tm = I.tm;
  // this script is loaded at the end of <body>, so the static page is already parsed: translate it before the app renders
  if (document.body) I.applyStatic();
  else document.addEventListener("DOMContentLoaded", () => I.applyStatic());
})();
