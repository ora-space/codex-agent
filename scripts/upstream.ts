/**
 * Resolves and verifies the complete upstream chain bundled by this plugin.
 *
 * The adapter chooses a Codex npm range, and the Codex package chooses one native package per
 * platform. The resolved exact versions and npm integrity hashes are committed to
 * `upstream.lock.json`; packaging reads only that lock and never asks what "latest" means.
 */
import { crypto } from "@std/crypto";
import { encodeBase64 } from "@std/encoding";
import { dirname } from "@std/path";
import { UntarStream } from "@std/tar";

export const CODEX_PACKAGE = "@openai/codex";
export const LOCK_PATH = "upstream.lock.json";

export interface PinnedPackage {
  name: string;
  version: string;
  integrity: string;
  tarball: string;
}

export interface PinnedPlatform extends PinnedPackage {
  runtime: string;
}

export interface UpstreamLock {
  adapter: PinnedPackage;
  codex: PinnedPackage & { requirement: string };
  platforms: Record<string, PinnedPlatform>;
}

interface VersionMeta {
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  dist: { tarball: string; integrity: string };
}

export async function readLock(path = LOCK_PATH): Promise<UpstreamLock> {
  return JSON.parse(await Deno.readTextFile(path)) as UpstreamLock;
}

export async function writeLock(
  lock: UpstreamLock,
  path = LOCK_PATH,
): Promise<void> {
  await Deno.writeTextFile(path, `${JSON.stringify(lock, null, 2)}\n`);
}

export async function resolveUpstream(
  adapterName: string,
  requestedVersion: string,
  runtimes: readonly string[],
): Promise<UpstreamLock> {
  const adapterMeta = await fetchPackageVersion(adapterName, requestedVersion);
  const requirement = adapterMeta.dependencies?.[CODEX_PACKAGE];
  if (requirement === undefined) {
    throw new Error(`${adapterName} does not depend on ${CODEX_PACKAGE}`);
  }

  const codexMeta = await fetchPackageRange(CODEX_PACKAGE, requirement);

  const platforms: Record<string, PinnedPlatform> = {};
  for (const runtime of runtimes) {
    const alias = `${CODEX_PACKAGE}-${runtime}`;
    const specification = codexMeta.optionalDependencies?.[alias];
    if (specification === undefined) {
      throw new Error(
        `${CODEX_PACKAGE}@${codexMeta.version} ships no ${runtime} runtime`,
      );
    }
    const match = specification.match(/^npm:(@[^/]+\/[^@]+)@(.+)$/);
    if (match === null) {
      throw new Error(
        `${alias} has unsupported specification ${specification}`,
      );
    }
    const platformMeta = await fetchPackageVersion(match[1], match[2]);
    platforms[runtime] = {
      ...pin(platformMeta),
      runtime,
    };
  }

  return {
    adapter: pin(adapterMeta),
    codex: { ...pin(codexMeta), requirement },
    platforms,
  };
}

function pin(meta: VersionMeta): PinnedPackage {
  return {
    name: meta.name,
    version: meta.version,
    integrity: meta.dist.integrity,
    tarball: meta.dist.tarball,
  };
}

export async function fetchPackageVersion(
  name: string,
  version: string,
): Promise<VersionMeta> {
  const url = `https://registry.npmjs.org/${name}/${version}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  return await response.json() as VersionMeta;
}

/** Resolves the newest ordinary three-part version satisfying the adapter's declared range. */
async function fetchPackageRange(
  name: string,
  range: string,
): Promise<VersionMeta> {
  const url = `https://registry.npmjs.org/${name}`;
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url} answered ${response.status}`);
  const packument = await response.json() as {
    versions: Record<string, VersionMeta>;
  };
  const version = Object.keys(packument.versions)
    .filter((candidate) => satisfiesSimpleRange(candidate, range))
    .sort(compareVersions)
    .at(-1);
  if (version === undefined) {
    throw new Error(`${name} has no version satisfying ${range}`);
  }
  return packument.versions[version];
}

function compareVersions(left: string, right: string): number {
  const a = left.split(".").map(Number);
  const b = right.split(".").map(Number);
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2];
}

/** Supports the exact, caret and tilde ranges used by codex-acp, and refuses unknown syntax. */
function satisfiesSimpleRange(version: string, range: string): boolean {
  const expected = range.match(/^(\^|~)?(\d+)\.(\d+)\.(\d+)$/);
  const actual = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (expected === null) {
    throw new Error(
      `unsupported Codex semver comparison: ${version} against ${range}`,
    );
  }
  if (actual === null) return false;
  const operator = expected[1] ?? "";
  const wanted = expected.slice(2).map(Number);
  const found = actual.slice(1).map(Number);
  const atLeast = found[0] > wanted[0] ||
    (found[0] === wanted[0] && found[1] > wanted[1]) ||
    (found[0] === wanted[0] && found[1] === wanted[1] && found[2] >= wanted[2]);
  if (!atLeast) return false;
  if (operator === "") {
    return found.every((part, index) => part === wanted[index]);
  }
  if (operator === "~") return found[0] === wanted[0] && found[1] === wanted[1];
  if (wanted[0] > 0) return found[0] === wanted[0];
  if (wanted[1] > 0) return found[0] === 0 && found[1] === wanted[1];
  return found[0] === 0 && found[1] === 0 && found[2] === wanted[2];
}

export async function downloadVerified(
  url: string,
  integrity: string,
  destination: string,
): Promise<void> {
  const separator = integrity.indexOf("-");
  const algorithm = integrity.slice(0, separator);
  const expected = integrity.slice(separator + 1);
  if (algorithm !== "sha512" && algorithm !== "sha256") {
    throw new Error(`unsupported integrity algorithm in ${integrity}`);
  }
  const response = await fetch(url);
  if (!response.ok || response.body === null) {
    throw new Error(`${url} answered ${response.status}`);
  }
  await Deno.mkdir(dirname(destination), { recursive: true });
  const file = await Deno.create(destination);
  const [toDisk, toDigest] = response.body.tee();
  const written = toDisk.pipeTo(file.writable);
  const digest = await crypto.subtle.digest(
    algorithm === "sha512" ? "SHA-512" : "SHA-256",
    toDigest,
  );
  await written;
  const actual = encodeBase64(new Uint8Array(digest));
  if (actual !== expected) {
    await Deno.remove(destination).catch(() => {});
    throw new Error(`${url} does not match its published integrity`);
  }
}

/** Extracts every file below one tar prefix, preserving its relative path. */
export async function extractTarPrefix(
  archive: string,
  prefix: string,
  destination: string,
): Promise<void> {
  const stream = (await Deno.open(archive)).readable
    .pipeThrough(new DecompressionStream("gzip"))
    .pipeThrough(new UntarStream());
  let extracted = 0;
  for await (const item of stream) {
    if (!item.path.startsWith(prefix)) {
      await item.readable?.cancel();
      continue;
    }
    const relative = item.path.slice(prefix.length);
    if (relative.length === 0) {
      await item.readable?.cancel();
      continue;
    }
    const path = `${destination}/${relative}`;
    if (item.readable === undefined) {
      await Deno.mkdir(path, { recursive: true });
      continue;
    }
    await Deno.mkdir(dirname(path), { recursive: true });
    await item.readable.pipeTo((await Deno.create(path)).writable);
    extracted++;
  }
  if (extracted === 0) {
    throw new Error(`${archive} contains nothing below ${prefix}`);
  }
}
