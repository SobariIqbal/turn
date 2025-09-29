const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');

const PORT = 8080;
const publicDir = path.join(__dirname, 'public');

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

function joinRoom(ws, roomId) {
  if (!roomId) return;
  // Leave previous room if any
  if (ws._room && rooms.has(ws._room)) {
    const prev = rooms.get(ws._room);
    prev.delete(ws);
    if (prev.size === 0) rooms.delete(ws._room);
  }
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
  const roster = Array.from(set).map(c => ({ id: c._id, username: c._username || '' }));
  broadcastToRoom(roomId, { type: 'roster', roomId: String(roomId), roster });
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`Server listening on http://localhost:${PORT}`);
});

wss.on('connection', (ws) => {
  ws._id = String(nextId++);
  console.log('Client connected', ws._id);
  ws.send(JSON.stringify({ type: 'id', id: ws._id }));

  ws.on('message', (message) => {
    let data;
    try { data = JSON.parse(message); } catch { return; }
    data.from = ws._id;

    // Handle join: attach username/room to socket and broadcast roster to that room
    if (data.type === 'join') {
      ws._username = data.username || '';
      joinRoom(ws, data.roomId || 'default');
      // Inform room about this join (optional)
      broadcastToRoom(ws._room, { type: 'join', from: ws._id, username: ws._username, roomId: ws._room }, ws);
      // Send updated roster to everyone in room
      sendRosterToRoom(ws._room);
      return;
    }

    // Unicast within the room when 'to' is present
    if (data.to) {
      const targetId = String(data.to);
      // Only allow sending to peers in the same room
      const set = rooms.get(ws._room);
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
      } else {
        // Update roster for remaining peers
        sendRosterToRoom(ws._room);
      }
    }
  });
});
