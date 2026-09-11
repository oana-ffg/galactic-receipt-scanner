"""Pure capture state machine. Only persisted captures may enter green."""

from dataclasses import dataclass, field
from uuid import uuid4


@dataclass
class CaptureState:
    paused: bool = True
    phase: str = "red"
    message: str = "Connect the phone, then start scanning."
    active_id: str | None = None
    armed: bool = True
    stable_since: float | None = None
    absent_since: float | None = None
    stable_frames: int = 0
    last_quad: list[list[float]] | None = None
    last_seen: float = 0
    capture_started: float = 0
    last_saved: str | None = None
    error_latched: bool = False
    quality: dict = field(default_factory=dict)

    def reset_stability(self) -> None:
        self.stable_since = None
        self.stable_frames = 0
        self.last_quad = None

    def control(self, action: str) -> None:
        if self.active_id:
            raise ValueError("Wait for the current capture to finish.")
        if action == "pause":
            self.paused = True
            self.phase, self.message = "red", "Paused."
        elif action in {"start", "retry"}:
            self.paused = False
            self.error_latched = False
            if action == "retry":
                self.armed = True
            self.phase, self.message = "red", "Place one receipt on the dark background."
        else:
            raise ValueError("Unknown control.")
        self.reset_stability()

    def observe(self, detection: dict, now: float) -> str | None:
        self.last_seen = now
        self.quality = detection
        if self.active_id or self.paused or self.error_latched:
            return None
        # A hand/noisy boundary is not removal. Require a clearly empty, still desk.
        if not self.armed:
            self.phase = "green"
            self.message = "Saved on this computer. Remove the receipt, then next."
            if detection.get("empty"):
                if self.absent_since is None:
                    self.absent_since = now
                if now - self.absent_since >= 0.45:
                    self.armed = True
                    self.reset_stability()
                    self.phase, self.message = "red", "Ready for the next receipt."
            else:
                self.absent_since = None
            return None
        if not detection.get("ok"):
            self.reset_stability()
            self.phase, self.message = "red", detection["reason"]
            return None
        quad = detection["quad"]
        changed = (
            self.last_quad is None
            or max(
                abs(a - b)
                for previous, current in zip(self.last_quad, quad, strict=True)
                for a, b in zip(previous, current, strict=True)
            )
            > 0.012
        )
        if changed or detection.get("motion", 0) > 3.5:
            self.stable_since, self.stable_frames = now, 0
        self.last_quad = quad
        self.stable_frames += 1
        self.phase, self.message = "amber", "Hold still—checking the receipt."
        if self.stable_since is None:
            self.stable_since = now
        if now - self.stable_since >= 0.9 and self.stable_frames >= 4:
            self.active_id = str(uuid4())
            self.capture_started = now
            self.message = "Capturing and saving—do not move the receipt."
            return self.active_id
        return None

    def saved(self, capture_id: str) -> None:
        if capture_id != self.active_id:
            raise ValueError("Capture is no longer active.")
        self.last_saved = capture_id
        self.error_latched = False
        self.active_id = None
        self.armed = False
        self.absent_since = None
        self.phase, self.message = "green", "Saved on this computer. Remove the receipt, then next."
        self.reset_stability()

    def failed(self, message: str) -> None:
        self.active_id = None
        self.phase, self.message = "red", message
        self.error_latched = True
        self.reset_stability()

    def disconnected(self) -> None:
        self.reset_stability()
        self.phase, self.message = "red", "Phone disconnected. Reconnect before moving on."

    def public(self) -> dict:
        return {
            "phase": self.phase,
            "message": self.message,
            "paused": self.paused,
            "activeId": self.active_id,
            "lastSaved": self.last_saved,
            "armed": self.armed,
            "quality": self.quality,
        }
