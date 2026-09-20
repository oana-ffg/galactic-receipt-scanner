import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
  existsSync,
  unlinkSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  randomBytes,
  createPublicKey,
  publicEncrypt,
  createCipheriv,
  constants,
} from "node:crypto";

test("encrypted handoff decrypts into private files, is repeatable, and never prints secrets", () => {
  const parent = mkdtempSync(join(tmpdir(), "scanner-connection-test-"));
  const root = join(parent, "connection");
  const run = (args, options = {}) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/receipt_connection.mjs"), ...args],
      { encoding: "utf8", ...options },
    );
  try {
    const init = run([
      "init",
      root,
      "https://synthetic.example",
      "Synthetic worker",
    ]);
    assert.equal(init.status, 0);
    const { request } = JSON.parse(init.stdout);
    const value = {
      origin: "https://synthetic.example",
      connection_id: request.request_id,
      scope: "processing",
      expires_at: Date.now() + 60000,
      sites_token: "synthetic-gateway-secret",
      processing_token: "rsc_" + "a".repeat(43),
    };
    const aes = randomBytes(32),
      iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", aes, iv);
    const ciphertext = Buffer.concat([
      cipher.update(JSON.stringify(value)),
      cipher.final(),
      cipher.getAuthTag(),
    ]);
    const envelope = {
      id: request.request_id,
      sealed: {
        algorithm: "RSA-OAEP-256+A256GCM",
        key: publicEncrypt(
          {
            key: createPublicKey({ key: request.public_key, format: "jwk" }),
            padding: constants.RSA_PKCS1_OAEP_PADDING,
            oaepHash: "sha256",
          },
          aes,
        ).toString("base64"),
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
      },
    };
    const response = join(parent, "response.json");
    writeFileSync(response, JSON.stringify(envelope));
    for (let i = 0; i < 2; i++) {
      const complete = run(["complete", root, response]);
      assert.equal(complete.status, 0);
      assert.ok(!complete.stdout.includes(value.sites_token));
      assert.ok(!complete.stdout.includes(value.processing_token));
    }
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "credentials.json"))),
      value,
    );
    if (process.platform !== "win32")
      assert.equal(
        statSync(join(root, "credentials.json")).mode & 0o777,
        0o600,
      );
    envelope.id = "wrong-connection";
    writeFileSync(response, JSON.stringify(envelope));
    assert.equal(run(["complete", root, response]).status, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "credentials.json"))),
      value,
    );
    const completedFromStdin = run(["complete-stdin", root], {
      input: JSON.stringify({ ...envelope, id: request.request_id }),
    });
    assert.equal(completedFromStdin.status, 0);
    assert.ok(!completedFromStdin.stdout.includes(value.processing_token));
    unlinkSync(join(root, "client.json"));
    writeFileSync(join(root, "credentials.json"), "{truncated", {
      mode: 0o600,
    });
    const destroyed = run(["destroy", root]);
    assert.equal(destroyed.status, 0);
    assert.deepEqual(JSON.parse(destroyed.stdout), { destroyed: true });
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("connection cleanup removes an init-only private directory", () => {
  const parent = mkdtempSync(
    join(tmpdir(), "scanner-connection-init-cleanup-"),
  );
  const root = join(parent, "connection");
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/receipt_connection.mjs"), ...args],
      { encoding: "utf8" },
    );
  try {
    assert.equal(
      run("init", root, "https://synthetic.example", "Synthetic worker").status,
      0,
    );
    assert.equal(run("destroy", root).status, 0);
    assert.equal(existsSync(root), false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("connection cleanup removes malformed partial files and can resume partial deletion", () => {
  const parent = mkdtempSync(
    join(tmpdir(), "scanner-connection-partial-cleanup-"),
  );
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/receipt_connection.mjs"), ...args],
      { encoding: "utf8" },
    );
  try {
    for (const filename of [
      "request.json",
      "client.json",
      "credentials.json",
    ]) {
      const root = join(parent, filename.replace(".json", ""));
      assert.equal(
        run("init", root, "https://synthetic.example", "Synthetic worker")
          .status,
        0,
      );
      writeFileSync(join(root, filename), "{truncated", { mode: 0o600 });
      assert.equal(run("destroy", root).status, 0);
      assert.equal(existsSync(root), false);
    }
    const root = join(parent, "partly-deleted");
    assert.equal(
      run("init", root, "https://synthetic.example", "Synthetic worker").status,
      0,
    );
    unlinkSync(join(root, "private.pem"));
    assert.equal(run("destroy", root).status, 0);
    assert.equal(existsSync(root), false);

    const requestMissing = join(parent, "request-missing");
    assert.equal(
      run(
        "init",
        requestMissing,
        "https://synthetic.example",
        "Synthetic worker",
      ).status,
      0,
    );
    writeFileSync(join(requestMissing, "credentials.json"), "{truncated", {
      mode: 0o600,
    });
    writeFileSync(join(requestMissing, "client.json"), "{truncated", {
      mode: 0o600,
    });
    unlinkSync(join(requestMissing, "request.json"));
    assert.equal(run("destroy", requestMissing).status, 0);
    assert.equal(existsSync(requestMissing), false);
  } finally {
    rmSync(parent, { recursive: true });
  }
});

test("connection cleanup refuses a directory containing unrelated files", () => {
  const parent = mkdtempSync(
    join(tmpdir(), "scanner-connection-cleanup-test-"),
  );
  const root = join(parent, "connection");
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/receipt_connection.mjs"), ...args],
      {
        encoding: "utf8",
      },
    );
  try {
    const init = run(
      "init",
      root,
      "https://synthetic.example",
      "Synthetic worker",
    );
    assert.equal(init.status, 0);
    writeFileSync(join(root, "unrelated.txt"), "preserve me");
    const destroyed = run("destroy", root);
    assert.equal(destroyed.status, 1);
    assert.equal(existsSync(root), true);
    assert.equal(
      readFileSync(join(root, "unrelated.txt"), "utf8"),
      "preserve me",
    );
  } finally {
    rmSync(parent, { recursive: true });
  }
});
