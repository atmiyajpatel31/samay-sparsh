/* ============================================================
   net.js — room transport for Samay Sparsh.

   This is the ONLY file that knows how bytes move between players.
   game.js talks to it through four things and nothing else:

       net.create(name)        -> Promise<{ code }>
       net.join(code, name)    -> Promise<{ code }>   (rejects: NO_ROOM | FULL)
       net.send(type, payload) -> broadcast to the room
       net.on(type, handler)   -> subscribe

   plus the read-only fields: net.me, net.code, net.isHost, net.players.

   Transport is SSE down (/events) + POST up (/api/msg), served by server.js
   with no dependencies. Real players on real phones, same as any web game.
   To move this onto another backend, keep the four signatures and swap the
   bodies — game.js has no idea what's underneath.

   HOST AUTHORITY
   --------------
   Exactly one peer is host (whoever created the room). The host is the
   only peer that generates round targets and tallies wins; everyone else
   renders what the host sends. That is what guarantees the spec's
   "never generate the target separately on each player's device".
   The server is a relay and never decides anything about the game.
   ============================================================ */

const MAX_PLAYERS = 3;
const HANDSHAKE_MS = 4000;   // how long a joiner waits for the host's roster

function randomId() {
  return Math.random().toString(36).slice(2, 10);
}

class Transport {
  constructor() {
    this.me = null;        // { id, name }
    this.code = null;
    this.isHost = false;
    this.players = [];     // [{ id, name }] — host-ordered, index 0 is host
    this.es = null;        // EventSource
    this.handlers = new Map();
    this._closed = false;
  }

  /* ---------- lifecycle ---------- */

  async create(name) {
    this.me = { id: randomId(), name };
    const { code } = await this._post('/api/create', { peerId: this.me.id });
    this.code = code;
    this.isHost = true;
    this.players = [{ ...this.me }];
    await this._stream();
    return { code };
  }

  async join(code, name) {
    this.me = { id: randomId(), name };
    this.code = code;
    this.isHost = false;
    this.players = [];

    await this._post('/api/join', { code, peerId: this.me.id });  // throws NO_ROOM / FULL
    await this._stream();

    // The server admitted us; now the host has to deal us into the roster.
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        this._close();
        reject(new Error('NO_ROOM'));
      }, HANDSHAKE_MS);

      this.on('roster', (msg) => {
        if (settled || !msg.players.some(p => p.id === this.me.id)) return;
        settled = true;
        clearTimeout(timer);
        this.players = msg.players;
        resolve({ code });
      });

      this.on('join-rejected', (msg) => {
        if (settled || msg.to !== this.me.id) return;
        settled = true;
        clearTimeout(timer);
        this._close();
        reject(new Error(msg.reason || 'REJECTED'));
      });

      this.send('join-request', { name });
    });
  }

  /** Quitting on purpose. Says so, so the server frees the seat now instead of
   *  holding it open the way it would for a dropped phone. */
  leave() {
    if (this.code && this.me) {
      fetch('/api/leave', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: this.code, peerId: this.me.id }),
        keepalive: true,   // must survive the page going away
      }).catch(() => {});
    }
    this._close();
  }

  /* ---------- messaging ---------- */

  send(type, payload = {}) {
    this._raw({ ...payload, type, from: this.me.id });
  }

  on(type, handler) {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type).add(handler);
    return () => this.handlers.get(type).delete(handler);
  }

  /* ---------- internals ---------- */

  async _post(url, data) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
    } catch (e) {
      throw new Error('NO_CONNECTION');
    }
    const out = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(out.error || 'NO_ROOM');
    return out;
  }

  /** Open the event stream and resolve once the server says it's live.
   *  Nothing may be sent before this: a message sent while the stream is
   *  still opening would be relayed to a room we aren't listening to yet. */
  _stream() {
    return new Promise((resolve, reject) => {
      this._closed = false;
      const es = new EventSource('/events?code=' + encodeURIComponent(this.code) +
                                '&peerId=' + encodeURIComponent(this.me.id));
      this.es = es;
      let ready = false;

      es.onmessage = (e) => {
        let m;
        try { m = JSON.parse(e.data); } catch { return; }
        if (m.op === 'ready') { ready = true; resolve(); return; }
        if (m.op === 'msg') this._receive(m.data);
      };

      es.onerror = () => {
        if (!ready) { es.close(); reject(new Error('NO_CONNECTION')); return; }
        // Already running: EventSource retries on its own. Surface it once so
        // a player staring at a dead round knows why.
        this._emit({ type: 'net-trouble' });
      };

      this._onUnload = () => this.leave();
      window.addEventListener('pagehide', this._onUnload);
    });
  }

  _close() {
    this._closed = true;
    if (this.es) { this.es.close(); this.es = null; }
    if (this._onUnload) window.removeEventListener('pagehide', this._onUnload);
  }

  _raw(msg) {
    if (this._closed) return;
    // Fire-and-forget: the room's copy goes over the wire...
    fetch('/api/msg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code: this.code, peerId: this.me.id, data: msg }),
      keepalive: true,
    }).catch(() => {});

    // ...and our own copy is delivered locally, because the server relays to
    // everyone EXCEPT the sender. Game logic assumes every peer sees every
    // message, including its own — one code path, host and guest alike.
    //
    // Microtask, never synchronous: a real socket always returns from send()
    // before any handler runs, and callers depend on that. Delivering inline
    // lets a handler fire mid-way through the function that sent the message
    // and get overwritten by the lines after the send() call.
    queueMicrotask(() => this._receive(msg, true));
  }

  _receive(msg, isLocal = false) {
    if (this._closed) return;

    // Host-only bookkeeping: admit joiners, drop leavers, republish roster.
    if (this.isHost && !isLocal) {
      if (msg.type === 'join-request') {
        if (this.players.length >= MAX_PLAYERS && !this.players.some(p => p.id === msg.from)) {
          this._raw({ type: 'join-rejected', to: msg.from, reason: 'FULL' });
          return;
        }
        if (!this.players.some(p => p.id === msg.from)) {
          this.players.push({ id: msg.from, name: msg.name });
        }
        this._raw({ type: 'roster', players: this.players, hostId: this.me.id });
        return;
      }
      if (msg.type === 'leave') {
        this.players = this.players.filter(p => p.id !== msg.from);
        this._raw({ type: 'roster', players: this.players, hostId: this.me.id });
        return;
      }
    }

    // Everyone keeps their roster mirror in sync.
    if (msg.type === 'roster') this.players = msg.players;

    this._emit(msg);
  }

  _emit(msg) {
    const set = this.handlers.get(msg.type);
    if (set) for (const h of [...set]) h(msg);
  }
}

window.net = new Transport();
window.NET_MAX_PLAYERS = MAX_PLAYERS;
