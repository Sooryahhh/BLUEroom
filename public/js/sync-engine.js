/**
 * SyncEngine keeps a running estimate of (serverClock - localClock) so that
 * every client can compute "what time it is on the server" without needing
 * synchronized system clocks. Same idea as NTP: several round trips,
 * take the ones with the lowest latency, average their offsets.
 */
class SyncEngine {
  constructor(socket) {
    this.socket = socket;
    this.offset = 0;
    this.lastRtt = null;
    this.samples = []; // {offset, rtt}
    this._interval = null;
  }

  start() {
    // Burst a few quick samples on connect so we converge fast...
    let bursts = 0;
    const burst = setInterval(() => {
      this._measure();
      bursts += 1;
      if (bursts >= 5) clearInterval(burst);
    }, 300);

    // ...then keep refining every few seconds to track clock/network drift.
    this._interval = setInterval(() => this._measure(), 4000);
  }

  stop() {
    if (this._interval) clearInterval(this._interval);
  }

  _measure() {
    const t0 = Date.now();
    this.socket.emit('time-sync', t0, (res) => {
      const t1 = Date.now();
      const rtt = t1 - t0;
      const offset = res.serverTime + rtt / 2 - t1;

      this.samples.push({ offset, rtt });
      if (this.samples.length > 10) this.samples.shift();

      // Weight toward samples with the lowest round-trip time (least jitter).
      const sorted = [...this.samples].sort((a, b) => a.rtt - b.rtt);
      const best = sorted.slice(0, Math.max(1, Math.ceil(sorted.length / 2)));
      this.offset = best.reduce((sum, s) => sum + s.offset, 0) / best.length;
      this.lastRtt = rtt;
    });
  }

  /** Current server time estimate, in ms epoch. */
  serverNow() {
    return Date.now() + this.offset;
  }
}
