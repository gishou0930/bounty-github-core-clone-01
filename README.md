# SmallForge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/gishou0930/bounty-github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/gishou0930/bounty-github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A single-process Git forge written for Node 22 with only the standard library. Git smart HTTP, REST, GraphQL and MCP share an in-memory object store, repositories, issues and pull requests.

## Run it

```sh
MAKEFUN_ENV_URL=http://127.0.0.1:8080 MAKEFUN_SHOP_TOKEN=your-token node main.ts
```

The forge binds an ephemeral port, registers with the competition environment and serves until that environment reports completion. It needs no package installation, external service or git executable. The source includes Git object and pack codecs, protocol v2 fetch with shallow history, fast-forward push validation and squash merging. API-created commits use a fixed timestamp for deterministic object ids.

The token authorizes one repository owner. Set `FORGE_LOGIN` to configure that login; when omitted, the first authenticated repository namespace establishes it for the lifetime of the process.

Source layout: `main.ts` manages the lifecycle, `app.ts` serves REST and MCP, `graphql.ts` parses and executes GraphQL, `git.ts` implements smart HTTP, and `store.ts` holds the shared data and git objects.

---

<sub>Entered on [make.fun](https://make.fun/?ref=97crja9n&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
