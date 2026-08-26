import type { AgentModel } from "@ora-space/plugin-sdk";

/**
 * Serves `agent/listModels` with an empty list, because Codex has no pre-session model list.
 *
 * `codex-acp` is a pure ACP server: it exposes no `models` subcommand, and its `initialize` result
 * carries capabilities only. Codex's model (and reasoning-effort) options appear exactly once, as
 * `category: "model"` / `category: "reasoning-effort"` entries of the `configOptions` array in a
 * `session/new` result — which this plugin already forwards to Ora untouched through `agent/acp`.
 *
 * Three alternatives were rejected:
 *
 * - Running an ACP probe here. `agent/listModels` is called between `agent/start` and the host's
 *   own `initialize`, so a probe would have to `initialize` the adapter a second time, which ACP
 *   does not allow, and would need a throwaway session just to read the option list back.
 * - Hardcoding model ids. They are the adapter's data, not this plugin's, so a copy would go stale
 *   silently the first time OpenAI ships a model — and it would disagree with the live list the
 *   session picker renders from ACP.
 * - Caching the list observed on a passing `session/new` result. Ora snapshots this answer once,
 *   when the connection comes up, and never asks again, so nothing learned later could reach it.
 *
 * An empty answer is a normal one: the host treats "this agent advertises no pre-session models"
 * as ordinary, and it is exactly what a built-in CLI reports.
 */
export function listCodexModels(): AgentModel[] {
  return [];
}
