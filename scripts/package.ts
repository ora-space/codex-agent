/**
 * Builds one `.orax` per target for an agent plugin that bundles an upstream CLI.
 *
 * `upstream.lock.json` is the only source of versions. Packaging verifies the native runtime
 * tarball against the integrity recorded there, so rebuilding a tag cannot silently pick up a
 * newer Codex CLI.
 *
 * Usage:
 *   deno task package --tag local --repo local --target x86_64-pc-windows-msvc
 *
 * Produces `dist/packages/<identifier>-<tag>-<triple>.orax` plus `dist/manifest.toml`, the release
 * form of the manifest the marketplace index needs. Archives are read and written in-process so
 * a maintainer can run this anywhere CI can.
 */
import { parseArgs } from "@std/cli/parse-args";
import { basename, dirname, join, relative } from "@std/path";
import { BlobReader, ZipWriter } from "@zip-js/zip-js";
import bundle from "../bundle.config.ts";
import {
  BUNDLED_BIN_DIR,
  bundledCodexPath,
} from "../src/services/bundled-binary.ts";
import {
  downloadVerified,
  extractTarPrefix,
  type PinnedPlatform,
  readLock,
  type UpstreamLock,
} from "./upstream.ts";

/** Operating systems a package can be built for, as `Deno.build.os` spells them. */
export type TargetOs = typeof Deno.build.os;

/**
 * How this plugin reaches the CLI it drives. Each release carries one package per declared target
 * triple, and each package refuses to install on a machine it was not built for.
 */
export type BundleConfig = {
  cli: "bundled";
  /** npm package publishing the ACP adapter. */
  adapter: string;
  /** Bun target used to compile each canonical Rust target triple. */
  targets: Record<string, { os: TargetOs; bun: string; runtime: string }>;
  /**
   * Package-relative path this target's binary is staged at, which the plugin later asks the
   * host to spawn.
   *
   * Supplied by the plugin rather than fixed here so the staging path and the path the running
   * plugin names stay one decision: a mismatch between them would only ever surface as an
   * install that cannot start its agent.
   */
  binaryPath: (os: TargetOs) => string;
};

/**
 * This plugin's own declaration, widened to the union this script handles.
 *
 * `bundle.config.ts` states one concrete shape, which narrows its type to that arm alone and would
 * make the other arm look like dead code here. The script must compile against both, since which
 * arm a plugin picks is exactly what it is generic over.
 */
const config: BundleConfig = bundle;

/** One target's resolved packaging inputs. */
interface TargetPlan {
  triple: string;
  os: TargetOs;
  bun: string;
  runtime: string;
  codex: PinnedPlatform;
  /** Package-relative path the binary is staged at, and the plugin later asks the host to spawn. */
  binaryPath: string;
}

const DIST = "dist";
const PACKAGES_DIR = join(DIST, "packages");
const DOWNLOAD_DIR = join(DIST, "download");
const STAGE_DIR = join(DIST, "stage");
const ADAPTER_DIR = join(DIST, "adapter");

/** Runs one command, failing loudly rather than letting a broken package be published. */
async function run(command: string, ...args: string[]): Promise<string> {
  const candidates = Deno.build.os === "windows"
    ? [`${command}.exe`, `${command}.cmd`, `${command}.bat`, command]
    : [command];
  for (const [index, candidate] of candidates.entries()) {
    let output: Deno.CommandOutput;
    try {
      output = await new Deno.Command(candidate, {
        args,
        stdout: "piped",
        stderr: "piped",
      }).output();
    } catch (error) {
      if (
        error instanceof Deno.errors.NotFound && index < candidates.length - 1
      ) continue;
      throw error;
    }
    if (!output.success) {
      throw new Error(
        `${candidate} ${args.join(" ")} failed with ${output.code}: ${
          new TextDecoder().decode(output.stderr)
        }`,
      );
    }
    return new TextDecoder().decode(output.stdout).trim();
  }
  throw new Error(`${command} is not installed`);
}

/**
 * Derives the operating system a canonical Rust target triple runs on.
 *
 * Only the OS is needed, and only to name the binary: the architecture never changes the package
 * layout, because one package serves exactly one triple.
 */
/** Reads one required field out of the installed manifest this repository ships. */
async function manifestField(field: string): Promise<string> {
  const source = await Deno.readTextFile("orax.toml");
  const match = source.match(new RegExp(`^${field}\\s*=\\s*"(.*)"`, "m"));
  if (match === null) {
    throw new Error(`orax.toml declares no ${field}`);
  }
  return match[1];
}

/**
 * Reads the one file named `entry` out of an upstream archive and writes it to `destination`.
 *
 * Archives are read in-process rather than by shelling out to `tar`/`unzip` so this script runs
 * the same way on a maintainer's machine as it does in CI, whatever that machine is. Only the
 * bytes are taken: the upstream mode is not consulted, because the staged file is chmod'ed to a
 * known-good mode below regardless of what upstream happened to record.
 */
/** Reads one file as a Blob, which is what `zip-js` takes as a random-access source. */
async function openBlob(path: string): Promise<Blob> {
  return new Blob([await Deno.readFile(path)]);
}

/**
 * Writes one staged directory tree into a `.orax`, recording execute bits on `executables`.
 *
 * The execute bit is what makes the bundled CLI spawnable after Ora extracts the package, and a
 * ZIP carries it in the upper 16 bits of the external file attributes. A fixed `0o100755` is
 * written rather than whatever upstream recorded, so the package can never install a setuid or
 * otherwise surprising mode. A package that bundles no CLI names no executable: everything it
 * ships is data Ora reads, and nothing in it is ever spawned.
 */
async function writeOrax(
  stageDir: string,
  destination: string,
  executables: ReadonlySet<string>,
): Promise<void> {
  const file = await Deno.create(destination);
  const writer = new ZipWriter(file.writable);
  for await (const entry of walk(stageDir)) {
    const relative = relativeSlashPath(stageDir, entry);
    await writer.add(relative, new BlobReader(await openBlob(entry)), {
      externalFileAttribute: executables.has(relative)
        ? (0o100_755 << 16) >>> 0
        : (0o100_644 << 16) >>> 0,
    });
  }
  await writer.close();
}

/** Yields every ordinary file under `root`, depth first. */
async function* walk(root: string): AsyncGenerator<string> {
  for await (const item of Deno.readDir(root)) {
    const path = join(root, item.name);
    if (item.isDirectory) {
      yield* walk(path);
    } else if (item.isFile) {
      yield path;
    }
  }
}

/** Renders one path below `root` as the slash-separated name a ZIP entry carries. */
function relativeSlashPath(root: string, path: string): string {
  return relative(root, path).replaceAll("\\", "/");
}

/** Returns the lowercase hex SHA-256 of one file, the spelling `sha256` takes in a manifest. */
async function sha256Hex(path: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    await Deno.readFile(path),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * Stages the files every package ships, whether or not it also carries a CLI.
 *
 * `target` is the triple a bundled package self-declares in `[artifact]`, which is what lets Ora
 * verify after extraction that the package it downloaded is really the one built for this machine.
 * A universal package declares none: it carries no binary whose host compatibility could be wrong,
 * and an `[artifact]` section on it would make Ora check the one thing it cannot promise.
 */
async function stagePluginFiles(target: string | undefined): Promise<void> {
  await Deno.mkdir(STAGE_DIR, { recursive: true });
  await Deno.copyFile(join(DIST, "main.js"), join(STAGE_DIR, "main.js"));
  for (const extra of ["logo.svg", "README.md"]) {
    await Deno.copyFile(extra, join(STAGE_DIR, extra)).catch(() => {});
  }
  const manifest = (await Deno.readTextFile("orax.toml")).trimEnd();
  const artifact = target === undefined
    ? ""
    : `\n\n[artifact]\ntarget = "${target}"`;
  await Deno.writeTextFile(
    join(STAGE_DIR, "orax.toml"),
    `${manifest}${artifact}\n`,
  );
}

/** Stages one target's package tree, CLI included, and zips it into a `.orax`. */
async function buildBundledPackage(
  plan: TargetPlan,
  fileName: string,
): Promise<void> {
  await Deno.remove(STAGE_DIR, { recursive: true }).catch(() => {});
  const staged = join(STAGE_DIR, plan.binaryPath);
  await Deno.mkdir(dirname(staged), { recursive: true });

  await compileAdapter(plan, staged);
  await stageCodexRuntime(plan, dirname(staged));

  await stagePluginFiles(plan.triple);
  const nativeSuffix = plan.os === "windows" ? ".exe" : "";
  const executables = new Set([
    plan.binaryPath,
    bundledCodexPath(plan.os),
    `${BUNDLED_BIN_DIR}/codex-code-mode-host${nativeSuffix}`,
    `${BUNDLED_BIN_DIR}/codex-path/rg${nativeSuffix}`,
    `${BUNDLED_BIN_DIR}/codex-resources/codex-command-runner${nativeSuffix}`,
    `${BUNDLED_BIN_DIR}/codex-resources/codex-windows-sandbox-setup${nativeSuffix}`,
  ]);
  await writeOrax(STAGE_DIR, join(PACKAGES_DIR, fileName), executables);
  await Deno.remove(STAGE_DIR, { recursive: true });
}

/** Installs the exact adapter and Codex JavaScript package recorded in the upstream lock. */
async function prepareAdapter(lock: UpstreamLock): Promise<void> {
  await Deno.remove(ADAPTER_DIR, { recursive: true }).catch(() => {});
  await Deno.mkdir(ADAPTER_DIR, { recursive: true });
  await Deno.writeTextFile(
    join(ADAPTER_DIR, "package.json"),
    JSON.stringify(
      {
        private: true,
        type: "module",
        dependencies: {
          [lock.adapter.name]: lock.adapter.version,
          [lock.codex.name]: lock.codex.version,
        },
      },
      null,
      2,
    ) + "\n",
  );
  const registry = Deno.env.get("NPM_CONFIG_REGISTRY");
  await run(
    "bun",
    "install",
    "--cwd",
    ADAPTER_DIR,
    "--omit=optional",
    ...(registry === undefined ? [] : ["--registry", registry]),
  );
  for (const pinned of [lock.adapter, lock.codex]) {
    const installed = JSON.parse(
      await Deno.readTextFile(
        join(ADAPTER_DIR, "node_modules", pinned.name, "package.json"),
      ),
    ) as { version: string };
    if (installed.version !== pinned.version) {
      throw new Error(
        `${pinned.name} resolved to ${installed.version}; upstream.lock.json pins ${pinned.version}`,
      );
    }
  }
}

/** Compiles the pinned adapter entrypoint as a standalone target binary. */
async function compileAdapter(plan: TargetPlan, staged: string): Promise<void> {
  const packageName = config.adapter;
  const entry = join(ADAPTER_DIR, "entry.mjs");
  await Deno.writeTextFile(
    entry,
    [
      'import { dirname, join } from "node:path";',
      "const root = dirname(process.execPath);",
      `process.env.CODEX_PATH = join(root, ${
        JSON.stringify(
          basename(bundledCodexPath(plan.os)),
        )
      });`,
      `await import(${
        JSON.stringify(
          `./node_modules/${packageName}/dist/index.js`,
        )
      });`,
      "",
    ].join("\n"),
  );
  await run(
    "bun",
    "build",
    "--compile",
    `--target=${plan.bun}`,
    entry,
    "--outfile",
    staged,
  );
  console.log(`compiled ${packageName} for ${plan.triple}`);
}

/** Downloads the locked platform package and flattens its vendor runtime beside the adapter. */
async function stageCodexRuntime(
  plan: TargetPlan,
  destination: string,
): Promise<void> {
  const archive = join(DOWNLOAD_DIR, `${plan.runtime}.tgz`);
  const vendorRoot = join(DOWNLOAD_DIR, plan.runtime);
  await Deno.remove(vendorRoot, { recursive: true }).catch(() => {});
  await downloadVerified(plan.codex.tarball, plan.codex.integrity, archive);
  await extractTarPrefix(archive, "package/vendor/", vendorRoot);
  await Deno.remove(archive).catch(() => {});
  const entries = [];
  for await (const item of Deno.readDir(vendorRoot)) {
    if (item.isDirectory) entries.push(item.name);
  }
  if (entries.length !== 1) {
    throw new Error(`expected one native Codex runtime under ${vendorRoot}`);
  }
  const source = join(vendorRoot, entries[0]);
  await copyTree(join(source, "bin"), destination);
  for (const directory of ["codex-path", "codex-resources"]) {
    await copyTree(join(source, directory), join(destination, directory));
  }
  await Deno.copyFile(
    join(source, "codex-package.json"),
    join(destination, "codex-package.json"),
  );
}

async function copyTree(source: string, destination: string): Promise<void> {
  await Deno.mkdir(destination, { recursive: true });
  for await (const item of Deno.readDir(source)) {
    const from = join(source, item.name);
    const to = join(destination, item.name);
    if (item.isDirectory) await copyTree(from, to);
    else if (item.isFile) await Deno.copyFile(from, to);
  }
}

/**
 * Builds every package this release publishes and returns the release-form manifest body.
 *
 * Each target produces one `[[targets]]` entry. Ora uses it to reject a package built for another
 * platform before the bundled executable is launched.
 */
async function buildRelease(
  identifier: string,
  tag: string,
  repo: string,
  requestedTarget?: string,
): Promise<string> {
  const base = `https://github.com/${repo}/releases/download/${tag}`;
  let manifest = (await Deno.readTextFile("orax.toml")).trimEnd();
  const lock = await readLock();
  if (lock.adapter.name !== config.adapter) {
    throw new Error(
      `bundle.config.ts names ${config.adapter}; upstream.lock.json pins ${lock.adapter.name}`,
    );
  }
  await prepareAdapter(lock);
  console.log(
    `Bundling ${lock.adapter.name}@${lock.adapter.version} with ${lock.codex.name}@${lock.codex.version}`,
  );

  for (const [triple, target] of Object.entries(config.targets)) {
    if (requestedTarget !== undefined && requestedTarget !== triple) {
      continue;
    }
    const plan: TargetPlan = {
      triple,
      os: target.os,
      bun: target.bun,
      runtime: target.runtime,
      codex: lock.platforms[target.runtime],
      binaryPath: config.binaryPath(target.os),
    };
    if (plan.codex === undefined) {
      throw new Error(`upstream.lock.json has no ${target.runtime} runtime`);
    }
    const fileName = `${identifier}-${tag}-${triple}.orax`;
    await buildBundledPackage(plan, fileName);

    const digest = await sha256Hex(join(PACKAGES_DIR, fileName));
    manifest +=
      `\n\n[[targets]]\ntarget = "${triple}"\nurl = "${base}/${fileName}"\nsha256 = "${digest}"`;
    console.log(`packaged ${fileName}`);
  }
  if (requestedTarget !== undefined && !(requestedTarget in config.targets)) {
    throw new Error(`unknown target ${requestedTarget}`);
  }
  console.log(
    `\nUpstream adapter: ${lock.adapter.version}; Codex CLI: ${lock.codex.version}`,
  );
  return manifest;
}

async function main(): Promise<void> {
  const flags = parseArgs(Deno.args, {
    string: ["tag", "repo", "target"],
  });
  const tag = flags.tag ?? Deno.env.get("GITHUB_REF_NAME");
  const repo = flags.repo ?? Deno.env.get("GITHUB_REPOSITORY");
  if (tag === undefined || repo === undefined) {
    throw new Error("both --tag and --repo are required");
  }

  const identifier = await manifestField("identifier");
  await Deno.mkdir(PACKAGES_DIR, { recursive: true });

  const manifest = await buildRelease(identifier, tag, repo, flags.target);

  // The marketplace index needs the release form of the manifest, which carries the download URLs
  // and digests. It is only knowable once the packages exist, so it is generated here rather than
  // committed.
  await Deno.writeTextFile(join(DIST, "manifest.toml"), `${manifest}\n`);
}

if (import.meta.main) {
  await main();
}
