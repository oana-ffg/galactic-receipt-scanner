import type { ScanState } from "./types";

/** Compare transport snapshots only within the server's current camera lease. */
export class StateOrder {
  private camera: string | null = null;
  private revision = -1;
  setCamera(camera: string | null) {
    if (camera !== this.camera) {
      this.camera = camera;
      this.revision = -1;
    }
  }
  accept(state: ScanState): boolean {
    if (state.cameraId !== undefined && state.cameraId !== this.camera)
      return false;
    if (
      state.cameraId === undefined ||
      !Number.isSafeInteger(state.stateRevision)
    )
      return this.revision < 0;
    if (state.stateRevision! < 0 || state.stateRevision! < this.revision)
      return false;
    this.revision = state.stateRevision!;
    return true;
  }
}
