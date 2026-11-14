# Harness used for this experiment

The runner, tasks and hidden tests that produced [`../sessions.csv`](../sessions.csv), copied unchanged from the experiment folder. [`evals.mjs`](../../../evals.mjs) in the repo root is the generalised version of this runner for any repo; it does not have the size and file limits used here.

| Path | What it is |
|---|---|
| `run.mjs` | Runs the agents, saves each patch, grades it. `--validate` checks the tasks, `--recheck` re-grades saved patches. |
| `report.mjs` | Prints the comparison tables from `rows.jsonl`. |
| `replay/prepare.mjs` | Exports the commit before each fix, strips agent instruction files, installs and builds it, extracts the real fix and its tests. |
| `configs/` | `baseline` (rows A to D) and `wiki` (rows E and F, adds `wiki/` and `configs/wiki/AGENTS.md`). |
| `tasks/<id>/task.json` | Fix commit, ticket text, repo notes, test command, limits. |
| `tasks/<id>/fix.patch` | The real fix, source files only. The yardstick for size and scope. |
| `tasks/<id>/hidden/` | The tests from the real fix, added to the workspace only after the agent has finished. |
| `tasks/<id>-vague/` | The same task with a symptom-only ticket (rows G to N). Same `fix.patch`; trimmed hidden tests. |
| `tasks/<id>-vague-hint/` | The vague task with one sentence added to the ticket (rows J and L). |
| `tasks/<id>-vague-preflight/` | The vague task with a spec-first procedure added to the ticket (row N). |

## How a session is graded

1. The agent's diff against the starting commit is saved as the patch.
2. The hidden tests are copied in, every package the agent changed under `packages/*/src/` is rebuilt, and the task's test files are run with the storage backend in `grade.env`.
3. **Tests pass** when the test run exits 0, no test failed and at least `grade.minTests` tests passed. Webiny's storage suites skip silently, so a green exit alone is not enough.
4. **In scope** when the source lines changed are at most `checks.maxSizeRatio` times the real fix and at most `checks.maxSourceFiles` source files changed. Tests and markdown are not counted.
5. **Pass** means both.

| Task | Max size vs real fix | Max source files | Min tests passed |
|---|---|---|---|
| audit-logs | 5× | 3 | 1 |
| os-registries | 5× | 5 | 1 |
| flp-logging | 3× | 6 | 3 |
| model-cache | 3× | 7 | 1 |
| sql-leak | 3× | 5 | 3 |
| tenant-leak | 3× | 4 | 8 |

## Hidden tests that were edited

Three of the eight hidden files differ from the real fix, so that a different correct fix is not failed. The other five are byte-identical to the fix commit.

| File | Change |
|---|---|
| `webiny-flp-logging/hidden/.../folder.flp.triggerFailures.test.ts` | Log level, argument order and wording are no longer checked, only that the failure was logged with the folder id. |
| `webiny-sql-leak/hidden/.../TableManager.test.ts` | Extra `TableManager` instances: at most 1 instead of exactly 1. |
| `webiny-tenant-leak/hidden/.../tenantContext.test.ts` | Any error is accepted instead of one exact message. |

### Vague tasks

The `-vague` tasks start from the files above and drop the assertions for requirements that only the precise ticket stated. Each change is marked with an `// eval-vague:` comment.

| File | Change |
|---|---|
| `webiny-os-registries-vague/hidden/.../registriesPerRequest.test.ts` | Isolation from other requests and from the root is not checked. |
| `webiny-sql-leak-vague/hidden/.../TableManager.test.ts` | The two concurrency tests and the same-object assertions are removed. The remaining test hides the test-runner environment variables (`NODE_ENV`, `VITEST`, `JEST_WORKER_ID` and others) while it counts registered managers, and counts only managers held by strong references. A fix that keeps the registry for tests only, or holds weak references, is not failed. |
| `webiny-tenant-leak-vague/hidden/.../tenantContext.test.ts` | The test that `setTenant()` is refused inside a callback is removed. |
| `webiny-flp-logging-vague/hidden/.../folder.flp.triggerFailures.test.ts` | The folder id in the log entry is not required. |

`audit-logs-vague` and `model-cache-vague` use the same hidden tests as the precise tasks. Limits are the same as in the table above, except `sql-leak-vague`: 6 source files, and 1 test passed at minimum; `tenant-leak-vague`: 7 tests passed at minimum.

Each edit to the precise tasks is marked with an `// eval:` comment. To see it in full, diff the file against the same path at the task's `replay.fix` commit in webiny-js.

## Running it again

The layout expects a webiny-js clone at `repos/webiny-js`, prepared checkouts at `prepared/<id>` (about 3.5 GB each), the Copilot CLI at `../node_modules/.bin/copilot` and `claude` on the PATH. The test suites need the storage backends that Webiny's own tests use, including OpenSearch on `localhost:9200`.

```bash
node replay/prepare.mjs webiny-audit-logs          # once per task
node run.mjs --validate                            # tests fail before the fix, pass with it
node run.mjs --agent copilot --model claude-sonnet-5.5 --repeats 3 --out results/B
node run.mjs --agent copilot --config wiki --repeats 1 --out results/E
node run.mjs --recheck results/B                   # re-grade saved patches
node report.mjs results/B results/E
```

## Licence of the Webiny code here

`fix.patch` and `hidden/` are code from MIT-licensed packages of [webiny/webiny-js](https://github.com/webiny/webiny-js), Copyright (c) Webiny Inc. The full notice is in [`../patches/README.md`](../patches/README.md).
