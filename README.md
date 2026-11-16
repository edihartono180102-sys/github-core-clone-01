# github-core-clone-01

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/edihartono180102-sys/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/edihartono180102-sys/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone GitHub-compatible git forge in a single Node process: git smart HTTP (upload-pack protocol v2 with a v0 fallback, receive-pack v0), REST v3, GraphQL v4 and MCP — all served from one in-memory store, with no git binary and no outside service. It speaks the wire the real `git` client speaks (including shallow clones, deepen, and two-round fetch negotiation) and the API shapes `gh` expects.

## Run it

```sh
node main.ts
```

The trial environment provides `MAKEFUN_SHOP_TOKEN` and `MAKEFUN_ENV_URL`: the forge binds a port of its own, registers it, answers `/healthz`, and waits for the environment to say the trial is done. With neither variable set it just listens until killed (local development).

---

<sub>Entered on [make.fun](https://make.fun/?ref={referral_code}&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
