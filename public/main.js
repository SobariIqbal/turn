// (FORCE_TURN removed) Use browser default ICE behavior

document.getElementById('join-btn').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const roomId = document.getElementById('room-id').value;

    if (!username || !roomId) {
        alert('Please enter your name and room ID.');
        return;
    }

    // Use default ICE servers (no TURN configured for local testing)
const iceServers = [
  { urls: 'turn:136.244.103.42:3478', username: 'iqbal', credential: 'sobari' }
];


    const peers = {}; // remoteId -> { pc, videoEl }
    let localId = null;

    try {
        const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

        // show local preview
        const participants = document.getElementById('participants');
        const localVideo = document.createElement('video');
        localVideo.srcObject = stream;
        localVideo.autoplay = true;
        localVideo.muted = true;
        localVideo.classList.add('participant');
        participants.appendChild(localVideo);

        // mute/unmute
        const muteButton = document.getElementById('mute-btn');
        let isMuted = false;
        if (muteButton) {
            const audioTrack = stream.getAudioTracks()[0];
            if (audioTrack) { isMuted = !audioTrack.enabled; muteButton.textContent = isMuted ? 'Unmute' : 'Mute'; }
            muteButton.addEventListener('click', () => {
                stream.getAudioTracks().forEach(t => t.enabled = !t.enabled);
                isMuted = !isMuted; muteButton.textContent = isMuted ? 'Unmute' : 'Mute';
            });
        }

        // video toggle
        const videoButton = document.getElementById('video-btn');
        let isVideoOn = true;
        if (videoButton) {
            const videoTrack = stream.getVideoTracks()[0];
            if (videoTrack) { isVideoOn = videoTrack.enabled; videoButton.textContent = isVideoOn ? 'Turn Off Video' : 'Turn On Video'; }
            videoButton.addEventListener('click', () => {
                stream.getVideoTracks().forEach(t => t.enabled = !t.enabled);
                isVideoOn = !isVideoOn; videoButton.textContent = isVideoOn ? 'Turn Off Video' : 'Turn On Video';
            });
        }

        // share screen
        const shareScreenButton = document.getElementById('share-screen-btn');
        let isSharingScreen = false;
        if (shareScreenButton) {
            shareScreenButton.addEventListener('click', async () => {
                try {
                    if (!isSharingScreen) {
                        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                        const screenTrack = screenStream.getVideoTracks()[0];
                        Object.values(peers).forEach(p => {
                            const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                            if (sender) sender.replaceTrack(screenTrack);
                        });
                        isSharingScreen = true; shareScreenButton.textContent = 'Stop Sharing';
                        screenTrack.onended = () => {
                            const webcamTrack = stream.getVideoTracks()[0];
                            Object.values(peers).forEach(p => {
                                const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                                if (sender && webcamTrack) sender.replaceTrack(webcamTrack);
                            });
                            isSharingScreen = false; shareScreenButton.textContent = 'Share Screen';
                        };
                    } else {
                        const webcamTrack = stream.getVideoTracks()[0];
                        Object.values(peers).forEach(p => {
                            const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                            if (sender && webcamTrack) sender.replaceTrack(webcamTrack);
                        });
                        isSharingScreen = false; shareScreenButton.textContent = 'Share Screen';
                    }
                } catch (err) { console.error('Error sharing screen:', err); }
            });
        }

        // connect to signaling and join
        joinSession({ stream, iceServers, peers, roomId, username, setLocalId: id => localId = id });
    } catch (err) {
        console.error('Error accessing media devices.', err);
    }
});


async function joinSession(opts) {
    const { stream, iceServers, peers, roomId, username, setLocalId } = opts;
    // local-only setup: signaling server runs on localhost:8080
    const signalingSocket = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);

    let localId = null;

    signalingSocket.onopen = () => {
        console.log('Connected to the signaling server');
        signalingSocket.send(JSON.stringify({ type: 'join', username, roomId }));
    };

    function sendToPeer(type, payload, to) {
        const msg = Object.assign({ type, to }, payload || {});
        signalingSocket.send(JSON.stringify(msg));
    }


    function createPeerConnectionFor(remoteId, isInitiator) {
        if (peers[remoteId]) return peers[remoteId].pc;
    const pcConfig = { iceServers };
    // Use the browser's default ICE transport policy so it can choose
    // the best path (host / srflx / relay) automatically.
        const pc = new RTCPeerConnection(pcConfig);
        stream.getTracks().forEach(t => pc.addTrack(t, stream));

        pc.onicecandidate = e => {
            if (e.candidate) {
                console.log(`[ICE] gathered candidate for peer ${remoteId}:`, e.candidate);
                try {
                    const candStr = e.candidate.candidate || '';
                    const protoMatch = candStr.match(/ (UDP|TCP) /i);
                    const proto = protoMatch ? protoMatch[1].toUpperCase() : (e.candidate.protocol ? e.candidate.protocol.toUpperCase() : 'unknown');
                    const typeMatch = candStr.match(/typ (\w+)/);
                    const typ = typeMatch ? typeMatch[1] : (e.candidate.candidateType || 'unknown');
                    console.log(`[ICE] candidate details for ${remoteId}: protocol=${proto}, type=${typ}`);
                } catch (err) {
                    console.warn('[ICE] failed to parse candidate', err);
                }
                sendToPeer('candidate', { candidate: e.candidate }, remoteId);
            } else {
                console.log(`[ICE] onicecandidate: null candidate (end) for ${remoteId}`);
            }
        };

        pc.ontrack = e => {
            const participants = document.getElementById('participants');
            let remoteVideo = peers[remoteId] && peers[remoteId].videoEl;
            if (!remoteVideo) { remoteVideo = document.createElement('video'); remoteVideo.autoplay = true; remoteVideo.classList.add('participant'); participants.appendChild(remoteVideo); }
            if (e.streams && e.streams[0]) remoteVideo.srcObject = e.streams[0]; else { const ms = new MediaStream(); ms.addTrack(e.track); remoteVideo.srcObject = ms; }
            peers[remoteId] = Object.assign(peers[remoteId] || {}, { pc, videoEl: remoteVideo });
        };

        pc.onconnectionstatechange = async () => {
            if (pc.connectionState === 'connected' || pc.connectionState === 'completed') {
                    console.log(`[PC] connectionState=${pc.connectionState} for ${remoteId}`);
                }
            if (pc.connectionState === 'closed' || pc.connectionState === 'failed' || pc.connectionState === 'disconnected') {
                if (peers[remoteId] && peers[remoteId].videoEl) peers[remoteId].videoEl.remove();
                delete peers[remoteId];
            }
        };

        peers[remoteId] = { pc, videoEl: peers[remoteId] && peers[remoteId].videoEl };

        if (isInitiator) {
            pc.createOffer().then(offer => pc.setLocalDescription(offer).then(() => {
                sendToPeer('offer', { offer: pc.localDescription }, remoteId);
            })).catch(console.error);
        }

        return pc;
    }

    signalingSocket.onmessage = async message => {
        const data = JSON.parse(message.data);
        if (data.type === 'id') { localId = data.id; if (typeof setLocalId === 'function') setLocalId(localId); return; }
        const from = data.from;
        if (!from || from === localId) return;

        switch (data.type) {
            case 'join':
                createPeerConnectionFor(from, true);
                break;
            case 'offer': {
                const pc = createPeerConnectionFor(from, false);
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendToPeer('answer', { answer: pc.localDescription }, from);
                break;
            }
            case 'answer': {
                const pc = peers[from] && peers[from].pc; if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                break;
            }
            case 'candidate': {
                const pc = peers[from] && peers[from].pc; if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { console.warn('Add ICE failed', e); } }
                break;
            }
            default: console.log('Unknown message type', data.type);
        }
    };

    signalingSocket.onerror = err => console.error('Signaling socket error', err);
}

// (removed TURN-detection helpers and candidate summarization)
