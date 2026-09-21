# Agent connections

The Site remains owner-private. Signed-in browser access uses the Sites owner identity.
Machine requests use a Sites gateway token in `OAI-Sites-Authorization` plus a scoped
scanner credential in `Authorization`. The server calls the pinned Jev model after
PP-OCR upload; the client never receives the TypeSafe key.

## Instance setup

Resolve `.openai/hosting.json` and the Site's metadata using the owner's Sites tools.
Confirm the exact origin and owner-only visitor policy. Preserve the existing Sites
access token: generating another rotates it and invalidates existing connections.
Request a new token only when the owner authorizes provisioning and none exists.

Set `SITES_GATEWAY_TOKEN` as a **secret** runtime environment value using that existing
Sites token, passing it directly between tools without printing it. Deploy the reviewed
version to apply the environment change. Never export browser cookies or put a token in
source, prompts, command arguments, logs, or an environment file. Keep the deployed
Worker behind Sites; its owner headers are trusted only through that gateway.

This secret lets the owner authorize encrypted connection bundles from the signed-in
site. It is not a new public endpoint or a change to the Site audience. The gateway
credential alone does not authorize scanner data access.

## Connect a processing host

1. Use the [data-access skill](.agents/skills/receipt-data-access/SKILL.md). The Node helper
   creates a host-local RSA key pair and a public request bound to the Site and purpose.
2. Terra uses `create_processing_connection` on `/agent-access`. The owner can instead
   upload the request file on that page and download its encrypted response. Both paths
   use the same owner-authorized route and validations.
3. The response uses RSA-OAEP/SHA-256 to wrap an AES-256-GCM key. Only the requesting
   host can decrypt the credential bundle; browser/model-visible results contain ciphertext.
   Repeating the exact request returns the same response, not a second credential.
4. Complete the handoff with the helper. The Python API client reads its private config,
   which points to the private credential file. There is **no gopass dependency**. POSIX
   permissions are checked; on Windows use a user-private directory with an appropriate ACL.
5. For a scheduled Luna batch, pass this fresh config to the controller, then revoke the
   exact connection and destroy its private connection directory at the end of the run.
   Test writes, revocation and wrong credentials only against synthetic isolated storage.

Credentials can last 1–365 days, as requested when connecting. Scheduled Luna processing
uses a new one-day connection per batch, revokes it at terminal cleanup, and deletes the
temporary local plaintext files only after revocation is confirmed; one day is the crash
fallback, not the expected lifetime. The owner manages named
connections, scope, expiry, last use and revocation on `/agent-access`. The server stores
only the scanner credential's hash, plus an encrypted handoff response for safe retries.
Revocation/expiry applies to every subsequent authenticated request. In-flight operations
already authorized may finish. Last-use timestamps update at most hourly.

## Scope

- **Processing:** capture/original/artifact reads, document/context/category reads, shared
  queue claims, drafts/submission, supported detach, immutable OCR and PDF operations,
  and Jev status/backfill reads and writes.
- **Backup:** GET-only capture history/metadata and original bytes; no processing writes.
- Neither credential permits camera uploads, station controls, private issues, arbitrary
  document writes, human approval, or creating/revoking other connections.

The old `PROCESSING_TOKEN_SHA256` setting remains temporarily supported for existing
clients during migration. Remove it only after its users have migrated and new access is
verified. Legacy clients need the new private-file config or an explicitly authorized
stdin provider; there is no implicit personal secret-store lookup.

Rotating Sites' gateway token requires updating this runtime secret and reconnecting
clients. Existing encrypted responses contain the old gateway token; they cannot repair
that rotation automatically. Individual scanner connections can be revoked without
rotating the shared gateway token or affecting other connections.

## Runtime and scheduling

Terra coordinates using compact metadata and authorizes access through WebMCP. Fresh
Luna workers inspect images, with independent Astra workers reviewing exceptions.
OCR production and PDF consumption are separate host roles outside the capture/save path.
The OCR host uses `.local/receipt-ocr-host.json` and may run PP-OCR; the Luna processing
host uses `.local/processing-host.json`, contains no OCR runtime, and only consumes exact
saved PP artifacts while generating PDFs. Count complete documents, including all their
pages, toward the batch limit.

The scheduled OCR runner drains Jev after its OCR attempts and requires two stable
zero-work responses before reporting full success. For an explicit standalone repair,
run `python scripts/receipt_api.py --config PRIVATE_CONFIG jev-backfill`. It queues only
the latest PP-OCR artifact for each current capture and processes retryable jobs one at a
time. Inspect `/api/jev/documents?disagreements=1`
before accepting any Jev/Luna category or document-role disagreement. This endpoint is
paginated: follow every non-null `next` value with `after`, even when a filtered page's
`documents` array is empty, until `next` is null.

Current development and verification are local Codex. Cloud Work remains the deployment
target; its browser tool support, private credential persistence and scheduled managed
worker spawning require later end-to-end validation. WebMCP does not itself provide a
persistent secret vault. A remote MCP server is not required by this design.

## Optional personal backup

`scripts/receipt_backup.py` creates append-only originals and metadata snapshots on an
explicitly mounted external volume. It enumerates all takes, verifies every original,
resumes verified files and reports missing remote captures without deleting local copies.
A partial run is a failure even though successfully verified files remain available.
Use `--credentials-stdin` with an authorized private provider, or a private connection
config. Personal scheduler and secret-store configuration belongs outside Git.

This backup command requires a POSIX host (Linux/macOS) and a filesystem supporting
Unix ownership, private permissions, no-follow file opens and file locking. Native
Windows is unsupported and is rejected before credentials are read or files written.
Its filesystem tests run on POSIX; Windows runs the platform-rejection tests instead.
