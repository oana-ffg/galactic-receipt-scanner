import pytest

from server.state import CaptureState

GOOD = {"ok": True, "quad": [[0.2, 0.1], [0.8, 0.1], [0.8, 0.9], [0.2, 0.9]], "motion": 0}


def trigger(state, start=10):
    result = None
    for step in range(9):
        result = state.observe(GOOD, start + step * 0.15) or result
    return result


def test_stability_capture_save_and_removal():
    state = CaptureState()
    assert trigger(state) is None  # paused by default
    state.control("start")
    capture_id = trigger(state)
    assert capture_id and state.phase == "amber"
    assert state.last_saved is None
    state.saved(capture_id)
    assert state.phase == "green"
    assert trigger(state, 20) is None  # stationary paper is never scanned twice
    state.observe({"ok": False, "empty": False, "reason": "hands"}, 30)
    assert not state.armed  # a hand is not evidence that the receipt was removed
    state.observe({"ok": False, "empty": True}, 31)
    state.observe({"ok": False, "empty": True}, 31.5)
    assert trigger(state, 32) is not None


def test_failure_requires_explicit_retry_and_never_green():
    state = CaptureState(paused=False)
    trigger(state)
    state.failed("Disk unavailable")
    assert state.phase == "red"
    assert trigger(state, 40) is None
    state.control("retry")
    assert trigger(state, 50)


def test_wrong_ack_cannot_turn_green():
    state = CaptureState(paused=False)
    trigger(state)
    with pytest.raises(ValueError):
        state.saved("wrong-id")
    assert state.phase == "amber"


def test_motion_and_disconnect_reset_settling_period():
    state = CaptureState(paused=False)
    state.observe(GOOD, 10)
    state.observe(GOOD, 10.8)
    state.disconnected()
    assert state.observe(GOOD, 12) is None
    assert state.phase == "amber"
    moving = {**GOOD, "motion": 9}
    assert all(state.observe(moving, 13 + i * 0.2) is None for i in range(20))


def test_controls_cannot_interrupt_an_active_save():
    state = CaptureState(paused=False)
    trigger(state)
    with pytest.raises(ValueError):
        state.control("retry")
