#!/usr/bin/env node
// agent-evals: replay real fix commits from your repo against coding agents and compare setups.
// No dependencies. Node 20+, git, bash. See README.md.
//
//   node evals.mjs add <fix-sha> [task-id]     scaffold a task from a commit that fixed something
//   node evals.mjs validate [--tasks a,b]      check each task fails before the fix and passes after it
//   node evals.mjs run --variant a,b [--tasks a,b] [--repeats 3] [--credit-cap N]
//   node evals.mjs report [variant...]         print the comparison table
//   node evals.mjs recheck [variant...]        re-grade saved patches (after editing a task's tests)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = process.env.AGENT_EVALS_CONFIG || path.join(HERE, 'evals.config.json');
if (!fs.existsSync(CONFIG_FILE)) fail(`No config at ${CONFIG_FILE}. Copy evals.config.example.json to evals.config.json and edit it.`);
const cfg = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
const REPO = path.resolve(HERE, cfg.repo ?? '..');
const TASKS_DIR = path.join(HERE, 'tasks');
const RESULTS_DIR = path.join(HERE, 'results');
// Workspaces live outside the repo so agents do not pick up anything from the surrounding checkout.
const WORK = path.resolve(HERE, cfg.workDir ?? path.join(os.homedir(), '.cache', 'agent-evals', path.basename(REPO)));
const testRe = new RegExp(cfg.testFiles ?? '(\\.(test|spec)\\.[cm]?[jt]sx?$|(^|/)(__tests__|tests?)/)');
const docRe = new RegExp(cfg.docFiles ?? '\\.mdx?$', 'i');

function fail(msg) { console.error(msg); process.exit(1); }

function sh(cmd, cwd, { env = {}, timeoutMin = 30, inherit = false } = {}) {
  const r = spawnSync('bash', ['-c', cmd], { cwd, encoding: 'utf8', env: { ...process.env, ...env }, timeout: timeoutMin * 60_000, maxBuffer: 1 << 28, stdio: inherit ? 'inherit' : 'pipe' });
  return { code: r.status, out: `${r.stdout ?? ''}${r.stderr ?? ''}` };
}

function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=agent-evals', '-c', 'user.email=agent-evals@localhost', '-c', 'commit.gpgsign=false', ...args], { cwd, encoding: 'utf8', maxBuffer: 1 << 28 });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// ---------- tasks ----------

function loadTasks(only) {
  if (!fs.existsSync(TASKS_DIR)) fail('No tasks yet. Create one with: node evals.mjs add <fix-sha>');
  const tasks = fs.readdirSync(TASKS_DIR).filter((f) => f.endsWith('.json')).map((f) => ({ id: f.replace(/\.json$/, ''), ...JSON.parse(fs.readFileSync(path.join(TASKS_DIR, f), 'utf8')) }));
  const picked = only ? tasks.filter((t) => only.includes(t.id)) : tasks;
  if (!picked.length) fail('No matching tasks.');
  for (const t of picked) if (/TODO/.test(`${t.prompt} ${t.test}`)) fail(`Task ${t.id} still has TODO placeholders in tasks/${t.id}.json.`);
  return picked;
}

// What the real fix changed: which files are tests (kept hidden from the agent) and how big the source change was.
function fixInfo(task) {
  const status = git(REPO, 'diff', '--no-renames', '--name-status', `${task.fix}^`, task.fix).trim().split('\n').map((l) => l.split('\t'));
  const numstat = git(REPO, 'diff', '--no-renames', '--numstat', `${task.fix}^`, task.fix).trim().split('\n').map((l) => l.split('\t'));
  const hidden = task.hidden ?? status.filter(([s, f]) => s !== 'D' && testRe.test(f)).map(([, f]) => f);
  const isSource = (f) => !hidden.includes(f) && !testRe.test(f) && !docRe.test(f);
  const source = status.filter(([, f]) => isSource(f));
  const lines = numstat.filter(([, , f]) => isSource(f)).reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0);
  return { hidden, source, sourceFiles: source.map(([, f]) => f), lines };
}

function cmdAdd([sha, idArg]) {
  if (!sha) fail('Usage: node evals.mjs add <fix-sha> [task-id]');
  const full = git(REPO, 'rev-parse', sha).trim();
  const subject = git(REPO, 'log', '-1', '--format=%s', full).trim();
  const id = idArg ?? subject.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40);
  const file = path.join(TASKS_DIR, `${id}.json`);
  if (fs.existsSync(file)) fail(`${file} already exists.`);
  const info = fixInfo({ fix: full });
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify({
    fix: full,
    prompt: `TODO: describe the problem the way it was reported (symptoms, not the solution). Commit subject was: ${subject}`,
    test: info.hidden.length ? `TODO: command that runs only these tests, e.g. npx vitest run ${info.hidden.join(' ')}` : 'TODO: this commit changed no test files; write a test under tasks/' + id + '/hidden/ and a command that runs it',
    hidden: info.hidden,
  }, null, 2)}\n`);
  console.log(`Wrote tasks/${id}.json`);
  console.log(`  fix changed ${info.sourceFiles.length} source file(s), ${info.lines} lines; ${info.hidden.length} test file(s) will be hidden from the agent.`);
  console.log(`  Edit "prompt" and "test", then run: node evals.mjs validate --tasks ${id}`);
}

// ---------- workspaces ----------

// One built checkout per task at the commit before the fix, cached and reused for every run.
function prepare(task) {
  const dir = path.join(WORK, 'prepared', task.id);
  const setup = task.setup ?? cfg.setup ?? [];
  const stamp = JSON.stringify({ fix: task.fix, setup });
  const marker = path.join(dir, '.agent-evals-prepared');
  if (fs.existsSync(marker) && fs.readFileSync(marker, 'utf8') === stamp) return dir;
  console.log(`preparing ${task.id} (checkout of ${task.fix.slice(0, 10)}^ + setup) ...`);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const a = spawnSync('bash', ['-c', 'git -C "$1" archive "$2^" | tar -x -C "$3"', '_', REPO, task.fix, dir], { encoding: 'utf8' });
  if (a.status !== 0) fail(`checkout failed: ${a.stderr}`);
  for (const cmd of setup) {
    const r = sh(cmd, dir, { env: cfg.env, timeoutMin: 60 });
    if (r.code !== 0) fail(`setup command failed for ${task.id}: ${cmd}\n${r.out.slice(-3000)}`);
  }
  fs.writeFileSync(marker, stamp);
  return dir;
}

// A throwaway copy of the prepared checkout with its own git repo and no remote. The agent works here.
// Nothing is ever written to, committed in, or pushed from the source repo.
function newWorkspace(task, variant = {}) {
  const prepared = prepare(task);
  fs.mkdirSync(path.join(WORK, 'runs'), { recursive: true });
  const ws = fs.mkdtempSync(path.join(WORK, 'runs', `${task.id}-`));
  const hardlink = cfg.hardlink ?? ['node_modules'];
  for (const name of fs.readdirSync(prepared)) {
    if (name === '.agent-evals-prepared') continue;
    // Big dependency folders are hard-linked (Linux) or cloned (macOS) instead of copied.
    const flags = process.platform === 'darwin' ? '-cRp' : hardlink.includes(name) ? '-al' : '-a';
    const r = spawnSync('cp', [flags, path.join(prepared, name), path.join(ws, name)], { encoding: 'utf8' });
    if (r.status !== 0) fail(`cp failed: ${r.stderr}`);
  }
  for (const p of variant.remove ?? []) fs.rmSync(path.join(ws, p), { recursive: true, force: true });
  if (variant.overlay) fs.cpSync(path.resolve(HERE, variant.overlay), ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '--no-verify', '-m', 'base');
  git(ws, 'tag', 'eval-base');
  return ws;
}

function diffOf(ws, info) {
  git(ws, 'add', '-A');
  const numstat = git(ws, 'diff', '--cached', '--no-renames', '--numstat', 'eval-base').trim().split('\n').filter(Boolean).map((l) => l.split('\t'));
  const files = numstat.map(([, , f]) => f);
  const source = numstat.filter(([, , f]) => !testRe.test(f) && !docRe.test(f));
  const lines = source.reduce((n, [a, d]) => n + (Number(a) || 0) + (Number(d) || 0), 0);
  const sourceFiles = source.map(([, , f]) => f);
  return {
    patch: git(ws, 'diff', '--cached', '--no-renames', 'eval-base'),
    files, sourceFiles, lines,
    testFilesTouched: files.filter((f) => testRe.test(f)).length,
    fixFilesTouched: sourceFiles.filter((f) => info.sourceFiles.includes(f)).length,
    otherFilesTouched: sourceFiles.filter((f) => !info.sourceFiles.includes(f)).length,
  };
}

// Adds the hidden tests (the real fix's, or your edited copies in tasks/<id>/hidden/) and runs the task's test command.
function grade(task, ws, info) {
  for (const p of info.hidden) {
    const override = path.join(TASKS_DIR, task.id, 'hidden', p);
    fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true });
    fs.writeFileSync(path.join(ws, p), fs.existsSync(override) ? fs.readFileSync(override) : spawnSync('git', ['show', `${task.fix}:${p}`], { cwd: REPO, maxBuffer: 1 << 28 }).stdout);
  }
  const extra = path.join(TASKS_DIR, task.id, 'hidden');
  if (fs.existsSync(extra)) fs.cpSync(extra, ws, { recursive: true });
  let out = '';
  for (const cmd of task.beforeTest ?? cfg.beforeTest ?? []) {
    const b = sh(cmd, ws, { env: { ...cfg.env, ...task.env } });
    out += `$ ${cmd} (exit ${b.code})\n${b.out.slice(-3000)}\n`;
    if (b.code !== 0) return { ok: false, out };
  }
  const t = sh(task.test, ws, { env: { ...cfg.env, ...task.env }, timeoutMin: task.testTimeoutMin ?? 20 });
  const text = t.out.replace(/\x1b\[[0-9;]*m/g, '');
  out += `$ ${task.test} (exit ${t.code})\n${text.slice(-8000)}\n`;
  // Some runners exit 0 when every test was skipped, so a task can require a minimum number of passed tests.
  const passed = Math.max(0, ...[...text.matchAll(/(\d+) (?:passed|passing)/g)].map((m) => Number(m[1])));
  return { ok: t.code === 0 && passed >= (task.minPassed ?? 0), out, passed };
}

function applyFix(task, ws, info) {
  for (const [status, f] of info.source) {
    if (status === 'D') { fs.rmSync(path.join(ws, f), { force: true }); continue; }
    fs.mkdirSync(path.dirname(path.join(ws, f)), { recursive: true });
    fs.writeFileSync(path.join(ws, f), spawnSync('git', ['show', `${task.fix}:${f}`], { cwd: REPO, maxBuffer: 1 << 28 }).stdout);
  }
}

function cmdValidate(args) {
  let bad = 0;
  for (const task of loadTasks(args.tasks)) {
    const info = fixInfo(task);
    const ws = newWorkspace(task);
    const before = grade(task, ws, info);
    applyFix(task, ws, info);
    const after = grade(task, ws, info);
    const ok = !before.ok && after.ok;
    if (!ok) bad += 1;
    console.log(`${ok ? 'ok  ' : 'BAD '} ${task.id}: before fix ${before.ok ? 'PASSES (tests do not catch the bug)' : 'fails'}, with fix ${after.ok ? 'passes' : 'FAILS'}${after.passed ? ` (${after.passed} tests)` : ''}`);
    if (!ok) console.log((before.ok ? before.out : after.out).split('\n').slice(-40).join('\n'));
    fs.rmSync(ws, { recursive: true, force: true });
  }
  process.exit(bad ? 1 : 0);
}

// ---------- agents ----------

const count = (xs, f) => xs.reduce((n, x) => n + (f(x) ? 1 : 0), 0);
const AGENTS = {
  copilot: {
    bin: 'copilot',
    args: (ws, prompt, v, o) => ['-p', prompt, '-C', ws, '--allow-all-tools', '--output-format', 'json', '--no-auto-update', '--no-color', '--model', v.model ?? 'auto', ...(o.creditCap ? ['--max-ai-credits', String(o.creditCap)] : []), ...(v.flags ?? [])],
    parse: (ev) => {
      const starts = ev.filter((e) => e.type === 'tool.execution_start');
      const nano = ev.filter((e) => e.type === 'session.usage_checkpoint').at(-1)?.data?.totalNanoAiu;
      return {
        // Models the main agent ran on. With Auto this shows what was actually chosen.
        models: [...new Set(ev.filter((e) => e.type === 'model.call_start' && !e.data?.parentToolCallId).map((e) => e.data?.model).filter(Boolean))],
        toolCalls: starts.length,
        subagents: count(ev, (e) => e.type === 'subagent.started'),
        toolInputs: starts.map((e) => JSON.stringify(e.data?.arguments ?? {})),
        final: JSON.stringify(ev.filter((e) => e.type === 'assistant.message' && !e.data?.parentToolCallId).at(-1)?.data?.content ?? ''),
        credits: nano == null ? null : nano / 1e9,
        error: ev.find((e) => e.type === 'session.error')?.data?.message ?? null,
      };
    },
  },
  claude: {
    bin: 'claude',
    args: (ws, prompt, v) => ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--no-session-persistence', '--permission-mode', 'acceptEdits',
      '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep', ...(v.model ? ['--model', v.model] : []), ...(v.flags ?? [])],
    parse: (ev) => {
      const uses = ev.filter((e) => e.type === 'assistant').flatMap((e) => (e.message?.content ?? []).filter((c) => c.type === 'tool_use'));
      const result = ev.filter((e) => e.type === 'result').at(-1);
      return {
        models: [ev.find((e) => e.type === 'system' && e.subtype === 'init')?.model].filter(Boolean),
        toolCalls: uses.length,
        subagents: count(uses, (u) => u.name === 'Agent' || u.name === 'Task'),
        toolInputs: uses.map((u) => JSON.stringify(u.input ?? {})),
        final: String(result?.result ?? ''),
        costUsd: result?.total_cost_usd ?? null,
        error: result?.is_error ? String(result?.result ?? 'error').slice(0, 300) : null,
      };
    },
  },
};

function runAgent(agent, ws, prompt, variant, opts, outFile, errFile, timeoutMin) {
  // Agent CLIs change behaviour when they think they are nested inside another agent session.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|CLAUDECODE|COPILOT_AGENT)/.test(k)));
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(agent.bin, agent.args(ws, prompt, variant, opts), { cwd: ws, env: { ...env, ...cfg.env, ...variant.env }, stdio: ['ignore', fs.openSync(outFile, 'w'), fs.openSync(errFile, 'w')], detached: true });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch { /* already gone */ } }, timeoutMin * 60_000);
    child.on('error', (e) => { clearTimeout(timer); fs.appendFileSync(errFile, `spawn failed: ${e.message}\n`); resolve({ code: null, timedOut, seconds: 0 }); });
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, timedOut, seconds: Math.round((Date.now() - started) / 1000) }); });
  });
}

const readEvents = (file) => fs.readFileSync(file, 'utf8').split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

// Which markdown files the agent opened or searched by name, and how much text that is. A stand-in for context load.
function docsRead(toolInputs, ws) {
  const seen = new Set();
  for (const s of toolInputs) for (const m of s.matchAll(/[\w@.\/-]+\.mdx?\b/g)) {
    const rel = m[0].startsWith(ws) ? path.relative(ws, m[0]) : m[0].replace(/^\.?\//, '');
    if (!rel.startsWith('..') && fs.existsSync(path.join(ws, rel)) && fs.statSync(path.join(ws, rel)).isFile()) seen.add(rel);
  }
  return { docsRead: seen.size, docsKB: Math.round([...seen].reduce((n, f) => n + fs.statSync(path.join(ws, f)).size, 0) / 1024) };
}

async function cmdRun(args) {
  const names = args.variant ?? fail(`--variant is required. Defined: ${Object.keys(cfg.variants ?? {}).join(', ')}`);
  const tasks = loadTasks(args.tasks);
  for (const name of names) {
    const variant = cfg.variants?.[name] ?? fail(`Unknown variant ${name}. Defined: ${Object.keys(cfg.variants ?? {}).join(', ')}`);
    const agent = AGENTS[variant.agent ?? 'copilot'] ?? fail(`Unknown agent ${variant.agent}`);
    const outDir = path.join(RESULTS_DIR, name);
    fs.mkdirSync(outDir, { recursive: true });
    const rowsFile = path.join(outDir, 'rows.jsonl');
    // Resumable: sessions already recorded are skipped. Repeats are the outer loop so a stopped run still covers every task.
    const done = new Set(fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).runId) : []);
    for (let rep = 1; rep <= (args.repeats ?? 3); rep += 1) {
      for (const task of tasks) {
        const runId = `${task.id}.${rep}`;
        if (done.has(runId)) continue;
        const info = fixInfo(task);
        const ws = newWorkspace(task, variant);
        process.stdout.write(`${name} ${runId} ... `);
        const prompt = [task.prompt, cfg.promptSuffix, variant.promptSuffix].filter(Boolean).join('\n\n');
        const eventsFile = path.join(outDir, `${runId}.events.jsonl`);
        const errFile = path.join(outDir, `${runId}.stderr.txt`);
        const run = await runAgent(agent, ws, prompt, variant, { creditCap: args.creditCap }, eventsFile, errFile, task.timeoutMin ?? cfg.timeoutMin ?? 30);
        const stderr = fs.readFileSync(errFile, 'utf8');
        const ev = agent.parse(readEvents(eventsFile));
        if (!ev.toolCalls && (run.code !== 0 || /not authenticated|not logged in|could not provide a token|Failed to load models|spawn failed|quota|rate.?limit|usage limit/i.test(`${stderr} ${ev.error ?? ''}`))) {
          console.log(`ABORT: the agent did not start (login, model access or usage limit?). Nothing recorded; rerun to resume.\n${(stderr || ev.error || '').trim().slice(0, 600)}`);
          fs.rmSync(ws, { recursive: true, force: true });
          process.exit(2);
        }
        const d = diffOf(ws, info);
        fs.writeFileSync(path.join(outDir, `${runId}.patch`), d.patch);
        const g = grade(task, ws, info);
        fs.writeFileSync(path.join(outDir, `${runId}.check.txt`), g.out);
        const { toolInputs, final, ...usage } = ev;
        const row = {
          runId, task: task.id, variant: name, repeat: rep, pass: g.ok, testsPassed: g.passed,
          lines: d.lines, fixLines: info.lines, sizeRatio: info.lines ? Number((d.lines / info.lines).toFixed(2)) : null,
          fixFiles: info.sourceFiles.length, fixFilesTouched: d.fixFilesTouched, otherFilesTouched: d.otherFilesTouched, testFilesTouched: d.testFilesTouched, files: d.files,
          seconds: run.seconds, timedOut: run.timedOut, exitCode: run.code,
          ...usage, ...docsRead(toolInputs, ws),
          committed: toolInputs.some((s) => /git\s+(-C\s+\S+\s+)?(commit|push)\b/.test(s)),
        };
        fs.writeFileSync(path.join(outDir, `${runId}.final.txt`), final);
        fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
        console.log(`${row.pass ? 'PASS' : 'fail'} ${row.lines} lines (${row.sizeRatio ?? '?'}x fix) fix-files=${row.fixFilesTouched}/${row.fixFiles} other=${row.otherFilesTouched} tools=${row.toolCalls} docs=${row.docsRead}/${row.docsKB}KB ${row.seconds}s model=${row.models.join('+') || '?'}${row.credits != null ? ` credits=${row.credits.toFixed(1)}` : ''}${row.costUsd != null ? ` $${row.costUsd.toFixed(2)}` : ''}${row.timedOut ? ' TIMEOUT' : ''}`);
        fs.rmSync(ws, { recursive: true, force: true });
      }
    }
  }
  cmdReport(names);
}

function cmdRecheck(names) {
  const tasks = Object.fromEntries(loadTasks().map((t) => [t.id, t]));
  for (const name of names.length ? names : fs.readdirSync(RESULTS_DIR)) {
    const rowsFile = path.join(RESULTS_DIR, name, 'rows.jsonl');
    const rows = fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    let changed = 0;
    for (const row of rows) {
      const task = tasks[row.task];
      const patch = path.join(RESULTS_DIR, name, `${row.runId}.patch`);
      if (!task || !fs.existsSync(patch)) continue;
      const ws = newWorkspace(task, cfg.variants?.[name]);
      if (fs.statSync(patch).size) git(ws, 'apply', '--whitespace=nowarn', patch);
      const g = grade(task, ws, fixInfo(task));
      fs.writeFileSync(path.join(RESULTS_DIR, name, `${row.runId}.check.txt`), g.out);
      if (g.ok !== row.pass) changed += 1;
      row.pass = g.ok; row.testsPassed = g.passed;
      fs.rmSync(ws, { recursive: true, force: true });
    }
    fs.writeFileSync(rowsFile, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
    console.log(`${name}: ${rows.length} runs re-graded, ${changed} verdicts changed`);
  }
}

// ---------- report ----------

const median = (xs) => { const s = xs.filter((x) => x != null).sort((a, b) => a - b); return s.length ? s[Math.floor((s.length - 1) / 2)] : null; };
const sum = (xs) => xs.reduce((n, x) => n + (x ?? 0), 0);

function table(head, rows) {
  const w = head.map((h, i) => Math.max(h.length, ...rows.map((r) => String(r[i]).length)));
  const line = (r) => `| ${r.map((c, i) => String(c).padEnd(w[i])).join(' | ')} |`;
  return [line(head), `| ${w.map((n) => '-'.repeat(n)).join(' | ')} |`, ...rows.map(line)].join('\n');
}

function cmdReport(names) {
  if (!fs.existsSync(RESULTS_DIR)) fail('No results yet.');
  const variants = (names.length ? names : fs.readdirSync(RESULTS_DIR)).filter((n) => fs.existsSync(path.join(RESULTS_DIR, n, 'rows.jsonl')));
  const data = variants.map((n) => [n, fs.readFileSync(path.join(RESULTS_DIR, n, 'rows.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l))]);
  const cells = (rows) => {
    const cost = rows.some((r) => r.credits != null) ? `${sum(rows.map((r) => r.credits)).toFixed(0)} cr` : rows.some((r) => r.costUsd != null) ? `$${sum(rows.map((r) => r.costUsd)).toFixed(2)}` : '-';
    const models = {};
    for (const r of rows) for (const m of r.models ?? []) models[m] = (models[m] ?? 0) + 1;
    return [`${count(rows, (r) => r.pass)}/${rows.length}`, median(rows.map((r) => r.sizeRatio)) ?? '-', (sum(rows.map((r) => r.otherFilesTouched)) / rows.length).toFixed(1), median(rows.map((r) => r.toolCalls)) ?? '-',
      median(rows.map((r) => r.seconds)) ?? '-', `${median(rows.map((r) => r.docsRead)) ?? 0} / ${median(rows.map((r) => r.docsKB)) ?? 0}KB`, count(rows, (r) => r.committed), count(rows, (r) => r.timedOut), cost,
      Object.entries(models).map(([m, n]) => `${m} x${n}`).join(', ')];
  };
  const head = ['pass', 'size vs fix', 'extra files', 'tool calls', 'seconds', 'docs read', 'committed', 'timeouts', 'cost', 'models'];
  console.log('\nMedians per session. size vs fix = source lines changed / lines in the real fix. extra files = source files touched that the real fix did not touch (mean).\n');
  console.log(table(['variant', ...head], data.map(([n, rows]) => [n, ...cells(rows)])));
  for (const task of [...new Set(data.flatMap(([, rows]) => rows.map((r) => r.task)))]) {
    console.log(`\n${task}\n`);
    console.log(table(['variant', ...head], data.map(([n, rows]) => [n, rows.filter((r) => r.task === task)]).filter(([, rows]) => rows.length).map(([n, rows]) => [n, ...cells(rows)])));
  }
}

// ---------- cli ----------

const [command, ...rest] = process.argv.slice(2);
const args = { _: [] };
for (let i = 0; i < rest.length; i += 1) {
  const a = rest[i];
  if (a === '--tasks') args.tasks = rest[++i].split(',');
  else if (a === '--variant' || a === '--variants') args.variant = rest[++i].split(',');
  else if (a === '--repeats') args.repeats = Number(rest[++i]);
  else if (a === '--credit-cap') args.creditCap = Number(rest[++i]);
  else args._.push(a);
}
if (command === 'add') cmdAdd(args._);
else if (command === 'validate') cmdValidate(args);
else if (command === 'run') await cmdRun(args);
else if (command === 'report') cmdReport(args._);
else if (command === 'recheck') cmdRecheck(args._);
else fail('Usage: node evals.mjs add <fix-sha> [id] | validate | run --variant a,b | report | recheck');
