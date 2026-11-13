#!/usr/bin/env node
// Prepares a replay task: exports the fix's parent commit as a plain tree (no .git, so nothing can be
// committed or pushed to the source repo), strips agent instruction files, installs and builds it, and
// extracts the real fix (reference patch) and its tests (hidden from the agent).
//   node evals/replay/prepare.mjs <taskId>...
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EVALS = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const STRIP = ['AGENTS.md', 'CLAUDE.md', 'GEMINI.md', '.claude', '.mcp.json', '.cursorignore', '.codegraph-test', '.github', 'skills', 'ai-context', 'plans'];

function sh(cmd, args, cwd, opts = {}) {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', maxBuffer: 1 << 28, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}:\n${(r.stderr || '').slice(-2000)}`);
  return r.stdout;
}

for (const id of process.argv.slice(2)) {
  const taskDir = path.join(EVALS, 'tasks', id);
  const task = JSON.parse(fs.readFileSync(path.join(taskDir, 'task.json'), 'utf8'));
  const { fix, srcPaths, hiddenPaths } = task.replay;
  const repo = path.join(EVALS, task.replay.repo);
  const parent = sh('git', ['rev-parse', `${fix}^`], repo).trim();
  const prepared = path.resolve(taskDir, task.prepared);
  const yarn = () => path.join('.yarn', 'releases', fs.readdirSync(path.join(prepared, '.yarn', 'releases')).find((f) => f.startsWith('yarn-')));

  // Reference patch and hidden tests come from the real fix commit.
  fs.writeFileSync(path.join(taskDir, 'fix.patch'), sh('git', ['diff', parent, fix, '--', ...srcPaths], repo));
  // Hidden tests are extracted once; later hand edits (relaxing over-specific assertions) are kept.
  for (const p of fs.existsSync(path.join(taskDir, 'hidden')) ? [] : hiddenPaths) {
    const out = path.join(taskDir, 'hidden', p);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, sh('git', ['show', `${fix}:${p}`], repo));
  }
  console.log(`${id}: fix ${fix}, parent ${parent.slice(0, 10)}, ${srcPaths.length} source files, ${hiddenPaths.length} hidden files`);

  if (fs.existsSync(path.join(prepared, '.prepared'))) { console.log(`${id}: already prepared`); continue; }
  if (!fs.existsSync(path.join(prepared, 'package.json'))) {
    fs.mkdirSync(prepared, { recursive: true });
    sh('sh', ['-c', `git archive ${parent} | tar -x -C "${prepared}"`], repo);
  }
  for (const name of STRIP) fs.rmSync(path.join(prepared, name), { recursive: true, force: true });
  console.log(`${id}: installing`);
  sh('node', [yarn(), 'install'], prepared, { stdio: ['ignore', 'ignore', 'pipe'] });
  console.log(`${id}: building`);
  sh('node', [yarn(), 'build'], prepared, { stdio: ['ignore', 'ignore', 'pipe'] });
  fs.writeFileSync(path.join(prepared, '.prepared'), `${parent}\n`);
  console.log(`${id}: prepared at ${prepared}`);
}
