#!/usr/bin/env node
// Summarises eval results.
//   node evals/report.mjs <resultsDir> [<resultsDir>...]
// The first directory is the baseline; later ones are compared against it per task.
import fs from 'node:fs';
import path from 'node:path';

const dirs = process.argv.slice(2);
if (dirs.length === 0) {
  console.error('usage: node evals/report.mjs <resultsDir> [<resultsDir>...]');
  process.exit(1);
}

const readRows = (dir) => fs.readFileSync(path.join(dir, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
const median = (values) => {
  const v = values.filter((x) => x !== null && x !== undefined).sort((a, b) => a - b);
  if (v.length === 0) return null;
  const mid = Math.floor(v.length / 2);
  return v.length % 2 ? v[mid] : (v[mid - 1] + v[mid]) / 2;
};
const fmt = (x, digits = 1) => (x === null || x === undefined ? '-' : Number(x).toFixed(digits));
const toolCalls = (row) => row.events?.toolCalls ?? null;

function summarize(rows) {
  const passed = rows.filter((r) => r.pass).length;
  return {
    runs: rows.length,
    pass: `${passed}/${rows.length}`,
    passRate: rows.length ? passed / rows.length : null,
    testsPass: `${rows.filter((r) => r.testsPass).length}/${rows.length}`,
    inScope: `${rows.filter((r) => r.inScope ?? r.checkFailures.length === 0).length}/${rows.length}`,
    extra: rows.some((r) => r.extraTestsPass != null) ? `${rows.filter((r) => r.extraTestsPass).length}/${rows.length}` : '-',
    approach: (() => {
      const counts = new Map();
      for (const r of rows) if (r.approach) counts.set(r.approach, (counts.get(r.approach) ?? 0) + 1);
      return [...counts].map(([k, n]) => `${k} x${n}`).join(', ') || '-';
    })(),
    sizeRatio: median(rows.map((r) => r.sizeRatio)),
    toolCalls: median(rows.map(toolCalls)),
    wallSeconds: median(rows.map((r) => r.wallSeconds)),
    models: [...new Set(rows.map((r) => r.events?.model).filter(Boolean))].join(', ') || '-',
    timeouts: rows.filter((r) => r.timedOut).length,
  };
}

function table(headers, lines) {
  const widths = headers.map((h, i) => Math.max(h.length, ...lines.map((l) => String(l[i]).length)));
  const row = (cells) => cells.map((c, i) => String(c).padEnd(widths[i])).join('  ');
  console.log(row(headers));
  console.log(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const l of lines) console.log(row(l));
  console.log();
}

const groupBy = (rows, key) => rows.reduce((m, r) => m.set(r[key], [...(m.get(r[key]) ?? []), r]), new Map());
const HEAD = ['pass', 'correct', 'in scope', 'size ratio', 'tool calls', 'seconds', 'timeouts'];
const cells = (s) => [s.pass, s.testsPass, s.inScope, fmt(s.sizeRatio), fmt(s.toolCalls, 0), fmt(s.wallSeconds, 0), s.timeouts];

const sets = dirs.map((dir) => { const rows = readRows(dir); return { name: rows[0] ? `${rows[0].agent ?? 'copilot'}/${rows[0].config}` : path.basename(dir), rows }; });

for (const { name, rows } of sets) {
  console.log(`# ${name} (${rows.length} runs, ${rows[0]?.agentVersion ?? 'unknown version'}, model: ${summarize(rows).models})\n`);
  console.log('correct = required hidden tests pass. in scope = size, file and type-check limits hold. pass = both.');
  console.log('approach = where the change went. all writes = stricter hidden tests (not required). size ratio = source lines changed / reference fix; medians.\n');
  table(['failure mode', ...HEAD], [...groupBy(rows, 'category')].map(([k, r]) => [k, ...cells(summarize(r))]).concat([['ALL', ...cells(summarize(rows))]]));
  table(['task', ...HEAD, 'all writes', 'approach'], [...groupBy(rows, 'task')].map(([k, r]) => { const s = summarize(r); return [k, ...cells(s), s.extra, s.approach]; }));
  for (const [k, r] of groupBy(rows, 'task')) { const f = [...new Set(r.flatMap((x) => x.checkFailures.map((c) => c.replace(/[\d.]+ >/, 'N >'))))]; if (f.length) console.log(`${k} scope failures: ${f.join('; ')}`); }
  console.log();
}

if (sets.length > 1) {
  const base = groupBy(sets[0].rows, 'task');
  for (const { name, rows } of sets.slice(1)) {
    console.log(`# ${name} vs ${sets[0].name}\n`);
    console.log('With 3 runs per task, only large differences mean anything.\n');
    const lines = [...groupBy(rows, 'task')].map(([task, r]) => {
      const a = summarize(base.get(task) ?? []);
      const b = summarize(r);
      const delta = (x, y, d = 1) => (x === null || y === null ? '-' : `${y - x >= 0 ? '+' : ''}${(y - x).toFixed(d)}`);
      return [task, `${a.pass} -> ${b.pass}`, delta(a.sizeRatio, b.sizeRatio), delta(a.toolCalls, b.toolCalls, 0), delta(a.wallSeconds, b.wallSeconds, 0)];
    });
    table(['task', 'pass', 'size ratio', 'tool calls', 'seconds'], lines);
  }
}
