/**
 * Minimal mesh WebRTC manager for small watch-party groups (a handful of people).
 * One RTCPeerConnection per remote participant; the existing Socket.io connection
 * carries signaling (offers/answers/ICE candidates) as plain relayed JSON.
 *
 * Design notes:
 * - Connections are created lazily: only once either side has an actual media track
 *   to send, or an incoming offer arrives. Idle rooms with cameras off open zero
 *   peer connections.
 * - Renegotiation (adding/removing tracks after the fact) relies on the browser's
 *   built-in `negotiationneeded` event rather than hand-rolled offer logic — simpler
 *   and handles "turn camera on after joining" for free.
 * - Basic "polite peer" glare handling: the socket with the lexicographically smaller
 *   id defers to the other side if both happen to send offers at once.
 *
 * Requires TURN in addition to STUN for participants behind restrictive/symmetric
 * NATs (many corporate or mobile networks). Only public STUN is configured here —
 * see README for adding a TURN provider if some participants can't connect.
 */
function createMediaManager(socket, callbacks) {
  const { onLocalStream, onRemoteStream, onRemoteStreamRemoved, onError } = callbacks;

  const ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' }
  ];

  const peerConnections = new Map(); // peerId -> RTCPeerConnection
  let localStream = null;
  let micOn = false;
  let camOn = false;

  function isPolite(peerId) {
    return socket.id < peerId;
  }

  function ensurePeerConnection(peerId) {
    if (peerConnections.has(peerId)) return peerConnections.get(peerId);

    const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
    let makingOffer = false;

    pc.onicecandidate = (e) => {
      if (e.candidate) socket.emit('webrtc-signal', { to: peerId, data: { type: 'candidate', candidate: e.candidate.toJSON() } });
    };

    pc.ontrack = (e) => {
      onRemoteStream(peerId, e.streams[0]);
    };

    pc.onnegotiationneeded = async () => {
      try {
        makingOffer = true;
        await pc.setLocalDescription();
        socket.emit('webrtc-signal', { to: peerId, data: { type: 'offer', sdp: pc.localDescription } });
      } catch (err) {
        onError && onError(err);
      } finally {
        makingOffer = false;
      }
    };

    pc.onconnectionstatechange = () => {
      if (['failed', 'closed', 'disconnected'].includes(pc.connectionState)) {
        teardownPeer(peerId);
      }
    };

    pc._makingOffer = () => makingOffer;

    if (localStream) {
      localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
    }

    peerConnections.set(peerId, pc);
    return pc;
  }

  function teardownPeer(peerId) {
    const pc = peerConnections.get(peerId);
    if (!pc) return;
    pc.close();
    peerConnections.delete(peerId);
    onRemoteStreamRemoved(peerId);
  }

  async function handleSignal(from, data) {
    const pc = ensurePeerConnection(from);

    if (data.type === 'offer') {
      const offerCollision = data.type === 'offer' && (pc._makingOffer() || pc.signalingState !== 'stable');
      const polite = isPolite(from);
      if (offerCollision && !polite) return; // impolite peer ignores the colliding offer, keeps its own
      await pc.setRemoteDescription(data.sdp); // polite peer implicitly rolls back via setRemoteDescription
      await pc.setLocalDescription();
      socket.emit('webrtc-signal', { to: from, data: { type: 'answer', sdp: pc.localDescription } });
    } else if (data.type === 'answer') {
      if (pc.signalingState === 'have-local-offer') await pc.setRemoteDescription(data.sdp);
    } else if (data.type === 'candidate') {
      try { await pc.addIceCandidate(data.candidate); } catch (_) { /* benign if connection already moved on */ }
    }
  }

  async function refreshLocalMedia(peerIdsToEnsure) {
    if (!micOn && !camOn) {
      if (localStream) {
        localStream.getTracks().forEach((t) => t.stop());
        localStream = null;
      }
      peerConnections.forEach((pc) => {
        pc.getSenders().forEach((s) => { if (s.track) pc.removeTrack(s); });
      });
      onLocalStream(null);
      return;
    }

    try {
      const newStream = await navigator.mediaDevices.getUserMedia({
        audio: micOn,
        video: camOn ? { width: { ideal: 320 }, height: { ideal: 240 } } : false
      });
      if (localStream) localStream.getTracks().forEach((t) => t.stop());
      localStream = newStream;
      onLocalStream(localStream);

      (peerIdsToEnsure || []).forEach((id) => ensurePeerConnection(id));

      peerConnections.forEach((pc) => {
        pc.getSenders().forEach((s) => { if (s.track) pc.removeTrack(s); });
        localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
      });
    } catch (err) {
      micOn = false;
      camOn = false;
      onError && onError(err);
    }
  }

  return {
    async setMic(on, peerIds) { micOn = on; await refreshLocalMedia(peerIds); return micOn; },
    async setCam(on, peerIds) { camOn = on; await refreshLocalMedia(peerIds); return camOn; },
    getMicOn: () => micOn,
    getCamOn: () => camOn,
    connectToNewPeer(peerId) {
      // Only worth proactively connecting if we actually have something to send —
      // otherwise we'd just be opening an idle connection for no reason.
      if (localStream) ensurePeerConnection(peerId);
    },
    handleSignal,
    teardownPeer,
    teardownAll() {
      peerConnections.forEach((_, id) => teardownPeer(id));
      if (localStream) { localStream.getTracks().forEach((t) => t.stop()); localStream = null; }
    }
  };
}
