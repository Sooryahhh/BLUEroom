# WatchWithIsha

A no-login watch party platform. Anyone can spin up a room, get a 6-character
code, and share it — no accounts, no installs. Works in any modern desktop or
mobile browser, with synced playback, in-room video/audio chat, and live text
chat.

## What it supports

| Source | How it works |
|---|---|
| **Direct video URL** (`.mp4`, `.m3u8`/HLS) | Everyone streams the same URL; playback is kept in sync by the server. |
| **YouTube link** | Loaded via the official YouTube IFrame API, synced the same way. |
| **Local file** | Uploaded to the server when you pick it, then streamed to everyone in the room from there — like a direct URL, except you didn't need to host it anywhere first. Nobody else needs a copy of the file. |

> **Note on "OTT platforms":** There's no way to embed or remote-control
> licensed streaming apps like Netflix, Prime Video, or Disney+ — they're
> DRM-protected specifically to prevent this, and expose no public playback
> API. WatchWithIsha covers everything that's actually technically open: files,
> direct stream links, and YouTube.

## Features

- **No login** — a room is just a 6-character code
- **Synced playback** — direct URLs, HLS, YouTube, and uploaded files, all kept
  within a couple hundred milliseconds of each other
- **Camera & mic** — peer-to-peer video/audio chat between everyone in the room
  while you watch (see [Camera & mic](#camera--mic-webrtc) below)
- **Text chat** — each participant gets a consistent color for their name,
  generated deterministically from their connection so it's the same
  everywhere in the room without needing accounts
- **Theater mode** — an in-page fullscreen that works reliably on mobile,
  including YouTube (see [why not native fullscreen](#why-theater-mode-instead-of-the-browser-fullscreen-api))
- **Cloud-hosted local files** — upload once, everyone streams it, works
  across different devices/networks (see [Local file uploads](#local-file-uploads))
- **Favorites** — save a movie/link you've loaded so you can reload it into a
  future room in one click, stored in your browser's `localStorage` (no
  account, so it's per-browser/per-device, not synced anywhere)

## How the sync works (no magic, just careful engineering)

1. **Clock sync** — each client periodically pings the server and computes
   `offset = serverTime - localTime` using a shortened NTP-style calculation
   (best-of-N round trips, lowest latency wins).
2. **Server is the single source of truth** for `{ isPlaying, time, updatedAt }`
   per room. It never runs a ticking timer — it just stores the last known
   state and *interpolates on demand* (`time + elapsed` while playing).
3. **Every client self-corrects continuously**, once a second, comparing
   where its video *should* be against where it actually is:
   - Drift **< 200ms** → do nothing.
   - Drift **200ms–800ms**, sustained for 2 checks in a row → nudge
     `playbackRate` (0.85×–1.15×) so the correction is invisible.
   - Drift **> 800ms** (sustained), or an explicit `seek` from someone → hard
     seek, with a 4-second cooldown afterward so a slow source has time to
     rebuffer instead of being seeked again mid-stall.
4. The correction loop also **backs off while the video is already buffering**
   (native `waiting`/`playing` events) — seeking a video that's mid-stall just
   restarts the stall, which is what "breaking and loading" looks like from a
   sync engine that doesn't know better.

## Mobile playback (black screen fix)

If a video's controls respond (play/pause toggles) but the picture stays
black on a phone, that's almost always an **HLS-on-iOS-Safari** issue: iOS
Safari plays `.m3u8` streams natively, but if the app forces `hls.js`
(a JS-based HLS implementation using MediaSource Extensions) instead of
letting Safari play it natively, playback can silently fail while the app's
own play/pause state keeps toggling based on what it *thinks* should be
happening, not what's actually rendering.

This is fixed by checking `video.canPlayType('application/vnd.apple.mpegurl')`
first — if the browser can play HLS natively (Safari/iOS), it does; `hls.js`
is only used as a fallback for browsers with no native HLS support (Chrome,
Firefox, Android). On top of that, load failures now surface as a visible
error message on the player instead of a silent black screen.

If you still hit a black screen after this: check whether the video URL
itself works when opened directly in the phone's browser (outside the app) —
if it doesn't play there either, it's a source/CORS/codec issue on the host
serving that video, not something this app can route around.

## Favorites

Saving a favorite stores `{ title, type, url }` in `localStorage` under the
key `watchwithisha:favorites` — there's no server-side favorites list (no
accounts), so favorites are local to whichever browser saved them and won't
show up on a different device. Loading a favorite just calls the same
`set-source` flow as pasting a fresh link. Favoriting an **uploaded** file's
URL will keep working only as long as that specific room (and its upload)
still exists — the app flags this when you save one, since uploads are
deleted ~2 minutes after the room they belong to empties out.

## Camera & mic (WebRTC)

Each participant can turn on their mic and/or camera. This uses **mesh
WebRTC** — a direct peer-to-peer connection between every pair of
participants, signaled over the existing Socket.io connection (the server
only relays small text messages: offers, answers, ICE candidates — it never
touches audio/video data itself).

This works well for the group sizes a watch party actually has (a handful of
people). It is **not** meant to scale to dozens of simultaneous cameras — a
real "many participants" video setup would route through a media server
(SFU) instead of full mesh, which is a materially bigger project.

**Known limitation — no TURN server.** The app only ships with public STUN
servers (`stun.l.google.com`). STUN is enough for most home networks, but
some participants — often anyone on a restrictive corporate network, some
mobile carriers, or certain symmetric NATs — won't be able to establish a
direct peer connection without a **TURN** relay. If some people can't see/hear
others in testing, this is almost certainly why. To fix it, add a TURN
provider's servers to the `ICE_SERVERS` array in `public/js/webrtc.js`:

```js
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  {
    urls: 'turn:your-turn-provider.com:3478',
    username: 'xxxx',
    credential: 'xxxx'
  }
];
```

Options with a free tier: Twilio's Network Traversal Service, Cloudflare
Calls TURN, metered.ca.

## Local file uploads

Selecting a file in the "Local file" tab now **uploads it to the WatchWithIsha
server** (with a progress bar), and everyone in the room streams it from
there — same mechanism as a direct URL, just self-hosted for you.

- Files live at `uploads/<ROOM_CODE>/...` on the server's disk and are served
  with HTTP range support (so seeking works), same as any static file server.
- **They're deleted automatically** when the room is deleted (~2 minutes
  after the last person leaves) — same ephemeral lifetime as everything else
  in this app, no manual cleanup needed.
- **Size limit**: 3072 MB (3GB) by default, configurable via the `MAX_UPLOAD_MB`
  environment variable.
- **This uses your server's disk and bandwidth.** A free-tier host (Render
  free, Railway free) typically has limited disk space and will be slow for
  large files; it's fine for clips and shorter content, less fine for
  multi-GB movies. For heavy use, either move to a host with more disk, or
  swap the storage layer for an object store (S3/R2/GCS) — the upload
  endpoint in `server/server.js` (`POST /api/upload/:code`) is the only place
  that would need to change; everything downstream just treats the result as
  a URL.
- On Render/Railway's free tiers specifically: **disk is ephemeral** — an
  uploaded file survives for the life of the room (which is also ephemeral),
  but won't survive a redeploy or a dyno restart if one happens to occur
  mid-room. This is a reasonable trade-off for what this app is (nothing
  persists on purpose), just don't expect files to outlive a redeploy.

## Why theater mode instead of the browser Fullscreen API

Earlier versions used the standard `Element.requestFullscreen()` API. It's
reliable on desktop, but **iOS Safari does not support making an arbitrary
element (like the container around a YouTube iframe) fullscreen** — only a
bare `<video>` element supports fullscreen there. Since the YouTube source is
an iframe (not a `<video>` tag we control), the fullscreen button would
silently fail specifically for YouTube on iPhones.

"Theater mode" fixes this by not touching the Fullscreen API at all — it's
just CSS: a `.theater-mode` class makes the player container `position: fixed`
and cover the full viewport. This behaves identically for `<video>`, HLS, and
YouTube, on every browser, because it isn't relying on inconsistent
per-platform fullscreen support. The trade-off: the browser's own address
bar/chrome stays visible (true OS-level fullscreen would hide it on desktop),
which in practice is a small cosmetic difference and not something users tend
to notice or mind on mobile.

## Project structure

```
watchwithisha/
├── server/
│   └── server.js        # Express + Socket.io: rooms, uploads, clock sync,
│                         # playback relay, chat, WebRTC signaling relay
├── public/
│   ├── index.html         # Landing page — create/join room
│   ├── room.html           # Watch room
│   ├── css/style.css
│   └── js/
│       ├── landing.js      # Create/join logic
│       ├── sync-engine.js  # Clock offset estimation
│       ├── adapters.js     # Unified interface over <video>/HLS, YouTube
│       ├── webrtc.js       # Mesh WebRTC manager for camera/mic
│       └── room.js         # Wires it all together
└── package.json
```

Uploaded videos land in `uploads/` at the project root (git-ignored, created
automatically) — not inside `public/`, so they're never accidentally bundled
into your deployed static assets.

## Run it locally

Requires Node.js 18+.

```bash
npm install
npm start
```

Open `http://localhost:3000` in two different browser tabs to try a watch
party with yourself — including turning on your own camera/mic in both tabs.

## Deploying it for real

This is a plain Node.js + Socket.io app — it deploys anywhere Node runs.
WebSockets need to stay open, so pick a host that supports persistent
connections (not a serverless function).

**Easiest options:**
- **Render / Railway / Fly.io** — connect the repo, set start command
  `npm start`, done.
- **A VPS** — `npm install && npm start` behind a reverse proxy (nginx/Caddy)
  with TLS, configured to allow WebSocket upgrades:
  ```nginx
  location / {
      proxy_pass http://localhost:3000;
      proxy_http_version 1.1;
      proxy_set_header Upgrade $http_upgrade;
      proxy_set_header Connection "upgrade";
  }
  ```
  If you're behind nginx, also raise its own upload cap to match (nginx
  defaults to rejecting anything over 1MB regardless of what the app
  allows): add `client_max_body_size 3072M;` inside the `server {}` block.

**Before going live:**
1. Set `PORT` (already respected) and optionally `MAX_UPLOAD_MB` via
   environment variables if your host needs them.
2. Tighten CORS in `server/server.js` (`cors: { origin: '*' }`) to your
   actual deployed domain.
3. Serve over **HTTPS** — required for clipboard "copy link", camera/mic
   permissions, and autoplay policies on mobile.
4. Add a TURN server for camera/mic reliability (see above) if you expect
   participants on restrictive networks.
5. If direct video URLs live on another domain, that domain needs to allow
   CORS/byte-range requests, or the `<video>` tag/HLS.js can't play them.

## Known limitations (by design, for this version)

- **Playback control is open to everyone in the room** (like Teleparty), not
  locked to a single host — a small change in `server.js`'s `playback-action`
  handler if you want host-only controls.
- **Camera/mic is mesh WebRTC**, fine for small groups, not built to scale to
  large calls (see [Camera & mic](#camera--mic-webrtc) above), and needs a
  TURN server added for full network reliability.
- Rooms are entirely in-memory and disappear ~2 minutes after the last person
  leaves — no database, by design. Multiple server instances behind a load
  balancer would need sticky sessions or a shared store (Redis) since room
  state currently lives in a single process's memory.
