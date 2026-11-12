# agent-evals

Measure how a coding agent behaves on **your** repo, and what each change to its setup actually does.

It replays real fix commits. For each one, the agent gets the repo as it was just before the fix and a description of the problem. The tests from the real fix are kept hidden and decide whether the agent solved it. The real fix is the yardstick for size and scope.

One file, no dependencies. Needs Node 20+, git, bash, and the agent CLIs you want to test (`copilot`, `claude`). Linux and macOS.

## Setup

Copy this folder into your repo (or next to it) and create the config:

```bash
cp evals.config.example.json evals.config.json
```

Edit `evals.config.json`:

| Field | Meaning |
|---|---|
| `repo` | Path to the git repo, relative to this folder. `..` if this folder sits in the repo root. |
| `setup` | Commands that make a fresh checkout runnable (`npm ci`, a build). Run once per task, then cached. |
| `hardlink` | Folders that are hard-linked into each run instead of copied. Default `["node_modules"]`. |
| `beforeTest` | Commands run before the hidden tests, for example a rebuild. |
| `env` | Environment for setup, tests and the agent. |
| `promptSuffix` | Text added to every task prompt. |
| `variants` | The setups you want to compare. See below. |
| `workDir` | Where checkouts and run copies go. Default `~/.cache/agent-evals/<repo>`. Keep it outside the repo. |

`evals.config.json`, `tasks/` and `results/` are git-ignored here so nothing from a private repo ends up in this one. Remove those lines from `.gitignore` if you want to keep tasks in your own repo.

## Add tasks

Pick commits that fixed a bug and added or changed a test for it.

```bash
node evals.mjs add <fix-sha> short-name
```

That writes `tasks/short-name.json`. Fill in two fields:

- `prompt`: the problem as it was reported. Describe symptoms, not the solution. Vague tickets are fine if your real ones are vague.
- `test`: a command that runs the fix's tests, for example `npx vitest run path/to/the.test.ts`.

Optional fields: `env`, `beforeTest`, `setup`, `timeoutMin`, `minPassed` (fail unless at least this many tests passed; use it when your runner exits 0 on skipped suites).

Then check the task:

```bash
node evals.mjs validate
```

A task is good when the tests fail before the fix and pass with it. If the real tests assert on exact wording or internals that a different correct fix would not match, put an edited copy at `tasks/<id>/hidden/<same path>`; it replaces the original.

Six to ten tasks is enough to start. Include the kind that went wrong for you.

## Variants

A variant is one setup. Everything not mentioned stays as it is in the repo, so the default variant is your real setup.

```json
"copilot-auto":         { "agent": "copilot", "model": "auto" },
"copilot-sonnet":       { "agent": "copilot", "model": "claude-sonnet-5.5" },
"copilot-auto-no-wiki": { "agent": "copilot", "model": "auto",
                          "remove": ["wiki", "AGENTS.md", ".github/copilot-instructions.md"] },
"copilot-auto-short-rules": { "agent": "copilot", "model": "auto",
                          "remove": ["wiki", "AGENTS.md", ".github/copilot-instructions.md"],
                          "overlay": "overlays/short-rules" }
```

| Field | Meaning |
|---|---|
| `agent` | `copilot` or `claude`. |
| `model` | Model id, or `auto` for Copilot. |
| `remove` | Paths deleted from the run copy before the agent starts: wiki, instruction files, MCP config. |
| `overlay` | A folder copied over the run copy: a different instructions file, an MCP config, a code index. |
| `flags` | Extra CLI flags, for example `["--reasoning-effort", "high"]`. |
| `env` | Extra environment for the agent. |
| `promptSuffix` | Extra text added to the prompt for this variant only. |

Change one thing per variant, otherwise you cannot tell what caused a difference.

## Run and report

```bash
node evals.mjs run --variant copilot-auto,copilot-sonnet --repeats 3
node evals.mjs report
```

Runs are resumable: rerun the same command and finished sessions are skipped. `--tasks a,b` limits the tasks. `--credit-cap 60` passes a per-session limit to Copilot (minimum 30).

The report shows, per variant and per task:

| Column | Meaning |
|---|---|
| pass | Sessions where the hidden tests pass. |
| size vs fix | Source lines the agent changed divided by lines in the real fix. Tests and markdown are not counted. |
| extra files | Source files changed that the real fix did not touch. |
| tool calls, seconds | Effort. |
| docs read | Markdown files the agent opened by path, and their size. A rough stand-in for context load; text seen through search results is not counted. |
| committed | Sessions that ran `git commit` or `git push`. |
| cost | Copilot AI credits, or Claude's reported cost. |
| models | What the main agent ran on. With Auto this shows what was picked. |

Each session also saves its event log, patch, test output and final message under `results/<variant>/`. After editing a task's tests, `node evals.mjs recheck` re-grades the saved patches without running the agent again.

## Reading the results

- Three repeats per task show only large differences. Agents vary between runs.
- If every variant passes everything, pass rate tells you nothing; compare size, extra files and effort, or add harder tasks.
- A fix that differs from the real one can still be right. Read the patch before calling a failure a failure.

## Safety

- The agent runs with all tools allowed, as your user, with your credentials. It works in a copy that has no git remote, but nothing stops a shell command from reaching outside it. Use tasks and a machine you would trust an agent with.
- The source repo is only read (`git archive`, `git show`). Nothing is committed or pushed there.
- Hard-linked folders are shared with the cached checkout. An agent that edits files inside `node_modules` changes the cache; delete `<workDir>/prepared/<task>` to rebuild it.
- Results contain your code and prompts. Keep `results/` out of public repos.

## Example results

[Copilot CLI vs Claude Code on six real Webiny bug fixes](experiments/webiny/README.md): 84 sessions comparing harness, model choice and a large wiki.
