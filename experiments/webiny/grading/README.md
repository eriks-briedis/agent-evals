# Grading results

What the grader recorded for each of the 84 sessions. Folder = row in the write-up. How grading works: [`../harness/README.md`](../harness/README.md).

| File | What it is |
|---|---|
| `<row>/rows.jsonl` | One JSON object per session: verdict, the reason for a failed scope check, files changed, size, time, and usage counted from the agent's event log. |
| `<row>/<task>.<attempt>.check.txt` | Output of the package rebuild and the hidden test run for that session. |

Main fields in `rows.jsonl`:

| Field | Meaning |
|---|---|
| `pass` | `testsPass` and `inScope`. |
| `testsPass` | The hidden tests passed. |
| `inScope`, `checkFailures` | Size and file limits held; if not, which one failed. |
| `sizeRatio`, `refLines` | Source lines changed divided by lines in the real fix; lines in the real fix. |
| `files`, `sourceFilesChanged`, `testLines` | What the agent changed. |
| `approach` | How many of the real fix's files the agent changed, and how many others. |
| `wallSeconds`, `timedOut`, `exitCode` | How the agent process ended. |
| `events` | Model, tool calls, turns, cost or credits, and for the wiki rows the pages opened. |

[`../sessions.csv`](../sessions.csv) is a flat extract of these rows; every value in it matches.

Changes made for publication:

- **Paths:** the workspace prefix on the machine that ran the experiment is replaced with `<work>/`.
- **Hardware:** the build line naming the CPU and memory of that machine is removed from the `check.txt` files.
- **Subscription usage:** the two fields with the Claude subscription's usage level after each session are removed.
- **Event logs:** not included. They hold full file contents, including code from Webiny packages that are not MIT-licensed.

## Re-grading

The `check.txt` files and verdicts are from the final grading pass, which used the hidden tests as published in `../harness/tasks/`. Verdicts that differed in earlier passes:

- **Rows A and B, before the first re-grade:** 8 sessions were graded failed on tests and pass now. Row A: `flp-logging` attempts 1 to 3, `sql-leak` 1 and 2, `tenant-leak` 1 and 2. Row B: `flp-logging` 1. These are the three tasks whose hidden tests were edited. Rows C to F have no earlier grading on record.
- **Row A, `model-cache` attempt 2:** graded failed once because the test database port was busy, passed when re-graded from its saved patch.
