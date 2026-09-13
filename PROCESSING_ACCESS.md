# Direct receipt processing access

The Site remains owner-private. Browser capture uses Sites owner identity and the existing
same-origin checks. Optional machine access uses two credentials: a platform Sites access
token in `OAI-Sites-Authorization` and a scanner processing token in `Authorization`.
No model API is called by the server or client.

## Provision one private instance

1. Resolve `.openai/hosting.json` and read its Site metadata. Confirm the exact origin,
   owner role and owner-only visitor policy. Preserve any existing platform token; generating
   another rotates it and invalidates clients using the old one. Request a new Sites bypass
   token only when the owner asks for that setup and no usable token exists.
2. Generate a cryptographically random 32-byte URL-safe token, without base64 padding,
   prefixed `rsc_`. Store only its lowercase SHA-256 as the secret runtime value
   `PROCESSING_TOKEN_SHA256` through Sites environment management. Leave other settings alone.
   Deploy the reviewed version to apply the setting. Absence of this setting disables
   machine access and does not affect owner browser capture.
3. Store a JSON credential object with keys `origin`, `sites_token`, `processing_token`
   in the owner's authorized secret store. On a local gopass host, create an agreed entry
   using a direct input pipe, with no secrets in shell arguments or printed output.
4. Write only `origin` and `gopass_entry` to ignored `.local/processing-access.json`.
   Keep instance addresses and entry names out of public source. The client requires Python 3
   and gopass on PATH, with access to the host's normal credential agent.
5. Run `python3 scripts/receipt_api.py status`, then list captures and download one original.
   Verify its hash and scan timestamp against metadata. Production verification is read-only;
   test write/read-back, conflicts and bad credentials with isolated synthetic storage.
6. Verify anonymous, forged-identity and incorrect-token requests cannot retrieve data.
   Verify processing credentials cannot call capture uploads, station controls or private issues.
   Confirm the saved visitor policy remains owner-only. The gateway token alone must not
   authorize processing routes without either the owner session or scanner credential.

## Work and other hosts

The same client supports `--credentials-stdin`: an authorized secret provider pipes the
credential JSON directly to stdin. This does not require gopass or a private config file.
Verify that host's secret facility and network access before scheduling anything. Browser
sign-in/password storage is not proof that shell scripts can obtain credentials. Never
put tokens in chat, source, a command argument, a shared project file or model-visible output.

MCP is not installed by this change. An MCP adapter can reuse the processing routes later;
it must solve its own supported authentication and unattended write permission path.

## Scope and rotation

Machine GET access: captures, raw/image/PDF/OCR downloads, documents, document history/PDFs,
and `/api/processing/access`. Machine POST access: versioned documents, document PDFs,
and immutable capture OCR artifacts. All other routes/methods are denied, including capture
upload/finalization, image replacement, camera control, private issues and UI/assets.
Server validation, original preservation and optimistic document revisions remain in force.

The processing credential belongs to the owner and authorizes reading all receipt data and
editing processing decisions. Treat it accordingly. Rotate by replacing the secret-store token
and hosted hash, then deploying and verifying the new token works and the old one fails.
Removing the hosted hash disables machine access after deployment. Platform-token rotation is
separate. There is one processing credential per instance in this version; per-agent keys and
revocation records are not implemented.

## Current capabilities

The client handles transport, resumable hash-verified image retrieval and existing document
writes. `/api/processing/access` advertises the actual capabilities. It does not yet provide
shared queue leases, a category registry or the new two-model human-review UI. Preserve new
extraction metadata in immutable artifacts and the private ledger until that rollout; do not
claim those fields exist in the current document schema or activate unattended overlapping runs.
