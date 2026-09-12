/** Track frames presented by a camera stream, independently of playback statistics. */
export class CameraFrames {
  readonly confirmed: boolean;
  private sequence = 0;
  private consumed: number | undefined;
  private callback: number | undefined;

  constructor(private video: HTMLVideoElement) {
    this.confirmed = typeof video.requestVideoFrameCallback === "function";
    if (this.confirmed) {
      const presented = () => {
        this.sequence++;
        this.callback = video.requestVideoFrameCallback(presented);
      };
      this.callback = video.requestVideoFrameCallback(presented);
    }
  }

  take(): boolean {
    const frame = this.confirmed ? this.sequence : this.video.currentTime;
    if ((this.confirmed && frame === 0) || frame === this.consumed)
      return false;
    this.consumed = frame;
    return true;
  }

  get presentedFrames(): number | undefined {
    return this.confirmed ? this.sequence : undefined;
  }

  close() {
    if (this.callback !== undefined)
      this.video.cancelVideoFrameCallback(this.callback);
  }
}
