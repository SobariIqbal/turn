// main.js
const localVideo = document.getElementById('local');
const remoteVideo = document.getElementById('remote');
const joinBtn = document.getElementById('join');
const callBtn = document.getElementById('call');
const hangupBtn = document.getElementById('hangup');
const roomInput = document.getElementById('room');

let localStream, pc, ws;
let isOfferer = false;

// Replace/add TURN if you have one (test with/without TURN):
const ICE_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  // FOR TESTING: replace the next line with your TURN server
  { urls: 'turn:136.244.103.42:443', username: 'iqbal', credential: 'sobari' }
];

async function startLocal() {
  localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
  localVideo.srcObject = localStream;
}

function connectWS() {
  const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(proto + '//' + location.host);
  ws.onopen = () => {
    console.log('ws open');
  };
  ws.onmessage = async (evt) => {
    const msg = JSON.parse(evt.data);
    if (msg.type === 'ready') {
      console.log('ready — you can call');
    } else if (msg.type === 'peer-joined') {
      console.log('peer joined');
    } else if (msg.type === 'offer') {
      await ensurePC();
      await pc.setRemoteDescription(msg.data);
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      ws.send(JSON.stringify({ type: 'answer', data: pc.localDescription }));
    } else if (msg.type === 'answer') {
      await pc.setRemoteDescription(msg.data);
    } else if (msg.type === 'candidate') {
      try {
        await pc.addIceCandidate(msg.data);
      } catch (e) {
        console.warn('addIceCandidate error', e);
      }
    }
  };
}

async function ensurePC() {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  pc.onicecandidate = (e) => {
    if (e.candidate) {
      ws.send(JSON.stringify({ type: 'candidate', data: e.candidate }));
    }
  };

  pc.ontrack = (e) => {
    remoteVideo.srcObject = e.streams[0];
  };

  // add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => pc.addTrack(track, localStream));
  }
}

joinBtn.onclick = async () => {
  await startLocal();
  connectWS();
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'join', room: roomInput.value }));
  };
};

callBtn.onclick = async () => {
  isOfferer = true;
  await ensurePC();
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  ws.send(JSON.stringify({ type: 'offer', data: pc.localDescription }));
};

hangupBtn.onclick = () => {
  if (pc) pc.close();
  pc = null;
};
