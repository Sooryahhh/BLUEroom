/**
 * There's no way to make a genuinely-cross-tab floating window with plain CSS/JS — a
 * position:fixed div is still trapped inside the current browser tab. The only thing
 * that actually floats over other tabs and other apps is the browser's own native
 * Picture-in-Picture window, which the OS also makes freely draggable/resizable for free.
 *
 * Native PiP only works on a single <video> element, but a watch party's video call is
 * several camera tiles at once — so this draws all of them onto a canvas every frame
 * (like a live video mixer), turns that canvas into a MediaStream via captureStream(),
 * and feeds that into a hidden <video> that we call requestPictureInPicture() on. Add or
 * remove a tile and the next frame just reflects it — no extra wiring needed there.
 *
 * Browser support: Chrome/Edge (desktop + Android), Safari (macOS + iOS 14.5+), Firefox
 * desktop. Firefox for Android does not support video PiP.
 */
function createPipController(mediaDockSelector, { onLeave } = {}) {
  const CANVAS_W = 480;
  const CANVAS_H = 270;

  const canvas = document.createElement('canvas');
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  const ctx = canvas.getContext('2d');

  // This video is never meant to be seen inline — it exists purely as a PiP source.
  // Off-screen positioning (not display:none) keeps it a valid, sized PiP candidate.
  const video = document.createElement('video');
  video.muted = true; // canvas streams carry no audio anyway; muted also allows autoplay with no gesture
  video.playsInline = true;
  video.autoplay = true;
  video.style.position = 'fixed';
  video.style.left = '-99999px';
  video.style.top = '-99999px';
  video.style.width = `${CANVAS_W}px`;
  video.style.height = `${CANVAS_H}px`;
  document.body.appendChild(video);

  let rafId = null;
  let streamStarted = false;

  function getTiles() {
    const dock = document.querySelector(mediaDockSelector);
    if (!dock) return [];
    return Array.from(dock.querySelectorAll('.media-tile'));
  }

  function drawFrame() {
    const tiles = getTiles();
    ctx.fillStyle = '#080808';
    ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

    if (tiles.length === 0) {
      ctx.fillStyle = '#8a96b8';
      ctx.font = '18px sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('No active camera', CANVAS_W / 2, CANVAS_H / 2);
    } else {
      const cols = Math.ceil(Math.sqrt(tiles.length));
      const rows = Math.ceil(tiles.length / cols);
      const cellW = CANVAS_W / cols;
      const cellH = CANVAS_H / rows;
      const pad = 2;

      tiles.forEach((tile, i) => {
        const x = (i % cols) * cellW;
        const y = Math.floor(i / cols) * cellH;
        const tileVideo = tile.querySelector('video');
        const labelEl = tile.querySelector('.tile-label');
        const labelText = labelEl ? labelEl.textContent : '';

        if (tileVideo && tileVideo.readyState >= 2 && tileVideo.videoWidth) {
          const vw = tileVideo.videoWidth, vh = tileVideo.videoHeight;
          const cw = cellW - pad * 2, ch = cellH - pad * 2;
          const scale = Math.max(cw / vw, ch / vh);
          const sw = cw / scale, sh = ch / scale;
          const sx = (vw - sw) / 2, sy = (vh - sh) / 2;
          ctx.drawImage(tileVideo, sx, sy, sw, sh, x + pad, y + pad, cw, ch);
        } else {
          const avatarEl = tile.querySelector('.tile-avatar');
          ctx.fillStyle = '#17203a';
          ctx.fillRect(x + pad, y + pad, cellW - pad * 2, cellH - pad * 2);
          ctx.fillStyle = '#38bdf8';
          ctx.font = `bold ${Math.floor(cellH * 0.28)}px sans-serif`;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText(avatarEl ? avatarEl.textContent : '?', x + cellW / 2, y + cellH / 2);
        }

        if (labelText) {
          const labelH = Math.max(14, cellH * 0.18);
          ctx.fillStyle = 'rgba(0,0,0,0.6)';
          ctx.fillRect(x + pad, y + cellH - labelH - pad, cellW - pad * 2, labelH);
          ctx.fillStyle = '#fff';
          ctx.font = `${Math.floor(labelH * 0.62)}px sans-serif`;
          ctx.textAlign = 'left';
          ctx.textBaseline = 'middle';
          ctx.fillText(labelText, x + pad + 6, y + cellH - labelH / 2 - pad, cellW - pad * 2 - 10);
        }
      });
    }

    rafId = requestAnimationFrame(drawFrame);
  }

  function ensureStreamStarted() {
    if (streamStarted) return;
    streamStarted = true;
    video.srcObject = canvas.captureStream(30);
    video.play().catch(() => {});
    drawFrame();
  }

  function stopIfIdle() {
    if (getTiles().length === 0 && document.pictureInPictureElement !== video) {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = null;
      streamStarted = false;
      video.pause();
    }
  }

  video.addEventListener('leavepictureinpicture', () => {
    stopIfIdle();
    if (onLeave) onLeave();
  });

  return {
    async togglePip() {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
        return false;
      }
      if (getTiles().length === 0) {
        const err = new Error('No active camera tiles to show');
        err.code = 'NO_TILES';
        throw err;
      }
      ensureStreamStarted();
      if (document.pictureInPictureEnabled) {
        await video.requestPictureInPicture();
      } else if (video.webkitSupportsPresentationMode && typeof video.webkitSetPresentationMode === 'function') {
        video.webkitSetPresentationMode('picture-in-picture'); // older Safari fallback
      } else {
        const err = new Error('Picture-in-Picture unsupported');
        err.code = 'UNSUPPORTED';
        throw err;
      }
      return true;
    },
    isPipActive: () => document.pictureInPictureElement === video,
    isSupported: () => !!(document.pictureInPictureEnabled || video.webkitSupportsPresentationMode),
    // Call whenever a tile is added/removed so the compositor starts/stops promptly
    // rather than waiting for the next unrelated PiP interaction.
    notifyTilesChanged() {
      if (getTiles().length > 0) ensureStreamStarted();
      else stopIfIdle();
    }
  };
}
