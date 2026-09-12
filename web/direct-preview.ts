import { api } from "./api";
import type { ScanState } from "./types";
import { isControlCommand } from "./control-command";

export interface PreviewSession {
  id: string;
  offer: RTCSessionDescriptionInit;
  answer?: RTCSessionDescriptionInit;
}

// Signalling is owner-authorized by the Site. No external STUN/TURN servers:
// try a direct network path, with the authenticated HTTP preview as fallback.
export class DirectPreview {
  private peer: RTCPeerConnection | null = null;
  private channel: RTCDataChannel | null = null;
  private camera = "";
  private session = "";
  private busy = false;
  private retryAt = 0;
  private lastMessage = 0;
  private started = 0;
  private renewedAt = 0;
  private lastState: ScanState | undefined;
  constructor(
    private receiveState: (state: ScanState) => void,
    private receiveCommand: (command: string) => void,
    private receiveVideo: (stream: MediaStream | null) => void,
  ) {}
  get connected() {
    return (
      this.peer?.connectionState === "connected" &&
      this.channel?.readyState === "open"
    );
  }
  get fresh() {
    return this.connected && performance.now() - this.lastMessage < 3000;
  }
  close() {
    const peer = this.peer;
    this.peer = null;
    this.channel = null;
    peer?.close();
    this.receiveVideo(null);
    this.camera = "";
    this.session = "";
    this.lastMessage = 0;
  }
  sendState(state: ScanState) {
    this.lastState = state;
    this.send({ state });
  }
  command(command: string) {
    return this.fresh && this.send({ command });
  }
  private send(message: object): boolean {
    if (!this.connected || this.channel!.bufferedAmount > 16000) return false;
    try {
      this.channel!.send(JSON.stringify(message));
      return true;
    } catch {
      return false;
    }
  }
  private attach(channel: RTCDataChannel, peer: RTCPeerConnection) {
    this.channel = channel;
    channel.onopen = () => {
      if (this.lastState) this.sendState(this.lastState);
    };
    channel.onmessage = (event) => {
      if (
        this.peer !== peer ||
        typeof event.data !== "string" ||
        event.data.length > 16000
      )
        return;
      try {
        const message = JSON.parse(event.data);
        this.lastMessage = performance.now();
        if (message.state?.type === "state") this.receiveState(message.state);
        if (isControlCommand(message.command))
          this.receiveCommand(message.command);
      } catch {
        /* Ignore malformed messages; the HTTP path remains available. */
      }
    };
  }
  private create(camera: string, session: string) {
    this.close();
    this.camera = camera;
    this.session = session;
    this.started = performance.now();
    const peer = new RTCPeerConnection({ iceServers: [] });
    this.peer = peer;
    peer.ondatachannel = (event) => this.attach(event.channel, peer);
    peer.ontrack = (event) => {
      if (this.peer === peer) this.receiveVideo(new MediaStream([event.track]));
    };
    return peer;
  }
  private async description(peer: RTCPeerConnection) {
    if (peer.iceGatheringState !== "complete")
      await new Promise<void>((resolve) => {
        const finish = () => {
          clearTimeout(timer);
          peer.removeEventListener("icegatheringstatechange", check);
          resolve();
        };
        const check = () => {
          if (peer.iceGatheringState === "complete") finish();
        };
        const timer = setTimeout(finish, 2000);
        peer.addEventListener("icegatheringstatechange", check);
        check();
      });
    if (this.peer !== peer || !peer.localDescription)
      throw new Error("Preview session changed.");
    return peer.localDescription.toJSON();
  }
  async sync(
    camera: string | null,
    session: PreviewSession | null,
    stream?: MediaStream,
  ) {
    if (!camera) {
      this.close();
      return;
    }
    if (
      this.busy ||
      performance.now() < this.retryAt ||
      !window.RTCPeerConnection
    )
      return;
    this.busy = true;
    try {
      if (stream) {
        if (!session || (this.camera === camera && this.session === session.id))
          return;
        const peer = this.create(camera, session.id);
        await peer.setRemoteDescription(session.offer);
        const track = stream.getVideoTracks()[0];
        const sender = peer.addTrack(track, stream);
        await peer.setLocalDescription(await peer.createAnswer());
        const parameters = sender.getParameters();
        if (parameters.encodings?.length) {
          parameters.encodings[0].maxBitrate = 1200000;
          parameters.encodings[0].maxFramerate = 15;
          parameters.encodings[0].scaleResolutionDownBy = Math.max(
            1,
            Math.max(
              track.getSettings().width ?? 800,
              track.getSettings().height ?? 800,
            ) / 800,
          );
          await sender.setParameters(parameters);
        }
        const answer = await this.description(peer);
        await api("/api/station/direct-preview", {
          method: "POST",
          body: JSON.stringify({ camera, id: session.id, answer }),
        });
      } else if (
        this.camera !== camera ||
        !this.peer ||
        this.peer.connectionState === "failed" ||
        (!this.connected && performance.now() - this.started > 15000)
      ) {
        const id = crypto.randomUUID();
        const peer = this.create(camera, id);
        peer.addTransceiver("video", { direction: "recvonly" });
        this.attach(peer.createDataChannel("station"), peer);
        await peer.setLocalDescription(await peer.createOffer());
        const offer = await this.description(peer);
        await api("/api/station/direct-preview", {
          method: "POST",
          body: JSON.stringify({ camera, id, offer }),
        });
      } else if (
        session?.id === this.session &&
        session.answer &&
        !this.peer.remoteDescription
      ) {
        await this.peer.setRemoteDescription(session.answer);
      } else if (this.connected && performance.now() - this.renewedAt > 5000) {
        await api("/api/station/direct-preview", {
          method: "POST",
          body: JSON.stringify({ camera, id: this.session, renew: true }),
        });
        this.renewedAt = performance.now();
      }
    } catch {
      this.close();
      this.retryAt = performance.now() + 10000;
    } finally {
      this.busy = false;
    }
  }
}
