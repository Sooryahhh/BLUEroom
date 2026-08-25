/**
 * Every adapter exposes the same surface so room.js never needs to know
 * whether it's driving a <video> tag or a YouTube iframe:
 *   mount(container) -> Promise<void>
 *   play() / pause() / seek(seconds)
 *   getCurrentTime() -> seconds | null
 *   getDuration() -> seconds | null
 *   isPaused() -> bool
 *   setPlaybackRate(rate)
 *   on(event, cb)                events: ready, timeupdate, ended, play, pause
 *   destroy()
 */

function extractYouTubeId(input) {
  const trimmed = (input || '').trim();
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed; // already a bare video ID
  try {
    const url = new URL(trimmed);
    if (url.hostname.includes('youtu.be')) return url.pathname.slice(1);
    if (url.searchParams.get('v')) return url.searchParams.get('v');
    const shortsMatch = url.pathname.match(/\/shorts\/([a-zA-Z0-9_-]{11})/);
    if (shortsMatch) return shortsMatch[1];
  } catch (_) { /* not a full URL, fall through */ }
  return null;
}

class EventedAdapter {
  constructor() { this._listeners = {}; }
  on(event, cb) {
    (this._listeners[event] = this._listeners[event] || []).push(cb);
    return this;
  }
  _emit(event, payload) {
    (this._listeners[event] || []).forEach((cb) => cb(payload));
  }
}

class Html5Adapter extends EventedAdapter {
  constructor() {
    super();
    this.video = document.createElement('video');
    this.video.playsInline = true;
    this.video.setAttribute('playsinline', ''); // iOS Safari wants the attribute, not just the property, on older versions
    this.video.setAttribute('webkit-playsinline', '');
    this.video.controls = false;
    this.video.style.width = '100%';
    this.video.style.height = '100%';
    this.hls = null;

    this.video.addEventListener('timeupdate', () => this._emit('timeupdate', this.getCurrentTime()));
    this.video.addEventListener('ended', () => this._emit('ended'));
    this.video.addEventListener('play', () => this._emit('play'));
    this.video.addEventListener('pause', () => this._emit('pause'));
    // 'waiting' fires when the browser stalls to buffer (e.g. after a seek on a slow source) —
    // room.js uses this to avoid piling more seeks/rate changes on top of an already-stalled video.
    this.video.addEventListener('waiting', () => this._emit('buffering', true));
    this.video.addEventListener('playing', () => this._emit('buffering', false));
    this.video.addEventListener('canplay', () => this._emit('buffering', false));
    // A native <video> failure (unsupported codec, blocked CORS, dead link) previously left a
    // silent black screen — the sync loop kept toggling play/pause based on assumed state even
    // though nothing was actually decoding. Surface it instead.
    this.video.addEventListener('error', () => {
      const code = this.video.error ? this.video.error.code : null;
      this._emit('error', { source: 'video', code });
    });
  }

  mount(container) {
    container.innerHTML = '';
    container.appendChild(this.video);
    return Promise.resolve();
  }

  loadUrl(url) {
    return new Promise((resolve, reject) => {
      const isHls = /\.m3u8($|\?)/i.test(url);
      // iOS/iPadOS Safari plays HLS natively and does it more reliably than hls.js — using
      // hls.js there is a well-known source of the "controls respond, picture stays black"
      // failure mode, since hls.js's MSE path has known Safari-specific bugs. Prefer the
      // browser's own native HLS support whenever it's available, and only reach for hls.js
      // on browsers (Chrome, Firefox, Edge, Android) that have no native HLS support at all.
      const nativeHlsSupported = this.video.canPlayType('application/vnd.apple.mpegurl') !== '';

      if (this.hls) { this.hls.destroy(); this.hls = null; }

      if (isHls && !nativeHlsSupported && window.Hls && window.Hls.isSupported()) {
        this.hls = new window.Hls();
        this.hls.loadSource(url);
        this.hls.attachMedia(this.video);
        this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => { this._emit('ready'); resolve(); });
        this.hls.on(window.Hls.Events.ERROR, (_evt, data) => {
          if (data.fatal) {
            this._emit('error', { source: 'hls', detail: data.type });
            reject(new Error(`HLS fatal error: ${data.type}`));
          }
        });
      } else {
        this.video.src = url;
        this.video.addEventListener('loadedmetadata', () => { this._emit('ready'); resolve(); }, { once: true });
        this.video.addEventListener('error', () => {
          reject(new Error('Video failed to load'));
        }, { once: true });
      }
    });
  }

  loadBlob(file) {
    return new Promise((resolve) => {
      const objectUrl = URL.createObjectURL(file);
      this.video.src = objectUrl;
      this.video.addEventListener('loadedmetadata', () => { this._emit('ready'); resolve(); }, { once: true });
    });
  }

  play() { return this.video.play().catch(() => {}); }
  pause() { this.video.pause(); }
  seek(seconds) { this.video.currentTime = Math.max(0, seconds); }
  getCurrentTime() { return this.video.currentTime || 0; }
  getDuration() { return Number.isFinite(this.video.duration) ? this.video.duration : 0; }
  isPaused() { return this.video.paused; }
  setPlaybackRate(rate) { this.video.playbackRate = rate; }
  setVolume(v) { this.video.volume = v; }
  destroy() {
    if (this.hls) this.hls.destroy();
    this.video.pause();
    this.video.removeAttribute('src');
    this.video.load();
  }
}

let youTubeApiReadyPromise = null;
function waitForYouTubeApi() {
  if (youTubeApiReadyPromise) return youTubeApiReadyPromise;
  youTubeApiReadyPromise = new Promise((resolve) => {
    if (window.YT && window.YT.Player) { resolve(); return; }
    window.onYouTubeIframeAPIReady = () => resolve();
  });
  return youTubeApiReadyPromise;
}

class YouTubeAdapter extends EventedAdapter {
  constructor() {
    super();
    this.player = null;
    this._pollTimer = null;
  }

  async mount(container) {
    container.innerHTML = '';
    const mountPoint = document.createElement('div');
    container.appendChild(mountPoint);
    await waitForYouTubeApi();
    this._mountPoint = mountPoint;
  }

  loadVideoId(videoId) {
    return new Promise((resolve) => {
      this.player = new window.YT.Player(this._mountPoint, {
        videoId,
        width: '100%',
        height: '100%',
        playerVars: { playsinline: 1, controls: 0, modestbranding: 1, rel: 0 },
        events: {
          onReady: () => {
            this._emit('ready');
            this._startPolling();
            resolve();
          },
          onStateChange: (e) => {
            if (e.data === window.YT.PlayerState.PLAYING) this._emit('play');
            if (e.data === window.YT.PlayerState.PAUSED) this._emit('pause');
            if (e.data === window.YT.PlayerState.ENDED) this._emit('ended');
          }
        }
      });
    });
  }

  _startPolling() {
    this._pollTimer = setInterval(() => this._emit('timeupdate', this.getCurrentTime()), 500);
  }

  play() { this.player && this.player.playVideo(); }
  pause() { this.player && this.player.pauseVideo(); }
  seek(seconds) { this.player && this.player.seekTo(Math.max(0, seconds), true); }
  getCurrentTime() { return this.player ? this.player.getCurrentTime() || 0 : 0; }
  getDuration() { return this.player ? this.player.getDuration() || 0 : 0; }
  isPaused() { return this.player ? this.player.getPlayerState() !== window.YT.PlayerState.PLAYING : true; }
  setPlaybackRate(rate) { this.player && this.player.setPlaybackRate(rate); }
  setVolume(v) { this.player && this.player.setVolume(v * 100); }
  destroy() {
    if (this._pollTimer) clearInterval(this._pollTimer);
    if (this.player && this.player.destroy) this.player.destroy();
  }
}
