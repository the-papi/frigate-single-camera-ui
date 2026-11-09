"""Tiny reverse proxy in front of Frigate + static PWA.

The browser only ever talks to this app. Users sign in with their own Frigate
credentials on the login screen; we exchange them for a Frigate session token
(JWT) and keep it in an httpOnly cookie on *our* origin. Every proxied request
to /api and /vod (and the /live WebSocket used for live video) gets that token
attached as Frigate's auth cookie.
No credentials are stored server-side.
"""

import asyncio
import html
import http.cookiejar
import logging
import os
import ssl
from contextlib import asynccontextmanager

import httpx
from fastapi import FastAPI, Request, WebSocket
from fastapi.responses import FileResponse, HTMLResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from starlette.background import BackgroundTask
from websockets.asyncio.client import connect as ws_connect
from websockets.exceptions import InvalidStatus

FRIGATE_URL = os.environ.get("FRIGATE_URL", "").rstrip("/")
if not FRIGATE_URL:
    raise SystemExit("FRIGATE_URL is not set – copy .env.example to .env and fill it in")
FRIGATE_WS_URL = "wss://" + FRIGATE_URL[8:] if FRIGATE_URL.startswith("https://") else "ws://" + FRIGATE_URL.split("://", 1)[-1]
APP_NAME = os.environ.get("APP_NAME", "").strip() or "Frigate Cam"
APP_SHORT_NAME = os.environ.get("APP_SHORT_NAME", "").strip() or APP_NAME
DEFAULT_CAMERA = os.environ.get("DEFAULT_CAMERA", "")
VERIFY_TLS = os.environ.get("FRIGATE_VERIFY_TLS", "true").lower() not in ("0", "false", "no")
SESSION_DAYS = int(os.environ.get("SESSION_DAYS", "30"))

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")

TOKEN_COOKIE = "fsu_token"   # Frigate JWT
NAME_COOKIE = "fsu_cookie"   # Frigate's auth cookie name (frigate_token by default)

REQ_HEADERS = {"range", "content-type", "accept", "if-none-match", "if-modified-since"}
RESP_HEADERS = {
    "content-type", "content-length", "content-encoding", "content-range", "accept-ranges",
    "content-disposition", "cache-control", "etag", "last-modified",
}

log = logging.getLogger("frigate-ui")
logging.basicConfig(level=logging.INFO)

client: httpx.AsyncClient


@asynccontextmanager
async def lifespan(_app: FastAPI):
    global client
    # A cookie jar that never stores anything: the client is shared between
    # users, auth is attached explicitly per request.
    jar = http.cookiejar.CookieJar(policy=http.cookiejar.DefaultCookiePolicy(allowed_domains=[]))
    client = httpx.AsyncClient(
        base_url=FRIGATE_URL,
        verify=VERIFY_TLS,
        cookies=jar,
        timeout=httpx.Timeout(30.0, read=600.0),  # clip.mp4 generation can be slow
        follow_redirects=False,
    )
    yield
    await client.aclose()


app = FastAPI(lifespan=lifespan, docs_url=None, redoc_url=None)
app.mount("/static", StaticFiles(directory=STATIC_DIR), name="static")


def set_session(resp: Response, request: Request, name: str, token: str) -> None:
    opts = dict(
        max_age=SESSION_DAYS * 86400,
        httponly=True,
        samesite="lax",
        secure=request.url.scheme == "https",
        path="/",
    )
    resp.set_cookie(TOKEN_COOKIE, token, **opts)
    resp.set_cookie(NAME_COOKIE, name, **opts)


def clear_session(resp: Response) -> None:
    resp.delete_cookie(TOKEN_COOKIE, path="/")
    resp.delete_cookie(NAME_COOKIE, path="/")


# ------------------------------------------------------------------ UI routes

@app.get("/_ui/config")
async def ui_config():
    return {"default_camera": DEFAULT_CAMERA}


@app.post("/_ui/login")
async def login(request: Request):
    try:
        data = await request.json()
    except Exception:
        data = {}
    user, password = str(data.get("user", "")), str(data.get("password", ""))
    if not user or not password:
        return JSONResponse({"detail": "Enter username and password"}, status_code=400)
    try:
        r = await client.post("/api/login", json={"user": user, "password": password})
    except httpx.HTTPError as e:
        return JSONResponse({"detail": f"Frigate unreachable: {e}"}, status_code=502)
    if r.status_code == 429:
        return JSONResponse({"detail": "Too many attempts, try again later"}, status_code=429)
    if r.status_code >= 400:
        return JSONResponse({"detail": "Wrong username or password"}, status_code=401)

    # Frigate sets its JWT as a cookie (name configurable in Frigate, default frigate_token)
    cookies = list(r.cookies.jar)
    cookie = next((c for c in cookies if c.name == "frigate_token"), cookies[0] if cookies else None)
    if not cookie or not cookie.value:
        return JSONResponse({"detail": "Frigate did not return a session token"}, status_code=502)

    resp = JSONResponse({"ok": True, "user": user})
    set_session(resp, request, cookie.name, cookie.value)
    log.info("User %s signed in", user)
    return resp


@app.post("/_ui/logout")
async def logout():
    resp = JSONResponse({"ok": True})
    clear_session(resp)
    return resp


def render_index() -> str:
    with open(os.path.join(STATIC_DIR, "index.html"), encoding="utf-8") as f:
        page = f.read()
    return (page.replace("{{APP_NAME}}", html.escape(APP_NAME))
                .replace("{{APP_SHORT_NAME}}", html.escape(APP_SHORT_NAME)))


# Served from the root so the service worker controls the whole app.
@app.get("/sw.js")
async def service_worker():
    return FileResponse(
        os.path.join(STATIC_DIR, "sw.js"),
        media_type="application/javascript",
        headers={"Cache-Control": "no-cache"},
    )


@app.get("/manifest.webmanifest")
async def manifest():
    return JSONResponse(
        {
            "name": APP_NAME,
            "short_name": APP_SHORT_NAME,
            "description": "Live view, motion timeline and clips from Frigate",
            "id": "/",
            "start_url": "/",
            "scope": "/",
            "display": "standalone",
            "orientation": "any",
            "background_color": "#19120c",
            "theme_color": "#19120c",
            "icons": [
                {"src": "/static/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any"},
                {"src": "/static/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any"},
                {"src": "/static/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png",
                 "purpose": "maskable"},
            ],
        },
        media_type="application/manifest+json",
    )


# ------------------------------------------------------------ live (go2rtc)

@app.websocket("/live/{path:path}")
async def live_ws(websocket: WebSocket, path: str):
    """Relay the go2rtc WebSocket (MSE live video) through Frigate's /live/ endpoint."""
    await websocket.accept()  # accept first so we can report errors with close codes
    token = websocket.cookies.get(TOKEN_COOKIE)
    name = websocket.cookies.get(NAME_COOKIE) or "frigate_token"
    if not token:
        await websocket.close(code=4401)
        return

    url = f"{FRIGATE_WS_URL}/live/{path}"
    if websocket.url.query:
        url += "?" + websocket.url.query
    ssl_ctx = None
    if url.startswith("wss://"):
        ssl_ctx = ssl.create_default_context()
        if not VERIFY_TLS:
            ssl_ctx.check_hostname = False
            ssl_ctx.verify_mode = ssl.CERT_NONE

    try:
        upstream = await ws_connect(url, additional_headers={"Cookie": f"{name}={token}"}, ssl=ssl_ctx,
                                    max_size=None, open_timeout=10, ping_interval=20)
    except InvalidStatus as e:
        await websocket.close(code=4401 if e.response.status_code == 401 else 4502)
        return
    except Exception as e:  # noqa: BLE001 – network errors of all kinds
        log.warning("Live stream connection failed: %s", e)
        await websocket.close(code=4502)
        return

    async def to_upstream():
        while True:
            msg = await websocket.receive()
            if msg["type"] == "websocket.disconnect":
                return
            if msg.get("text") is not None:
                await upstream.send(msg["text"])
            elif msg.get("bytes") is not None:
                await upstream.send(msg["bytes"])

    async def to_client():
        async for msg in upstream:
            if isinstance(msg, bytes):
                await websocket.send_bytes(msg)
            else:
                await websocket.send_text(msg)

    tasks = [asyncio.create_task(to_upstream()), asyncio.create_task(to_client())]
    done, pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    for t in pending:
        t.cancel()
    for t in done:
        t.exception()  # retrieve so it isn't logged as "never retrieved"
    await upstream.close()
    try:
        await websocket.close()
    except RuntimeError:
        pass  # already closed by the browser


# ---------------------------------------------------------------------- proxy

@app.api_route("/{prefix:path}", methods=["GET", "POST", "DELETE", "PUT", "PATCH"])
async def proxy(prefix: str, request: Request):
    top = prefix.split("/", 1)[0]
    if top not in ("api", "vod"):
        if request.method == "GET" and prefix in ("", "index.html"):
            return HTMLResponse(render_index(), headers={"Cache-Control": "no-cache"})
        return JSONResponse({"detail": "Not found"}, status_code=404)

    token = request.cookies.get(TOKEN_COOKIE)
    name = request.cookies.get(NAME_COOKIE) or "frigate_token"
    if not token:
        return JSONResponse({"detail": "Not signed in"}, status_code=401)

    headers = {k: v for k, v in request.headers.items() if k.lower() in REQ_HEADERS}
    headers["cookie"] = f"{name}={token}"
    body = await request.body()
    try:
        req = client.build_request(request.method, "/" + prefix, params=request.query_params,
                                   headers=headers, content=body)
        resp = await client.send(req, stream=True)
    except httpx.HTTPError as e:
        return JSONResponse({"detail": f"Frigate unreachable: {e}"}, status_code=502)

    out_headers = {k: v for k, v in resp.headers.items() if k.lower() in RESP_HEADERS}
    out = StreamingResponse(resp.aiter_raw(), status_code=resp.status_code, headers=out_headers,
                            background=BackgroundTask(resp.aclose))
    if resp.status_code == 401:
        clear_session(out)
    else:
        # Frigate refreshes the JWT shortly before it expires – keep ours in sync.
        refreshed = next((c for c in resp.cookies.jar if c.name == name and c.value), None)
        if refreshed:
            set_session(out, request, name, refreshed.value)
    return out
