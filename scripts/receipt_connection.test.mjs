import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
  statSync,
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
  const run = (...args) =>
    spawnSync(
      process.execPath,
      [resolve("scripts/receipt_connection.mjs"), ...args],
      { encoding: "utf8" },
    );
  try {
    const init = run(
      "init",
      root,
      "https://synthetic.example",
      "Synthetic worker",
    );
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
      const complete = run("complete", root, response);
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
    assert.equal(run("complete", root, response).status, 1);
    assert.deepEqual(
      JSON.parse(readFileSync(join(root, "credentials.json"))),
      value,
    );
  } finally {
    rmSync(parent, { recursive: true });
  }
});
