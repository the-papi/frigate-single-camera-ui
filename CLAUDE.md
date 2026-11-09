# CLAUDE.md

A small, phone-first PWA for watching one (or a few) Frigate cameras: live video, a motion
timeline, skip-to-motion, and record-and-stop clips. See README.md for the user-facing feature list.

**Keep it simple.** The owner explicitly wants a minimal app and has removed features that added
complexity (e.g. "Save in Frigate" exports). Prefer small, focused changes; don't add settings,
panels or dependencies unless asked.

## Layout

```
app/main.py            FastAPI: login, reverse proxy to Frigate, /live WebSocket relay, templated index + manifest
app/static/index.html  Single page (login screen, app, clip sheet, install banner). {{APP_NAME}} / {{APP_SHORT_NAME}} placeholders
app/static/app.js      All frontend logic, plain JS, no build step, no framework
app/static/style.css   Material Design 3 tokens + components, hand-written
app/static/sw.js       Service worker (served at /sw.js): network-first app shell, never caches /api /vod /_ui
app/static/icons/      PWA icons (generated with Pillow; the hamster face is intentional)
docker-compose.yml                    local run (port 8000), reads .env
docker-compose.traefik.example.yaml   template; the real docker-compose.traefik.yaml is gitignored
.env.example                          every setting lives here; FRIGATE_URL is required
```

## Commands

```sh
docker compose up -d --build              # run (needs .env, copy from .env.example)
node --check app/static/app.js            # syntax check JS
python3 -c "import ast;ast.parse(open('app/main.py').read())"
```

There is no test suite; see "Verifying changes" below.

## Backend (app/main.py)

- **Auth**: `/_ui/login` exchanges username/password for Frigate's JWT (`POST /api/login`) and stores
  it in httpOnly cookies `fsu_token` + `fsu_cookie` (Frigate's cookie name). Nothing is stored
  server-side. The proxy attaches `Cookie: <name>=<token>` to every upstream request; a 401 from
  Frigate clears our cookies and the frontend shows the login screen. Refreshed tokens from
  Frigate's `Set-Cookie` are copied into our cookie.
- The shared `httpx.AsyncClient` uses a cookie jar that **refuses all cookies**, so one user's
  session can never leak to another. Keep it that way.
- Only `/api/*` and `/vod/*` are proxied (plus the `/live/*` WebSocket). Responses are streamed
  (`aiter_raw`), so `content-encoding` must be passed through unchanged.
- `/live/{path}` relays go2rtc's WebSocket via Frigate. It accepts the browser socket first so
  it can report failures as close codes (`4401` = not signed in, `4502` = upstream failed).
  No `Origin` header is sent upstream (go2rtc's origin check passes without one).
- No configuration-specific data in code: everything comes from env vars (see `.env.example`).

## Frontend (app/static/app.js)

- All times are **unix seconds** (wall clock). `state.cur` is the playhead.
- **Recordings** are fetched per clock hour (`/api/<cam>/recordings?after&before`) into `recCache`
  (`camera:hour` → segments `{s, e, motion}`); the current hour is refreshed every ~20 s.
- **Playback** loads Frigate VOD HLS one clock hour at a time
  (`/vod/<cam>/start/<h>/end/<h+3600>/index.m3u8`). VOD concatenates segments and **skips gaps**,
  so `wallToVideo` / `videoToWall` map between video time and wall time using that hour's segment
  list. `ended` continues into the next hour; reaching "now" switches to live.
- **Timeline** is a canvas: coverage + motion bars bucketed per 2 px, normalized to the
  95th percentile. Colors come from CSS custom properties via `readColors()` (light/dark aware);
  don't hard-code colors in `draw()`.
- **Significant motion** (⏮/⏭, faded "minor" bars): segment motion ≥ `SIG_FRACTION` × 90th
  percentile of loaded data; events merge across gaps < `MOTION_GAP`; jumps land `PREROLL` early.
- **Clips**: Record stores the start time, Stop takes the playhead as the end, then the sheet waits
  until Frigate has written the last segment (recordings lag 10–20 s behind live), fetches
  `/api/<cam>/start/<s>/end/<e>/clip.mp4` into a Blob and offers Web Share (phones) / download.
  Clips > 15 min are not buffered in memory; they get a direct download link instead.
- **Live**: go2rtc MSE over `ws(s)://<host>/live/mse/api/ws?src=<stream>`; send
  `{type:'mse', value:<codecs>}`, receive `{type:'mse', value:<mime>}`, then binary fMP4.
  Uses `ManagedMediaSource` on iOS 17.1+. Snapshots (`latest.jpg`, detect stream) are the
  placeholder and the fallback. Streams come from `live.streams`, `live.stream_name` and go2rtc
  streams named `<cam>` / `<cam>_*`. Live is stopped while the page is hidden.
- **Install banner**: `beforeinstallprompt` on Chromium; Share → Add to Home Screen text on iOS.

## UI conventions

- Material Design 3: use the `--md-*` tokens and existing components (`.btn.filled/.tonal/.text`,
  `.icon-btn`, `.fab`, `.chip`, `.card`, `.video-chip`, `.snackbar`, bottom `.sheet`).
  Icons are Material Symbols Rounded (`<span class="icon">name</span>`).
- Mobile first: check at ~390 px wide. 48 px touch targets, safe-area insets (`--safe-*`), and
  pointer events that work for touch (pan, pinch-zoom, tap). Desktop gets keyboard shortcuts.
- Toggle visibility with the `hidden` attribute (CSS forces `display:none`).
- JS: 2-space indent, no dependencies besides hls.js (CDN). Python: 4-space, keep it in one file.

## Verifying changes

No access to the real Frigate (needs the owner's credentials), so verify against a mock:

- **Mock Frigate**: a small FastAPI app run inside the app image (it already has fastapi, uvicorn,
  websockets) on `--network host`, implementing what's needed: `POST /api/login` (sets
  `frigate_token=eyJ…`), `/api/config` (cameras + `go2rtc.streams`), `/api/<cam>/recordings`
  (fake 10 s segments with motion), `latest.jpg`, `clip.mp4`, and the go2rtc MSE WebSocket.
  Generate real H.264 fMP4 for live tests with
  `ffmpeg -f lavfi -i testsrc2=size=1280x720:rate=25 -c:v libx264 -profile:v high -level 4.1 -pix_fmt yuv420p -g 25 -movflags frag_keyframe+empty_moov+default_base_moof -f mp4 out.mp4`
  (codec string `avc1.640029`).
- Run the app against it: `docker run --network host -e FRIGATE_URL=http://127.0.0.1:15000 <image> uvicorn app.main:app --host 127.0.0.1 --port 18001`.
- **Browser**: `google-chrome-stable --headless=new --remote-debugging-port=9333` driven over CDP
  with a small Node script (Node has a built-in `WebSocket`): emulate a 390×844 mobile device,
  log in, `Runtime.evaluate` app functions/state, `Page.captureScreenshot`, and look at the screenshots.
- Gotchas: separate `Runtime.evaluate` calls share one global scope (a repeated `const x` throws,
  so wrap snippets in `{ }`). Headless Chrome fires a real `beforeinstallprompt`, so block it
  to test the iOS install path. Put mocks/scripts in a scratch dir, not the repo.

## Git

- Commit and push only when asked.
- Stage files explicitly and check `git status` first. Don't blindly `git add -A`: an unrelated
  local deletion (`.env.example`) once slipped into a commit that way.
- Never commit `.env`, `docker-compose.traefik.yaml` or anything host-specific (hostnames, URLs,
  credentials, camera names).
