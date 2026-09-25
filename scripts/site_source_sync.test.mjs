import { strict as assert } from "node:assert";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";

const script = resolve("scripts/site_source_sync.mjs");

function git(checkout, ...args) {
  return execFileSync(
    "git",
    ["-c", "core.fsmonitor=false", "-C", checkout, ...args],
    {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    },
  ).trim();
}

function init(checkout) {
  mkdirSync(checkout, { recursive: true });
  git(checkout, "init", "--initial-branch=main");
  git(checkout, "config", "user.name", "Synthetic Test");
  git(checkout, "config", "user.email", "synthetic@example.test");
}

function commit(checkout, message) {
  git(checkout, "add", "--all", ":!/.openai/hosting.json");
  git(checkout, "commit", "-m", message);
  return git(checkout, "rev-parse", "HEAD");
}

function run(publicCheckout, siteCheckout, options = {}) {
  const args = [
    script,
    "--public-checkout",
    publicCheckout,
    "--site-checkout",
    siteCheckout,
    ...(options.args ?? []),
  ];
  return spawnSync(process.execPath, args, {
    encoding: "utf8",
    env: { ...process.env, ...(options.env ?? {}) },
  });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "receipt-site-source-test-"));
  const origin = join(root, "origin.git");
  const publicCheckout = join(root, "public");
  const siteCheckout = join(root, "site");
  mkdirSync(origin, { recursive: true });
  git(origin, "init", "--bare");
  init(publicCheckout);
  writeFileSync(join(publicCheckout, ".gitignore"), ".openai/hosting.json\n");
  writeFileSync(join(publicCheckout, "application.txt"), "public-main\n");
  const publicCommit = commit(publicCheckout, "Public source");
  git(publicCheckout, "remote", "add", "origin", origin);
  git(publicCheckout, "push", "--set-upstream", "origin", "main");

  init(siteCheckout);
  mkdirSync(join(siteCheckout, ".openai"), { recursive: true });
  const manifest = JSON.stringify(
    { project_id: "appgprj_synthetic", d1: "DB", r2: "BUCKET" },
    null,
    2,
  );
  writeFileSync(join(siteCheckout, ".openai", "hosting.json"), `${manifest}\n`);
  writeFileSync(join(siteCheckout, "application.txt"), "stale-site-source\n");
  writeFileSync(join(siteCheckout, "obsolete.txt"), "remove me\n");
  git(siteCheckout, "add", "--force", ".openai/hosting.json");
  git(siteCheckout, "add", "application.txt", "obsolete.txt");
  git(siteCheckout, "commit", "-m", "Private Site source");
  return {
    root,
    publicCheckout,
    siteCheckout,
    publicCommit,
    manifest: `${manifest}\n`,
  };
}

test("synchronizes the complete public tree while preserving the private manifest", () => {
  const value = fixture();
  try {
    const first = run(value.publicCheckout, value.siteCheckout);
    assert.equal(first.status, 0, first.stderr);
    const result = JSON.parse(first.stdout);
    assert.equal(result.changed, true);
    assert.equal(result.public_commit, value.publicCommit);
    assert.equal(
      readFileSync(join(value.siteCheckout, "application.txt"), "utf8"),
      "public-main\n",
    );
    assert.equal(existsSync(join(value.siteCheckout, "obsolete.txt")), false);
    assert.equal(
      readFileSync(join(value.siteCheckout, ".openai", "hosting.json"), "utf8"),
      value.manifest,
    );
    assert.equal(git(value.publicCheckout, "status", "--porcelain"), "");
    assert.equal(git(value.siteCheckout, "status", "--porcelain"), "");
    assert.doesNotThrow(() =>
      git(
        value.siteCheckout,
        "merge-base",
        "--is-ancestor",
        value.publicCommit,
        "HEAD",
      ),
    );
    assert.equal(
      git(value.siteCheckout, "rev-list", "--parents", "-n", "1", "HEAD").split(
        " ",
      ).length,
      3,
    );

    const second = run(value.publicCheckout, value.siteCheckout);
    assert.equal(second.status, 0, second.stderr);
    assert.equal(JSON.parse(second.stdout).changed, false);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("initializes an unborn private source history from public main plus the manifest", () => {
  const value = fixture();
  try {
    rmSync(value.siteCheckout, { recursive: true, force: true });
    init(value.siteCheckout);
    mkdirSync(join(value.siteCheckout, ".openai"), { recursive: true });
    writeFileSync(
      join(value.siteCheckout, ".openai", "hosting.json"),
      value.manifest,
    );
    const result = run(value.publicCheckout, value.siteCheckout);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(
      readFileSync(join(value.siteCheckout, "application.txt"), "utf8"),
      "public-main\n",
    );
    assert.equal(
      git(value.siteCheckout, "rev-parse", "HEAD^"),
      value.publicCommit,
    );
    assert.equal(git(value.siteCheckout, "status", "--porcelain"), "");
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses the shared checkout and dirty source trees", () => {
  const value = fixture();
  try {
    const same = run(value.publicCheckout, value.publicCheckout);
    assert.notEqual(same.status, 0);
    assert.match(same.stderr, /separate Git checkouts/);

    writeFileSync(join(value.publicCheckout, "application.txt"), "dirty\n");
    const dirtyPublic = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(dirtyPublic.status, 0);
    assert.match(dirtyPublic.stderr, /public checkout must be clean/);
    git(value.publicCheckout, "checkout", "--", "application.txt");

    writeFileSync(join(value.siteCheckout, "application.txt"), "dirty\n");
    const dirtySite = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(dirtySite.status, 0);
    assert.match(dirtySite.stderr, /private Sites checkout must be clean/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses a private Sites manifest committed to public main", () => {
  const value = fixture();
  try {
    mkdirSync(join(value.publicCheckout, ".openai"), { recursive: true });
    writeFileSync(
      join(value.publicCheckout, ".openai", "hosting.json"),
      value.manifest,
    );
    git(value.publicCheckout, "add", "--force", ".openai/hosting.json");
    git(
      value.publicCheckout,
      "commit",
      "-m",
      "Incorrectly track private manifest",
    );
    git(value.publicCheckout, "push", "origin", "main");
    const result = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must not track \.openai\/hosting\.json/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses a public feature branch or an unpushed main commit", () => {
  const value = fixture();
  try {
    git(value.publicCheckout, "switch", "-c", "feature");
    const feature = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(feature.status, 0);
    assert.match(feature.stderr, /public checkout must be on main/);

    git(value.publicCheckout, "switch", "main");
    writeFileSync(join(value.publicCheckout, "application.txt"), "unpushed\n");
    commit(value.publicCheckout, "Unpushed public change");
    const unpushed = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(unpushed.status, 0);
    assert.match(unpushed.stderr, /HEAD must exactly match origin\/main/);

    const override = run(value.publicCheckout, value.siteCheckout, {
      args: ["--public-ref", "main"],
    });
    assert.notEqual(override.status, 0);
    assert.match(override.stderr, /Usage:/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses linked worktrees and inherited Git directory overrides", () => {
  const value = fixture();
  try {
    const linkedSite = join(value.root, "linked-site");
    git(
      value.publicCheckout,
      "worktree",
      "add",
      "--detach",
      linkedSite,
      "main",
    );
    mkdirSync(join(linkedSite, ".openai"), { recursive: true });
    writeFileSync(join(linkedSite, ".openai", "hosting.json"), value.manifest);
    const linked = run(value.publicCheckout, linkedSite);
    assert.notEqual(linked.status, 0);
    assert.match(linked.stderr, /independent Git histories/);

    const overridden = run(value.publicCheckout, value.siteCheckout, {
      env: { GIT_DIR: join(value.root, "unexpected-git-dir") },
    });
    assert.notEqual(overridden.status, 0);
    assert.match(overridden.stderr, /Unset Git directory and index/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("protects an ignored private file from an incoming public path", () => {
  const value = fixture();
  try {
    writeFileSync(join(value.publicCheckout, "owner-file.txt"), "public\n");
    commit(value.publicCheckout, "Add public path");
    git(value.publicCheckout, "push", "origin", "main");

    writeFileSync(
      join(value.siteCheckout, ".git", "info", "exclude"),
      "owner-file.txt\n",
    );
    writeFileSync(join(value.siteCheckout, "owner-file.txt"), "private\n");
    const siteHead = git(value.siteCheckout, "rev-parse", "HEAD");

    const result = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /would overwrite: owner-file\.txt/);
    assert.equal(
      readFileSync(join(value.siteCheckout, "owner-file.txt"), "utf8"),
      "private\n",
    );
    assert.equal(git(value.siteCheckout, "rev-parse", "HEAD"), siteHead);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("protects ignored descendants when public source replaces a directory", () => {
  const value = fixture();
  try {
    mkdirSync(join(value.siteCheckout, "assets"), { recursive: true });
    writeFileSync(
      join(value.siteCheckout, "assets", "source.txt"),
      "tracked\n",
    );
    git(value.siteCheckout, "add", "assets/source.txt");
    git(value.siteCheckout, "commit", "-m", "Track private assets directory");
    writeFileSync(
      join(value.siteCheckout, ".git", "info", "exclude"),
      "assets/private.log\n",
    );
    writeFileSync(
      join(value.siteCheckout, "assets", "private.log"),
      "private\n",
    );

    writeFileSync(join(value.publicCheckout, "assets"), "public file\n");
    commit(value.publicCheckout, "Replace assets directory with public file");
    git(value.publicCheckout, "push", "origin", "main");
    const siteHead = git(value.siteCheckout, "rev-parse", "HEAD");

    const result = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /would overwrite: assets\/private\.log/);
    assert.equal(
      readFileSync(join(value.siteCheckout, "assets", "private.log"), "utf8"),
      "private\n",
    );
    assert.equal(git(value.siteCheckout, "rev-parse", "HEAD"), siteHead);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("protects files inside an ignored nested repository", () => {
  const value = fixture();
  try {
    mkdirSync(join(value.siteCheckout, "vendor"), { recursive: true });
    init(join(value.siteCheckout, "vendor"));
    writeFileSync(
      join(value.siteCheckout, "vendor", "owner.txt"),
      "private data\n",
    );
    commit(join(value.siteCheckout, "vendor"), "Private nested source");
    writeFileSync(
      join(value.siteCheckout, ".git", "info", "exclude"),
      "vendor/\n",
    );

    mkdirSync(join(value.publicCheckout, "vendor"), { recursive: true });
    writeFileSync(
      join(value.publicCheckout, "vendor", "owner.txt"),
      "public data\n",
    );
    commit(value.publicCheckout, "Add public vendor source");
    git(value.publicCheckout, "push", "origin", "main");
    const siteHead = git(value.siteCheckout, "rev-parse", "HEAD");

    const result = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /would overwrite: vendor/);
    assert.equal(
      readFileSync(join(value.siteCheckout, "vendor", "owner.txt"), "utf8"),
      "private data\n",
    );
    assert.equal(git(value.siteCheckout, "rev-parse", "HEAD"), siteHead);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});

test("refuses an existing private history that does not track its manifest", () => {
  const value = fixture();
  try {
    git(value.siteCheckout, "rm", "--cached", ".openai/hosting.json");
    writeFileSync(
      join(value.siteCheckout, ".gitignore"),
      ".openai/hosting.json\n",
    );
    git(value.siteCheckout, "add", ".gitignore");
    git(value.siteCheckout, "commit", "-m", "Stop tracking private manifest");
    const result = run(value.publicCheckout, value.siteCheckout);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /must track \.openai\/hosting\.json/);
  } finally {
    rmSync(value.root, { recursive: true, force: true });
  }
});
