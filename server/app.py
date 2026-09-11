import asyncio
import json
import logging
import secrets
import time
from concurrent.futures import ThreadPoolExecutor
from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import Depends, FastAPI, HTTPException, Request, WebSocket, WebSocketDisconnect
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from server.config import Settings, load_settings
from server.processing import process_capture, run_ocr
from server.state import CaptureState
from server.storage import Store
from server.vision import Detector, decode_image

logger = logging.getLogger(__name__)
MAX_CAPTURE_BYTES = 32 * 1024 * 1024
MAX_PREVIEW_BYTES = 400_000


def create_app(settings: Settings, detector_factory=Detector) -> FastAPI:
    store = Store(settings.data)
    state = CaptureState()
    viewers: set[WebSocket] = set()
    camera: WebSocket | None = None
    detector = None
    detector_error: str | None = None
    pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="vision")
    ocr_pool = ThreadPoolExecutor(max_workers=1, thread_name_prefix="ocr")
    upload_lock = asyncio.Lock()
    vision_lock = asyncio.Lock()
    ocr_queue: asyncio.Queue[str] = asyncio.Queue()
    queued_ocr: set[str] = set()

    def snapshot() -> dict:
        value = state.public()
        fresh = camera is not None and time.monotonic() - state.last_seen < 3.0
        value.update(
            type="state",
            cameraConnected=camera is not None,
            streamFresh=fresh,
            count=store.count(),
            detectorReady=detector is not None,
        )
        if detector_error:
            value.update(phase="red", message=detector_error)
        elif not fresh and not state.active_id:
            value.update(phase="red", message="Waiting for a live phone camera feed.")
        return value

    async def send(socket: WebSocket, payload: dict | bytes) -> bool:
        try:
            async with asyncio.timeout(2):
                if isinstance(payload, bytes):
                    await socket.send_bytes(payload)
                else:
                    await socket.send_json(payload)
            return True
        except (TimeoutError, RuntimeError, WebSocketDisconnect, OSError):
            return False

    async def broadcast(payload: dict | bytes, *, include_camera: bool = False):
        recipients = set(viewers)
        if include_camera and camera:
            recipients.add(camera)
        if recipients:
            await asyncio.gather(*(send(peer, payload) for peer in recipients))

    def queue_ocr(capture_id: str):
        if capture_id not in queued_ocr:
            queued_ocr.add(capture_id)
            ocr_queue.put_nowait(capture_id)

    async def ocr_worker():
        while True:
            capture_id = await ocr_queue.get()
            try:
                await asyncio.get_running_loop().run_in_executor(
                    ocr_pool, run_ocr, store, capture_id, settings.root / ".local" / "tessdata"
                )
                await broadcast({"type": "libraryChanged"})
            finally:
                queued_ocr.discard(capture_id)
                ocr_queue.task_done()

    async def watchdog():
        while True:
            await asyncio.sleep(1)
            if state.active_id and time.monotonic() - state.capture_started > 40:
                if not upload_lock.locked():
                    state.failed("Capture timed out. Keep the receipt and retry from the Mac.")
            await broadcast(snapshot(), include_camera=True)

    @asynccontextmanager
    async def lifespan(_app):
        nonlocal detector, detector_error
        try:
            detector = await asyncio.get_running_loop().run_in_executor(
                pool, detector_factory, settings.model
            )
        except Exception:
            logger.exception("Hand detector could not start")
            detector_error = (
                "Hand detector unavailable. Run setup and restart; automatic capture is blocked."
            )
        for capture_id in store.pending_ocr():
            queue_ocr(capture_id)
        worker = asyncio.create_task(ocr_worker())
        monitor = asyncio.create_task(watchdog())
        yield
        worker.cancel()
        monitor.cancel()
        await asyncio.gather(worker, monitor, return_exceptions=True)
        if detector:
            await asyncio.get_running_loop().run_in_executor(pool, detector.close)
        pool.shutdown(wait=True)
        ocr_pool.shutdown(wait=True)

    app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None, openapi_url=None)

    def authorized(request: Request):
        token = request.headers.get("authorization", "").removeprefix("Bearer ")
        if not secrets.compare_digest(token, settings.token):
            raise HTTPException(401, "Pair this browser using the project launch link.")

    @app.middleware("http")
    async def headers(request: Request, call_next):
        response = await call_next(request)
        response.headers.update(
            {
                "X-Content-Type-Options": "nosniff",
                "Referrer-Policy": "no-referrer",
                "Cache-Control": "no-store",
                "Permissions-Policy": "camera=(self), microphone=(), geolocation=()",
                "Content-Security-Policy": "default-src 'self'; script-src 'self'; "
                "style-src 'self'; "
                "img-src 'self' blob: data:; media-src 'self' blob:; connect-src 'self'; "
                "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
            }
        )
        return response

    @app.get("/health")
    async def health():
        return {"ok": True, "detectorReady": detector is not None}

    @app.get("/api/state", dependencies=[Depends(authorized)])
    async def current_state():
        return snapshot()

    @app.get("/api/captures", dependencies=[Depends(authorized)])
    async def captures():
        return {"captures": store.recent(), "count": store.count()}

    @app.get("/api/files/{capture_id}/{kind}", dependencies=[Depends(authorized)])
    async def capture_file(capture_id: UUID, kind: str):
        try:
            path = store.file(str(capture_id), kind)
            if not path.is_file():
                raise FileNotFoundError
        except FileNotFoundError:
            raise HTTPException(404, "File is not available yet.") from None
        return FileResponse(path, filename=path.name)

    @app.post("/api/control/{action}", dependencies=[Depends(authorized)])
    async def control(action: str):
        if action == "retry-upload":
            if camera is None:
                raise HTTPException(409, "Reconnect the phone first.")
            await send(camera, {"type": "retryUpload"})
            return {"sent": True}
        if detector is None:
            raise HTTPException(503, detector_error)
        try:
            state.control(action)
        except ValueError as error:
            raise HTTPException(409, str(error)) from error
        await broadcast(snapshot(), include_camera=True)
        return snapshot()

    @app.post("/api/ocr/{capture_id}", dependencies=[Depends(authorized)])
    async def retry_ocr(capture_id: UUID):
        record = store.get(str(capture_id))
        if not record or record["status"] != "accepted":
            raise HTTPException(404, "Accepted capture not found.")
        queue_ocr(str(capture_id))
        return {"queued": True}

    @app.post("/api/captures/{capture_id}", dependencies=[Depends(authorized)])
    async def upload(capture_id: UUID, request: Request):
        key = str(capture_id)
        if upload_lock.locked():
            raise HTTPException(409, "Another capture is being saved. Retry the same image.")
        async with upload_lock:
            previous = store.get(key)
            if state.active_id and key != state.active_id and not previous:
                raise HTTPException(
                    409, "A different capture is active. Retry this upload afterwards."
                )
            if detector is None:
                raise HTTPException(503, detector_error)
            data = bytearray()
            async for chunk in request.stream():
                data.extend(chunk)
                if len(data) > MAX_CAPTURE_BYTES:
                    state.failed("Image exceeds 32 MB. Reduce the camera resolution and retry.")
                    raise HTTPException(413, state.message)
            source = {"captureMethod": request.headers.get("x-capture-method", "unknown")[:80]}
            try:
                async with vision_lock:
                    result = await asyncio.get_running_loop().run_in_executor(
                        pool, process_capture, store, detector, key, bytes(data), source
                    )
                if result["status"] == "accepted":
                    # A persisted phone buffer can recover after a server restart. Its
                    # full-resolution image passes exactly the same quality gates.
                    if state.active_id is None:
                        state.active_id = key
                    if state.active_id == key:
                        state.saved(key)
                    if result["ocr_status"] in {"pending", "running"}:
                        queue_ocr(key)
                else:
                    if state.active_id in (key, None):
                        state.failed(
                            result["metadata"]["quality"]["reason"] + " Keep it and retry."
                        )
                await broadcast(snapshot(), include_camera=True)
                await broadcast({"type": "libraryChanged"})
                return result
            except ValueError as error:
                if state.active_id == key:
                    state.failed(str(error))
                raise HTTPException(409, str(error)) from error
            except Exception as error:
                logger.exception("Capture could not be acknowledged")
                if state.active_id == key:
                    state.failed(
                        "Could not save/check the receipt. "
                        "Original may be retained; keep it and retry."
                    )
                raise HTTPException(500, state.message) from error

    @app.websocket("/ws")
    async def connection(socket: WebSocket):
        nonlocal camera
        await socket.accept()
        role = None
        try:
            async with asyncio.timeout(5):
                hello = await socket.receive_json()
            if not isinstance(hello, dict) or not secrets.compare_digest(
                str(hello.get("token", "")), settings.token
            ):
                await socket.close(4401)
                return
            role = hello.get("role")
            if role == "camera":
                if camera is not None:
                    await socket.close(4409, "A phone camera is already connected.")
                    return
                camera = socket
                state.reset_stability()
            elif role == "dashboard":
                viewers.add(socket)
            else:
                await socket.close(4400)
                return
            await send(socket, snapshot())
            while True:
                packet = await socket.receive()
                if packet["type"] == "websocket.disconnect":
                    break
                if role != "camera":
                    continue
                if packet.get("bytes") is not None:
                    frame = packet["bytes"]
                    if len(frame) > MAX_PREVIEW_BYTES:
                        await socket.close(4400, "Preview frame too large.")
                        break
                    if detector is None or state.active_id or vision_lock.locked():
                        await send(socket, {"type": "frameAck"})
                        continue
                    async with vision_lock:

                        def analyze(frame_data=frame):
                            image, _ = decode_image(frame_data)
                            if max(image.shape[:2]) > 1000:
                                raise ValueError("Preview dimensions exceed 1000 pixels.")
                            return detector.analyze(image)

                        quality = await asyncio.get_running_loop().run_in_executor(pool, analyze)
                    capture_id = state.observe(quality, time.monotonic())
                    await broadcast(snapshot(), include_camera=True)
                    await broadcast(frame)
                    await send(socket, {"type": "frameAck"})
                    if capture_id:
                        if not await send(socket, {"type": "capture", "id": capture_id}):
                            state.failed(
                                "Could not reach the phone. Keep the receipt and reconnect."
                            )
                elif packet.get("text"):
                    event = json.loads(packet["text"])
                    if event.get("type") == "captureError" and event.get("id") == state.active_id:
                        state.failed(str(event.get("message", "Camera capture failed."))[:250])
                        await broadcast(snapshot(), include_camera=True)
        except (WebSocketDisconnect, TimeoutError, RuntimeError, ValueError, OSError):
            logger.info("Camera/dashboard connection ended", exc_info=True)
        finally:
            viewers.discard(socket)
            if camera is socket:
                camera = None
                state.disconnected()
            await broadcast(snapshot())

    dist = settings.root / "dist"
    if dist.is_dir():
        app.mount("/assets", StaticFiles(directory=dist / "assets"), name="assets")

        @app.get("/")
        @app.get("/camera")
        async def index():
            return FileResponse(dist / "index.html")

    return app


app = create_app(load_settings())
