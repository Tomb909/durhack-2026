"""Deck of Worlds server.

Serves the world page to the laptop (http://localhost:8000), the camera page
to the phone (https://<laptop-ip>:8443/phone), receives camera frames, runs
card tracking, and pushes the list of cards to the world page.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import time
from pathlib import Path

import cv2
import segno
from aiohttp import WSMsgType, web

from .certs import CertManager
from .netinfo import local_ipv4s
from .vision.pipeline import Vision, VisionWorker

ROOT = Path(__file__).resolve().parents[2]
STATIC = Path(__file__).resolve().parent / "static"
WEB_DIST = ROOT / "web" / "dist"
DATA = ROOT / ".deck"
RECORDINGS = ROOT / "recordings"

SNAPSHOT_MIN_INTERVAL = 0.05  # at most 20 snapshots a second
HEARTBEAT = 0.5
CRLF = bytes([13, 10])
HEADER_END = CRLF + CRLF


class Server:
    def __init__(self, args: argparse.Namespace) -> None:
        self.args = args
        DATA.mkdir(exist_ok=True)
        self.config_path = DATA / "config.json"
        self.config = {"flip": False}
        if self.config_path.exists():
            try:
                self.config.update(json.loads(self.config_path.read_text()))
            except ValueError:
                pass
        reader = None
        if not args.no_read:
            print("Loading the word reader...", flush=True)
            from .vision.reader import Reader

            reader = Reader()
        self.vision = Vision(reader, flip=bool(self.config["flip"]))
        self.loop: asyncio.AbstractEventLoop | None = None
        self.changed = asyncio.Event()
        self.worker = VisionWorker(self.vision, on_update=self._on_vision_update)
        self.sockets: set[web.WebSocketResponse] = set()
        self.certs = CertManager(DATA)
        self.ips: list[str] = []
        self.record_dir: Path | None = Path(args.record) if args.record else None
        self._last_record = 0.0
        self._snap_count = 0
        self._noted: set[tuple[str, str]] = set()
        self.inner_https_port = args.https_port + 1

    # --- plumbing -------------------------------------------------------------

    def _on_vision_update(self) -> None:
        if self.loop is not None:
            self.loop.call_soon_threadsafe(self.changed.set)

    def save_config(self) -> None:
        self.config_path.write_text(json.dumps(self.config))

    def phone_urls(self) -> list[str]:
        return [f"https://{ip}:{self.args.https_port}/phone" for ip in self.ips]

    def submit(self, jpeg: bytes) -> None:
        self.worker.submit(jpeg)
        if self.record_dir is not None and time.monotonic() - self._last_record > 0.33:
            self._last_record = time.monotonic()
            self.record_dir.mkdir(parents=True, exist_ok=True)
            (self.record_dir / f"{time.strftime('%H%M%S')}_{self.worker.frames_received:06d}.jpg").write_bytes(jpeg)

    # --- background tasks -----------------------------------------------------

    async def broadcast_loop(self) -> None:
        while True:
            try:
                await asyncio.wait_for(self.changed.wait(), timeout=HEARTBEAT)
            except asyncio.TimeoutError:
                pass
            self.changed.clear()
            if self.sockets:
                message = json.dumps({"type": "snapshot", **self.vision.snapshot(), "phoneUrls": self.phone_urls()})
                for ws in list(self.sockets):
                    try:
                        await ws.send_str(message)
                    except (ConnectionError, RuntimeError):
                        self.sockets.discard(ws)
            await asyncio.sleep(SNAPSHOT_MIN_INTERVAL)

    async def network_loop(self) -> None:
        """Notice when the laptop joins a different network (e.g. the phone's hotspot)."""
        while True:
            ips = await asyncio.to_thread(local_ipv4s)
            if ips != self.ips:
                self.certs.refresh(ips)
                self.ips = ips
                print("\nPhone camera page:", flush=True)
                for url in self.phone_urls() or ["(no network found: join the phone's hotspot)"]:
                    print("   ", url, flush=True)
                print(f"World page:  http://localhost:{self.args.http_port}\n", flush=True)
            await asyncio.sleep(4.0)

    async def source_loop(self) -> None:
        """Optional frame sources other than the phone."""
        source: str = self.args.source
        if source == "phone":
            return
        if source == "synth":
            from .vision.synth import Scrap, render_frame

            t0 = time.monotonic()
            while True:
                t = time.monotonic() - t0
                import math

                scraps = [
                    Scrap("MOUNTAIN", 0.25, 0.3, angle=10),
                    Scrap("WATER", 0.5 + 0.25 * math.cos(t * 0.5), 0.5 + 0.25 * math.sin(t * 0.5), angle=t * 20),
                    Scrap("SUN", 0.8, 0.25, angle=95),
                    Scrap("LIFE", 0.3, 0.75, angle=-30),
                ]
                frame = await asyncio.to_thread(render_frame, scraps, (1280, 720))
                ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
                if ok:
                    self.submit(jpeg.tobytes())
                await asyncio.sleep(0.05)
        if source.startswith("replay:"):
            files = sorted(Path(source.split(":", 1)[1]).glob("*.jpg"))
            if not files:
                print("No .jpg frames found to replay.")
                return
            while True:
                for path in files:
                    self.submit(path.read_bytes())
                    await asyncio.sleep(0.2)
        if source.startswith("camera:"):
            index = int(source.split(":", 1)[1])
            capture = cv2.VideoCapture(index, cv2.CAP_DSHOW)
            capture.set(cv2.CAP_PROP_FRAME_WIDTH, 1920)
            capture.set(cv2.CAP_PROP_FRAME_HEIGHT, 1080)
            while True:
                ok, frame = await asyncio.to_thread(capture.read)
                if ok:
                    ok, jpeg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                    if ok:
                        self.submit(jpeg.tobytes())
                else:
                    await asyncio.sleep(0.2)

    # --- phone-facing front door ----------------------------------------------

    def _note(self, ip: str, what: str) -> None:
        """Log each kind of event once per device, so the terminal shows what the phone did."""
        key = (ip, what)
        if key not in self._noted:
            self._noted.add(key)
            print(f"[link] {ip}: {what}", flush=True)

    async def front_door(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        """Accepts phone connections on the public port.

        Secure (TLS) connections are passed straight to the HTTPS server. A plain
        http:// request (easy to type by mistake) is redirected to https:// instead
        of being dropped, which Safari reports as "the network connection was lost".
        """
        peer = writer.get_extra_info("peername") or ("?", 0)
        ip = str(peer[0])
        try:
            first = await asyncio.wait_for(reader.read(1), timeout=15)
        except (asyncio.TimeoutError, ConnectionError, OSError):
            first = b""
        if not first:
            self._note(ip, "connected but sent nothing")
            writer.close()
            return
        if first[0] != 0x16:  # not a TLS handshake: plain HTTP
            try:
                rest = await asyncio.wait_for(reader.readuntil(HEADER_END), timeout=5)
            except (asyncio.TimeoutError, asyncio.IncompleteReadError, asyncio.LimitOverrunError, ConnectionError, OSError):
                rest = b""
            lines = (first + rest).decode("latin-1", "replace").splitlines()
            path = "/phone"
            parts = lines[0].split(" ") if lines else []
            if len(parts) >= 2 and parts[1].startswith("/"):
                path = parts[1]
            host = ""
            for line in lines[1:]:
                if line.lower().startswith("host:"):
                    host = line.split(":", 1)[1].strip()
            if not host:
                host = f"{writer.get_extra_info('sockname')[0]}:{self.args.https_port}"
            self._note(ip, "used http://, redirected to https://")
            body = f"Redirecting to https://{host}{path}"
            head = [
                "HTTP/1.1 307 Temporary Redirect",
                f"Location: https://{host}{path}",
                "Content-Type: text/plain",
                f"Content-Length: {len(body)}",
                "Connection: close",
                "",
                body,
            ]
            writer.write(CRLF.join(part.encode("latin-1") for part in head))
            try:
                await writer.drain()
            except (ConnectionError, OSError):
                pass
            writer.close()
            return
        self._note(ip, "secure connection opened")
        try:
            up_reader, up_writer = await asyncio.open_connection("127.0.0.1", self.inner_https_port)
        except OSError:
            writer.close()
            return
        up_writer.write(first)

        async def pipe(source: asyncio.StreamReader, sink: asyncio.StreamWriter) -> None:
            try:
                while True:
                    data = await source.read(65536)
                    if not data:
                        break
                    sink.write(data)
                    await sink.drain()
            except (ConnectionError, OSError):
                pass
            finally:
                try:
                    sink.close()
                except OSError:
                    pass

        await asyncio.gather(pipe(reader, up_writer), pipe(up_reader, writer))

    # --- handlers -------------------------------------------------------------

    async def index(self, request: web.Request) -> web.StreamResponse:
        page = WEB_DIST / "index.html"
        if page.exists():
            return web.FileResponse(page, headers={"Cache-Control": "no-cache"})
        raise web.HTTPFound("/debug")

    async def phone_page(self, request: web.Request) -> web.StreamResponse:
        print("[link] phone page loaded", flush=True)
        return web.FileResponse(STATIC / "phone" / "index.html", headers={"Cache-Control": "no-cache"})

    async def debug_page(self, request: web.Request) -> web.StreamResponse:
        return web.FileResponse(STATIC / "debug.html", headers={"Cache-Control": "no-cache"})

    async def frame(self, request: web.Request) -> web.Response:
        body = await request.read()
        if body:
            if self.worker.frames_received == 0:
                print("[link] first camera frame received", flush=True)
            self.submit(body)
        return web.json_response(self.vision.phone_status())

    async def websocket(self, request: web.Request) -> web.WebSocketResponse:
        ws = web.WebSocketResponse(heartbeat=20)
        await ws.prepare(request)
        self.sockets.add(ws)
        self.changed.set()
        try:
            async for message in ws:
                if message.type != WSMsgType.TEXT:
                    continue
                try:
                    data = json.loads(message.data)
                except ValueError:
                    continue
                self.command(str(data.get("type", "")))
        finally:
            self.sockets.discard(ws)
        return ws

    def command(self, name: str) -> None:
        if name == "flip":
            self.config["flip"] = not self.config["flip"]
            self.vision.set_flip(bool(self.config["flip"]))
            self.save_config()
        elif name == "relock":
            self.vision.relock()
        self.changed.set()

    async def api_command(self, request: web.Request) -> web.Response:
        self.command(request.match_info["name"])
        return web.json_response({"ok": True, **self.config})

    async def api_info(self, request: web.Request) -> web.Response:
        return web.json_response(
            {"phoneUrls": self.phone_urls(), "framesReceived": self.worker.frames_received, **self.vision.snapshot()}
        )

    async def api_qr(self, request: web.Request) -> web.Response:
        urls = self.phone_urls()
        try:
            url = urls[int(request.query.get("i", "0"))]
        except (ValueError, IndexError):
            raise web.HTTPNotFound()
        import io

        buffer = io.BytesIO()
        segno.make(url, error="m").save(buffer, kind="svg", scale=8, border=2, dark="#111", light="#fff")
        return web.Response(body=buffer.getvalue(), content_type="image/svg+xml", headers={"Cache-Control": "no-store"})

    @staticmethod
    def _jpeg(image) -> web.Response:
        if image is None:
            raise web.HTTPNotFound()
        ok, jpeg = cv2.imencode(".jpg", image, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return web.Response(body=jpeg.tobytes(), content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def api_frame(self, request: web.Request) -> web.Response:
        if self.worker.latest_jpeg is None:
            raise web.HTTPNotFound()
        return web.Response(body=self.worker.latest_jpeg, content_type="image/jpeg", headers={"Cache-Control": "no-store"})

    async def api_rectified(self, request: web.Request) -> web.Response:
        return self._jpeg(await asyncio.to_thread(self.vision.debug_image))

    async def api_crop(self, request: web.Request) -> web.Response:
        try:
            track_id = int(request.match_info["id"])
        except ValueError:
            raise web.HTTPNotFound()
        return self._jpeg(self.vision.crop_for(track_id))

    async def api_snap(self, request: web.Request) -> web.Response:
        if self.worker.latest_jpeg is None:
            raise web.HTTPNotFound()
        RECORDINGS.mkdir(exist_ok=True)
        folder = RECORDINGS / "snaps"
        folder.mkdir(exist_ok=True)
        self._snap_count += 1
        path = folder / f"{time.strftime('%H%M%S')}_{self._snap_count:03d}.jpg"
        path.write_bytes(self.worker.latest_jpeg)
        return web.json_response({"saved": str(path.relative_to(ROOT))})

    async def api_shot(self, request: web.Request) -> web.Response:
        """Development aid: the world page can save a picture of itself to .deck/shot.jpg."""
        (DATA / "shot.jpg").write_bytes(await request.read())
        return web.json_response({"ok": True})

    async def ca_cert(self, request: web.Request) -> web.Response:
        return web.Response(
            body=self.certs.ca_path.read_bytes(),
            content_type="application/x-x509-ca-cert",
            headers={"Content-Disposition": 'attachment; filename="deck-of-worlds-ca.crt"'},
        )

    # --- startup --------------------------------------------------------------

    def build_app(self) -> web.Application:
        app = web.Application(client_max_size=12 * 1024 * 1024)
        app.router.add_get("/", self.index)
        app.router.add_get("/phone", self.phone_page)
        app.router.add_get("/debug", self.debug_page)
        app.router.add_post("/frame", self.frame)
        app.router.add_get("/ws", self.websocket)
        app.router.add_get("/api/info", self.api_info)
        app.router.add_get("/api/qr.svg", self.api_qr)
        app.router.add_get("/api/frame.jpg", self.api_frame)
        app.router.add_get("/api/rectified.jpg", self.api_rectified)
        app.router.add_get("/api/crop/{id}.jpg", self.api_crop)
        app.router.add_post("/api/snap", self.api_snap)
        app.router.add_post("/api/shot", self.api_shot)
        app.router.add_post("/api/{name:flip|relock}", self.api_command)
        app.router.add_get("/ca.crt", self.ca_cert)
        if (WEB_DIST / "assets").exists():
            app.router.add_static("/assets/", WEB_DIST / "assets")
        return app

    async def run(self) -> None:
        self.loop = asyncio.get_running_loop()
        self.ips = []
        ips = local_ipv4s()
        self.certs.refresh(ips)
        runner = web.AppRunner(self.build_app(), access_log=None)
        await runner.setup()
        await web.TCPSite(runner, "127.0.0.1", self.args.http_port).start()
        # HTTPS itself listens privately; the public port is the front door above.
        await web.TCPSite(runner, "127.0.0.1", self.inner_https_port, ssl_context=self.certs.context).start()
        self._front = await asyncio.start_server(self.front_door, "0.0.0.0", self.args.https_port)
        tasks = [
            asyncio.create_task(self.broadcast_loop()),
            asyncio.create_task(self.network_loop()),
            asyncio.create_task(self.source_loop()),
        ]
        try:
            await asyncio.gather(*tasks)
        finally:
            self.worker.stop()
            await runner.cleanup()


def main() -> None:
    parser = argparse.ArgumentParser(description="Deck of Worlds server")
    parser.add_argument("--http-port", type=int, default=8000, help="laptop page port (localhost only)")
    parser.add_argument("--https-port", type=int, default=8443, help="phone page port")
    parser.add_argument(
        "--source", default="phone",
        help="where frames come from: phone (default), synth, replay:<folder of jpgs>, camera:<index>",
    )
    parser.add_argument("--record", metavar="FOLDER", help="save about 3 incoming frames a second to this folder")
    parser.add_argument("--no-read", action="store_true", help="skip loading the word reader (tracking only)")
    args = parser.parse_args()
    server = Server(args)
    try:
        asyncio.run(server.run())
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
