#!/usr/bin/env node
// Lists `${expr}` interpolations of unescaped values into HTML template literals in
// frontend/js/*.js (skips lib/, generated vendor-*.js, verification-templates.js).
//
//   node testing/lint/raw-interp.mjs            report every finding not in the allow-list
//   node testing/lint/raw-interp.mjs --strict   same, exit 1 if there are any (CI)
//   node testing/lint/raw-interp.mjs --max N    exit 1 if there are more than N (CI ratchet)
//   node testing/lint/raw-interp.mjs --fix      wrap plain attribute-value reads in escHtml(...)
//   node testing/lint/raw-interp.mjs --all      ignore the allow-list
//   node testing/lint/raw-interp.mjs --text     also report values placed in element text
//                                               (default: attribute values only — the part that
//                                               can break out of a tag; the page's content-security-policy
//                                               blocks injected script either way)
//
// A template literal counts as HTML when it contains a tag (`<name`). An expression is
// accepted when it is escaped (escHtml / escapeHtml / esc / _esc), numeric (Number(, +x,
// Math., .toFixed, .length, parseInt/parseFloat), a ternary of string literals, or a
// helper that returns trusted markup (`*Html`, `*Opts`, `*Options`, `.join('')` of
// those are reviewed by hand and listed in raw-interp-allow.txt as `file:line`).
// Anything else could carry project / library / uploaded text into the page: wrap it
// in escHtml(...), or for a number use `Number.isFinite(+x) ? +x : ''`.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const jsDir = path.join(root, 'frontend', 'js');
const allowFile = path.join(path.dirname(fileURLToPath(import.meta.url)), 'raw-interp-allow.txt');
const strict = process.argv.includes('--strict');
const maxArg = process.argv.indexOf('--max');
const maxAllowed = maxArg > 0 ? Number(process.argv[maxArg + 1]) : null;   // ratchet: fail if the count grows past this
const ignoreAllow = process.argv.includes('--all');
const fix = process.argv.includes('--fix');   // wrap plain property reads inside quoted attribute values in escHtml(...)
const textToo = process.argv.includes('--text');   // also report values placed in element text

const allow = new Set();
if (!ignoreAllow && fs.existsSync(allowFile)) {
  for (const l of fs.readFileSync(allowFile, 'utf8').split('\n')) {
    const t = l.split('#')[0].trim();
    if (t) allow.add(t);
  }
}

const SAFE = [
  /^(this\.|RoadLight\.|[A-Z]\w*\.)?(escHtml|escapeHtml|esc|_esc|_e|e|escAttr|safeHtml|numAttr)\(/,
  /^(Number|Math\.[a-zA-Z]+|parseInt|parseFloat|Number\.isFinite|String\(Number)\(/,
  /^\+[\w.\[\]]+( \|\| \d+)?$/,
  /\.(toFixed|toPrecision)\([^)]*\)$/,
  /\.length$/,
  /^[\w.$]*(Html|HTML)\b/,
];
const LITERAL_TERNARY = /^[^?]+\?\s*(['"`])[^'"`${}]*\1\s*:\s*(['"`])[^'"`${}]*\2$/;
const STRING_ONLY = /^(['"])[^'"\\]*\1$/;

function findTemplates(src) {
  // Returns [{start, end, parts:[{expr, pos}], text}] for every top-level + nested template.
  const out = [];
  function readTemplate(i) {
    const start = i;
    const parts = [];
    i++;
    while (i < src.length) {
      const c = src[i];
      if (c === '\\') { i += 2; continue; }
      if (c === '`') return { end: i + 1, start, parts };
      if (c === '$' && src[i + 1] === '{') {
        const exprStart = i + 2;
        let depth = 1, j = exprStart;
        while (j < src.length && depth > 0) {
          const d = src[j];
          if (d === '`') { const t = readTemplate(j); out.push({ ...t, text: src.slice(t.start, t.end) }); j = t.end; continue; }
          if (d === '"' || d === "'") { j = skipString(j); continue; }
          if (d === '/' && src[j + 1] === '/') { while (j < src.length && src[j] !== '\n') j++; continue; }
          if (d === '/' && src[j + 1] === '*') { j = src.indexOf('*/', j + 2) + 2; continue; }
          if (d === '{') depth++;
          else if (d === '}') depth--;
          j++;
        }
        parts.push({ expr: src.slice(exprStart, j - 1).trim(), pos: exprStart });
        i = j;
        continue;
      }
      i++;
    }
    return { end: i, start, parts };
  }
  function skipString(i) {
    const q = src[i++];
    while (i < src.length && src[i] !== q) { if (src[i] === '\\') i++; if (src[i] === '\n') break; i++; }
    return i + 1;
  }
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === '/' && src[i + 1] === '/') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (c === '/' && src[i + 1] === '*') { i = src.indexOf('*/', i + 2) + 2 || src.length; continue; }
    if (c === '"' || c === "'") { i = skipString(i); continue; }
    if (c === '/') {
      // regex literal: only when the previous significant char cannot end an expression
      let k = i - 1; while (k >= 0 && /\s/.test(src[k])) k--;
      if (k < 0 || /[=(,:;!&|?{}\[+\-*%<>~^]/.test(src[k]) || /\breturn$/.test(src.slice(Math.max(0, k - 5), k + 1))) {
        let j = i + 1, cls = false;
        while (j < src.length && src[j] !== '\n') {
          if (src[j] === '\\') { j += 2; continue; }
          if (src[j] === '[') cls = true; else if (src[j] === ']') cls = false;
          else if (src[j] === '/' && !cls) break;
          j++;
        }
        i = j + 1; continue;
      }
    }
    if (c === '`') { const t = readTemplate(i); out.push({ ...t, text: src.slice(t.start, t.end) }); i = t.end; continue; }
    i++;
  }
  return out;
}

// Names that only ever hold drawing coordinates / counters; arithmetic over them and
// literals is numeric and cannot carry markup.
const NUMERIC_NAME = /^(x|y|z|w|h|r|i|j|k|n|cx|cy|x\d|y\d|px|py|idx|index|width|height|size|len|angle|rot|rotation|scale|zoom|pct|count|total|col|row|cols|rows|dx|dy|sw|fs|opacity)$/;
function numericArith(e) {
  const stripped = e.replace(/\b\d+(\.\d+)?\b/g, '0').replace(/[()+\-*\/% .]/g, ' ').trim();
  if (!stripped) return true;
  return stripped.split(/\s+/).every(tok => tok === '0' || NUMERIC_NAME.test(tok.replace(/^[a-zA-Z_$][\w$]*\./, '')) || NUMERIC_NAME.test(tok));
}

// True when `${` at `pos` sits inside an HTML tag (an attribute value), not in text.
function inTag(text, pos) {
  const before = text.slice(0, pos).replace(/\$\{[^{}]*\}/g, '0');
  return before.lastIndexOf('<') > before.lastIndexOf('>');
}

// What is reported: a member access / index / call (`o.name`, `row[k]`, `fmt(x)`), or a bare
// identifier whose name says it holds text. Bare locals such as `hw`, `piv`, `busY` in the
// SVG drawing code are geometry; constants like `P.muted` / `COLORS.x` are internal palettes.
const TEXTY_NAME = /^(name|label|title|text|desc|description|note|notes|tag|id|key|value|val|type|unit|units|url|src|href|logo|html|msg|message|placeholder|cls|klass|style|color|colour|fill|stroke|font|family|kind|mode|ref|code|path|d|attrs|extra|opts|tip|tooltip|hint)$/;
const INTERNAL_CONST = /^[A-Z][A-Za-z0-9_]*\./;   // PALETTE.x, COMPONENT_DEFS.x, STANDARD_*.x
// Ids come from AppState.genId / the app itself, and `this.UPPER_CASE` are class constants.
const ID_OR_CONST = /(^|\.)id$|^this\.[A-Z][A-Z0-9_]*(\s*[-+*\/]\s*[\w.]+)*$/;
function worthReporting(e) {
  if (ID_OR_CONST.test(e)) return false;
  if (/\b(escHtml|escapeHtml|_esc|esc)\(/.test(e)) return false;   // composite expression that escapes its text
  if (INTERNAL_CONST.test(e) && !/[(\[]/.test(e.split('.').slice(0, 1)[0])) return /\[/.test(e);
  if (/[.\[(]/.test(e)) return true;
  return TEXTY_NAME.test(e) || /(Id|ID|Name|Key|Label|Title)$/.test(e);
}

// Coordinate helpers of the drawing code: they return numbers.
const GEOM_CALL = /^(X|Y|S|f|px|py|sx|sy|tx|ty|r2|n1|n2)\(/;
// `a * b`, `a / b`, `a - b`, `-a`: the result is a number (or NaN), never text.
function arithmeticOnly(e) {
  if (/['"`]/.test(e)) return false;
  return /[*\/%]|(^|[\s(])-\s*[\w(]|\w\s-\s\w/.test(e) && !/\bfunction\b|=>|\?/.test(e);
}

// Whatever the branches, a ternary whose branches are all literals / numbers / palette
// constants (P.x, this.SEC_FILL[..] fallbacks excluded) produces fixed text.
const LITERAL_BRANCH = /^(['"][^'"`$\\]*['"]|[+-]?[\d.]+|P\.\w+|\d+ \|\| \d+)$/;
function literalTernary(e) {
  const q = e.indexOf('?');
  if (q < 0 || /[`]/.test(e)) return false;
  const branches = e.slice(q + 1).split(/ : (?![^()]*\))/).map(x => x.trim());
  return branches.length >= 2 && branches.every(b => LITERAL_BRANCH.test(b) || literalTernary(b));
}
// A comparison / negation is a boolean.
function booleanExpr(e) {
  return !/['"`?]/.test(e.replace(/(===|!==)\s*(['"])[^'"]*\2/g, '')) && /(===|!==|>=|<=|\bhas\()/.test(e) || /^!+[\w.$]+$/.test(e);
}

function topLevelSafe(expr) {
  const e = expr.replace(/\s+/g, ' ').trim();
  if (literalTernary(e) || booleanExpr(e)) return true;
  if (GEOM_CALL.test(e) && !/['"`]/.test(e.replace(/toFixed\([^)]*\)/g, ''))) return true;
  if (arithmeticOnly(e)) return true;
  if (STRING_ONLY.test(e) || LITERAL_TERNARY.test(e)) return true;
  if (/^[\d.]+$/.test(e) || numericArith(e)) return true;
  return SAFE.some(r => r.test(e));
}

// True when `${` at `pos` is inside a quoted attribute value of the tag being written.
function inQuotedValue(text, pos) {
  const before = text.slice(0, pos).replace(/\$\{[^{}]*\}/g, '0');
  let q = null;
  for (let i = before.lastIndexOf('<') + 1; i < before.length; i++) {
    const c = before[i];
    if (q) { if (c === q) q = null; } else if (c === '"' || c === "'") q = c;
  }
  return !!q;
}
// `a.b.c` / `a.b[c]` — a plain read of a field, safe to escape (a bare local might already be escaped).
const READ = String.raw`[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*|\[[\w$.'"]+\])+`;
const LIT = String.raw`(?:[\d.]+|''|'[\w -]*')`;
// `a.b`, `a.b || 0`, `a.b ?? ''`, `a.b || c.d`
const PLAIN_READ = new RegExp(`^${READ}(?:\\s*(?:\\|\\||\\?\\?)\\s*(?:${LIT}|${READ}))*$`);

const files = fs.readdirSync(jsDir).filter(f => f.endsWith('.js') && !f.startsWith('vendor-') && f !== 'verification-templates.js').sort();
let total = 0, fixed = 0;
for (const f of files) {
  let src = fs.readFileSync(path.join(jsDir, f), 'utf8');
  const edits = [];
  const lineAt = pos => src.slice(0, pos).split('\n').length;
  for (const t of findTemplates(src)) {
    if (!/<[a-zA-Z][^>`]*/.test(t.text.replace(/\$\{[\s\S]*?\}/g, ''))) continue;   // not HTML
    for (const p of t.parts) {
      if (topLevelSafe(p.expr)) continue;
      if (!worthReporting(p.expr.replace(/\s+/g, ' ').trim())) continue;
      if (!textToo && !inTag(t.text, p.pos - t.start)) continue;
      if (fix && inQuotedValue(t.text, p.pos - t.start)) {
        if (PLAIN_READ.test(p.expr)) { edits.push(p); continue; }
        // A bare local: wrap it unless it was just built from an escaping call.
        if (/^[A-Za-z_$][\w$]*$/.test(p.expr)) {
          const back = src.slice(Math.max(0, p.pos - 2500), p.pos);
          const lastAssign = [...back.matchAll(new RegExp(`\\b${p.expr.replace('$', '\\$')}\\s*=\\s*([^;\\n]*)`, 'g'))].pop();
          if (!(lastAssign && /(escHtml|escapeHtml|_esc|\be|\b_e|numAttr)\(/.test(lastAssign[1]))) { edits.push(p); continue; }
        }
      }
      const line = lineAt(p.pos);
      const id = `${f}:${line}`;
      if (allow.has(id)) continue;
      total++;
      console.log(`${id}  \${${p.expr.length > 90 ? p.expr.slice(0, 87) + '...' : p.expr}}`);
    }
  }
  if (edits.length) {
    for (const p of edits.sort((a, b) => b.pos - a.pos)) {
      src = src.slice(0, p.pos) + `escHtml(${p.expr})` + src.slice(p.pos + p.expr.length);
      fixed++;
    }
    fs.writeFileSync(path.join(jsDir, f), src);
  }
}
if (fix) console.error(`${fixed} attribute value(s) wrapped in escHtml`);
console.error(`${total} unreviewed interpolation(s)`);
if (strict && total) process.exit(1);
if (maxAllowed !== null && total > maxAllowed) { console.error(`more than the ${maxAllowed} reviewed interpolations — escape the new ones (escHtml / numAttr)`); process.exit(1); }
