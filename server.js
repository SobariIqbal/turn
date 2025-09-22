const WebSocket = require('ws');

const SIGNALING_PORT = process.env.SIGNALING_PORT || 8081;
const wss = new WebSocket.Server({ port: Number(SIGNALING_PORT) });

let nextClientId = 1;

wss.on('listening', () => console.log(`Signaling server listening on ws://localhost:${SIGNALING_PORT}`));

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

    // Otherwise broadcast to all other clients in the same room (no rooms tracking here)
    wss.clients.forEach(client => {
      if (client !== ws && client.readyState === WebSocket.OPEN) {
        client.send(JSON.stringify(data));
      }
    });
  });

  ws.on('close', () => console.log('Client disconnected', id));
});
