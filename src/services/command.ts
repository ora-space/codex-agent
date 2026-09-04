import {
  type AgentInvocation,
  type HostChildProcess,
  type HostProcesses,
  spawnAgentProcess,
} from "@ora-space/plugin-sdk";
import { bundledAdapterPath } from "./bundled-binary.ts";

/**
 * Starts the target-specific `codex-acp` executable carried by this plugin package.
 *
 * The host owns the OS process rather than this sandboxed runtime: it terminates process trees
 * and reclaims every child this plugin generation left behind, which a plugin spawning its own
 * `Deno.Command` cannot promise — least of all through a Windows `.cmd`/`.bat` shim, where the
 * handle a plugin holds is the shim and the real adapter underneath it can outlive a kill of the
 * wrapper.
 *
 * There is intentionally no PATH fallback: an installed package must run the exact adapter it was
 * built and tested with.
 */
export function spawnCodex(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  return spawnAgentProcess(
    processes,
    { packageCommand: bundledAdapterPath(), command: "codex-acp" },
    invocation,
  );
}
