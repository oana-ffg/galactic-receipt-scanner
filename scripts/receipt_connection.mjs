#!/usr/bin/env node
// Key material never appears in model-visible output. No network or inference calls.
import {
  generateKeyPairSync,
  privateDecrypt,
  constants,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import { mkdir, writeFile, readFile, stat, lstat } from "node:fs/promises";
import { resolve, join } from "node:path";

async function privateFile(path) {
  const info = await lstat(path);
  if (
    info.isSymbolicLink() ||
    !info.isFile() ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw Error("Connection files must be private regular files.");
  return readFile(path, "utf8");
}

async function run() {
  const [command, directory, ...args] = process.argv.slice(2);
  if (!directory || !["init", "complete"].includes(command))
    throw Error(
      "Use init DIRECTORY ORIGIN NAME [processing|backup] [DAYS], or complete DIRECTORY ENVELOPE_FILE.",
    );
  const root = resolve(directory);
  if (command === "init") {
    const [origin, name, scope = "processing", lifetime = "1"] = args;
    const url = new URL(origin);
    const days = Number(lifetime);
    if (
      url.origin !== origin ||
      url.protocol !== "https:" ||
      !name ||
      name.length > 80 ||
      !["processing", "backup"].includes(scope) ||
      !Number.isInteger(days) ||
      days < 1 ||
      days > 365
    )
      throw Error(
        "Provide an HTTPS origin, name, valid scope and lifetime of 1–365 days.",
      );
    await mkdir(root, { mode: 0o700 }); // A new directory prevents accidental connection/key replacement.
    const { publicKey, privateKey } = generateKeyPairSync("rsa", {
      modulusLength: 2048,
    });
    const request = {
      request_id: randomUUID(),
      name,
      scope,
      days,
      public_key: publicKey.export({ format: "jwk" }),
    };
    await writeFile(
      join(root, "private.pem"),
      privateKey.export({ format: "pem", type: "pkcs8" }),
      { mode: 0o600, flag: "wx" },
    );
    await writeFile(
      join(root, "request.json"),
      JSON.stringify({ origin, request }),
      { mode: 0o600, flag: "wx" },
    );
    console.log(JSON.stringify({ directory: root, origin, request }));
    return;
  }
  const info = await stat(root);
  if (process.platform !== "win32" && info.mode & 0o077)
    throw Error("Connection directory must be private.");
  const envelope = JSON.parse(await readFile(args[0], "utf8"));
  const expected = JSON.parse(await privateFile(join(root, "request.json")));
  if (
    envelope.id !== expected.request.request_id ||
    envelope.sealed?.algorithm !== "RSA-OAEP-256+A256GCM"
  )
    throw Error("Envelope is for a different connection.");
  const aes = privateDecrypt(
    {
      key: await privateFile(join(root, "private.pem")),
      padding: constants.RSA_PKCS1_OAEP_PADDING,
      oaepHash: "sha256",
    },
    Buffer.from(envelope.sealed.key, "base64"),
  );
  const bytes = Buffer.from(envelope.sealed.ciphertext, "base64");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    aes,
    Buffer.from(envelope.sealed.iv, "base64"),
  );
  decipher.setAuthTag(bytes.subarray(-16));
  const value = JSON.parse(
    Buffer.concat([
      decipher.update(bytes.subarray(0, -16)),
      decipher.final(),
    ]).toString(),
  );
  if (
    value.origin !== expected.origin ||
    value.connection_id !== expected.request.request_id ||
    value.scope !== expected.request.scope ||
    value.expires_at <= Date.now() ||
    !/^rsc_[A-Za-z0-9_-]{43}$/.test(value.processing_token) ||
    typeof value.sites_token !== "string" ||
    !value.sites_token
  )
    throw Error(
      "Connection does not match the requested origin, identity, scope or lifetime.",
    );
  const credentialFile = join(root, "credentials.json");
  // Idempotent completion may recover after the credential was saved but config publication failed.
  try {
    await writeFile(credentialFile, JSON.stringify(value), {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      (await privateFile(credentialFile)) !== JSON.stringify(value)
    )
      throw error;
  }
  const config = JSON.stringify({
    origin: value.origin,
    credential_file: credentialFile,
  });
  try {
    await writeFile(join(root, "client.json"), config, {
      mode: 0o600,
      flag: "wx",
    });
  } catch (error) {
    if (
      error.code !== "EEXIST" ||
      (await privateFile(join(root, "client.json"))) !== config
    )
      throw error;
  }
  console.log(
    JSON.stringify({
      config: join(root, "client.json"),
      connection_id: value.connection_id,
      scope: value.scope,
      expires_at: value.expires_at,
    }),
  );
}

run().catch(() => {
  console.error(
    "Connection setup failed. Verify the request, encrypted response and private directory permissions; existing files were preserved.",
  );
  process.exitCode = 1;
});
