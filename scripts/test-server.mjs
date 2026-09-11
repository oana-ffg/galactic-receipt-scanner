// Loopback-only synthetic dispatcher for browser tests. Never part of the deployment bundle.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { runtime, origin, ownerHeaders } from "./test-runtime.mjs";
const mf = await runtime();
const server = createServer(async (req, res) => {
  try {
    const headers = new Headers();
    for (const [key, value] of Object.entries(req.headers))
      if (value)
        headers.set(key, Array.isArray(value) ? value.join(",") : value);
    for (const [key, value] of Object.entries(ownerHeaders))
      headers.set(key, value);
    const response = await mf.dispatchFetch(new URL(req.url, origin), {
      method: req.method,
      headers,
      body: ["GET", "HEAD"].includes(req.method)
        ? undefined
        : Readable.toWeb(req),
      duplex: "half",
    });
    res.writeHead(response.status, Object.fromEntries(response.headers));
    if (response.body) Readable.fromWeb(response.body).pipe(res);
    else res.end();
  } catch (e) {
    console.error(e);
    res.writeHead(500);
    res.end("Test runtime failed.");
  }
});
server.listen(8766, "127.0.0.1", () =>
  console.log("Synthetic test server: " + origin),
);
process.on("SIGTERM", () => {
  server.close();
  void mf.dispose().then(() => process.exit());
});
