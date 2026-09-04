/** Records the exact adapter, Codex CLI, and platform packages used by a release. */
import { parseArgs } from "@std/cli/parse-args";
import bundle from "../bundle.config.ts";
import {
  LOCK_PATH,
  readLock,
  resolveUpstream,
  type UpstreamLock,
  writeLock,
} from "./upstream.ts";

const BEHIND = 20;

async function currentLock(): Promise<UpstreamLock | undefined> {
  try {
    return await readLock();
  } catch (error) {
    if (error instanceof Deno.errors.NotFound) return undefined;
    throw error;
  }
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["version"],
    boolean: ["check"],
  });
  const runtimes = Object.values(bundle.targets).map((target) =>
    target.runtime
  );
  const before = await currentLock();
  const resolved = await resolveUpstream(
    bundle.adapter,
    flags.version ?? "latest",
    runtimes,
  );
  const unchanged = before !== undefined &&
    JSON.stringify(before) === JSON.stringify(resolved);
  const summary = `${resolved.adapter.name}@${resolved.adapter.version} ` +
    `(${resolved.codex.name}@${resolved.codex.version})`;

  if (unchanged) {
    console.log(`${LOCK_PATH} is current: ${summary}`);
    return;
  }
  if (flags.check) {
    console.log(`${LOCK_PATH} is behind: ${summary}`);
    if (before !== undefined) {
      console.log(`  currently pinned: ${before.adapter.version}`);
    }
    Deno.exit(BEHIND);
  }
  await writeLock(resolved);
  console.log(`${LOCK_PATH} now pins ${summary}`);
  for (const [runtime, entry] of Object.entries(resolved.platforms)) {
    console.log(`  ${runtime}: ${entry.version} ${entry.integrity}`);
  }
}

if (import.meta.main) await main();
