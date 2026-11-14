#!/usr/bin/env node
// Renders the result tables in this folder as PNG images from sessions.csv and sessions-vague.csv.
// Needs Chrome or Chromium: node make-images.mjs [path-to-chrome]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const chrome = process.argv[2] ?? ['google-chrome', 'chromium', 'chromium-browser'].find((b) => spawnSync('which', [b]).status === 0);
if (!chrome) { console.error('Chrome not found. Pass its path as the first argument.'); process.exit(1); }

const [head, ...lines] = fs.readFileSync(path.join(HERE, 'sessions.csv'), 'utf8').trim().split('\n');
const cols = head.split(',');
const sessions = lines.map((l) => Object.fromEntries(l.split(',').slice(0, cols.length - 1).map((v, i) => [cols[i], v])));
const of = (row) => sessions.filter((s) => s.row === row);
const median = (xs) => { const s = xs.filter((x) => x !== '' && x != null).map(Number).sort((a, b) => a - b); const m = s.length / 2; return s.length % 2 ? s[Math.floor(m)] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => { const s = xs.filter((x) => x !== '').map(Number); return s.reduce((a, b) => a + b, 0) / s.length; };
const stat = (row) => {
  const r = of(row);
  return {
    pass: `${r.filter((s) => s.pass === 'true').length}/${r.length}`,
    tools: median(r.map((s) => s.tool_calls)), seconds: Math.round(median(r.map((s) => s.seconds))),
    size: `${median(r.map((s) => s.size_vs_real_fix)).toFixed(2)}×`,
    credits: r[0].copilot_credits !== '' ? mean(r.map((s) => s.copilot_credits)).toFixed(1) : null,
    usd: r[0].claude_cost_usd !== '' ? `$${mean(r.map((s) => s.claude_cost_usd)).toFixed(2)}` : null,
    pages: r[0].wiki_pages_opened !== '' ? median(r.map((s) => s.wiki_pages_opened)) : null,
  };
};
const S = Object.fromEntries(['A', 'B', 'C', 'D', 'E', 'F'].map((k) => [k, stat(k)]));
const x = (a, b) => `${(a / b).toFixed(1)}×`;

// Vague-ticket follow-up (rows G to N).
const [vHead, ...vLines] = fs.readFileSync(path.join(HERE, 'sessions-vague.csv'), 'utf8').trim().split('\n');
const vCols = vHead.split(',');
const vague = vLines.map((l) => Object.fromEntries(l.split(',').slice(0, vCols.length - 1).map((v, i) => [vCols[i], v])));
const frac = (r, key) => `${r.filter((s) => s[key] === 'true').length}/${r.length}`;
// First three attempts of all six tasks.
const V = Object.fromEntries(['G', 'H', 'I', 'M'].map((k) => {
  const r = vague.filter((s) => s.row === k && Number(s.attempt) <= 3);
  return [k, {
    tests: frac(r, 'tests_pass'), scope: frac(r, 'in_scope'), pass: frac(r, 'pass'),
    tools: median(r.map((s) => s.tool_calls)), seconds: Math.round(median(r.map((s) => s.seconds))),
    cost: r[0].copilot_credits !== '' ? `${median(r.map((s) => s.copilot_credits)).toFixed(1)} credits` : `$${median(r.map((s) => s.claude_cost_usd)).toFixed(2)}`,
  }];
}));
// Hidden tests passed on one task, all attempts of a row.
const vt = (row, task) => frac(vague.filter((s) => s.row === row && s.task.startsWith(`webiny-${task}-vague`)), 'tests_pass');

const page = (title, sub, table, notes) => `<!doctype html><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0}
body{width:1600px;height:900px;background:#fbfaf7;color:#1c1b19;font-family:"Inter","Noto Sans","Helvetica Neue",Arial,sans-serif;padding:64px 72px;display:flex;flex-direction:column}
h1{font-size:46px;line-height:1.15;font-weight:700;letter-spacing:-0.5px;max-width:1400px}
.sub{font-size:25px;color:#5d5a54;margin-top:14px}
table{width:100%;border-collapse:collapse;margin-top:44px;font-size:29px;font-variant-numeric:tabular-nums}
th{text-align:right;font-size:20px;font-weight:600;color:#6b6861;text-transform:uppercase;letter-spacing:.6px;padding:0 18px 14px;border-bottom:2px solid #1c1b19}
th:first-child,td:first-child{text-align:left;padding-left:0}
td{text-align:right;padding:21px 18px;border-bottom:1px solid #dedad2}
td:first-child{font-weight:600}
td small{display:block;font-size:20px;font-weight:400;color:#6b6861;margin-top:3px}
.hi{background:#fde9c8;font-weight:700}
.good{color:#1c1b19}
.notes{margin-top:auto;font-size:21px;color:#5d5a54;line-height:1.45;display:flex;justify-content:space-between;align-items:flex-end;gap:40px}
.notes b{color:#1c1b19;font-weight:600;white-space:nowrap}
</style><h1>${title}</h1><div class="sub">${sub}</div>${table}<div class="notes"><div>${notes}</div><b>github.com/eriks-briedis/agent-evals</b></div>`;

const images = {
  'same-model-tie': page(
    'Same model, two harnesses: Copilot CLI and Claude Code tie.',
    'Both pinned to Sonnet 5.5. Six real Webiny bug fixes, 3 attempts each. Hidden tests from the real fix decide a pass.',
    `<table><tr><th>Harness</th><th>Passed</th><th>Tool calls</th><th>Seconds</th><th>Size vs real fix</th></tr>
    <tr><td>Claude Code<small>2.1.322, Sonnet 5.5</small></td><td class="hi">${S.A.pass}</td><td>${S.A.tools}</td><td>${S.A.seconds}</td><td>${S.A.size}</td></tr>
    <tr><td>Copilot CLI<small>1.0.109, Sonnet 5.5</small></td><td class="hi">${S.B.pass}</td><td>${S.B.tools}</td><td>${S.B.seconds}</td><td>${S.B.size}</td></tr></table>`,
    'Medians per session, 18 sessions per harness. Size = source lines changed ÷ lines in the real fix.<br>Most of the time gap is one task where Claude Code’s sessions ran about 12 minutes.'),
  'harness-vs-model': page(
    'Same model, same result. Copilot’s extra effort comes from the model Auto picks.',
    'Six real Webiny bug fixes, 3 attempts each. Hidden tests from the real fix decide a pass.',
    `<table><tr><th>Setup</th><th>Passed</th><th>Tool calls</th><th>Seconds</th><th>Size vs real fix</th><th>Cost per session</th></tr>
    <tr><td>Claude Code<small>Sonnet 5.5</small></td><td>${S.A.pass}</td><td>${S.A.tools}</td><td>${S.A.seconds}</td><td>${S.A.size}</td><td>${S.A.usd}</td></tr>
    <tr><td>Copilot CLI<small>Sonnet 5.5, pinned</small></td><td>${S.B.pass}</td><td>${S.B.tools}</td><td>${S.B.seconds}</td><td>${S.B.size}</td><td>${S.B.credits} credits</td></tr>
    <tr><td>Copilot CLI<small>Auto: Terra ×12, Luna ×4, Sonnet ×2</small></td><td>${S.C.pass}</td><td class="hi">${S.C.tools}</td><td class="hi">${S.C.seconds}</td><td>${S.C.size}</td><td>${S.C.credits} credits</td></tr>
    <tr><td>Claude Code<small>Opus 5.5</small></td><td>${S.D.pass}</td><td>${S.D.tools}</td><td>${S.D.seconds}</td><td>${S.D.size}</td><td>${S.D.usd}</td></tr></table>`,
    `Medians per session, 18 sessions per row. Copilot on Auto: ${x(S.C.tools, S.B.tools)} the tool calls and ${x(S.C.seconds, S.B.seconds)} the time of Copilot on Sonnet.<br>Copilot CLI 1.0.109, Claude Code 2.1.322. Claude cost is the API-equivalent figure.`),
  'wiki-effect': page(
    'A 300-page wiki in the repo: no better pass rate, more credits.',
    'Same six bug fixes. The repo’s own docs added as wiki/ with instructions to read the relevant pages first.',
    `<table><tr><th>Copilot CLI</th><th>Passed</th><th>Tool calls</th><th>Seconds</th><th>Size vs real fix</th><th>Credits per session</th><th>Wiki pages opened</th></tr>
    <tr><td>Auto<small>no wiki</small></td><td>${S.C.pass}</td><td>${S.C.tools}</td><td>${S.C.seconds}</td><td>${S.C.size}</td><td>${S.C.credits}</td><td>–</td></tr>
    <tr><td>Auto<small>with wiki</small></td><td>${S.E.pass}</td><td>${S.E.tools}</td><td>${S.E.seconds}</td><td>${S.E.size}</td><td class="hi">${S.E.credits}</td><td>${S.E.pages}</td></tr>
    <tr><td>Sonnet 5.5<small>no wiki</small></td><td>${S.B.pass}</td><td>${S.B.tools}</td><td>${S.B.seconds}</td><td>${S.B.size}</td><td>${S.B.credits}</td><td>–</td></tr>
    <tr><td>Sonnet 5.5<small>with wiki</small></td><td>${S.F.pass}</td><td>${S.F.tools}</td><td>${S.F.seconds}</td><td>${S.F.size}</td><td class="hi">${S.F.credits}</td><td>${S.F.pages}</td></tr></table>`,
    `Medians per session, 18 sessions per row. Credits are the mean per session.<br>With the wiki, Auto used ${x(S.E.credits, S.C.credits)} the credits and ${x(S.E.tools, S.C.tools)} the tool calls. Sonnet made the same changes but cost ${x(S.F.credits, S.B.credits)}.`),
  'per-task': page(
    'Tool calls per task: the gap is the same on every bug.',
    'Median tool calls per session. All setups solved every task at least once.',
    `<table><tr><th>Task</th><th>Claude Code<br>Sonnet</th><th>Copilot<br>Sonnet</th><th>Copilot<br>Auto</th><th>Claude Code<br>Opus</th><th>Copilot Auto<br>+ wiki</th><th>Copilot Sonnet<br>+ wiki</th></tr>
    ${['audit-logs', 'os-registries', 'flp-logging', 'model-cache', 'sql-leak', 'tenant-leak'].map((t) => `<tr><td>${t}</td>${['A', 'B', 'C', 'D', 'E', 'F'].map((k) => `<td${k === 'C' || k === 'E' ? ' class="hi"' : ''}>${median(of(k).filter((s) => s.task === `webiny-${t}`).map((s) => s.tool_calls))}</td>`).join('')}</tr>`).join('')}</table>`,
    'Tasks are merged bug-fix PRs in webiny/webiny-js. Three attempts per task.'),
  'vague-tickets': page(
    'Vague tickets: Sonnet fails in both harnesses.',
    'The same six Webiny bugs, with tickets that give only the symptom. 3 attempts each.',
    `<table><tr><th>Setup</th><th>Passed,<br>precise ticket</th><th>Tests,<br>vague ticket</th><th>Within<br>size limits</th><th>Tool calls</th><th>Seconds</th><th>Cost per session</th></tr>
    <tr><td>Claude Code<small>Sonnet 5.5</small></td><td>${S.A.pass}</td><td class="hi">${V.G.tests}</td><td>${V.G.scope}</td><td>${V.G.tools}</td><td>${V.G.seconds}</td><td>${V.G.cost}</td></tr>
    <tr><td>Copilot CLI<small>Sonnet 5.5, pinned</small></td><td>${S.B.pass}</td><td class="hi">${V.H.tests}</td><td>${V.H.scope}</td><td>${V.H.tools}</td><td>${V.H.seconds}</td><td>${V.H.cost}</td></tr>
    <tr><td>Copilot CLI<small>Auto: Terra ×18</small></td><td>${S.C.pass}</td><td>${V.I.tests}</td><td>${V.I.scope}</td><td>${V.I.tools}</td><td>${V.I.seconds}</td><td>${V.I.cost}</td></tr>
    <tr><td>Claude Code<small>Opus 5.5</small></td><td>${S.D.pass}</td><td>${V.M.tests}</td><td>${V.M.scope}</td><td>${V.M.tools}</td><td>${V.M.seconds}</td><td>${V.M.cost}</td></tr></table>`,
    'Medians per session, 18 sessions per row. Tests = the hidden tests from the real fix pass.<br>Sonnet’s failures are fixes that stop at the first plausible cause.'),
  'vague-harness': page(
    'Vague tickets: both harnesses fail the same way.',
    'The two bugs Sonnet 5.5 gets wrong. Sessions where the hidden tests pass, out of attempts.',
    `<table><tr><th>Bug and ticket</th><th>Claude Code<br>Sonnet 5.5</th><th>Copilot CLI<br>Sonnet 5.5</th><th>Claude Code<br>Opus 5.5</th><th>Copilot CLI<br>Auto (Terra)</th></tr>
    <tr><td>flp-logging<small>vague ticket</small></td><td class="hi">${vt('G', 'flp-logging')}</td><td class="hi">${vt('H', 'flp-logging')}</td><td>${vt('M', 'flp-logging')}</td><td>${vt('I', 'flp-logging')}</td></tr>
    <tr><td>audit-logs<small>vague ticket</small></td><td>${vt('G', 'audit-logs')}</td><td>${vt('H', 'audit-logs')}</td><td>${vt('M', 'audit-logs')}</td><td>${vt('I', 'audit-logs')}</td></tr>
    <tr><td>flp-logging<small>+ one-sentence hint to look for other causes</small></td><td>${vt('L', 'flp-logging')}</td><td>${vt('J', 'flp-logging')}</td><td>–</td><td>–</td></tr>
    <tr><td>audit-logs<small>+ one-sentence hint to look for other causes</small></td><td>${vt('L', 'audit-logs')}</td><td>${vt('J', 'audit-logs')}</td><td>–</td><td>–</td></tr>
</table>`,
    'flp-logging: two kinds of failure must be logged; Sonnet usually handles one.<br>audit-logs: Sonnet often changes a plausible line in the wrong package.'),
};

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-evals-img-'));
for (const [name, html] of Object.entries(images)) {
  const file = path.join(tmp, `${name}.html`);
  fs.writeFileSync(file, html);
  const out = path.join(HERE, `${name}.png`);
  const r = spawnSync(chrome, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--force-device-scale-factor=2', '--window-size=1600,900', `--screenshot=${out}`, `file://${file}`], { encoding: 'utf8' });
  console.log(r.status === 0 && fs.existsSync(out) ? `wrote ${name}.png` : `failed ${name}: ${r.stderr.slice(-300)}`);
}
fs.rmSync(tmp, { recursive: true, force: true });
