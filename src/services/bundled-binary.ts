/** Package-relative location of the Codex ACP executable shipped in an `.orax`. */
export const BUNDLED_BIN_DIR = "assets/bin";

export type TargetOs = typeof Deno.build.os;

/** Windows requires the executable suffix; Unix binaries deliberately have none. */
function binaryName(os: TargetOs): string {
  return os === "windows" ? "codex-acp.exe" : "codex-acp";
}

function nativeBinaryName(os: TargetOs): string {
  return os === "windows" ? "codex.exe" : "codex";
}

/** Path shared by the packager and the runtime spawn handler. */
export function bundledAdapterPath(os: TargetOs = Deno.build.os): string {
  return `${BUNDLED_BIN_DIR}/${binaryName(os)}`;
}

/** Package-relative root of the native Codex SDK runtime used by the adapter. */
export function bundledCodexPath(os: TargetOs = Deno.build.os): string {
  return `${BUNDLED_BIN_DIR}/${nativeBinaryName(os)}`;
}
