# Codex for Ora

This plugin adds **Codex** — OpenAI's coding agent — as a selectable agent
inside [Ora](https://ora.dev). Once installed, you pick "Codex" from Ora's agent
picker the same way you'd pick any other agent, and every session runs against
your own Codex CLI with your own OpenAI account.

## Requirements

- The plugin package includes a target-specific standalone build of the
  [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp). No
  global `codex-acp` installation is required.
- **A working Codex CLI**, signed in with either a ChatGPT subscription or an
  API key. The adapter bundles a compatible `codex` binary, so a separate
  install is only needed if you want to pin a specific version.

## Installing the plugin

Grab the latest `.orax` package from this repository's
[Releases](../../releases) page and install it the way you install any Ora agent
plugin — drop it into Ora's plugins folder, or use Ora's plugin install flow if
one is available in your build. Once installed, "Codex" shows up in the agent
picker; removing the plugin removes the agent.

## Signing in

Codex authenticates the same way the `codex` CLI does. The adapter looks for, in
order:

1. A ChatGPT login (the adapter can prompt a browser sign-in the first time you
   start a Codex session in Ora — set `NO_BROWSER=1` in your environment if
   you're running somewhere headless).
2. An API key, via the `CODEX_API_KEY` or `OPENAI_API_KEY` environment variable.

If Codex was already signed in from the terminal, sessions started through Ora
reuse that same login.

## Using Codex in a session

Model, reasoning effort, and approval/sandbox mode are all configured from
_inside_ a Codex session (Ora surfaces them as session options), rather than
from a separate picker — Codex exposes its live model list this way instead of a
fixed one, so you always see exactly what your account can access.

The plugin's pre-session `agent/listModels` response is discovered from a
short-lived ACP probe. It starts the adapter in the requested workspace,
performs `initialize` and `session/new`, and extracts the `category: "model"`
selector that `codex-acp` returns in `configOptions`. The live session receives
the same options, so the pre-session picker and in-session picker use one source
of truth. If the adapter is unavailable or authentication prevents discovery,
the request fails with that diagnostic rather than pretending that no models
exist.

Slash commands you'd use in the Codex CLI directly — `/review`,
`/review-branch`, `/compact`, `/status`, `/mcp`, `/skills`, and so on — work the
same way inside an Ora session.

## Project skills

Codex looks for reusable [Skills](https://agentclientprotocol.com) in a
`.agents/skills/<name>/SKILL.md` folder at the root of your project, alongside
any skills installed globally on your machine. Add or edit files there and Ora
takes care of getting Codex to pick them up — no manual restart needed.

## Troubleshooting

- **Ora stays on "Loading…"** — reinstall the plugin package so Ora extracts the
  binary for the current target. A package built for another target is rejected
  by the manifest's `[artifact]` declaration.
- **`agent/listModels` fails or returns `[]`** — model discovery asks the
  adapter for the same `session/new` configuration options used by a live
  session. Check that the adapter starts in the requested workspace and that
  Codex is authenticated; an adapter that genuinely exposes no model selector
  returns an empty list.
- **Codex keeps asking you to sign in** — check that `codex` itself is
  authenticated (`codex login` from a terminal), or set `CODEX_API_KEY` /
  `OPENAI_API_KEY`.
- **A bundled binary fails to start** — check the plugin/runtime log for the
  target triple and the adapter startup error, then reinstall the plugin to
  replace an incomplete extraction.
- **Useful log messages** — search Ora's plugin/runtime log for:
  `agent startup failed`, `agent_initialize_timeout`,
  `agent runtime is unavailable`, or `the bundled agent cannot run` or
  `agent startup failed`.
- **A session seems stuck** — stopping and restarting the Codex agent from Ora
  relaunches the adapter cleanly.

## Building from source

```
deno task build
deno task package --tag v0.3.0 --repo ora-space/codex-agent
```

This writes `dist/packages/ora-space.codex-<tag>.orax` and `dist/manifest.toml`
— the release form of the manifest, which is `orax.toml` plus the download `url`
and its `sha256`. That file is what the marketplace index needs, and it is
copied into the marketplace as-is; it can only be written once the package
exists, so it is generated at package time rather than committed. The release
workflow uploads both to the GitHub release.

`bundle.config.ts` declares the target-specific release shape:

| `cli`       | Produces                               | Manifest carries             | At runtime                                 |
| ----------- | -------------------------------------- | ---------------------------- | ------------------------------------------ |
| `"bundled"` | one `.orax` per declared target triple | one `[[targets]]` per triple | runs an adapter shipped inside the package |

This plugin ships `"bundled"`: the packaging script installs the pinned
`@agentclientprotocol/codex-acp` npm package and compiles its official
entrypoint for each supported target. `upstream.lock.json` pins that adapter,
the compatible `@openai/codex` version, and every native platform tarball with
its npm integrity hash. Ora's marketplace release carries per-target artifacts,
so the installed package always contains both `codex-acp` and the native Codex
CLI selected for its host.

`deno task sync --check` compares the committed lock with the latest resolved
upstream chain. The nightly `.github/workflows/upstream.yml` updates the lock,
bumps this plugin's patch version, pushes a tag, and calls the same reusable
release workflow used by maintainer tags.

`deno task check` type checks, `deno task lint` lints, and `deno task test` runs
the unit tests; `deno task simulate` drives the plugin the way Ora's host does
and compiles the adapter into the package.

## License

Apache-2.0
