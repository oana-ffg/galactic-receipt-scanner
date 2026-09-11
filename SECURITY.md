# Security boundaries

Galactic receipt scanner is one private installation per owner. Sites' saved visitor
policy must remain owner-only. The Worker additionally denies requests without the
Sites-authenticated user ID and exact configured owner email, or on an unexpected origin.
Missing configuration fails closed. Real account settings live in hosted environment
values and the ignored instance manifest, never public source.

The trusted boundary is the Sites dispatcher. It authenticates users and supplies identity
headers. A directly exposed Worker that accepts those headers from callers is unsafe.
Do not add direct Worker routes, public R2 access, anonymous file links, bypass tokens,
client-side owner checks, or first-visitor ownership. Changes to this model need explicit
owner direction and a new access review.

All API responses and downloads use no-store, attachment downloads and nosniff. Mutations
require an exact same-origin request and a custom header; cross-origin access is denied.
Uploads are bounded and IDs validated. Raw objects and artifact revisions are immutable,
content-addressed and private. Untrusted text is rendered as text, never HTML. Models and
WASM are served from the Site; receipt images are not sent to external inference hosts.

OpenCV requires dynamically generated JavaScript bindings. Only the isolated image-worker
response permits `unsafe-eval`; the document retains a strict script policy. The worker
has no DOM and can connect only to this origin.

The browser is an authenticated owner client. Its image-quality metadata is not an
independent server or forensic certification. Model-based checks and OCR can be wrong;
retain originals and uncertainties. The system trusts the owner to decide which generated
artifacts to store. Downloaded PDFs can contain active content if an owner uploads such
content; only generated image PDFs are produced by the capture client.

The in-memory synthetic development dispatcher is loopback-only and is excluded from the
Worker bundle. Tests exercise negative identities, origins, sensitive routes, upload
conflicts, incomplete finalization and camera leases. Deployment verification must also
exercise the actual Sites gateway; local tests cannot establish gateway header handling.

Sites and its infrastructure operators retain administrative access. This application
does not provide end-to-end encryption against the hosting provider. Keep a separate
backup of receipts and reports. Never report security guarantees beyond the checked scope.
