import type { BundleConfig } from "./scripts/package.ts";
import { bundledAdapterPath } from "./src/services/bundled-binary.ts";

/**
 * Declares how this plugin reaches the Codex CLI, and therefore what its release looks like.
 *
 * The adapter is compiled from its pinned npm package, while each `runtime` selects the native
 * Codex package recorded in `upstream.lock.json` for that target.
 */
export default {
  cli: "bundled",
  adapter: "@agentclientprotocol/codex-acp",
  targets: {
    "x86_64-pc-windows-msvc": {
      os: "windows",
      bun: "bun-windows-x64",
      runtime: "win32-x64",
    },
    "aarch64-apple-darwin": {
      os: "darwin",
      bun: "bun-darwin-arm64",
      runtime: "darwin-arm64",
    },
    "x86_64-unknown-linux-gnu": {
      os: "linux",
      bun: "bun-linux-x64-baseline",
      runtime: "linux-x64",
    },
  },
  binaryPath: bundledAdapterPath,
} satisfies BundleConfig;
