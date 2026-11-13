#!/usr/bin/env node
// Copilot CLI eval runner.
//   node evals/run.mjs --validate
//   node evals/run.mjs --recheck <resultsDir>...   re-grade finished runs from their saved patches
//   node evals/run.mjs [--agent copilot|claude|codex] [--model id] [--codex-sandbox workspace-write|danger-full-access] [--max-5h 0.85] [--max-7d 0.9] [--config baseline] [--tasks a,b] [--repeats 3] [--credit-cap N] [--timeout-min 15] [--out dir]
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.dirname(HERE);
const COPILOT = path.join(ROOT, 'node_modules', '.bin', 'copilot');
const TASKS_DIR = path.join(HERE, 'tasks');
const CONFIGS_DIR = path.join(HERE, 'configs');
const CHECK_DIR = '__check__';
const IGNORED = [/^node_modules(\/|$)/, /^package-lock\.json$/, /^__check__\//, /^copilot-session-.*\.md$/];
const isDoc = (file) => /^docs\//.test(file) || /\.md$/i.test(file);
const isTest = (file) => /(^|\/)(test|tests|__tests__)\//.test(file) || /\.test\.[cm]?[jt]s$/.test(file);

const count = (events, pick) => events.reduce((n, e) => n + pick(e), 0);
const lastOf = (events, type) => events.filter((e) => e.type === type).at(-1);
// Drop this session's own Claude Code variables so a nested agent starts clean.
const cleanEnv = () => Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(CLAUDE_|CLAUDECODE$)/.test(k)));

// Each agent runs with its vendor defaults: no user-level instructions, settings, plugins or MCP servers.
const AGENTS = {
  copilot: {
    bin: COPILOT,
    args: (ws, prompt, flags, opts) => ['-p', prompt, '-C', ws, '--allow-all-tools', '--output-format', 'json', '--no-auto-update', '--no-color',
      '--model', opts.model ?? 'auto', ...(opts.creditCap ? ['--max-ai-credits', String(opts.creditCap)] : []), ...flags],
    parse: (events) => {
      const result = lastOf(events, 'result');
      return {
        // Main-agent model only; subagents run on their own models and are counted separately.
        model: events.find((e) => e.type === 'model.call_start' && !e.data?.parentToolCallId)?.data.model ?? lastOf(events, 'session.start')?.data?.selectedModel ?? null,
        toolCalls: count(events, (e) => (e.type === 'tool.execution_start' ? 1 : 0)),
        subagentToolCalls: count(events, (e) => (e.type === 'tool.execution_start' && e.data?.parentToolCallId ? 1 : 0)),
        subagents: count(events, (e) => (e.type === 'subagent.started' ? 1 : 0)),
        subagentModels: [...new Set(events.filter((e) => e.type === 'subagent.started').map((e) => e.data?.model).filter(Boolean))],
        turns: count(events, (e) => (e.type === 'model.call_start' && !e.data?.parentToolCallId ? 1 : 0)),
        premiumRequests: result?.usage?.premiumRequests ?? null,
        ...(() => {
          const starts = events.filter((e) => e.type === 'tool.execution_start');
          const argsOf = (e) => JSON.stringify(e.data?.arguments ?? {});
          const wikiFiles = new Set();
          for (const e of starts) for (const m of argsOf(e).matchAll(/wiki\/[\w./@-]+\.mdx?/g)) wikiFiles.add(m[0]);
          const final = JSON.stringify(events.filter((e) => e.type === 'assistant.message' && !e.data?.parentToolCallId).at(-1)?.data ?? '');
          return {
            wikiCalls: starts.filter((e) => /wiki\//.test(argsOf(e))).length,
            wikiFiles: [...wikiFiles],
            committed: starts.some((e) => /git\s+(-C\s+\S+\s+)?(commit|push)\b/.test(argsOf(e))),
            canary: /Wiki pages consulted:/i.test(final),
            compactions: events.filter((e) => /compaction/.test(e.type) && /start|begin/.test(e.type)).length,
          };
        })(),
        aiCredits: (() => { const n = lastOf(events, 'session.usage_checkpoint')?.data?.totalNanoAiu; return n == null ? null : n / 1e9; })(),
        limitError: events.find((e) => e.type === 'session.error' && /quota|rate.?limit|usage limit|credit/i.test(e.data?.message ?? ''))?.data.message ?? null,
      };
    },
  },
  claude: {
    bin: 'claude',
    args: (ws, prompt, _flags, opts) => ['-p', prompt, '--output-format', 'stream-json', '--verbose', '--setting-sources', 'project', '--strict-mcp-config',
      '--no-session-persistence', '--permission-mode', 'acceptEdits', '--allowedTools', 'Bash,Read,Edit,Write,Glob,Grep', ...(opts.model ? ['--model', opts.model] : [])],
    parse: (events) => {
      const result = lastOf(events, 'result');
      return {
        model: events.find((e) => e.type === 'system' && e.subtype === 'init')?.model ?? null,
        toolCalls: count(events, (e) => (e.type === 'assistant' ? (e.message?.content ?? []).filter((c) => c.type === 'tool_use').length : 0)),
        costUsd: result?.total_cost_usd ?? null,
        // Subscription usage after this session, as fractions of the 5-hour and 7-day windows.
        usage5h: lastOf(events, 'rate_limit_event')?.rate_limit_info?.unifiedWindows?.five_hour?.utilization ?? null,
        usage7d: lastOf(events, 'rate_limit_event')?.rate_limit_info?.unifiedWindows?.seven_day?.utilization ?? null,
        limitError: (result?.is_error && /limit|429|overloaded/i.test(`${result?.api_error_status ?? ''} ${result?.result ?? ''}`)) || lastOf(events, 'rate_limit_event')?.rate_limit_info?.status === 'rejected' ? String(result?.result ?? 'usage limit reached').slice(0, 200) : null,
        turns: result?.num_turns ?? null,
        outputTokens: result?.usage?.output_tokens ?? null,
      };
    },
  },
  codex: {
    bin: 'codex',
    args: (ws, prompt, _flags, opts) => ['exec', '--json', '--sandbox', opts.codexSandbox ?? 'workspace-write', '--ignore-user-config', '--ignore-rules', '--ephemeral', '--skip-git-repo-check', ...(opts.model ? ['-m', opts.model] : []), '-C', ws, prompt],
    parse: (events, opts) => {
      const done = events.filter((e) => e.type === 'item.completed').map((e) => e.item?.type);
      const usage = events.filter((e) => e.type === 'turn.completed').map((e) => e.usage ?? {});
      return {
        model: events.find((e) => e.model)?.model ?? opts?.model ?? null,
        toolCalls: done.filter((t) => t && !['agent_message', 'reasoning', 'todo_list', 'error'].includes(t)).length,
        turns: usage.length,
        outputTokens: usage.reduce((n, u) => n + (u.output_tokens ?? 0), 0) || null,
      };
    },
  },
};

function parseArgs(argv) {
  const args = { agent: 'copilot', config: 'baseline', repeats: 3, timeoutMin: 15, validate: false, max5h: 0.85, max7d: 0.9 };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--validate') args.validate = true;
    else if (a === '--recheck') { args.recheck = argv.slice(i + 1); break; }
    else if (a === '--config') args.config = argv[++i];
    else if (a === '--agent') args.agent = argv[++i];
    else if (a === '--model') args.model = argv[++i];
    else if (a === '--codex-sandbox') args.codexSandbox = argv[++i];
    else if (a === '--max-5h') args.max5h = Number(argv[++i]);
    else if (a === '--max-7d') args.max7d = Number(argv[++i]);
    else if (a === '--tasks') args.tasks = argv[++i].split(',');
    else if (a === '--repeats') args.repeats = Number(argv[++i]);
    else if (a === '--credit-cap') args.creditCap = argv[++i];
    else if (a === '--timeout-min') args.timeoutMin = Number(argv[++i]);
    else if (a === '--out') args.out = argv[++i];
    else throw new Error(`unknown argument: ${a}`);
  }
  return args;
}

function loadTasks(only) {
  const ids = fs.readdirSync(TASKS_DIR).filter((d) => fs.existsSync(path.join(TASKS_DIR, d, 'task.json'))).sort();
  const picked = only ? ids.filter((id) => only.includes(id)) : ids;
  if (only && picked.length !== only.length) throw new Error(`unknown task in: ${only.join(',')}`);
  return picked.map((id) => ({ dir: path.join(TASKS_DIR, id), ...JSON.parse(fs.readFileSync(path.join(TASKS_DIR, id, 'task.json'), 'utf8')) }));
}

function git(ws, ...args) {
  const r = spawnSync('git', ['-c', 'user.name=eval', '-c', 'user.email=eval@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd: ws, encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${r.stderr}`);
  return r.stdout;
}

// Replay tasks run in a copy of a prepared, built checkout of a real repo. Dependencies are hard-linked
// (same filesystem), everything else is copied. The copy gets its own throwaway git repo with no remote,
// used only to diff the agent's changes: nothing is ever committed or pushed to the source repo.
function makePreparedWorkspace(task, config = {}, overlayDir = null) {
  const prepared = path.resolve(task.dir, task.prepared);
  if (!fs.existsSync(path.join(prepared, '.prepared'))) throw new Error(`${task.id} is not prepared: run node evals/replay/prepare.mjs ${task.id}`);
  const base = process.env.EVAL_WORK || path.join(HERE, '.work');
  fs.mkdirSync(base, { recursive: true });
  const ws = fs.mkdtempSync(path.join(base, `${task.id}-`));
  const cp = (flags, from, to) => { const r = spawnSync('cp', [flags, from, to], { encoding: 'utf8' }); if (r.status !== 0) throw new Error(`cp failed: ${r.stderr}`); };
  for (const name of fs.readdirSync(prepared)) {
    if (name === '.prepared') continue;
    cp(name === 'node_modules' ? '-al' : '-a', path.join(prepared, name), path.join(ws, name));
  }
  if (config.wiki) addWiki(task, ws, config.wiki);
  if (overlayDir) fs.cpSync(overlayDir, ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'initial');
  return ws;
}

// Puts the repo's own markdown docs, as they were at the commit before the fix, into wiki/ with an index page.
// Read-only on the source clone (git archive). Nothing newer than the fix is included, so the wiki cannot leak it.
function addWiki(task, ws, spec) {
  const clone = path.resolve(HERE, 'repos', task.replay.repo.split('/').pop());
  const wiki = path.join(ws, 'wiki');
  fs.mkdirSync(wiki, { recursive: true });
  const r = spawnSync('bash', ['-c', 'git -C "$1" archive "$2^" -- "${@:4}" | tar -x -C "$3"', '_', clone, task.replay.fix, wiki, ...spec.paths], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`wiki archive failed: ${r.stderr}`);
  const pages = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { if (e.name.startsWith('.')) fs.rmSync(p, { recursive: true, force: true }); else walk(p); }
      else if (!/\.mdx?$/i.test(e.name)) fs.rmSync(p);
      else pages.push(path.relative(wiki, p));
    }
  };
  walk(wiki);
  const title = (rel) => (fs.readFileSync(path.join(wiki, rel), 'utf8').match(/^#\s+(.+)$/m)?.[1] ?? path.basename(rel)).trim();
  fs.writeFileSync(path.join(wiki, 'README.md'), `# Project wiki\n\n${pages.length} pages. Read the pages relevant to your task before changing code.\n\n${pages.sort().map((p) => `- [${title(p)}](${p})`).join('\n')}\n`);
}

const yarnOf = (ws) => path.join('.yarn', 'releases', fs.readdirSync(path.join(ws, '.yarn', 'releases')).find((f) => f.startsWith('yarn-')));

// Grades a replay run: adds the real fix's tests, rebuilds the packages the agent changed, runs those tests.
function gradeReplay(task, ws, changedFiles) {
  const out = [];
  for (const p of task.replay.hiddenPaths) {
    fs.mkdirSync(path.dirname(path.join(ws, p)), { recursive: true });
    fs.copyFileSync(path.join(task.dir, 'hidden', p), path.join(ws, p));
  }
  const pkgDirs = [...new Set(changedFiles.map((f) => f.match(/^(packages\/[^/]+)\/src\//)?.[1]).filter(Boolean))];
  for (const dir of pkgDirs) {
    const name = JSON.parse(fs.readFileSync(path.join(ws, dir, 'package.json'), 'utf8')).name;
    const b = spawnSync('node', [yarnOf(ws), 'build', '-p', name], { cwd: ws, encoding: 'utf8', timeout: 900_000, maxBuffer: 1 << 26 });
    out.push(`$ build -p ${name} (exit ${b.status})\n${(b.stdout + b.stderr).slice(-3000)}`);
    if (b.status !== 0) return { ok: false, output: out.join('\n'), buildFailed: name };
  }
  const t = spawnSync('node', [yarnOf(ws), 'test', ...task.grade.test], { cwd: ws, encoding: 'utf8', timeout: 900_000, maxBuffer: 1 << 26, env: { ...cleanEnv(), ...(task.grade.env ?? {}) } });
  const text = (t.stdout + t.stderr).replace(/\x1b\[[0-9;]*m/g, '');
  out.push(`$ test ${task.grade.test.join(' ')} (exit ${t.status})\n${text.slice(-6000)}`);
  const line = text.split('\n').filter((l) => /^\s*Tests\s/.test(l)).at(-1) ?? '';
  const passed = Number(line.match(/(\d+) passed/)?.[1] ?? 0);
  const failed = Number(line.match(/(\d+) failed/)?.[1] ?? 0);
  // Webiny's storage suites skip silently, so a green exit is not enough: enough tests must have run and passed.
  return { ok: t.status === 0 && failed === 0 && passed >= (task.grade.minTests ?? 1), output: out.join('\n'), passed, failed };
}

function makeWorkspace(task, overlayDir) {
  if (task.prepared) return makePreparedWorkspace(task);
  const base = process.env.EVAL_TMP || os.tmpdir();
  const ws = fs.mkdtempSync(path.join(base, `copilot-eval-${task.id}-`));
  // A task either has its own repo/ or points at a shared fixture with "repo": "../_shared/name".
  const repoDir = task.repo ? path.resolve(task.dir, task.repo) : path.join(task.dir, 'repo');
  fs.cpSync(repoDir, ws, { recursive: true, filter: (src) => path.basename(src) !== 'node_modules' });
  // Dependencies are installed once in the fixture and linked in (the fixture's .gitignore excludes them).
  if (fs.existsSync(path.join(repoDir, 'node_modules'))) fs.symlinkSync(path.join(repoDir, 'node_modules'), path.join(ws, 'node_modules'));
  if (overlayDir) fs.cpSync(overlayDir, ws, { recursive: true });
  git(ws, 'init', '-q', '-b', 'main');
  git(ws, 'add', '-A');
  git(ws, 'commit', '-q', '-m', 'initial');
  return ws;
}

// Diff of the working tree against the initial commit, untracked files included.
function diffStats(ws) {
  git(ws, 'add', '-A');
  const keep = (file) => !IGNORED.some((re) => re.test(file));
  const numstat = git(ws, 'diff', '--cached', '--numstat', 'HEAD').trim().split('\n').filter(Boolean)
    .map((l) => l.split('\t')).map(([a, r, file]) => ({ file, added: Number(a) || 0, removed: Number(r) || 0 })).filter((e) => keep(e.file));
  const status = git(ws, 'diff', '--cached', '--name-status', 'HEAD').trim().split('\n').filter(Boolean)
    .map((l) => l.split('\t')).filter(([, file]) => keep(file));
  // Size and file limits apply to source only: adding tests or updating docs is not over-engineering.
  const source = numstat.filter((e) => !isTest(e.file) && !isDoc(e.file));
  const tests = numstat.filter((e) => isTest(e.file));
  return {
    files: numstat.map((e) => e.file),
    filesChanged: numstat.length,
    linesAdded: source.reduce((s, e) => s + e.added, 0),
    linesRemoved: source.reduce((s, e) => s + e.removed, 0),
    testLines: tests.reduce((s, e) => s + e.added + e.removed, 0),
    sourceFiles: source.map((e) => e.file),
    newFiles: status.filter(([s, f]) => s === 'A' && !isTest(f) && !isDoc(f)).map(([, f]) => f),
    patch: git(ws, 'diff', '--cached', 'HEAD'),
  };
}

function runHiddenCheck(task, ws, dirs = task.checkDirs ?? ['check']) {
  for (const dir of dirs) fs.cpSync(path.resolve(task.dir, dir), path.join(ws, CHECK_DIR), { recursive: true });
  const r = spawnSync(process.execPath, ['--test', `${CHECK_DIR}/**/*.test.{js,ts}`], { cwd: ws, encoding: 'utf8', timeout: 120_000 });
  fs.rmSync(path.join(ws, CHECK_DIR), { recursive: true, force: true });
  return { ok: r.status === 0, output: `${r.stdout}\n${r.stderr}` };
}

function taskChecks(task, ws, stats, refLines) {
  const c = task.checks || {};
  const failures = [];
  const sizeRatio = refLines ? (stats.linesAdded + stats.linesRemoved) / refLines : null;
  if (c.maxNewFiles !== undefined && stats.newFiles.length > c.maxNewFiles) failures.push(`new files: ${stats.newFiles.join(', ')}`);
  if (c.maxSizeRatio !== undefined && sizeRatio !== null && sizeRatio > c.maxSizeRatio) failures.push(`size ratio ${sizeRatio.toFixed(1)} > ${c.maxSizeRatio}`);
  if (c.maxSourceFiles !== undefined && stats.sourceFiles.length > c.maxSourceFiles) failures.push(`${stats.sourceFiles.length} source files changed > ${c.maxSourceFiles}`);
  for (const file of c.mustNotTouch || []) if (stats.files.includes(file)) failures.push(`touched ${file}`);
  // Repo commands that must still succeed, e.g. the type check.
  for (const command of c.commands || []) {
    const r = spawnSync(command[0], command.slice(1), { cwd: ws, encoding: 'utf8', timeout: 180_000 });
    if (r.status !== 0) failures.push(`\`${command.join(' ')}\` failed`);
  }
  for (const { file, pattern } of c.mustMatch || []) {
    const p = path.join(ws, file);
    if (!fs.existsSync(p) || !new RegExp(pattern, 'm').test(fs.readFileSync(p, 'utf8'))) failures.push(`${file} lacks /${pattern}/`);
  }
  for (const { file, pattern } of c.mustNotMatch || []) {
    const p = path.join(ws, file);
    if (fs.existsSync(p) && new RegExp(pattern, 'm').test(fs.readFileSync(p, 'utf8'))) failures.push(`${file} has /${pattern}/`);
  }
  return { failures, sizeRatio };
}

// Added lines per file in a unified diff, and whether the file is new.
function addedByFile(patch) {
  const files = new Map();
  let current = null;
  for (const line of patch.split('\n')) {
    const header = line.match(/^diff --git a\/(.+) b\/(.+)$/);
    if (header) { current = { added: [], isNew: false }; files.set(header[2], current); continue; }
    if (!current) continue;
    if (line.startsWith('new file mode')) current.isNew = true;
    else if (line.startsWith('+') && !line.startsWith('+++')) current.added.push(line.slice(1));
  }
  return files;
}

// Where the change went: for each named signal, the number of files (matching `files`) with an added line matching `addedLines`.
function approachOf(task, stats) {
  const signals = {};
  const files = addedByFile(stats.patch);
  for (const [name, spec] of Object.entries(task.signals ?? {})) {
    const fileRe = new RegExp(spec.files);
    const lineRe = new RegExp(spec.addedLines, 'i');
    signals[name] = [...files].filter(([file, f]) => fileRe.test(file) && !isTest(file) && !isDoc(file) && !(spec.existingOnly && f.isNew) && f.added.some((l) => lineRe.test(l))).length;
  }
  const hit = Object.entries(signals).filter(([, n]) => n > 0).map(([name, n]) => (n > 1 ? `${name}(${n})` : name));
  if (task.replay) {
    // Replay tasks: how the agent's changed source files compare with the files the real fix changed.
    const real = task.replay.srcPaths;
    const same = stats.sourceFiles.filter((f) => real.includes(f)).length;
    return { signals: { fixFilesTouched: same, fixFiles: real.length, otherSourceFiles: stats.sourceFiles.length - same },
      approach: `${same}/${real.length} fix files${stats.sourceFiles.length - same ? ` + ${stats.sourceFiles.length - same} other` : ''}` };
  }
  return { signals, approach: task.signals ? hit.join(' + ') || 'other' : null };
}

// Optional stricter hidden tests that are reported but not required for a pass.
function extraCheck(task, ws) {
  return task.extraCheckDirs ? runHiddenCheck(task, ws, task.extraCheckDirs).ok : null;
}

// Applies the reference solution in a scratch workspace; returns its size and whether it passes.
function reference(task) {
  const ws = makeWorkspace(task, null);
  try {
    const before = task.replay ? gradeReplay(task, ws, []) : runHiddenCheck(task, ws);
    if (task.replay) {
      for (const p of task.replay.hiddenPaths) fs.rmSync(path.join(ws, p), { force: true });
      git(ws, 'checkout', '-q', '--', '.');
      git(ws, 'apply', '--whitespace=nowarn', path.join(task.dir, 'fix.patch'));
    } else {
      fs.cpSync(path.join(task.dir, 'solution'), ws, { recursive: true });
    }
    const stats = diffStats(ws);
    const lines = stats.linesAdded + stats.linesRemoved;
    const after = task.replay ? gradeReplay(task, ws, stats.files) : runHiddenCheck(task, ws);
    const checks = taskChecks(task, ws, stats, lines);
    return { lines, failsAsShipped: !before.ok, passesWithSolution: after.ok, checkFailures: checks.failures, output: after.output,
      extra: extraCheck(task, ws), approach: approachOf(task, stats).approach, passed: after.passed };
  } finally {
    fs.rmSync(ws, { recursive: true, force: true });
  }
}

function runAgent(agent, ws, prompt, flags, opts, env, timeoutMs, outFile, errFile) {
  return new Promise((resolve) => {
    const out = fs.openSync(outFile, 'w');
    const err = fs.openSync(errFile, 'w');
    const started = Date.now();
    const child = spawn(agent.bin, agent.args(ws, prompt, flags, opts), {
      cwd: ws, env: { ...cleanEnv(), ...env }, stdio: ['ignore', out, err], detached: true,
    });
    child.on('error', (e) => { fs.writeSync(err, `spawn failed: ${e.message}\n`); });
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, timeoutMs);
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      fs.closeSync(out); fs.closeSync(err);
      resolve({ code, signal, timedOut, wallSeconds: (Date.now() - started) / 1000 });
    });
  });
}

// Counts JSONL events by `type`, keeps the final `result` usage block, and adds the agent's own metrics.
function summarizeEvents(file, agent, opts) {
  const typeCounts = {};
  const events = [];
  let usage = null;
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      events.push(event);
      const t = event.type ?? '(no type)';
      typeCounts[t] = (typeCounts[t] || 0) + 1;
      if (t === 'result') usage = event.usage ?? null;
    } catch { typeCounts['(unparsed)'] = (typeCounts['(unparsed)'] || 0) + 1; }
  }
  return { typeCounts, usage, ...agent.parse(events, opts) };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const tasks = loadTasks(args.tasks);

  if (args.validate) {
    let bad = 0;
    for (const task of tasks) {
      const ref = reference(task);
      const ok = ref.failsAsShipped && ref.passesWithSolution && ref.checkFailures.length === 0;
      if (!ok) bad += 1;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${task.id}  failsAsShipped=${ref.failsAsShipped} passesWithSolution=${ref.passesWithSolution} refLines=${ref.lines} checks=${ref.checkFailures.join('; ') || 'ok'}${ref.extra === null ? '' : ` extraTests=${ref.extra}`}${ref.approach ? ` approach=${ref.approach}` : ''}${ref.passed !== undefined ? ` hiddenTestsPassed=${ref.passed}` : ''}`);
      if (!ref.passesWithSolution) console.log(ref.output);
    }
    process.exit(bad ? 1 : 0);
  }

  if (args.recheck) {
    // Rebuild each run's workspace from the fixture plus its saved patch, then grade it with the current checks.
    const byId = new Map(loadTasks().map((t) => [t.id, t]));
    const refs = new Map();
    for (const dir of args.recheck) {
      const rowsFile = path.join(dir, 'rows.jsonl');
      const backup = path.join(dir, 'rows.orig.jsonl');
      if (!fs.existsSync(backup)) fs.copyFileSync(rowsFile, backup);
      const rows = fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
      let changed = 0;
      for (const row of rows) {
        const task = byId.get(row.task);
        if (!refs.has(task.id)) refs.set(task.id, reference(task));
        const ws = makeWorkspace(task, null);
        const patchFile = path.resolve(dir, `${row.runId}.patch`);
        if (fs.statSync(patchFile).size > 0) git(ws, 'apply', '--whitespace=nowarn', patchFile);
        const stats = diffStats(ws);
        const hidden = task.replay ? gradeReplay(task, ws, stats.files) : runHiddenCheck(task, ws);
        fs.writeFileSync(path.join(dir, `${row.runId}.check.txt`), hidden.output);
        const checks = taskChecks(task, ws, stats, refs.get(task.id).lines);
        const pass = hidden.ok && checks.failures.length === 0;
        if (pass !== row.pass || hidden.ok !== row.testsPass) changed += 1;
        Object.assign(row, { ...approachOf(task, stats), extraTestsPass: extraCheck(task, ws), inScope: checks.failures.length === 0, pass, testsPass: hidden.ok, checkFailures: checks.failures, filesChanged: stats.filesChanged, sourceFilesChanged: stats.sourceFiles.length,
          files: stats.files, linesAdded: stats.linesAdded, linesRemoved: stats.linesRemoved, testLines: stats.testLines, newFiles: stats.newFiles,
          refLines: refs.get(task.id).lines, sizeRatio: checks.sizeRatio });
        fs.rmSync(ws, { recursive: true, force: true });
      }
      fs.writeFileSync(rowsFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n');
      console.log(`${dir}: ${rows.length} runs re-graded, ${changed} verdicts changed (original kept in rows.orig.jsonl)`);
    }
    return;
  }

  const config = JSON.parse(fs.readFileSync(path.join(CONFIGS_DIR, `${args.config}.json`), 'utf8'));
  const overlayDir = config.overlay ? path.join(CONFIGS_DIR, config.overlay) : null;
  const agent = AGENTS[args.agent];
  if (!agent) throw new Error(`unknown agent: ${args.agent}`);
  if (args.agent !== 'copilot' && (config.flags.length || overlayDir)) throw new Error('configs other than baseline are Copilot-only');
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = args.out || path.join(HERE, 'results', `${stamp}-${args.agent}-${config.name}`);
  fs.mkdirSync(outDir, { recursive: true });
  const rowsFile = path.join(outDir, 'rows.jsonl');
  const version = (spawnSync(agent.bin, ['--version'], { encoding: 'utf8', env: cleanEnv() }).stdout ?? '').trim();

  // Resumable: sessions already recorded in this results folder are skipped.
  const done = new Set(fs.existsSync(rowsFile) ? fs.readFileSync(rowsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l).runId) : []);
  // Repeats are the outer loop so a row stopped early still covers every task evenly.
  const refs = new Map();
  for (let rep = 1; rep <= args.repeats; rep += 1) {
    for (const task of tasks) {
      const runId = `${task.id}.${rep}`;
      if (done.has(runId)) continue;
      if (!refs.has(task.id)) refs.set(task.id, reference(task));
      const ref = refs.get(task.id);
      const ws = task.prepared ? makePreparedWorkspace(task, config, overlayDir) : makeWorkspace(task, overlayDir);
      const eventsFile = path.join(outDir, `${runId}.events.jsonl`);
      process.stdout.write(`${args.agent}/${config.name} ${runId} ... `);
      const prompt = task.notes ? `${task.prompt}\n\n${task.notes}` : task.prompt;
      const run = await runAgent(agent, ws, prompt, config.flags, { creditCap: args.creditCap, model: args.model, codexSandbox: args.codexSandbox }, config.env || {}, (task.timeoutMin ?? args.timeoutMin) * 60_000, eventsFile, path.join(outDir, `${runId}.stderr.txt`));
      const stderr = fs.readFileSync(path.join(outDir, `${runId}.stderr.txt`), 'utf8');
      if (/bwrap: .*(not permitted|denied)/i.test(fs.readFileSync(eventsFile, 'utf8'))) {
        console.log(`ABORT: ${args.agent} could not run shell commands (its sandbox failed to start, usually because the runner itself is inside another sandbox).`);
        fs.rmSync(ws, { recursive: true, force: true });
        process.exit(2);
      }
      if (/Failed to load models|could not provide a token|not authenticated|not logged in|please run \/login|spawn failed/i.test(stderr)) {
        console.log(`ABORT: ${args.agent} could not start or is not authenticated.`);
        console.log(stderr.trim());
        fs.rmSync(ws, { recursive: true, force: true });
        process.exit(2);
      }
      const usage = summarizeEvents(eventsFile, agent, { model: args.model });
      if (usage.limitError) {
        console.log(`STOPPED: ${args.agent} hit a usage limit (${usage.limitError}). Nothing recorded for ${runId}; rerun the same command to resume.`);
        fs.rmSync(ws, { recursive: true, force: true });
        process.exit(3);
      }
      const stats = diffStats(ws);
      fs.writeFileSync(path.join(outDir, `${runId}.patch`), stats.patch);
      const hidden = task.replay ? gradeReplay(task, ws, stats.files) : runHiddenCheck(task, ws);
      fs.writeFileSync(path.join(outDir, `${runId}.check.txt`), hidden.output);
      const checks = taskChecks(task, ws, stats, ref.lines);
      const extraTestsPass = extraCheck(task, ws);
      const row = {
        ...approachOf(task, stats), extraTestsPass, inScope: checks.failures.length === 0,
        runId, task: task.id, category: task.category, agent: args.agent, config: config.name, repeat: rep, agentVersion: version,
        pass: hidden.ok && checks.failures.length === 0, testsPass: hidden.ok, checkFailures: checks.failures,
        filesChanged: stats.filesChanged, sourceFilesChanged: stats.sourceFiles.length, files: stats.files, linesAdded: stats.linesAdded, linesRemoved: stats.linesRemoved, testLines: stats.testLines, newFiles: stats.newFiles,
        refLines: ref.lines, sizeRatio: checks.sizeRatio,
        wallSeconds: Math.round(run.wallSeconds), exitCode: run.code, timedOut: run.timedOut,
        events: summarizeEvents(eventsFile, agent, { model: args.model }),
      };
      if (row.events.wikiFiles) row.events.wikiBytes = row.events.wikiFiles.reduce((n, f) => n + (fs.existsSync(path.join(ws, f)) ? fs.statSync(path.join(ws, f)).size : 0), 0);
      fs.appendFileSync(rowsFile, `${JSON.stringify(row)}\n`);
      console.log(`${row.pass ? 'PASS' : 'fail'} tests=${row.testsPass} +${row.linesAdded}/-${row.linesRemoved} files=${row.filesChanged} ${row.wallSeconds}s tools=${row.events.toolCalls ?? '?'} model=${row.events.model ?? '?'}${row.events.usage5h != null ? ` usage5h=${row.events.usage5h} usage7d=${row.events.usage7d}` : ''}${row.events.aiCredits != null ? ` credits=${row.events.aiCredits.toFixed(1)}` : ''} exit=${run.code}${run.timedOut ? ' TIMEOUT' : ''}${row.events.wikiFiles ? ` wiki=${row.events.wikiFiles.length}pages/${Math.round((row.events.wikiBytes ?? 0) / 1024)}KB canary=${row.events.canary} committed=${row.events.committed}` : ''} ${checks.failures.join('; ')}`);
      fs.rmSync(ws, { recursive: true, force: true });
      const { usage5h, usage7d } = row.events;
      if ((usage5h ?? 0) >= args.max5h || (usage7d ?? 0) >= args.max7d) {
        console.log(`PAUSED: subscription usage is at ${Math.round((usage5h ?? 0) * 100)}% of the 5-hour window and ${Math.round((usage7d ?? 0) * 100)}% of the 7-day window (caps ${args.max5h * 100}% / ${args.max7d * 100}%). Rerun the same command to resume.`);
        process.exit(4);
      }
    }
  }
  console.log(`results: ${outDir}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
