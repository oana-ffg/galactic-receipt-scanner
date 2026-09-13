# Private capture diagnostics

Report an issue while the problem is visible. Reports freeze bounded recent numeric
histories from that device. Phone save and removal summaries travel with scan state,
so desktop reports include them too. No diagnostic history stores image pixels,
receipt text, request bodies, credentials or arbitrary server headers.

## Save timing

`saveHistory` contains capture, upload-retry, recovery-resend and background-verification records.
`at` identifies the attempt on the phone; `kind`, `outcome`, `status`, `bytes` and
`failedStage` distinguish successful uploads, failures and verification. Each attempt carries its last four individual HTTP request records (`save.request`),
so a missing-record response, resend and successful verification remain distinguishable.
Top-level request/server fields describe the last HTTP request, not their sum. Pending
records are partial observations, not additional completed saves. Deduplicate by
attempt timestamp and kind; do not count repeated scan-state timings as new saves.

- Before upload: pending inventory, still capture, initial original persistence,
  image decoding, quality checks and persistence of checked metadata.
- Request: time until response headers, JSON parsing, overall request duration,
  local source/metadata hashing and acknowledgement validation.
- Server: authorization, routing, request-body reception, source hashing,
  validation, retake lookup when needed, provenance validation, original storage,
  atomic database insert, retry lookup/readback when needed, acknowledgement and
  total handler time. These are numeric `Server-Timing` fields, including completed
  stages on error responses. Unsupported/older servers leave fields absent.
- After response: phone acknowledgement persistence, recovery inventory refresh,
  total save wait and total capture duration.
- Verification: local source hash, verification request/server readback, local
  deletion after success, and total verification duration.

**Durations overlap.** Local hashing runs alongside the upload. Server durations
are inside request time, and body reception can overlap network upload. Do not sum
all fields or call request time minus server time “upload time”: that remainder
also includes gateway/queueing, transit and response overhead. Server timer resolution
may produce zero for short CPU stages. Compare bytes, method and attempt outcome
alongside elapsed time. Instrumentation introduces no extra database/storage calls.

## Receipt removal

`removalHistory` samples brightness, segmentation, outline, hand checks, frame gaps
and the gate preventing rearming. `removalTransitions` retains gate/geometry/reset
changes separately so a short transition is not hidden by one-second sampling or
preview chatter. The phone carries its latest eight transitions in subsequent
states, including when the desktop missed the original update.

Per-cycle summaries retain qualifying-empty sample count, longest observed clear
interval, minimum brightness/coverage, longest observed interval without an outline,
and the last reset reason and interrupted clear duration. A clear duration ends at
the last qualifying observation; a later blind gap is never counted as clear.
These describe detector classifications, not proof the physical desk was empty.
Removal thresholds and confirmation rules are unchanged.

## Phone to desktop

`state.delivery` records phone emission, direct-channel send (when applicable),
desktop reception, revision acceptance and synchronous UI rendering duration.
Direct-channel clock probes estimate device offset and an uncertainty bound; the
estimate expires after 30 seconds. Uncalibrated/mixed-version sessions explicitly
report `clockSynced: false`. Never subtract raw device timestamps as latency.
HTTP state delivery can use a still-valid direct clock estimate; otherwise its
cross-device delay is unknown. Probe messages do not count as fresh scan state.

`preview.latency` uses browser-provided receiver-clock capture/receive/presentation
timestamps when available. Availability flags distinguish missing support from zero
delay. It is separate from state delivery and existing RTP/freeze/rate diagnostics.
Synchronous UI rendering completion is not proof that a frame has been painted.

General history is capped at 16 KB, removal samples at 12 KB, removal transitions
at 6 KB and save timing at 8 KB, each expiring after two minutes. Issue context must
remain below the server's 48 KB limit. These are bounded diagnostic windows, not a
complete session audit or a replacement for durable receipt records.
