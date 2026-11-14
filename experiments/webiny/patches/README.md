# Agent patches

One file per session: the diff the agent left in the workspace, against the Webiny commit just before the real fix. Folder = row in the write-up, file = `<task>.<attempt>.patch`. Tests the agents wrote are included. The hidden tests are in [`../harness/tasks/`](../harness/README.md) and each session's grading output is in [`../grading/`](../grading/README.md).

Two of the 108 sessions are left out (`E-copilot-auto-wiki`: `sql-leak.1`, `model-cache.1`) because they changed files in Webiny packages that are not MIT-licensed. Their numbers are still in `sessions.csv`.

Rows G to N are the vague-ticket sessions. Six of those 154 are left out for the same reason (`I-copilot-auto-vague` and `M-claude-opus-vague`: `model-cache-vague.1` to `.3`). Their numbers are in `sessions-vague.csv`.

The patches, and the `fix.patch` and `hidden/` files under `../harness/tasks/`, contain Webiny source code. That code is from MIT-licensed packages of [webiny/webiny-js](https://github.com/webiny/webiny-js) and is covered by this notice:

```
Copyright (c) Webiny Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```
