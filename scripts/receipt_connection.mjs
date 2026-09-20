#!/usr/bin/env node
// Key material never appears in model-visible output. No network or inference calls.
import {
  generateKeyPairSync,
  privateDecrypt,
  constants,
  createDecipheriv,
  randomUUID,
} from "node:crypto";
import {
  mkdir,
  writeFile,
  readFile,
  lstat,
  readdir,
  unlink,
  rmdir,
} from "node:fs/promises";
import { resolve, join } from "node:path";

const MARKER = '{"receipt_connection":1}';

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

async function readStdin() {
  let text = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function run() {
  const [command, directory, ...args] = process.argv.slice(2);
  if (
    !directory ||
    !["init", "complete", "complete-stdin", "destroy"].includes(command)
  )
    throw Error(
      "Use init DIRECTORY ORIGIN NAME [processing|backup] [DAYS], complete DIRECTORY ENVELOPE_FILE, complete-stdin DIRECTORY, or destroy DIRECTORY.",
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
    await writeFile(join(root, ".receipt-connection"), MARKER, {
      mode: 0o600,
      flag: "wx",
    });
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
  const info = await lstat(root);
  if (
    info.isSymbolicLink() ||
    !info.isDirectory() ||
    (process.platform !== "win32" && info.mode & 0o077)
  )
    throw Error("Connection directory must be private.");
  if (command === "destroy") {
    const expectedNames = new Set([
      ".receipt-connection",
      "private.pem",
      "request.json",
      "credentials.json",
      "client.json",
    ]);
    const names = await readdir(root);
    if (names.some((name) => !expectedNames.has(name)))
      throw Error("Connection directory contains unexpected files.");
    if (
      !names.includes(".receipt-connection") ||
      (await privateFile(join(root, ".receipt-connection"))) !== MARKER
    )
      throw Error("Connection directory was not created by this helper.");
    for (const name of names) await privateFile(join(root, name));
    const hasRequest = names.includes("request.json");
    const hasConfig = names.includes("client.json");
    const hasCredentials = names.includes("credentials.json");
    const parseIfComplete = async (name) => {
      try {
        return JSON.parse(await privateFile(join(root, name)));
      } catch {
        return undefined;
      }
    };
    const expected = hasRequest
      ? await parseIfComplete("request.json")
      : undefined;
    const config = hasConfig ? await parseIfComplete("client.json") : undefined;
    const credentials = hasCredentials
      ? await parseIfComplete("credentials.json")
      : undefined;
    if (
      (config &&
        (resolve(config.credential_file ?? "") !==
          join(root, "credentials.json") ||
          (expected && config.origin !== expected.origin))) ||
      (credentials &&
        expected &&
        (credentials.origin !== expected.origin ||
          credentials.connection_id !== expected.request?.request_id))
    )
      throw Error("Connection files do not belong to this directory.");
    for (const name of [
      "credentials.json",
      "client.json",
      "private.pem",
      "request.json",
    ])
      if (names.includes(name)) await unlink(join(root, name));
    await unlink(join(root, ".receipt-connection"));
    await rmdir(root);
    console.log(JSON.stringify({ destroyed: true }));
    return;
  }
  const envelopeText =
    command === "complete-stdin"
      ? await readStdin()
      : await readFile(args[0], "utf8");
  const envelope = JSON.parse(envelopeText);
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
