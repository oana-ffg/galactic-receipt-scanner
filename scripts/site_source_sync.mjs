#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import {
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

class SyncError extends Error {}

function fail(message) {
  throw new SyncError(message);
}

function parseArgs(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!value || !["--public-checkout", "--site-checkout"].includes(flag)) {
      fail(
        "Usage: site_source_sync.mjs --public-checkout <path> --site-checkout <path>",
      );
    }
    if (flag === "--public-checkout") result.publicCheckout = value;
    if (flag === "--site-checkout") result.siteCheckout = value;
  }
  if (!result.publicCheckout || !result.siteCheckout) {
    fail(
      "Usage: site_source_sync.mjs --public-checkout <path> --site-checkout <path>",
    );
  }
  return result;
}

function rejectGitEnvironmentOverrides() {
  const forbidden = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_INDEX_FILE",
    "GIT_COMMON_DIR",
  ].filter((name) => process.env[name]);
  if (forbidden.length > 0) {
    fail(
      `Unset Git directory and index environment overrides before synchronization: ${forbidden.join(", ")}.`,
    );
  }
}

function git(checkout, args, options = {}) {
  const result = spawnSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", checkout, ...args],
    {
      encoding: "utf8",
      env: { ...process.env, ...(options.env ?? {}) },
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  if (result.status !== 0 && !options.allowFailure) {
    const detail = `${result.stderr ?? ""}`.trim();
    fail(detail || `Git failed: ${args[0]}`);
  }
  return result;
}

function output(checkout, args) {
  return git(checkout, args).stdout.trim();
}

function gitRoot(checkout, label) {
  let root;
  try {
    root = output(checkout, ["rev-parse", "--show-toplevel"]);
  } catch {
    fail(`${label} must be a usable Git checkout.`);
  }
  return realpathSync(root);
}

function gitCommonDirectory(checkout, label) {
  let directory;
  try {
    directory = output(checkout, ["rev-parse", "--git-common-dir"]);
  } catch {
    fail(`${label} must have an independent Git directory.`);
  }
  return realpathSync(
    isAbsolute(directory) ? directory : resolve(checkout, directory),
  );
}

function status(checkout, untrackedFiles = "normal") {
  return output(checkout, [
    "status",
    "--porcelain",
    `--untracked-files=${untrackedFiles}`,
  ]);
}

function readManifest(siteCheckout, allowUntracked) {
  const path = join(siteCheckout, ".openai", "hosting.json");
  const metadata = lstatSync(path, { throwIfNoEntry: false });
  if (!metadata?.isFile() || metadata.isSymbolicLink()) {
    fail(
      "The private Sites checkout must contain a regular .openai/hosting.json file.",
    );
  }
  let value;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    fail("The private Sites manifest must contain valid JSON.");
  }
  const allowed = new Set(["project_id", "static", "d1", "r2", "capabilities"]);
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    typeof value.project_id !== "string" ||
    !value.project_id.startsWith("appgprj_") ||
    Object.keys(value).some((key) => !allowed.has(key))
  ) {
    fail(
      "The private Sites manifest must contain a Sites project_id and only supported hosting fields.",
    );
  }
  const currentStatus = status(siteCheckout, allowUntracked ? "all" : "normal");
  if (
    currentStatus &&
    !(allowUntracked && currentStatus === "?? .openai/hosting.json")
  ) {
    fail("The private Sites checkout must be clean before synchronization.");
  }
  return { path, source: readFileSync(path) };
}

function hasCommit(checkout) {
  return (
    git(checkout, ["rev-parse", "--verify", "HEAD^{commit}"], {
      allowFailure: true,
    }).status === 0
  );
}

function isAncestor(checkout, ancestor, descendant) {
  return (
    git(checkout, ["merge-base", "--is-ancestor", ancestor, descendant], {
      allowFailure: true,
    }).status === 0
  );
}

function nulSeparatedPaths(value) {
  return value.split("\0").filter(Boolean);
}

function assertNoPrivatePathCollisions(siteCheckout, targetTree) {
  const targetPaths = nulSeparatedPaths(
    git(siteCheckout, ["ls-tree", "-rz", "--name-only", targetTree]).stdout,
  );
  const privatePaths = new Set(
    nulSeparatedPaths(
      git(siteCheckout, [
        "status",
        "--porcelain=v1",
        "-z",
        "--untracked-files=normal",
        "--ignored=matching",
      ]).stdout,
    )
      .filter((entry) => entry.startsWith("?? ") || entry.startsWith("!! "))
      .map((entry) => entry.slice(3).replace(/\/+$/, "")),
  );
  if (privatePaths.delete(".openai")) {
    for (const ignoredFlag of [[], ["--ignored"]]) {
      for (const path of nulSeparatedPaths(
        git(siteCheckout, [
          "ls-files",
          "--others",
          ...ignoredFlag,
          "--exclude-standard",
          "-z",
          "--",
          ".openai",
        ]).stdout,
      )) {
        privatePaths.add(path.replace(/\/+$/, ""));
      }
    }
  }
  privatePaths.delete(".openai/hosting.json");

  for (const privatePath of privatePaths) {
    const collision = targetPaths.find(
      (targetPath) =>
        targetPath === privatePath ||
        targetPath.startsWith(`${privatePath}/`) ||
        privatePath.startsWith(`${targetPath}/`),
    );
    if (collision) {
      fail(
        `The private Sites checkout contains an untracked or ignored path that synchronization would overwrite: ${privatePath}.`,
      );
    }
  }
}

function commitIdentity(siteCheckout) {
  const name = git(siteCheckout, ["config", "user.name"], {
    allowFailure: true,
  }).stdout.trim();
  const email = git(siteCheckout, ["config", "user.email"], {
    allowFailure: true,
  }).stdout.trim();
  if (name && email) return {};
  return {
    GIT_AUTHOR_NAME: "Sites Source Sync",
    GIT_AUTHOR_EMAIL: "sites-sync@users.noreply.openai.com",
    GIT_COMMITTER_NAME: "Sites Source Sync",
    GIT_COMMITTER_EMAIL: "sites-sync@users.noreply.openai.com",
  };
}

function synchronize({ publicCheckout, siteCheckout }) {
  rejectGitEnvironmentOverrides();
  const publicRef = "origin/main";
  const publicRoot = gitRoot(resolve(publicCheckout), "The public checkout");
  const siteRoot = gitRoot(resolve(siteCheckout), "The private Sites checkout");
  if (publicRoot === siteRoot) {
    fail(
      "Public development and private Sites source must use separate Git checkouts.",
    );
  }
  if (
    gitCommonDirectory(publicRoot, "The public checkout") ===
    gitCommonDirectory(siteRoot, "The private Sites checkout")
  ) {
    fail(
      "Public development and private Sites source must use independent Git histories, not linked worktrees.",
    );
  }
  if (output(publicRoot, ["branch", "--show-current"]) !== "main") {
    fail("The public checkout must be on main.");
  }
  if (status(publicRoot)) {
    fail("The public checkout must be clean before Sites synchronization.");
  }
  const publicCommit = output(publicRoot, [
    "rev-parse",
    "--verify",
    `${publicRef}^{commit}`,
  ]);
  const publicFullRef = output(publicRoot, [
    "rev-parse",
    "--symbolic-full-name",
    publicRef,
  ]);
  if (!publicFullRef.startsWith("refs/")) {
    fail("The public revision must be a named Git ref.");
  }
  const publicHead = output(publicRoot, [
    "rev-parse",
    "--verify",
    "HEAD^{commit}",
  ]);
  if (publicCommit !== publicHead) {
    fail(`The public checkout HEAD must exactly match ${publicRef}.`);
  }
  if (
    git(
      publicRoot,
      ["cat-file", "-e", `${publicCommit}:.openai/hosting.json`],
      {
        allowFailure: true,
      },
    ).status === 0
  ) {
    fail("The public commit must not track .openai/hosting.json.");
  }

  const existingSiteCommit = hasCommit(siteRoot);
  const manifest = readManifest(siteRoot, !existingSiteCommit);
  if (
    existingSiteCommit &&
    git(siteRoot, ["cat-file", "-e", "HEAD:.openai/hosting.json"], {
      allowFailure: true,
    }).status !== 0
  ) {
    fail("An existing private Sites history must track .openai/hosting.json.");
  }
  const siteBranch = output(siteRoot, ["symbolic-ref", "HEAD"]);
  const siteHead = existingSiteCommit
    ? output(siteRoot, ["rev-parse", "--verify", "HEAD^{commit}"])
    : null;
  const oldManifestObject = existingSiteCommit
    ? output(siteRoot, ["rev-parse", "HEAD:.openai/hosting.json"])
    : null;

  git(siteRoot, ["fetch", "--no-tags", publicRoot, publicFullRef]);
  const importedPublicCommit = output(siteRoot, [
    "rev-parse",
    "--verify",
    "FETCH_HEAD^{commit}",
  ]);
  if (importedPublicCommit !== publicCommit) {
    fail("The imported public commit did not match the requested revision.");
  }

  const temporary = mkdtempSync(join(tmpdir(), "receipt-site-source-sync-"));
  const temporaryIndex = join(temporary, "index");
  const indexEnvironment = { GIT_INDEX_FILE: temporaryIndex };
  try {
    git(siteRoot, ["read-tree", publicCommit], { env: indexEnvironment });
    const manifestObject =
      oldManifestObject ??
      output(siteRoot, ["hash-object", "-w", manifest.path]);
    git(
      siteRoot,
      [
        "update-index",
        "--add",
        "--cacheinfo",
        "100644",
        manifestObject,
        ".openai/hosting.json",
      ],
      { env: indexEnvironment },
    );
    const targetTree = outputWithEnvironment(
      siteRoot,
      ["write-tree"],
      indexEnvironment,
    );
    assertNoPrivatePathCollisions(siteRoot, targetTree);
    const siteTree = existingSiteCommit
      ? output(siteRoot, ["rev-parse", "HEAD^{tree}"])
      : null;
    const containsPublic =
      existingSiteCommit && isAncestor(siteRoot, publicCommit, siteHead);
    if (targetTree === siteTree && containsPublic) {
      return {
        changed: false,
        public_commit: publicCommit,
        site_commit: siteHead,
      };
    }

    const parents = [];
    if (siteHead) parents.push("-p", siteHead);
    if (!containsPublic) parents.push("-p", publicCommit);
    const message = `Sync public main ${publicCommit.slice(0, 12)} for Sites deployment`;
    const newCommit = outputWithEnvironment(
      siteRoot,
      ["commit-tree", targetTree, ...parents, "-m", message],
      commitIdentity(siteRoot),
    );
    const updateArgs = ["update-ref", siteBranch, newCommit];
    if (siteHead) updateArgs.push(siteHead);
    git(siteRoot, updateArgs);
    git(siteRoot, ["reset", "--hard", newCommit]);
    if (status(siteRoot))
      fail("The private Sites checkout was not clean after synchronization.");
    if (!readFileSync(manifest.path).equals(manifest.source)) {
      fail("The private Sites manifest changed during synchronization.");
    }
    return {
      changed: true,
      public_commit: publicCommit,
      site_commit: newCommit,
    };
  } finally {
    rmSync(temporary, { recursive: true, force: true });
  }
}

function outputWithEnvironment(checkout, args, environment) {
  return git(checkout, args, { env: environment }).stdout.trim();
}

try {
  const result = synchronize(parseArgs(process.argv.slice(2)));
  process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
  process.stderr.write(
    `${error instanceof SyncError ? error.message : "Unable to synchronize Sites source."}\n`,
  );
  process.exitCode = 1;
}
