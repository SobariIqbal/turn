const http = require('http');
const path = require('path');
const fs = require('fs');
const WebSocket = require('ws');
const PORT = Number(process.env.PORT || process.env.SIGNALING_PORT || 8080);

// Simple static file server for the 'public' directory
const publicDir = path.join(__dirname, 'public');
const server = http.createServer((req, res) => {
  // serve index.html for root or any unknown path (SPA-friendly)
  let reqPath = req.url.split('?')[0];
  if (reqPath === '/' || reqPath === '') reqPath = '/index.html';
  const filePath = path.join(publicDir, decodeURIComponent(reqPath));
  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // fallback to index.html for SPA
      const index = path.join(publicDir, 'index.html');
      fs.createReadStream(index).pipe(res);
      return;
    }
    const stream = fs.createReadStream(filePath);
    stream.pipe(res);
  });
});

const wss = new WebSocket.Server({ server });

let nextClientId = 1;

server.listen(PORT, '127.0.0.1', () => console.log(`Server listening on http://localhost:${PORT}`));

wss.on('connection', ws => {
  const id = String(nextClientId++);
  ws._clientId = id;
  console.log('Client connected', id);

  // notify client of its id
  ws.send(JSON.stringify({ type: 'id', id }));

  ws.on('message', message => {
    let data = null;
    try { data = JSON.parse(message); } catch (e) { console.warn('Invalid JSON from', id); return; }

    // Attach sender id
    data.from = id;

    // If message has `to`, forward only to that client
    if (data.to) {
      const target = Array.from(wss.clients).find(c => c._clientId === data.to && c.readyState === WebSocket.OPEN);
      if (target) {
        target.send(JSON.stringify(data));
      } else {
        console.warn('Target not found or not open:', data.to);
      }
      return;
    }

    // Otherwise broadcast to all other clients
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  });

  ws.on('close', () => console.log('Client disconnected', id));
});
