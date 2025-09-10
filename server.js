// server.js
// Minimal Express + ws signaling server
const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

const rooms = new Map(); // roomId -> Set of ws

wss.on('connection', (ws) => {
  ws.on('message', (msg) => {
    let m;
    try { m = JSON.parse(msg); } catch (e) { return; }
    const { type, room, data } = m;

    if (type === 'join') {
      ws.room = room;
      if (!rooms.has(room)) rooms.set(room, new Set());
      rooms.get(room).add(ws);
      // notify others if room has 2 peers
      const others = [...rooms.get(room)].filter(s => s !== ws);
      if (others.length >= 1) {
        ws.send(JSON.stringify({ type: 'ready' }));
        others.forEach(o => o.send(JSON.stringify({ type: 'peer-joined' })));
      }
      return;
    }

    // forward messages to other peer(s) in the same room
    if (ws.room && rooms.has(ws.room)) {
      const peers = rooms.get(ws.room);
      for (const peer of peers) {
        if (peer !== ws && peer.readyState === WebSocket.OPEN) {
          peer.send(JSON.stringify({ type, data }));
        }
      }
    }
  });

  ws.on('close', () => {
    if (ws.room && rooms.has(ws.room)) {
      rooms.get(ws.room).delete(ws);
      if (rooms.get(ws.room).size === 0) rooms.delete(ws.room);
    }
  });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log('Server listening on', PORT));
