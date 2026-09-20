import { api } from "./api";
import { messageOf } from "./errors";

interface Connection {
  id: string;
  name: string;
  scope: string;
  created_at: number;
  expires_at: number;
  revoked_at: number | null;
  last_used_at: number | null;
}

export async function mountAgentAccess(app: HTMLElement) {
  app.innerHTML = `<header><h1>Agent access</h1><a href="/">Capture station</a><a href="/review">Review receipts</a></header>
    <main class="agent-access"><p>Connect a processing worker or a read-only backup. Each connection can be revoked separately.</p>
    <p id="connection-status" role="status"></p>
    <section><h2>Connect a worker</h2><p>Have your agent prepare a connection request, then approve it here or ask the agent to use this page’s site tools. Only the requesting worker can unlock the response.</p>
    <label>Connection request file <input id="connection-file" type="file" accept="application/json,.json"></label>
    <p id="connection-summary"></p><button id="connection-create" disabled>Approve connection</button>
    <a id="connection-download" hidden download="connection-response.json">Download encrypted response</a></section>
    <section><h2>Connections</h2><button id="connection-refresh" class="secondary">Refresh</button><div id="connection-list"></div><button id="connection-more" class="secondary" hidden>Load older connections</button></section></main>`;
  const status = app.querySelector<HTMLElement>("#connection-status")!;
  const list = app.querySelector<HTMLElement>("#connection-list")!;
  const create = app.querySelector<HTMLButtonElement>("#connection-create")!;
  const download = app.querySelector<HTMLAnchorElement>(
    "#connection-download",
  )!;
  let request: Record<string, unknown> | undefined;
  let blobUrl: string | undefined;
  let next: string | null = null;
  const more = app.querySelector<HTMLButtonElement>("#connection-more")!;
  const refresh = async (append = false) => {
    const value = await api<{
      connections: Connection[];
      ready: boolean;
      next: string | null;
    }>(
      "/api/connections" +
        (append && next ? `?before=${encodeURIComponent(next)}` : ""),
    );
    status.textContent = value.ready
      ? "Connections are available."
      : "Ask your setup agent to configure Sites access before connecting a worker.";
    if (!append) list.replaceChildren();
    next = value.next;
    more.hidden = !next;
    for (const connection of value.connections) {
      const row = document.createElement("div");
      row.className = "connection-row";
      const text = document.createElement("p");
      text.textContent = `${connection.name} · ${connection.scope === "backup" ? "Read-only backup" : "Receipt processing"} · ${connection.revoked_at ? "Revoked" : connection.expires_at <= Date.now() ? "Expired" : "Active"} · expires ${new Date(connection.expires_at).toLocaleString()} · last used ${connection.last_used_at ? new Date(connection.last_used_at).toLocaleString() : "Never"}`;
      row.append(text);
      if (!connection.revoked_at && connection.expires_at > Date.now()) {
        const button = document.createElement("button");
        button.textContent = "Revoke";
        button.className = "secondary";
        button.onclick = () =>
          void perform(async () => {
            button.disabled = true;
            await revokeConnection(connection.id);
            await refresh();
          });
        row.append(button);
      }
      list.append(row);
    }
    if (!append && !value.connections.length)
      list.textContent = "No connections yet.";
  };
  const perform = async (task: () => Promise<unknown>) => {
    try {
      await task();
    } catch (error) {
      status.textContent = messageOf(error);
    }
  };
  more.onclick = () =>
    void perform(async () => {
      more.disabled = true;
      try {
        await refresh(true);
      } finally {
        more.disabled = false;
      }
    });
  const provision = async (input: Record<string, unknown>) => {
    return api<object>("/api/connections", {
      method: "POST",
      body: JSON.stringify(input),
    });
  };
  const revokeConnection = async (id: string) => {
    return api<{ revoked: boolean }>(
      `/api/connections/${encodeURIComponent(id)}/revoke`,
      { method: "POST", body: "{}" },
    );
  };
  app.querySelector<HTMLInputElement>("#connection-file")!.onchange = (event) =>
    void perform(async () => {
      request = undefined;
      create.disabled = true;
      const file = (event.target as HTMLInputElement).files?.[0];
      if (!file) return;
      if (file.size > 16384) throw Error("Connection request is too large.");
      const value = JSON.parse(await file.text());
      if (value.origin !== location.origin || !value.request?.public_key)
        throw Error(
          "Request belongs to a different Site or is not a connection request.",
        );
      request = value.request;
      app.querySelector<HTMLElement>("#connection-summary")!.textContent =
        `${request!.name} · ${request!.scope} · ${request!.days} day(s)`;
      create.disabled = false;
    });
  create.onclick = () =>
    void perform(async () => {
      if (!request) return;
      create.disabled = true;
      try {
        const result = await provision(request);
        await refresh();
        if (blobUrl) URL.revokeObjectURL(blobUrl);
        blobUrl = URL.createObjectURL(
          new Blob([JSON.stringify(result)], { type: "application/json" }),
        );
        download.href = blobUrl;
        download.hidden = false;
      } finally {
        create.disabled = false;
      }
    });
  app.querySelector<HTMLButtonElement>("#connection-refresh")!.onclick = () =>
    void perform(refresh);
  const context = (
    document as unknown as {
      modelContext?: { registerTool: (tool: object) => void };
    }
  ).modelContext;
  context?.registerTool({
    name: "create_processing_connection",
    description:
      "Authorize a named processing or read-only backup connection using the signed-in owner session. Input must be the public request from receipt_connection.mjs. Returns encrypted credentials decryptable only by the requesting worker, never plaintext keys. Creating access is a write action.",
    inputSchema: {
      type: "object",
      properties: {
        request_id: { type: "string" },
        name: { type: "string" },
        scope: { enum: ["processing", "backup"] },
        days: { type: "integer", minimum: 1, maximum: 365 },
        public_key: { type: "object" },
      },
      required: ["request_id", "name", "scope", "days", "public_key"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: provision,
  });
  context?.registerTool({
    name: "revoke_processing_connection",
    description:
      "Revoke one exact processing or backup connection through the signed-in owner session. Use the connection ID returned when that connection was created. Revocation is a write action.",
    inputSchema: {
      type: "object",
      properties: {
        connection_id: { type: "string", format: "uuid" },
      },
      required: ["connection_id"],
      additionalProperties: false,
    },
    annotations: { readOnlyHint: false },
    execute: (input: { connection_id: string }) =>
      revokeConnection(input.connection_id),
  });
  context?.registerTool({
    name: "list_processing_connections",
    description:
      "List 50 connection names, scopes, expiry, revocation and last use without secret values. Follow next using before for older connections.",
    inputSchema: {
      type: "object",
      properties: { before: { type: "string" } },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
    execute: (input: { before?: string }) =>
      api(
        "/api/connections" +
          (input.before ? `?before=${encodeURIComponent(input.before)}` : ""),
      ),
  });
  await perform(refresh);
}
