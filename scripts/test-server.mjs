// Loopback-only synthetic dispatcher. Never part of the deployment bundle.
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pathToFileURL } from "node:url";
import { runtime, ownerHeaders } from "./test-runtime.mjs";

export async function startTestServer(port = 0) {
  let mf;
  let origin;
  const server = createServer(async (req, res) => {
    if (!mf) {
      res.writeHead(503);
      res.end("Test runtime starting.");
      return;
    }
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
    } catch (error) {
      console.error(error);
      res.writeHead(500);
      res.end("Test runtime failed.");
    }
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  origin = `http://127.0.0.1:${server.address().port}`;
  try {
    mf = await runtime({
      appOrigin: origin,
      sitesGatewayToken: "synthetic-gateway",
    });
  } catch (error) {
    await new Promise((resolve) => server.close(resolve));
    throw error;
  }
  return {
    origin,
    async close() {
      server.closeAllConnections();
      await new Promise((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
      await mf.dispose();
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const instance = await startTestServer(8766);
  console.log("Synthetic test server: " + instance.origin);
  process.on("SIGTERM", () => {
    void instance.close().then(() => process.exit());
  });
}
