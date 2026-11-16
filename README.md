# github-core-clone-01 — a GitHub-compatible git forge

[![make.fun bounty](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/edihartono180102-sys/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/edihartono180102-sys/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone git forge in one Node process, standard library only: git smart
HTTP (upload-pack v2 + v0, receive-pack), REST v3, GraphQL, and MCP over a
single in-memory store. No UI, no outside service, no git binary, no proxy.

Entry for the [github-core-clone-01 bounty on make.fun](https://make.fun/bounty/github-core-clone-01).

## Run

```sh
node main.ts
```

The server binds an ephemeral port, registers it at `$MAKEFUN_ENV_URL/register`,
and exits when `$MAKEFUN_ENV_URL/done` reports `{"done": true}`. The bearer
token for REST/GraphQL/MCP comes from `MAKEFUN_SHOP_TOKEN`; dates come from
`MAKEFUN_TRIAL_NOW`.

## Layout

- `main.ts` — lifecycle: bind, register, long-poll `/done`, exit.
- `app.ts` — HTTP routing to the four surfaces, JSON errors, no crashes.
- `git.ts` — smart HTTP: v2 advertisement/ls-refs/fetch, v0 fetch, receive-pack.
- `api.ts` — REST v3, the GraphQL executor, and the MCP (JSON-RPC) handlers.
- `store.ts` — the store: repos, git objects/refs, issues, pull requests,
  labels, comments, trees, diffs, and squash merges with conflict detection.
- `util.ts` — SHA-1 objects, pkt-lines, packfiles, the trial clock, and the
  deterministic viewer-login derivation.

## Determinism

No wall clock and no unseeded randomness in any request path: identifiers come
from counters, dates from `MAKEFUN_TRIAL_NOW`, object ids from content hashes.
Replay of the same request sequence leaves the same state.
