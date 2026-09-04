# ora-space.codex

An Ora **agent plugin**: a Deno process that speaks Ora's binary JSON-RPC
protocol on stdio and bridges `codex-acp` to Ora as an ACP pipe. `README.md`
describes what it does; this file records the constraints that are easy to get
wrong and expensive to rediscover. It follows the same shape as the sibling
`codeagent-agent/AGENTS.md` and `opencode-agent/AGENTS.md` — this package used
to lag them on an older SDK pin (`0.3.0`, no `HostProcesses`,
`waitForIdle`/`restart` Effect Surfaces, camelCase `agent/listModels`) until it
was migrated onto `0.9.0` to match; see the root `../AGENTS.md` for the general
rule this migration exists to satisfy.

## This is an agent plugin, and an agent plugin implements the whole SDK contract

**`kind = "agent"` in `orax.toml` is not a label — it is a contract, and a
partial implementation of it fails silently rather than loudly.** Ora validates
the registration handshake and then simply does not use what a plugin did not
declare. There is no warning, no log line, and no error surfaced to the user.

Every API the plugin SDK offers an agent must be served, not just the ones a
feature currently exercises:

| SDK surface                                                                                                                             | Where it is mounted                                     | What is lost by omitting it                                                  |
| --------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- | ---------------------------------------------------------------------------- |
| `agent/start` · `agent/stop`                                                                                                            | `handlers/lifecycle.ts`                                 | the agent cannot run at all — these are `abstract`, so this fails to compile |
| `agent/list_models`                                                                                                                     | `handlers/models.ts`                                    | no model picker; also `abstract`                                             |
| `agent/acp` (both directions)                                                                                                           | `handlers/acp.ts` + `services/codex-client.ts`          | no conversation; also `abstract`                                             |
| **Effect Resources** — `effect/coordinate`, `effect/reactivate`, `effect/verify_ready`, and the `EffectResourceDeclaration` behind them | `handlers/effects.ts`, mounted as `AgentPlugin.effects` | **Skills never appear in the Workspace, with no error anywhere**             |

The Effect row is the one that has actually shipped broken before, in the
sibling `codeagent-agent`. Read the next section before touching anything about
Skills.

## Effects are opt-in, and opting out is invisible

The Skill directory Ora writes into a Workspace exists **only** because this
plugin declares it. The chain is short and every link is a hard gate:

```
handlers/effects.ts  SKILLS_RESOURCE                    ← the declaration
main.ts              override readonly effects = …      ← mounted on the instance
base/agent-plugin.ts defineAgent({ …, effects })        ← handed to the SDK
SDK agent.ts         if (effects !== undefined) { declareEffectResource(…) }
SDK plugin.ts        effectResources omitted from ora/register when the list is empty
```

Miss **any** of those and `ora/register` goes out with no `effectResources`
field at all. From Ora's side this plugin does not consume Skills, so importing
one succeeds, Ora has no Target to project it onto, nothing is written to disk,
and no error is raised, logged, or shown anywhere.

**When a Skill does not appear, check the declaration before debugging
materialization.** The shipped bundle answers it in one command:

```
deno task build && grep -c skill dist/main.js
```

A `0` means the declaration never reached the package.

### What the coordination calls have to promise

Declaring a Resource is also a promise to make its mutation safe, and Ora will
call all three methods:

- **`coordinate`** must raise the new-turn barrier _before_ it waits for running
  turns, not after. A check that only latched on an observed idle moment would
  never find one in a Workspace whose prompts keep arriving; holding first makes
  the set of turns to drain finite, so the wait terminates. It must also release
  the barrier before failing — Ora only reactivates Targets whose coordination
  succeeded, so an abandoned barrier holds its queued prompts for the life of
  the process. The 10-second drain budget exists because Ora allows a plugin
  control call 30 seconds and coordination holds that call open; it must finish
  well inside that rather than wait out a prompt that may legitimately run for
  minutes.
- **`reactivate`** respawns the adapter. Codex resolves skills by precedence —
  every `.agents/skills` directory from the working directory up to the
  repository root, the user's `~/.agents/skills`, then a system directory
  (`/etc/codex/skills`) — and restarting is deliberately chosen over modelling
  exactly when in that chain a rescan happens: a restart is correct regardless.
- **`verify_ready`** reports readiness by **returning**; a Consumer says "not
  ready" by throwing. Returning a payload that says "not ready" would be
  recorded as ready.
- **Both coordination calls must be idempotent.** Ora retries them. The held
  frame queue is the marker: a repeat `reactivate` finds nothing held — the
  state a finished reactivation leaves behind — and must not restart an adapter
  that already rescanned, which would tear down the sessions that came back from
  the first restart.

`SKILLS_RESOURCE.workspaceRelativePath` is `.agents/skills` — the
repository-root directory in Codex's own precedence chain. Ora only manages that
surface: the user- and system-level directories are Preserved State from this
plugin's point of view, and declaring either would be a mistake — Ora fully owns
what it materializes into a declared Resource, so it would reconcile away Skills
another tool put there.

## Bundled adapter binary

The plugin follows the Claude plugin's side-by-side layout. Each target package
contains the official `@agentclientprotocol/codex-acp` entrypoint at
`assets/bin/codex-acp` (or `codex-acp.exe` on Windows) and the native Codex CLI
at `assets/bin/codex` (or `codex.exe` on Windows). The adapter sets `CODEX_PATH`
to that neighboring native executable. The helper directories `codex-path/` and
`codex-resources/` remain under the same `bin` directory.

The paths are defined once in `src/services/bundled-binary.ts`; the packager and
`services/command.ts` use those definitions rather than deriving paths
independently. The package is target-specific and declares `[artifact]`, so Ora
rejects a package built for a different platform.

## Process ownership

Every subprocess goes through the host: `createHostProcesses(plugin)` →
`ora/childprocess/spawn`. Never `Deno.Command`. The host owns the OS handle,
terminates process trees, and reclaims whatever a plugin generation left behind
— none of which a sandboxed plugin can promise, least of all through a Windows
shim whose real child outlives a kill of the wrapper.

`CodexClient` tracks generations: a process that is no longer `#running` was
superseded by a later `start()` — an Effect restart, typically — so its exit
must never clear the new process's tracking or fire `onExited`. The shared
`#expectedExit` flag reflects the newer generation's intent by then, which is
why the identity check comes first.

## Model discovery

`codex-acp` is a pure ACP server: it takes no subcommand, and its `initialize`
result carries capabilities only. Codex's model **and** reasoning-effort options
both appear in the same place: the `configOptions` array of a `session/new`
result, as `category: "model"` and `category: "reasoning-effort"` entries
respectively. Discovery picks out the `model` category specifically —
reasoning-effort is a session-level choice with nothing to show before a session
exists, and must never leak into the pre-session picker.

`agent/list_models` receives the workspace `cwd` and answers it by running a
**separate, one-shot** `codex-acp`, not by borrowing the connection Ora holds:

- A request injected into Ora's connection returns its answer down Ora's pipe.
- Ora's own `initialize` declares the client capability that decides whether the
  adapter reports a model selector at all, and discovery runs before that.

The probe declares `clientCapabilities: { session: { configOptions: {} } }` —
without it the adapter reports no model selector. Answers are cached per
workspace for five minutes; a failure is never cached.

`session/delete` is sent only when `initialize` advertised the capability —
sending it unconditionally would earn a `method_not_found` on every discovery
and clean up nothing.

Note that `onStart` and `onStop` both invalidate the catalog for their `cwd`, so
a start/stop cycle around a picker opening makes the next open pay full price.

## Protocol hygiene

- **stdout is the binary protocol channel.** `protectProtocolStdout()` redirects
  every `console` method to stderr before any plugin code runs. A single
  `console.log` reaching stdout is read by the host as a corrupt frame and takes
  the plugin down.
- **ACP payloads are never parsed** on the bridge. Frames are re-framed between
  Ora's binary envelope and the adapter's NDJSON and otherwise passed through
  verbatim. `handlers/effects.ts` is the one exception, and a deliberately
  narrow one: it reads `method` and `id` off the envelope to track turns, and
  never looks at `params`.
- **Throw the right error code.** `AGENT_NOT_INSTALLED` (`-32001`) is retried
  quietly by Ora as expected local configuration; `AGENT_UNUSABLE` (`-32002`) is
  reported once and not retried; `-32000` is how an Effect Consumer says "not
  ready right now".

## Manifest

`orax.toml` is the manifest Ora reads. `package.json` is a legacy Ora manifest
that no release has ever read, and its `engines.ora` field held a plugin **SDK**
version in a **host** version field — do not fill it with an SDK number. If a
host requirement ever needs declaring, it goes in `orax.toml`:

```toml
[dependencies]
ora = ">= x.y.z"
```

Ora parses and validates that table today but does not yet enforce it.

## Working on this repository

- `deno task check` / `lint` / `format` / `test` / `simulate` / `build` /
  `package`.
- The SDK is imported from its published JSR package and pinned in `deno.json`;
  keep `deno.lock` synchronized when changing the SDK version — see the root
  `../AGENTS.md` before bumping it, since the Effect API and process-ownership
  API have changed shape across versions before.
- `deno task test` needs no CLI: discovery is exercised against a fake
  `HostProcesses` that scripts an ACP peer, and effect coordination against a
  `CodexClient` with a scripted `spawn`. `deno task simulate` needs a built
  package binary, or a locally provided adapter for the simulator.
- One test reads `src/main.ts` as text to assert the effect wiring is present.
  That is deliberate: the entrypoint calls `runAgentPlugin` at module scope, so
  importing it would start serving the host, and the wiring it guards is exactly
  the kind whose absence is invisible at runtime.
- Bump `orax.toml` `version` before handing someone a `.orax` to import.
  `install_local` refuses a version that is already installed and never retires
  older ones, so reusing a number silently leaves the old code running.

## Releasing

`deno task package --tag <tag> --repo <owner/name>` writes
`dist/packages/*.orax` **and `dist/manifest.toml`**, the release form of the
manifest — `orax.toml` plus the download `url` and `sha256` — which is what gets
copied into the marketplace index. Both are uploaded by
`.github/workflows/release.yml`. Publishing only the `.orax` leaves the
marketplace with nothing to point at.

`bundle.config.ts` declares `cli: "bundled"` and the target-specific Bun and
native-runtime targets. `upstream.lock.json` pins the exact adapter, compatible
Codex package, and each platform tarball. `scripts/package.ts` compiles that
adapter, verifies the target tarball's npm integrity, and emits one `.orax` plus
one `[[targets]]` record per target.

`deno task sync --check` exits 20 when the committed lock is behind. The nightly
`upstream.yml` treats only that code as an update, commits the refreshed lock
with synchronized `orax.toml`, `deno.json`, and `package.json` patch versions,
tags it, then calls the reusable `release.yml`. Packaging must never resolve
`latest` itself; rebuilding an existing tag must use only its committed lock.

Bump `orax.toml` `version` before tagging: `install_local` refuses a version
that is already installed and never retires older ones, so reusing a number
silently leaves the old code running.
