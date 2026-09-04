import type { BundleConfig } from "./scripts/package.ts";

/**
 * Declares how this plugin reaches the Codex CLI, and therefore what its release looks like.
 *
 * This is the only plugin-specific half of the release pipeline: `scripts/package.ts` and
 * `.github/workflows/release.yml` know nothing about Codex and are copied from the sibling
 * plugins unchanged, with only this file rewritten.
 *
 * `cli: "user_installed"` produces a single package every host can install, whose manifest
 * carries one `url`/`sha256` pair rather than a `[[targets]]` table. That is the right shape
 * here because this plugin drives `codex-acp`, an npm-published adapter the user installs
 * themselves (`npm i -g @agentclientprotocol/codex-acp`) and which `services/command.ts`
 * resolves off `PATH` at spawn time — there is no upstream release asset to bundle. Switching
 * to `cli: "bundled"` would be a one-file change here, but only makes sense once this package
 * ships an adapter of its own.
 */
export default {
  cli: "user_installed",
} satisfies BundleConfig;
