(function () {
  const params = new URLSearchParams(window.location.search);
  const roomCode = (params.get('code') || '').toUpperCase();
  const myName = sessionStorage.getItem('watchwithisha:name') || 'Guest';

  if (!roomCode) { window.location.href = '/'; return; }

  const socket = io();
  const syncEngine = new SyncEngine(socket);

  // ---- DOM refs ----
  const el = {
    roomCode: document.getElementById('room-code'),
    copyLinkBtn: document.getElementById('copy-link-btn'),
    syncDot: document.getElementById('sync-dot'),
    syncLabel: document.getElementById('sync-label'),
    playerShell: document.getElementById('player-shell'),
    adapterMount: document.getElementById('adapter-mount'),
    stage: document.getElementById('stage'),
    playerEmpty: document.getElementById('player-empty'),
    gestureOverlay: document.getElementById('gesture-overlay'),
    sourceTabs: document.querySelectorAll('.source-tab'),
    inputDirect: document.getElementById('source-input-direct'),
    inputYoutube: document.getElementById('source-input-youtube'),
    inputLocal: document.getElementById('source-input-local'),
    directUrl: document.getElementById('direct-url'),
    loadDirectBtn: document.getElementById('load-direct-btn'),
    youtubeUrl: document.getElementById('youtube-url'),
    loadYoutubeBtn: document.getElementById('load-youtube-btn'),
    localFile: document.getElementById('local-file'),
    uploadProgress: document.getElementById('upload-progress'),
    uploadProgressBar: document.getElementById('upload-progress-bar'),
    uploadProgressLabel: document.getElementById('upload-progress-label'),
    playPauseBtn: document.getElementById('play-pause-btn'),
    seekBar: document.getElementById('seek-bar'),
    timeCurrent: document.getElementById('time-current'),
    timeDuration: document.getElementById('time-duration'),
    resyncBtn: document.getElementById('resync-btn'),
    micBtn: document.getElementById('mic-btn'),
    camBtn: document.getElementById('cam-btn'),
    pipBtn: document.getElementById('pip-btn'),
    mediaDock: document.getElementById('media-dock'),
    dockToggleBtn: document.getElementById('dock-toggle-btn'),
    fullscreenBtn: document.getElementById('fullscreen-btn'),
    sidebarTabs: document.querySelectorAll('.sidebar-tab'),
    panelChat: document.getElementById('panel-chat'),
    panelPeople: document.getElementById('panel-people'),
    panelFavorites: document.getElementById('panel-favorites'),
    favoritesSaveRow: document.getElementById('favorites-save-row'),
    favoriteNameInput: document.getElementById('favorite-name-input'),
    favoriteSaveBtn: document.getElementById('favorite-save-btn'),
    favoritesHint: document.getElementById('favorites-hint'),
    favoritesList: document.getElementById('favorites-list'),
    chatLog: document.getElementById('chat-log'),
    chatInput: document.getElementById('chat-input'),
    chatSendBtn: document.getElementById('chat-send-btn'),
    peopleList: document.getElementById('people-list'),
    peopleCount: document.getElementById('people-count'),
    toastWrap: document.getElementById('toast-wrap')
  };

  el.roomCode.textContent = roomCode;

  // ---- State ----
  let adapter = null;
  let currentSourceType = null;         // 'direct' | 'youtube' | 'local'
  let lastKnownState = { source: null, time: 0, isPlaying: false, serverTime: Date.now() };
  let isDraggingSeek = false;
  let isBuffering = false;              // true while the video element is stalled loading data
  let lastHardSeekAt = 0;               // cooldown so we don't seek-on-top-of-seek while a slow source rebuffers
  let overDriftStreak = 0;              // consecutive correction ticks over HARD_DRIFT, to ignore one-off jitter

  const HARD_DRIFT = 0.8;    // seconds — beyond this (for 2 ticks running), hard-seek
  const SOFT_DRIFT = 0.2;    // seconds — beyond this, nudge playbackRate instead of seeking
  const RATE_GAIN = 0.4;
  const HARD_SEEK_COOLDOWN_MS = 4000; // give a slow source time to rebuffer before we consider seeking again

  function toast(text) {
    const t = document.createElement('div');
    t.className = 'toast';
    t.textContent = text;
    el.toastWrap.appendChild(t);
    setTimeout(() => t.remove(), 3500);
  }

  function formatTime(s) {
    if (!Number.isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const sec = Math.floor(s % 60);
    return `${m}:${String(sec).padStart(2, '0')}`;
  }

  // ---- Source loading ----
  el.sourceTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      el.sourceTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      el.inputDirect.classList.toggle('hidden', tab.dataset.type !== 'direct');
      el.inputYoutube.classList.toggle('hidden', tab.dataset.type !== 'youtube');
      el.inputLocal.classList.toggle('hidden', tab.dataset.type !== 'local');
    });
  });

  el.loadDirectBtn.addEventListener('click', () => {
    const url = el.directUrl.value.trim();
    if (!url) return;
    socket.emit('set-source', { type: 'direct', url });
  });

  el.loadYoutubeBtn.addEventListener('click', () => {
    const id = extractYouTubeId(el.youtubeUrl.value.trim());
    if (!id) { toast("Couldn't read a video ID from that YouTube link."); return; }
    socket.emit('set-source', { type: 'youtube', url: id });
  });

  el.localFile.addEventListener('change', async () => {
    const file = el.localFile.files[0];
    if (!file) return;
    uploadLocalFile(file);
    el.localFile.value = ''; // allow re-selecting the same file later
  });

  function uploadLocalFile(file) {
    el.uploadProgress.classList.remove('hidden');
    setUploadProgress(0);

    const xhr = new XMLHttpRequest();
    xhr.open('POST', `/api/upload/${roomCode}`);

    xhr.upload.addEventListener('progress', (e) => {
      if (e.lengthComputable) setUploadProgress(Math.round((e.loaded / e.total) * 100));
    });

    xhr.addEventListener('load', () => {
      el.uploadProgress.classList.add('hidden');
      let res;
      try { res = JSON.parse(xhr.responseText); } catch (_) { res = null; }
      if (xhr.status >= 200 && xhr.status < 300 && res && res.ok) {
        // The file now lives on the server as a streamable URL — everyone in the room, on any
        // device, plays it the same way a direct link would work. No one else needs the file.
        socket.emit('set-source', { type: 'direct', url: res.url, name: res.name });
      } else {
        const reason = res && res.error === 'FILE_TOO_LARGE' ? 'That file is too large for this server.'
          : res && res.error === 'NOT_A_VIDEO' ? 'That file doesn\u2019t look like a video.'
          : 'Upload failed.';
        toast(reason);
      }
    });

    xhr.addEventListener('error', () => {
      el.uploadProgress.classList.add('hidden');
      toast('Upload failed — check your connection and try again.');
    });

    const form = new FormData();
    form.append('video', file);
    xhr.send(form);
  }

  function setUploadProgress(pct) {
    el.uploadProgressBar.style.setProperty('--pct', `${pct}%`);
    el.uploadProgressLabel.textContent = `Uploading… ${pct}%`;
  }

  async function mountAdapter(type) {
    if (adapter) { adapter.destroy(); adapter = null; }
    el.playerEmpty.classList.add('hidden');

    adapter = type === 'youtube' ? new YouTubeAdapter() : new Html5Adapter();
    await adapter.mount(el.adapterMount);
    currentSourceType = type;

    adapter.on('timeupdate', (t) => {
      if (!isDraggingSeek) {
        el.seekBar.value = adapter.getDuration() ? (t / adapter.getDuration()) * 100 : 0;
        el.timeCurrent.textContent = formatTime(t);
        el.timeDuration.textContent = formatTime(adapter.getDuration());
      }
    });

    adapter.on('buffering', (buffering) => {
      isBuffering = buffering;
      if (buffering) overDriftStreak = 0; // don't let a stall-triggered drift count toward a future hard seek
    });

    adapter.on('error', (info) => {
      console.error('Playback error:', info);
      showPlayerError('This video couldn\u2019t be played on this device. It may be an unsupported format, a dead link, or the source is blocking playback here.');
    });
  }

  function showPlayerError(message) {
    el.playerEmpty.innerHTML = `<div class="film-icon">⚠️</div><div>${escapeHtml(message)}</div>`;
    el.playerEmpty.classList.remove('hidden');
    toast('Playback error — see message on the player.');
  }

  socket.on('source-changed', async ({ source, changedBy }) => {
    if (!source) return;
    toast(`${changedBy} loaded a ${source.type === 'youtube' ? 'YouTube video' : 'video'}.`);
    lastKnownState = { source, time: 0, isPlaying: false, serverTime: syncEngine.serverNow() };
    refreshFavoriteSaveAvailability();

    if (source.type === 'direct') {
      await mountAdapter('direct');
      try { await adapter.loadUrl(source.url); } catch (err) { showPlayerError('This video couldn\u2019t be loaded — the link may be broken or unsupported on this device.'); }
    } else if (source.type === 'youtube') {
      await mountAdapter('youtube');
      await adapter.loadVideoId(source.url);
    }
  });

  // ---- Playback controls (only path that emits playback-action) ----
  el.playPauseBtn.addEventListener('click', () => {
    if (!adapter) return;
    const t = adapter.getCurrentTime();
    if (adapter.isPaused()) {
      adapter.play();
      lastKnownState = { ...lastKnownState, time: t, isPlaying: true, serverTime: syncEngine.serverNow() };
      socket.emit('playback-action', { action: 'play', time: t });
    } else {
      adapter.pause();
      lastKnownState = { ...lastKnownState, time: t, isPlaying: false, serverTime: syncEngine.serverNow() };
      socket.emit('playback-action', { action: 'pause', time: t });
    }
    updatePlayPauseIcon();
  });

  function updatePlayPauseIcon() {
    if (!adapter) { el.playPauseBtn.textContent = '▶'; return; }
    el.playPauseBtn.textContent = adapter.isPaused() ? '▶' : '⏸';
  }

  el.seekBar.addEventListener('mousedown', () => { isDraggingSeek = true; });
  el.seekBar.addEventListener('touchstart', () => { isDraggingSeek = true; });

  el.seekBar.addEventListener('change', () => {
    isDraggingSeek = false;
    if (!adapter) return;
    const t = (el.seekBar.value / 100) * (adapter.getDuration() || 0);
    adapter.seek(t);
    lastKnownState = { ...lastKnownState, time: t, serverTime: syncEngine.serverNow() };
    socket.emit('playback-action', { action: 'seek', time: t });
  });

  el.resyncBtn.addEventListener('click', () => {
    socket.emit('request-sync', null, (state) => {
      if (!state) return;
      lastKnownState = state;
      applyCorrection(true);
      toast('Resynced to room.');
    });
  });

  el.fullscreenBtn.addEventListener('click', () => {
    const active = el.stage.classList.toggle('theater-mode');
    document.body.classList.toggle('theater-active', active);
    el.fullscreenBtn.textContent = active ? '⤢' : '⛶';
    // Nudge people to rotate on narrow screens — the video itself doesn't force orientation.
    if (active && window.innerWidth < window.innerHeight && window.innerWidth < 700) {
      toast('Rotate your device for a bigger view');
    }
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && el.stage.classList.contains('theater-mode')) {
      el.stage.classList.remove('theater-mode');
      document.body.classList.remove('theater-active');
      el.fullscreenBtn.textContent = '⛶';
    }
  });

  el.gestureOverlay.addEventListener('click', () => {
    el.gestureOverlay.classList.add('hidden');
    if (adapter) adapter.play();
  });

  // ---- Incoming sync events from other clients ----
  socket.on('playback-sync', (payload) => {
    lastKnownState = {
      source: lastKnownState.source,
      time: payload.time,
      isPlaying: payload.isPlaying,
      serverTime: payload.serverTime
    };
    applyCorrection(payload.action === 'seek');
  });

  function applyCorrection(forceHardSeek) {
    if (!adapter) return;

    // A peer explicitly hit play/pause/seek — that always applies immediately, buffering or not.
    // A periodic drift check, though, should back off while the video is already stalled loading data;
    // seeking a rebuffering video just restarts the stall and reads as constant "breaking and loading".
    if (isBuffering && !forceHardSeek) return;

    const expected = lastKnownState.isPlaying
      ? lastKnownState.time + (syncEngine.serverNow() - lastKnownState.serverTime) / 1000
      : lastKnownState.time;

    const local = adapter.getCurrentTime();
    const drift = expected - local;
    const overHard = Math.abs(drift) > HARD_DRIFT;
    overDriftStreak = overHard ? overDriftStreak + 1 : 0;

    const cooledDown = Date.now() - lastHardSeekAt > HARD_SEEK_COOLDOWN_MS;
    const shouldHardSeek = forceHardSeek || (overHard && overDriftStreak >= 2 && cooledDown);

    if (shouldHardSeek) {
      adapter.seek(Math.max(0, expected));
      adapter.setPlaybackRate(1);
      lastHardSeekAt = Date.now();
      overDriftStreak = 0;
    } else if (Math.abs(drift) > SOFT_DRIFT) {
      const rate = 1 + Math.max(-0.15, Math.min(0.15, drift * RATE_GAIN));
      adapter.setPlaybackRate(rate);
    } else {
      adapter.setPlaybackRate(1);
    }

    if (lastKnownState.isPlaying && adapter.isPaused()) {
      const p = adapter.play();
      if (p && typeof p.catch === 'function') {
        p.catch(() => el.gestureOverlay.classList.remove('hidden'));
      }
    } else if (!lastKnownState.isPlaying && !adapter.isPaused()) {
      adapter.pause();
    }
    updatePlayPauseIcon();
  }

  // Continuously re-derive the expected position between events (handles clock/network drift mid-playback).
  setInterval(() => applyCorrection(false), 1000);

  // ---- Latency ticker ----
  setInterval(() => {
    const rtt = syncEngine.lastRtt;
    if (rtt == null) { el.syncLabel.textContent = 'LATENCY --ms'; return; }
    el.syncLabel.textContent = `LATENCY ${Math.round(rtt / 2)}ms`;
    el.syncDot.classList.remove('drift', 'lost');
    if (rtt > 500) el.syncDot.classList.add('lost');
    else if (rtt > 150) el.syncDot.classList.add('drift');
  }, 1000);

  // ---- Chat ----
  // A curated palette (not pure red, which is reserved for the brand accent) so every
  // participant gets a consistent, legible-on-dark color for their name across the whole room.
  const USER_COLOR_PALETTE = [
    '#4ECDC4', '#FFD93D', '#6BCB77', '#4D96FF', '#C780FA',
    '#FF9F45', '#38E1C6', '#F76E96', '#8FD9A8', '#7FB3FF', '#F2A65A', '#B8E986'
  ];

  function colorForUser(id) {
    if (!id) return USER_COLOR_PALETTE[0];
    let hash = 0;
    for (let i = 0; i < id.length; i++) {
      hash = (hash * 31 + id.charCodeAt(i)) >>> 0;
    }
    return USER_COLOR_PALETTE[hash % USER_COLOR_PALETTE.length];
  }

  function addChatLine({ name, text, time, system, senderId }) {
    const row = document.createElement('div');
    row.className = 'chat-msg' + (system ? ' system' : '');
    if (system) {
      row.textContent = text;
    } else {
      const when = new Date(time || Date.now()).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
      const color = colorForUser(senderId || name);
      row.innerHTML = `<span class="who" style="color:${color}">${escapeHtml(name)}</span>${escapeHtml(text)}<span class="when">${when}</span>`;
    }
    el.chatLog.appendChild(row);
    el.chatLog.scrollTop = el.chatLog.scrollHeight;
  }

  function escapeHtml(s) {
    const d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

  function sendChat() {
    const text = el.chatInput.value.trim();
    if (!text) return;
    socket.emit('chat-message', { text });
    el.chatInput.value = '';
  }
  el.chatSendBtn.addEventListener('click', sendChat);
  el.chatInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') sendChat(); });
  socket.on('chat-message', (msg) => addChatLine(msg));

  // ---- Sidebar tabs ----
  el.sidebarTabs.forEach((tab) => {
    tab.addEventListener('click', () => {
      el.sidebarTabs.forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      el.panelChat.classList.toggle('active', tab.dataset.panel === 'chat');
      el.panelPeople.classList.toggle('active', tab.dataset.panel === 'people');
      el.panelFavorites.classList.toggle('active', tab.dataset.panel === 'favorites');
    });
  });

  // ---- People / presence ----
  let hostId = null;
  let currentUsers = [];
  const remoteNameById = new Map();

  function renderPeople(users) {
    currentUsers = users;
    users.forEach((u) => remoteNameById.set(u.id, u.name));
    el.peopleCount.textContent = users.length;
    el.peopleList.innerHTML = '';
    users.forEach((u) => {
      const row = document.createElement('div');
      row.className = 'person-row';
      const color = colorForUser(u.id);
      row.innerHTML = `<span class="avatar" style="background:${color}26;color:${color};">${escapeHtml(u.name.slice(0, 2).toUpperCase())}</span><span>${escapeHtml(u.name)}</span>${u.isHost ? '<span class="host-tag">HOST</span>' : ''}`;
      el.peopleList.appendChild(row);
    });
  }

  socket.on('presence-update', ({ users }) => renderPeople(users));
  socket.on('user-joined', ({ user }) => {
    addChatLine({ system: true, text: `${user.name} joined the room.` });
    remoteNameById.set(user.id, user.name);
    mediaManager.connectToNewPeer(user.id); // proactively offer our stream if camera/mic is already on
  });
  socket.on('user-left', ({ id }) => {
    mediaManager.teardownPeer(id);
    removeMediaTile(id);
  });
  socket.on('host-changed', ({ hostName }) => { hostId = hostName; toast(`${hostName} is now the host.`); });

  // ---- Camera & mic (WebRTC) ----
  function otherPeerIds() {
    return currentUsers.filter((u) => u.id !== socket.id).map((u) => u.id);
  }

  const mediaManager = createMediaManager(socket, {
    onLocalStream: (stream) => renderMediaTile('me', stream, 'You'),
    onRemoteStream: (peerId, stream) => renderMediaTile(peerId, stream, remoteNameById.get(peerId) || 'Guest'),
    onRemoteStreamRemoved: (peerId) => removeMediaTile(peerId),
    onError: (err) => {
      console.error(err);
      toast('Camera/mic unavailable — check your browser permissions.');
      el.micBtn.classList.remove('media-active');
      el.camBtn.classList.remove('media-active');
    }
  });

  function renderMediaTile(peerId, stream, label) {
    let tile = el.mediaDock.querySelector(`[data-peer="${peerId}"]`);
    if (!stream) { if (tile) tile.remove(); return; }
    if (!tile) {
      tile = document.createElement('div');
      tile.className = 'media-tile';
      tile.dataset.peer = peerId;
      el.mediaDock.appendChild(tile);
    }
    tile.innerHTML = '';
    if (stream.getVideoTracks().length) {
      const video = document.createElement('video');
      video.autoplay = true;
      video.playsInline = true;
      if (peerId === 'me') video.muted = true; // never echo your own mic back to yourself
      video.srcObject = stream;
      tile.appendChild(video);
    } else {
      const avatar = document.createElement('div');
      avatar.className = 'tile-avatar';
      avatar.textContent = label.slice(0, 2).toUpperCase();
      tile.appendChild(avatar);
    }
    const tag = document.createElement('div');
    tag.className = 'tile-label';
    tag.textContent = label;
    tile.appendChild(tag);
    pipController.notifyTilesChanged();
  }

  function removeMediaTile(peerId) {
    const tile = el.mediaDock.querySelector(`[data-peer="${peerId}"]`);
    if (tile) tile.remove();
    pipController.notifyTilesChanged();
  }

  const pipController = createPipController('#media-dock', {
    onLeave: () => el.pipBtn.classList.remove('media-active')
  });
  if (!pipController.isSupported()) {
    el.pipBtn.classList.add('hidden'); // e.g. Firefox for Android has no video PiP support
  }

  el.pipBtn.addEventListener('click', async () => {
    try {
      const active = await pipController.togglePip();
      el.pipBtn.classList.toggle('media-active', active);
    } catch (err) {
      if (err.code === 'NO_TILES') {
        toast('Turn on your camera, or wait for someone else\u2019s, to pop out the video call.');
      } else {
        console.error(err);
        toast('Picture-in-Picture isn\u2019t available in this browser.');
      }
    }
  });

  el.micBtn.addEventListener('click', async () => {
    await mediaManager.setMic(!mediaManager.getMicOn(), otherPeerIds());
    el.micBtn.classList.toggle('media-active', mediaManager.getMicOn());
    if (!mediaManager.getCamOn() && !mediaManager.getMicOn()) removeMediaTile('me');
  });

  el.camBtn.addEventListener('click', async () => {
    await mediaManager.setCam(!mediaManager.getCamOn(), otherPeerIds());
    el.camBtn.classList.toggle('media-active', mediaManager.getCamOn());
    if (!mediaManager.getCamOn() && !mediaManager.getMicOn()) removeMediaTile('me');
  });

  socket.on('webrtc-signal', ({ from, data }) => { mediaManager.handleSignal(from, data); });

  el.dockToggleBtn.addEventListener('click', () => {
    el.mediaDock.classList.toggle('collapsed');
  });

  // ---- Favorites (saved locally in this browser — no account needed, matches the rest of the app) ----
  const FAVORITES_KEY = 'watchwithisha:favorites';

  function loadFavorites() {
    try { return JSON.parse(localStorage.getItem(FAVORITES_KEY) || '[]'); }
    catch (_) { return []; }
  }

  function persistFavorites(list) {
    try { localStorage.setItem(FAVORITES_KEY, JSON.stringify(list)); }
    catch (_) { toast('Couldn\u2019t save favorites — your browser storage may be full or blocked.'); }
  }

  function favoriteMeta(fav) {
    if (fav.type === 'youtube') return 'YouTube';
    if (fav.url && fav.url.startsWith('/uploads/')) return 'Uploaded file (only works while its room still exists)';
    return 'Direct link';
  }

  function renderFavorites() {
    const favorites = loadFavorites();
    el.favoritesList.innerHTML = '';
    favorites.forEach((fav) => {
      const row = document.createElement('div');
      row.className = 'favorite-item';
      row.innerHTML = `
        <div class="fav-icon">★</div>
        <div class="fav-info">
          <div class="fav-title">${escapeHtml(fav.title)}</div>
          <div class="fav-meta">${escapeHtml(favoriteMeta(fav))}</div>
        </div>
        <div class="fav-actions">
          <button class="fav-play" title="Play in this room">▶</button>
          <button class="fav-remove" title="Remove">✕</button>
        </div>`;
      row.querySelector('.fav-play').addEventListener('click', () => {
        socket.emit('set-source', { type: fav.type, url: fav.url, name: fav.title });
        toast(`Loading "${fav.title}"…`);
      });
      row.querySelector('.fav-remove').addEventListener('click', () => {
        persistFavorites(loadFavorites().filter((f) => f.id !== fav.id));
        renderFavorites();
      });
      el.favoritesList.appendChild(row);
    });
    el.favoritesHint.classList.toggle('hidden', favorites.length > 0);
  }

  function refreshFavoriteSaveAvailability() {
    const hasSource = !!(lastKnownState.source && lastKnownState.source.url);
    el.favoritesSaveRow.classList.toggle('hidden', !hasSource);
    if (hasSource && !el.favoriteNameInput.value) {
      el.favoriteNameInput.value = lastKnownState.source.name || '';
    }
  }

  el.favoriteSaveBtn.addEventListener('click', () => {
    const source = lastKnownState.source;
    if (!source || !source.url) return;
    const title = el.favoriteNameInput.value.trim() || 'Untitled';
    const favorites = loadFavorites();
    favorites.unshift({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, title, type: source.type, url: source.url, addedAt: Date.now() });
    persistFavorites(favorites);
    renderFavorites();
    el.favoriteNameInput.value = '';
    toast(source.url.startsWith('/uploads/')
      ? `Saved "${title}" — note: this link stops working once the room closes.`
      : `Saved "${title}" to favorites.`);
  });

  renderFavorites();

  // ---- Copy invite link ----
  el.copyLinkBtn.addEventListener('click', async () => {
    const link = `${window.location.origin}/?code=${roomCode}`;
    try {
      await navigator.clipboard.writeText(link);
      el.copyLinkBtn.textContent = 'COPIED';
      setTimeout(() => (el.copyLinkBtn.textContent = 'COPY LINK'), 1500);
    } catch (_) {
      toast(link);
    }
  });

  // ---- Boot ----
  syncEngine.start();
  socket.emit('join-room', { code: roomCode, name: myName }, async (res) => {
    if (!res || !res.ok) {
      toast('That room no longer exists.');
      setTimeout(() => (window.location.href = '/'), 1800);
      return;
    }
    renderPeople(res.users);
    (res.chat || []).forEach(addChatLine);

    if (res.playback && res.playback.source) {
      lastKnownState = {
        source: res.playback.source,
        time: res.playback.time,
        isPlaying: res.playback.isPlaying,
        serverTime: syncEngine.serverNow()
      };
      refreshFavoriteSaveAvailability();
      const s = res.playback.source;
      if (s.type === 'direct') {
        await mountAdapter('direct');
        try {
          await adapter.loadUrl(s.url);
          applyCorrection(true);
        } catch (err) {
          showPlayerError('This video couldn\u2019t be loaded — the link may be broken or unsupported on this device.');
        }
      } else if (s.type === 'youtube') {
        await mountAdapter('youtube');
        await adapter.loadVideoId(s.url);
        applyCorrection(true);
      }
    }
  });

  window.addEventListener('beforeunload', () => { syncEngine.stop(); mediaManager.teardownAll(); });
})();
