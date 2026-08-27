# Codex for Ora

This plugin adds **Codex** — OpenAI's coding agent — as a selectable agent
inside [Ora](https://ora.dev). Once installed, you pick "Codex" from Ora's agent
picker the same way you'd pick any other agent, and every session runs against
your own Codex CLI with your own OpenAI account.

## Requirements

- **The [Codex ACP adapter](https://github.com/agentclientprotocol/codex-acp)**,
  published as
  [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp),
  which this plugin drives on your behalf:
  ```
  npm i -g @agentclientprotocol/codex-acp
  ```
- Verify that the adapter command is available in the same environment that
  launches Ora:
  ```
  codex-acp --version
  ```
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

The plugin's pre-session `agent/listModels` response is intentionally empty. The
actual model list is returned by ACP `session/new` in `configOptions`, after Ora
has initialized the adapter and warmed a session. An empty `agent/listModels`
response therefore does not mean that Codex has no models.

Slash commands you'd use in the Codex CLI directly — `/review`,
`/review-branch`, `/compact`, `/status`, `/mcp`, `/skills`, and so on — work the
same way inside an Ora session.

## Project skills

Codex looks for reusable [Skills](https://agentclientprotocol.com) in a
`.codex/skills/<name>/SKILL.md` folder at the root of your project, alongside
any skills installed globally on your machine. Add or edit files there and Ora
takes care of getting Codex to pick them up — no manual restart needed.

## Troubleshooting

- **Ora stays on "Loading…"** — first verify that `codex-acp --version` works
  from the environment used to launch Ora. The plugin resolves `codex-acp.cmd`
  on Windows and `codex-acp` elsewhere. If the npm package is installed but the
  command is missing, reinstall it so npm recreates its executable shim:
  ```
  npm uninstall -g @agentclientprotocol/codex-acp
  npm install -g @agentclientprotocol/codex-acp
  codex-acp --version
  ```
  Then restart Ora, or disable and re-enable the Codex plugin, so its runtime
  supervisor retries the adapter with the updated `PATH`.
- **"Codex's ACP adapter is not installed or not on PATH"** — install the
  official
  [`@agentclientprotocol/codex-acp`](https://www.npmjs.com/package/@agentclientprotocol/codex-acp)
  package with `npm i -g @agentclientprotocol/codex-acp`. If you keep it
  somewhere non-standard, set `ORA_CODEX_ACP_BIN` to the full path of an
  executable adapter command and restart Ora. On Windows, prefer the generated
  `codex-acp.cmd` shim rather than pointing directly at the JavaScript file.
- **`agent/listModels` returns `[]`** — this is expected for Codex. Models are
  supplied by ACP `session/new` as session configuration options, not by the
  plugin's pre-session model endpoint. Check the session picker after the ACP
  handshake completes.
- **Codex keeps asking you to sign in** — check that `codex` itself is
  authenticated (`codex login` from a terminal), or set `CODEX_API_KEY` /
  `OPENAI_API_KEY`.
- **The command works in a terminal but not in Ora** — Ora must inherit the
  directory containing `codex-acp.cmd` / `codex-acp` in its `PATH`. Launch Ora
  from an environment with the correct `PATH`, or configure `ORA_CODEX_ACP_BIN`
  before starting Ora. An already-running Ora process does not automatically
  inherit changes made to the shell environment.
- **Useful log messages** — search Ora's plugin/runtime log for:
  `agent startup failed`, `agent_initialize_timeout`,
  `agent runtime is unavailable`, or
  `Codex's ACP adapter is not installed or not on PATH`.
- **A session seems stuck** — stopping and restarting the Codex agent from Ora
  relaunches the adapter cleanly.

## License

Apache-2.0
