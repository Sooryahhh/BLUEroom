const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const http = require('http');
const express = require('express');
const multer = require('multer');
const { Server } = require('socket.io');

const PORT = process.env.PORT || 3000;
const ROOM_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1 - avoids ambiguity
const ROOM_IDLE_DELETE_MS = 2 * 60 * 1000; // grace period before an empty room is deleted
const MAX_CHAT_HISTORY = 100;
const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB) || 3072; // cap on uploaded video size (3GB default)
const UPLOADS_DIR = path.join(__dirname, '..', 'uploads');

fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));
// express.static (via the `send` package) already handles Range requests, which is what lets
// <video> seek into an uploaded file instead of re-downloading it from the start.
app.use('/uploads', express.static(UPLOADS_DIR));
app.get('/health', (req, res) => res.json({ ok: true, rooms: rooms.size }));

const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' } // tighten this to your deployed frontend origin in production
});

/**
 * rooms: Map<code, {
 *   code, createdAt, hostId,
 *   users: Map<socketId, {id, name, joinedAt}>,
 *   playback: { source: {type, url, name} | null, isPlaying: bool, time: number, updatedAt: number },
 *   chat: Array<{name, text, time}>,
 *   deleteTimer: NodeJS.Timeout | null
 * }>
 */
const rooms = new Map();

// Videos are stored per-room (uploads/<CODE>/<uuid>.<ext>) and wiped when the room is deleted —
// same ephemeral lifetime as the room itself, so nothing lingers on disk indefinitely.
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const code = String(req.params.code || '').toUpperCase();
      if (!rooms.has(code)) return cb(new Error('ROOM_NOT_FOUND'));
      const dir = path.join(UPLOADS_DIR, code);
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10);
      cb(null, `${crypto.randomUUID()}${ext}`);
    }
  }),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    cb(null, file.mimetype.startsWith('video/'));
  }
});

app.post('/api/upload/:code', (req, res) => {
  const code = String(req.params.code || '').toUpperCase();
  if (!rooms.has(code)) return res.status(404).json({ ok: false, error: 'ROOM_NOT_FOUND' });

  upload.single('video')(req, res, (err) => {
    if (err) {
      const message = err.message === 'ROOM_NOT_FOUND' ? 'ROOM_NOT_FOUND'
        : err.code === 'LIMIT_FILE_SIZE' ? 'FILE_TOO_LARGE'
        : 'UPLOAD_FAILED';
      return res.status(400).json({ ok: false, error: message });
    }
    if (!req.file) return res.status(400).json({ ok: false, error: 'NOT_A_VIDEO' });

    res.json({
      ok: true,
      url: `/uploads/${code}/${req.file.filename}`,
      name: req.file.originalname
    });
  });
});

function generateRoomCode() {
  let code;
  do {
    code = Array.from({ length: 6 }, () =>
      ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  if (typeof name !== 'string') return 'Guest';
  const trimmed = name.trim().slice(0, 24);
  return trimmed.length ? trimmed : 'Guest';
}

function publicUsers(room) {
  return Array.from(room.users.values()).map((u) => ({
    id: u.id,
    name: u.name,
    isHost: u.id === room.hostId
  }));
}

// Interpolates where playback SHOULD be right now, given the last known state.
function currentPlaybackState(room) {
  const p = room.playback;
  if (!p.source) return p;
  if (!p.isPlaying) return p;
  const elapsed = (Date.now() - p.updatedAt) / 1000;
  return { ...p, time: p.time + elapsed };
}

function getOrCreateRoom(code, hostSocketId) {
  const room = {
    code,
    createdAt: Date.now(),
    hostId: hostSocketId,
    users: new Map(),
    playback: { source: null, isPlaying: false, time: 0, updatedAt: Date.now() },
    chat: [],
    deleteTimer: null
  };
  rooms.set(code, room);
  return room;
}

function cancelRoomDeletion(room) {
  if (room.deleteTimer) {
    clearTimeout(room.deleteTimer);
    room.deleteTimer = null;
  }
}

function scheduleRoomDeletionIfEmpty(room) {
  if (room.users.size > 0) return;
  cancelRoomDeletion(room);
  room.deleteTimer = setTimeout(() => {
    if (room.users.size === 0) {
      rooms.delete(room.code);
      // Room is gone — its uploaded video(s) go with it. No accounts, no history, nothing lingers.
      fs.rm(path.join(UPLOADS_DIR, room.code), { recursive: true, force: true }, () => {});
    }
  }, ROOM_IDLE_DELETE_MS);
}

io.on('connection', (socket) => {
  let currentRoomCode = null;

  socket.on('create-room', (payload = {}, ack) => {
    const code = generateRoomCode();
    const room = getOrCreateRoom(code, socket.id);
    const name = sanitizeName(payload.name);

    room.users.set(socket.id, { id: socket.id, name, joinedAt: Date.now() });
    socket.join(code);
    currentRoomCode = code;

    if (typeof ack === 'function') {
      ack({
        ok: true,
        code,
        isHost: true,
        users: publicUsers(room),
        playback: currentPlaybackState(room),
        chat: room.chat
      });
    }
  });

  socket.on('join-room', (payload = {}, ack) => {
    const code = String(payload.code || '').toUpperCase().trim();
    const room = rooms.get(code);

    if (!room) {
      if (typeof ack === 'function') ack({ ok: false, error: 'ROOM_NOT_FOUND' });
      return;
    }

    cancelRoomDeletion(room);
    const name = sanitizeName(payload.name);
    room.users.set(socket.id, { id: socket.id, name, joinedAt: Date.now() });
    if (!room.hostId) room.hostId = socket.id; // e.g. original creator's socket already disconnected (page navigation)
    socket.join(code);
    currentRoomCode = code;

    if (typeof ack === 'function') {
      ack({
        ok: true,
        code,
        isHost: room.hostId === socket.id,
        users: publicUsers(room),
        playback: currentPlaybackState(room),
        chat: room.chat
      });
    }

    socket.to(code).emit('user-joined', { user: { id: socket.id, name, isHost: false } });
    io.to(code).emit('presence-update', { users: publicUsers(room) });
  });

  // High-frequency clock sync: client measures round-trip time and offset from this.
  socket.on('time-sync', (clientTime, ack) => {
    if (typeof ack === 'function') ack({ clientTime, serverTime: Date.now() });
  });

  socket.on('set-source', (payload = {}) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const { type, url, name } = payload;
    if (!['direct', 'youtube'].includes(type)) return;

    room.playback = {
      source: { type, url: url || null, name: name || null },
      isPlaying: false,
      time: 0,
      updatedAt: Date.now()
    };

    io.to(currentRoomCode).emit('source-changed', {
      source: room.playback.source,
      changedBy: room.users.get(socket.id)?.name || 'Someone'
    });
  });

  socket.on('playback-action', (payload = {}) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !room.playback.source) return;

    const { action, time } = payload;
    const t = Number.isFinite(time) ? Math.max(0, time) : room.playback.time;

    if (action === 'play') {
      room.playback = { ...room.playback, isPlaying: true, time: t, updatedAt: Date.now() };
    } else if (action === 'pause') {
      room.playback = { ...room.playback, isPlaying: false, time: t, updatedAt: Date.now() };
    } else if (action === 'seek') {
      room.playback = { ...room.playback, time: t, updatedAt: Date.now() };
    } else {
      return;
    }

    socket.to(currentRoomCode).emit('playback-sync', {
      action,
      time: room.playback.time,
      isPlaying: room.playback.isPlaying,
      serverTime: room.playback.updatedAt,
      actor: room.users.get(socket.id)?.name || 'Someone'
    });
  });

  // Late joiners or anyone hitting "resync" pull the authoritative state on demand.
  socket.on('request-sync', (payload, ack) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const state = currentPlaybackState(room);
    const response = {
      source: room.playback.source,
      time: state.time,
      isPlaying: state.isPlaying,
      serverTime: Date.now()
    };
    if (typeof ack === 'function') ack(response);
    else socket.emit('playback-sync', { action: 'sync', ...response });
  });

  socket.on('chat-message', (payload = {}) => {
    const room = rooms.get(currentRoomCode);
    if (!room) return;
    const text = String(payload.text || '').slice(0, 500).trim();
    if (!text) return;
    const user = room.users.get(socket.id);
    const message = { name: user?.name || 'Guest', text, time: Date.now(), senderId: socket.id };
    room.chat.push(message);
    if (room.chat.length > MAX_CHAT_HISTORY) room.chat.shift();
    io.to(currentRoomCode).emit('chat-message', message);
  });

  // Pure relay for WebRTC signaling (offers/answers/ICE candidates) — the server never touches
  // media itself, it just forwards these small JSON blobs between two sockets in the same room.
  socket.on('webrtc-signal', ({ to, data } = {}) => {
    const room = rooms.get(currentRoomCode);
    if (!room || !to || !room.users.has(to)) return;
    io.to(to).emit('webrtc-signal', { from: socket.id, data });
  });

  socket.on('disconnect', () => {
    if (!currentRoomCode) return;
    const room = rooms.get(currentRoomCode);
    if (!room) return;

    room.users.delete(socket.id);
    io.to(currentRoomCode).emit('user-left', { id: socket.id });
    io.to(currentRoomCode).emit('presence-update', { users: publicUsers(room) });

    if (room.hostId === socket.id) {
      // Hand host duties to the next-longest-present member, if any remain.
      const next = Array.from(room.users.values())[0];
      if (next) {
        room.hostId = next.id;
        io.to(currentRoomCode).emit('host-changed', { hostId: next.id, hostName: next.name });
      } else {
        room.hostId = null; // room is momentarily empty; next joiner (e.g. after page navigation) becomes host
      }
    }

    scheduleRoomDeletionIfEmpty(room);
  });
});

server.listen(PORT, () => {
  console.log(`WatchWithIsha server listening on port ${PORT}`);
});
