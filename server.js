const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 8080;
const publicDir = path.join(__dirname, 'public');

// Presence tuning
const HEARTBEAT_INTERVAL_MS = 20000; // client-sent heartbeat cadence
const OFFLINE_THRESHOLD_MS = HEARTBEAT_INTERVAL_MS * 2 + 5000; // mark offline if no heartbeat beyond ~2 intervals

// Minimal static file server with SPA fallback
const server = http.createServer((req, res) => {
  let reqPath = (req.url || '/').split('?')[0] || '/';
  if (reqPath === '/') reqPath = '/index.html';
  const filePath = path.join(publicDir, decodeURIComponent(reqPath));

  fs.stat(filePath, (err, stats) => {
    const toServe = !err && stats.isFile() ? filePath : path.join(publicDir, 'index.html');
    fs.createReadStream(toServe).pipe(res);
  });
});

// WebSocket signaling: id assignment, room scoping, targeted send, broadcast-in-room
const wss = new WebSocket.Server({ server });
let nextId = 1;

// roomId -> Set<WebSocket>
const rooms = new Map();
// roomId -> timestamp of last roster push (to throttle heartbeat-triggered updates)
const roomRosterLastPushedAt = new Map();

function joinRoom(ws, roomId) {
  if (!roomId) return;
  // Als degene al in een room zat en die room leeg is verwijder die client uit de map en als de room leeg is verwijder de room
  if (ws._room && rooms.has(ws._room)) {
    const prev = rooms.get(ws._room);
    prev.delete(ws);
    if (prev.size === 0) {
      rooms.delete(ws._room);
      // Also clear last roster push timestamp for this room
      roomRosterLastPushedAt.delete(ws._room);
    }
  }// join een nieuwe room
  ws._room = String(roomId);
  if (!rooms.has(ws._room)) rooms.set(ws._room, new Set());
  rooms.get(ws._room).add(ws);
}

function broadcastToRoom(roomId, data, exceptWs) {
  const set = rooms.get(String(roomId));
  if (!set) return;
  const msg = typeof data === 'string' ? data : JSON.stringify(data);
  for (const client of set) {
    if (client !== exceptWs && client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function sendRosterToRoom(roomId) {
  const set = rooms.get(String(roomId));
  if (!set) return;
  const now = Date.now();
  const roster = Array.from(set).map(c => {
    const endedAt = c._lastCallEndedAt || null;
    const agoMs = endedAt ? (now - endedAt) : null;
    return {
      id: c._id,
      username: c._username || '',
      lang: c._lang || '',
      status: c._status || 'online',
      role: c._role || '',
      // Previous call metadata
      lastCallEndedAt: endedAt ? new Date(endedAt).toISOString() : null,
      lastCallAgoMs: agoMs,
      lastCallAgo: agoMs != null ? formatAgo(agoMs) : null
    };
  });
  broadcastToRoom(roomId, { type: 'roster', roomId: String(roomId), roster });
}

// Human-friendly formatter for durations like "2m 10s" or "1h 3m"
function formatAgo(ms) {
  if (ms == null || ms < 0) return null;
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (d > 0) return `${d}d ${h}h`;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

// Helper: update a user's presence status and broadcast roster if changed
function setStatus(ws, nextStatus) {
  const prev = ws._status || 'online';
  if (prev === nextStatus) return;
  // console.log(`[PRESENCE] client ${ws._id} status ${prev} -> ${nextStatus}`);
  ws._status = nextStatus;
  // NOTE (DB integration): here you could upsert presence into a DB table, e.g.
  // UPDATE presence SET status = ?, last_seen = NOW() WHERE user_id = ?;
  if (ws._room) sendRosterToRoom(ws._room);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

wss.on('connection', (ws) => {
  ws._id = String(nextId++);
  console.log('Client connected', ws._id);
  ws.send(JSON.stringify({ type: 'id', id: ws._id }));
  // Initialize presence metadata
  ws._status = 'online';
  ws._lastSeen = Date.now();

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    data.from = ws._id;
    // Update lastSeen on any message to avoid being marked offline while active
    ws._lastSeen = Date.now();

    // Handle join: attach username/room to socket and broadcast roster to that room
    if (data.type === 'join') {
      ws._username = data.username || '';
      ws._lang = data.lang || '';
      ws._role = data.role || '';
      ws._status = 'online';
      ws._lastSeen = Date.now();
      joinRoom(ws, data.roomId || 'default');
      // Inform room about this join (optional)
      broadcastToRoom(ws._room, { type: 'join', from: ws._id, username: ws._username, roomId: ws._room }, ws);
      // Send updated roster to everyone in room
      sendRosterToRoom(ws._room);
      return;
    }

    // Heartbeat: keep-alive presence signal from client
    if (data.type === 'heartbeat') {
      // NOTE (DB integration): write last_seen to DB here if needed
      ws._lastSeen = Date.now();
      // Log heartbeat with last call info (debug only)
      const endedAt = ws._lastCallEndedAt ? new Date(ws._lastCallEndedAt).toISOString() : 'n/a';
      const agoMs = ws._lastCallEndedAt ? (Date.now() - ws._lastCallEndedAt) : null;
      const ago = agoMs != null ? formatAgo(agoMs) + ' ago' : 'never';
      // console.log(`[HEARTBEAT] client ${ws._id}${ws._username ? ` (${ws._username})` : ''} room=${ws._room || '-'} status=${ws._status} | lastCall=${endedAt} (${ago})`);
      if (ws._status === 'offline') setStatus(ws, 'online');
      // Periodically refresh roster so 'last call: ... ago' stays current for all clients
      if (ws._room) {
        const now = Date.now();
        const last = roomRosterLastPushedAt.get(ws._room) || 0;
        if (now - last >= HEARTBEAT_INTERVAL_MS) {
          roomRosterLastPushedAt.set(ws._room, now);
          sendRosterToRoom(ws._room);
        }
      }
      return; // no need to forward
    }

    // Unicast within the room when 'to' is present
    if (data.to) {
      const targetId = String(data.to);
      // Only allow sending to peers in the same room
      const set = rooms.get(ws._room);
      // Presence transitions for 1:1 signaling
      if (data.type === 'ring') {
        setStatus(ws, 'busy');
      } else if (data.type === 'pickup') {
        // On pickup, both parties are in-call
        if (set) {
          for (const client of set) {
            if (client._id === targetId) {
              setStatus(client, 'in-call');
              break;
            }
          }
        }
        setStatus(ws, 'in-call');
      } else if (data.type === 'end') {
        // On end, both return to online
        if (set) {
          for (const client of set) {
            if (client._id === targetId) {
              // NOTE (DB integration): write a call-log row with ended_at for both parties.
              // INSERT INTO call_logs (caller_id, callee_id, ended_at, ...) VALUES (?, ?, NOW(), ...)
              client._lastCallEndedAt = Date.now();
              setStatus(client, 'online');
              break;
            }
          }
        }
        ws._lastCallEndedAt = Date.now();
        setStatus(ws, 'online');
      } else if (data.type === 'cancel') {
        // Caller cancels ringing: return to online
        setStatus(ws, 'online');
      }
      if (set) {
        for (const client of set) {
          if (client._id === targetId && client.readyState === WebSocket.OPEN) {
            client.send(JSON.stringify(data));
            return;
          }
        }
      }
      return;
    }

    // Server-side language-filtered ring broadcast within room
    // When a 'ring' message comes without a 'to', we optionally filter recipients by data.langFilter
    if (data.type === 'ring' && ws._room) {
      const set = rooms.get(ws._room);
      const filter = (data.langFilter || '').toString().trim().toLowerCase();
      const recipients = [];
      if (set) {
        for (const client of set) {
          if (client === ws) continue; // don't ring self
          if (client.readyState !== WebSocket.OPEN) continue;
          // Only deliver ring to receptionists (callees)
          if (client._role && client._role !== 'callee') continue;
          if (filter && String(client._lang || '').toLowerCase() !== filter) continue; // enforce language filter
          recipients.push(client);
        }
      }

      if (filter && recipients.length === 0) {
        // No recipients match requested language; notify caller only
        try { ws.send(JSON.stringify({ type: 'ring-no-match', roomId: ws._room, langFilter: filter })); } catch {}
        return;
      }

      // Mark caller as busy during ringing
      setStatus(ws, 'busy');

      // Send ring to the (possibly filtered) recipients
      if (recipients.length > 0) {
        const payload = JSON.stringify(data);
        for (const client of recipients) {
          try { client.send(payload); } catch {}
        }
      }
      return;
    }

    // Handle cancel broadcast (no 'to'): caller is no longer busy
    if (data.type === 'cancel') {
      setStatus(ws, 'online');
      // fall-through to broadcast so recipients clear UI
    }

    // Otherwise broadcast to everyone else in the same room
    if (ws._room) {
      broadcastToRoom(ws._room, data, ws);
    }
  });

  ws.on('close', () => {
    console.log('Client disconnected', ws._id);
    if (ws._room && rooms.has(ws._room)) {
      const set = rooms.get(ws._room);
      set.delete(ws);
      if (set.size === 0) {
        rooms.delete(ws._room);
        roomRosterLastPushedAt.delete(ws._room);
      } else {
        // Update roster for remaining peers
        sendRosterToRoom(ws._room);
      }
    }
  });
});

// Periodic sweeper to mark clients offline if they miss heartbeats
setInterval(() => {
  const now = Date.now();
  for (const [roomId, set] of rooms.entries()) {
    for (const ws of set) {
      if (!ws._lastSeen) continue;
      const age = now - ws._lastSeen;
      if (age > OFFLINE_THRESHOLD_MS && ws._status !== 'offline') {
        // console.log(`[OFFLINE] client ${ws._id}${ws._username ? ` (${ws._username})` : ''} marked offline; lastSeen=${age}ms ago`);
        setStatus(ws, 'offline');
        // NOTE (DB integration): UPDATE presence SET status='offline' WHERE user_id = ws._id
      }
    }
  }
}, HEARTBEAT_INTERVAL_MS);
