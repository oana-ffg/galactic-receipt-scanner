import type { ServerMessage } from "./types";

const fragment = new URLSearchParams(location.hash.slice(1));
if (fragment.has("key")) {
  localStorage.setItem("receipt-scanner-key", fragment.get("key")!);
  history.replaceState(null, "", location.pathname + location.search);
}
export const token = localStorage.getItem("receipt-scanner-key") ?? "";

export async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: { Authorization: `Bearer ${token}`, ...init.headers },
    signal: init.signal ?? AbortSignal.timeout(35000),
  });
  if (!response.ok) {
    const error = await response
      .json()
      .catch(() => ({ detail: `HTTP ${response.status}` }));
    throw new Error(String(error.detail ?? "Request failed."));
  }
  return response.json() as Promise<T>;
}

export class Connection {
  socket: WebSocket | null = null;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;
  constructor(
    private role: "camera" | "dashboard",
    private onMessage: (message: ServerMessage | Blob) => void,
    private onConnection: (connected: boolean, reason?: string) => void,
  ) {}

  start(): void {
    this.stopped = false;
    this.connect();
  }

  private connect(): void {
    if (this.stopped) return;
    const protocol = location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${location.host}/ws`);
    this.socket = socket;
    socket.onopen = () => {
      socket.send(JSON.stringify({ role: this.role, token }));
    };
    socket.onmessage = (event: MessageEvent<Blob | string>) => {
      if (event.data instanceof Blob) this.onMessage(event.data);
      else {
        const message = JSON.parse(event.data) as ServerMessage;
        if (message.type === "state") this.onConnection(true);
        this.onMessage(message);
      }
    };
    socket.onclose = (event) => {
      const permanent = [4400, 4401, 4409].includes(event.code);
      this.onConnection(
        false,
        event.code === 4409
          ? "Another phone is connected. Close its camera page first."
          : event.code === 4401
            ? "Pairing key rejected. Open the current launch link."
            : "Connection lost. Reconnecting…",
      );
      if (!permanent && !this.stopped)
        this.retry = setTimeout(() => this.connect(), 1500);
    };
    socket.onerror = () => socket.close();
  }

  send(data: Blob | object): boolean {
    if (
      this.socket?.readyState !== WebSocket.OPEN ||
      this.socket.bufferedAmount > 400000
    )
      return false;
    this.socket.send(data instanceof Blob ? data : JSON.stringify(data));
    return true;
  }

  close(): void {
    this.stopped = true;
    clearTimeout(this.retry);
    this.socket?.close();
  }
}
