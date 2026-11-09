# Frigate single camera UI

A small, phone-friendly web app (installable PWA, Material Design 3) for watching a
[Frigate](https://frigate.video) camera. It was built for watching a pet, and is meant to be simpler than the full Frigate UI.

- **Video**: live video (go2rtc, same as Frigate's own live view) with a stream / quality picker,
  recorded playback (Frigate VOD / HLS), 1–16× speed, fullscreen
- **Timeline**: drag to pan, pinch / scroll to zoom (1 min – 3 days), tap to play from there.
  Shaded = recording exists, orange bars = **motion** (Frigate's motion detection, not objects).
  Faded bars are minor motion.
- **Skip**: ±10 s, and ⏮ / ⏭ to jump to the previous / next **significant motion**
- **Record clips** (like HikConnect): press **Record**, watch (live or a recording, you can skip
  around), press **Stop**. The clip is cut by Frigate and shown with a preview:
  **Save or share** on phones (native share sheet → Save Video to Photos, AirDrop, messengers…)
  or **Download** the MP4.
- **Login** with your Frigate username/password. No credentials are stored on the server.
- Multiple cameras work too (a picker appears in the top bar).

## Setup

```sh
cp .env.example .env    # set FRIGATE_URL (required), optionally APP_NAME etc.
docker compose up -d --build
```

Open http://localhost:8000 and sign in with a Frigate account (the `viewer` role is enough).

### Configuration (`.env`)

| Variable | Default | |
| --- | --- | --- |
| `FRIGATE_URL` | – (required) | URL of your Frigate instance, e.g. `https://frigate.example.com` |
| `FRIGATE_VERIFY_TLS` | `true` | `false` for self-signed certificates |
| `APP_NAME` | `Frigate Cam` | Name in the title bar, login screen and installed app |
| `APP_SHORT_NAME` | `APP_NAME` | Name under the home screen icon |
| `DEFAULT_CAMERA` | first enabled camera | Camera selected on first load |
| `SESSION_DAYS` | `30` | How long the browser stays signed in (Frigate's `auth.session_length` still applies) |

### Behind Traefik

```sh
cp docker-compose.traefik.example.yaml docker-compose.traefik.yaml   # gitignored
# edit the Host(`…`) rule (and router name / network / entrypoint if yours differ)
docker compose -f docker-compose.traefik.yaml up -d --build
```

The example assumes Traefik is attached to an external docker network called `web` and has an
entrypoint called `https` that terminates TLS.

### Install as an app (PWA)

Installing needs **HTTPS** (except on `localhost`), e.g. via the Traefik setup above.

- **iPhone / iPad** (Safari): Share → *Add to Home Screen*
- **Android** (Chrome): ⋮ → *Install app*

It then opens fullscreen with its own icon, like a native app.

After signing in, the app shows its own install banner: an **Install** button on Android /
Chrome / Edge, or the Share → Add to Home Screen steps on iPhone / iPad (iOS has no install
prompt for websites). It is hidden inside the installed app and after closing it stays away for 30 days.

## How it works

`app/main.py` is a small FastAPI proxy. Signing in posts the credentials to Frigate's
`/api/login`. The resulting Frigate session token (JWT) is kept in an httpOnly cookie in the
browser, and the proxy attaches it to every `/api/*` and `/vod/*` request (and the `/live/` WebSocket)
it forwards to Frigate.
The server keeps no credentials or state. When Frigate rejects the token, the login
screen is shown again.

The frontend is plain HTML/CSS/JS in `app/static/` (no build step) and uses hls.js,
Roboto and Material Symbols from CDNs. `sw.js` caches the app shell but never camera data.

| What | Frigate endpoint |
| --- | --- |
| sign in | `POST /api/login` |
| cameras | `GET /api/config` |
| motion + recording coverage | `GET /api/<camera>/recordings?after=&before=` |
| playback | `GET /vod/<camera>/start/<ts>/end/<ts>/index.m3u8` |
| live video | WebSocket `/live/mse/api/ws?src=<go2rtc stream>` (MSE) |
| live fallback | `GET /api/<camera>/latest.jpg` (snapshots from the detect stream) |
| clips | `GET /api/<camera>/start/<ts>/end/<ts>/clip.mp4` |

### Live view and stream quality

Live video is streamed from go2rtc through Frigate's `/live/` endpoint, like Frigate's own UI.
The picker on the video lists the camera's streams: the ones in `cameras.<name>.live.streams`
(Frigate 0.15+) or `live.stream_name`, plus go2rtc streams named after the camera (`<camera>`
→ "Main", `<camera>_sub` → "sub"). The last choice is remembered per camera.

If live video can't play (older iPhones without MSE / ManagedMediaSource, a codec the browser
can't decode such as H.265 in most browsers, or the stream missing in go2rtc), the app falls back
to snapshots from Frigate's `detect` stream, which are lower quality and ~2 fps.
The stream is paused while the app is in the background.

### Motion skipping

A recording segment (~10 s) counts as significant motion when its motion value is at least
20 % of the camera's typical strong motion (90th percentile of the loaded data). Significant
segments less than 30 s apart form one event. ⏭ jumps to the start of the next event (2 s early),
⏮ to the start of the current/previous one. Tune `SIG_FRACTION`, `MOTION_GAP` and `PREROLL`
at the top of the motion section in `app/static/app.js` if it stops too often or too rarely.

### Recording clips from live

Frigate writes recordings in ~10 s segments with a short delay, so after **Stop** the app
waits until the end of the clip is on disk (usually 10–20 s) before fetching it. Clips over
15 min skip the in-app preview and download directly.

## Keyboard (desktop)

`Space` play/pause · `←`/`→` ±10 s (Shift: ±60 s) · `P`/`N` previous/next motion · `R` record/stop clip ·
`Esc` discard recording · `L` live · `+`/`-` zoom · `F` fullscreen
