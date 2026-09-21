import {
  type AgentInvocation,
  type HostChildProcess,
  type HostProcesses,
  spawnAgentProcess,
} from "@ora-space/plugin-sdk";
import { bundledAdapterPath } from "./bundled-binary.ts";
import { logger } from "./log.ts";

const log = logger("command");

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
export async function spawnCodex(
  processes: HostProcesses,
  invocation: AgentInvocation,
): Promise<HostChildProcess> {
  const packageCommand = bundledAdapterPath();
  log.info("spawning the bundled adapter", {
    context: { cwd: invocation.cwd, packageCommand },
  });
  try {
    const child = await spawnAgentProcess(
      processes,
      { packageCommand, command: "codex-acp" },
      invocation,
    );
    log.info("adapter spawned", {
      context: { cwd: invocation.cwd, pid: child.pid },
    });
    return child;
  } catch (error) {
    log.warn("failed to spawn the bundled adapter", {
      context: { cwd: invocation.cwd, packageCommand },
      error,
    });
    throw error;
  }
}
