'use strict';
/* Samay Pakad — party server (zero dependencies)
 * Run:  node server.js   → open http://<this-machine's-IP>:5173 on each phone
 * Clients receive room traffic via SSE (/events) and send via POST /api/msg.
 *
 * This is a RELAY, not a referee. It owns exactly two things the browsers
 * can't: unique room codes, and knowing when a socket died. Everything about
 * the game — targets, scoring, round flow — still lives in the host client,
 * so game.js is untouched by the move off BroadcastChannel.
 */
const http = require('http'), fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const PORT = +(process.env.PORT || 5173);
const ROOT = __dirname;
const MAX_PLAYERS = 3;
const PING_MS = 25000;   // proxies and tunnels drop idle streams; keep them warm
const GRACE_MS = 30000;  // how long a vanished player keeps their seat
const QUEUE_MAX = 60;    // messages held for a player while they're away

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
               '.css': 'text/css', '.svg': 'image/svg+xml', '.ico': 'image/x-icon' };

const rooms = new Map();   // code -> { code, hostId, players: Map<peerId, {peerId, sse}> }

/* ==================== helpers ==================== */
function newCode() { let c; do { c = String(Math.floor(100000 + Math.random() * 900000)); } while (rooms.has(c)); return c; }
function send(res, code, obj) { res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); res.end(JSON.stringify(obj)); }
function push(p, obj) {
  if (p.sse) { try { p.sse.write('data: ' + JSON.stringify(obj) + '\n\n'); return; } catch (e) {} }
  // Away but still holding a seat: keep their mail. A player who locks their
  // phone mid-round must come back to the round, not to a dead screen.
  if (p.queue.length < QUEUE_MAX) p.queue.push(obj);
}
function relay(room, fromId, data) {   // to everyone EXCEPT the sender — the sender echoes locally
  for (const p of room.players.values()) if (p.peerId !== fromId) push(p, { op: 'msg', data });
}
function lanUrls() {
  const out = []; const ifs = os.networkInterfaces();
  for (const k in ifs) for (const i of ifs[k]) if (i.family === 'IPv4' && !i.internal) out.push('http://' + i.address + ':' + PORT);
  return out;
}
function body(req) {
  return new Promise(resolve => {
    let b = '';
    req.on('data', d => { b += d; if (b.length > 1e5) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch (e) { resolve({}); } });
  });
}

/* ==================== peer lifecycle ==================== */

/* A phone that locks its screen, switches app, or wobbles on Wi-Fi drops the
 * stream. That must not end anyone's game — the browser reconnects on its own,
 * so hold the seat, hold their messages, and only really drop them if they
 * stay gone for GRACE_MS. */
function scheduleDrop(room, peerId) {
  const p = room.players.get(peerId);
  if (!p || p.dropTimer) return;
  p.dropTimer = setTimeout(() => dropPeer(room, peerId), GRACE_MS);
}

function cancelDrop(p) {
  if (p.dropTimer) { clearTimeout(p.dropTimer); p.dropTimer = null; }
}

function dropPeer(room, peerId) {
  if (!room.players.has(peerId)) return;
  const p = room.players.get(peerId);
  cancelDrop(p);
  room.players.delete(peerId);

  // The host holds the game state. If it's gone, the room is gone — say so
  // rather than leaving everyone waiting on a round that will never open.
  if (peerId === room.hostId) {
    for (const p of room.players.values()) push(p, { op: 'msg', data: { type: 'host-left' } });
    rooms.delete(room.code);
    console.log('  room ' + room.code + ' closed (host left)');
    return;
  }
  if (!room.players.size) { rooms.delete(room.code); return; }
  relay(room, peerId, { type: 'leave', from: peerId });
}

/* ==================== http ==================== */
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const p = url.pathname;

  if (p === '/healthz') return send(res, 200, { ok: true, rooms: rooms.size });

  if (p === '/api/create' && req.method === 'POST') {
    const { peerId } = await body(req);
    if (!peerId) return send(res, 400, { error: 'BAD_REQUEST' });
    const code = newCode();
    rooms.set(code, { code, hostId: peerId, players: new Map([[peerId, { peerId, sse: null, queue: [], dropTimer: null }]]) });
    console.log('  room ' + code + ' created');
    return send(res, 200, { code });
  }

  if (p === '/api/join' && req.method === 'POST') {
    const { code, peerId } = await body(req);
    const room = rooms.get(String(code || ''));
    if (!room) return send(res, 404, { error: 'NO_ROOM' });
    if (room.players.size >= MAX_PLAYERS && !room.players.has(peerId)) return send(res, 409, { error: 'FULL' });
    room.players.set(peerId, { peerId, sse: null, queue: [], dropTimer: null });
    return send(res, 200, { ok: true });
  }

  // Deliberately quitting is not a dropout — no grace, no ghost in the lobby.
  if (p === '/api/leave' && req.method === 'POST') {
    const { code, peerId } = await body(req);
    const room = rooms.get(String(code || ''));
    if (room) dropPeer(room, peerId);
    return send(res, 200, { ok: true });
  }

  if (p === '/api/msg' && req.method === 'POST') {
    const { code, peerId, data } = await body(req);
    const room = rooms.get(String(code || ''));
    if (!room || !room.players.has(peerId)) return send(res, 404, { error: 'NO_ROOM' });
    relay(room, peerId, data);
    return send(res, 200, { ok: true });
  }

  if (p === '/events') {
    const code = url.searchParams.get('code'), peerId = url.searchParams.get('peerId');
    const room = rooms.get(String(code || ''));
    if (!room || !room.players.has(peerId)) return send(res, 404, { error: 'NO_ROOM' });

    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',   // tell proxies not to buffer the stream
    });
    const peer = room.players.get(peerId);
    cancelDrop(peer);              // they're back — call off the eviction
    peer.sse = res;
    push(peer, { op: 'ready' });   // client waits for this before sending anything

    // Anything that happened while they were away, in order.
    const held = peer.queue.splice(0);
    for (const m of held) push(peer, m);
    if (held.length) console.log('  peer ' + peerId + ' back in ' + room.code + ', ' + held.length + ' held');

    const ping = setInterval(() => { try { res.write(': ping\n\n'); } catch (e) {} }, PING_MS);
    req.on('close', () => {
      clearInterval(ping);
      if (peer.sse === res) { peer.sse = null; scheduleDrop(room, peerId); }
    });
    return;
  }

  // static files
  let f = decodeURIComponent(p === '/' ? '/index.html' : p);
  const file = path.join(ROOT, path.normalize(f).replace(/^(\.\.[/\\])+/, ''));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(file, (err, buf) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(buf);
  });
});

server.listen(PORT, () => {
  console.log('\n  Samay Pakad — http://localhost:' + PORT);
  for (const u of lanUrls()) console.log('  on this Wi-Fi:  ' + u);
  console.log('');
});
