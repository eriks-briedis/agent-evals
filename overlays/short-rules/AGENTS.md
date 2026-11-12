# Working in this repository

- Read the code that already handles the thing you are changing before you write anything. Reuse what exists.
- Make the smallest change that fixes the reported problem. Fix it at the one place that causes it, not at every caller.
- Do not add abstractions, options, retries or deduplication that the task did not ask for.
- When debugging, find the cause before changing code. If an approach has failed twice, step back and re-read the problem.
- Run the existing tests for the area you changed before you finish.
