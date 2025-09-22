const FORCE_TURN = true; // set at module scope so all functions can access

document.getElementById('join-btn').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const roomId = document.getElementById('room-id').value;

    if (!username || !roomId) {
        alert('Please enter your name and room ID.');
        return;
    }

    const iceServers = [
        { urls: 'turn:136.244.103.42:3478', username: 'iqbal', credential: 'sobari' }
    ];

    // Extract host/IPs from iceServers for matching against candidate addresses
    try {
        window._ICE_SERVERS_FOR_TURN_MATCH = (iceServers || []).flatMap(s => {
            const urls = s.urls || s.url || [];
            const arr = Array.isArray(urls) ? urls : [urls];
            return arr.map(u => {
                try {
                    // remove protocol and params, e.g. turn:host:3478?transport=udp
                    const host = u.replace(/^\w+:\/\//, '').replace(/^\w+:/, '').split(/[\?:]/)[0];
                    return host;
                } catch (e) { return null; }
            }).filter(Boolean);
        });
    } catch (e) { window._ICE_SERVERS_FOR_TURN_MATCH = []; }


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
    const signalingServerUrl = `ws://localhost:8081`;
    const signalingSocket = new WebSocket(signalingServerUrl);

    let localId = null;

    signalingSocket.onopen = () => {
        console.log('Connected to the signaling server');
        console.log('[CONFIG] FORCE_TURN =', FORCE_TURN);
        signalingSocket.send(JSON.stringify({ type: 'join', username, roomId }));
    };

    function sendToPeer(type, payload, to) {
        const msg = Object.assign({ type, to }, payload || {});
        signalingSocket.send(JSON.stringify(msg));
    }


    function createPeerConnectionFor(remoteId, isInitiator) {
        if (peers[remoteId]) return peers[remoteId].pc;
        const pcConfig = { iceServers };
        if (FORCE_TURN) pcConfig.iceTransportPolicy = 'relay';
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
                console.log(`[PC] connectionState=${pc.connectionState} for ${remoteId} — gathering stats to determine transport/proxy usage`);
                try { await logSelectedCandidatePair(pc, remoteId); } catch (err) { console.warn('[PC] error getting stats', err); }
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

// Helper: examine RTCPeerConnection.getStats to determine selected candidate pair and if TURN is used
async function logSelectedCandidatePair(pc, remoteId) {
    if (!pc || typeof pc.getStats !== 'function') return;
    const stats = await pc.getStats();
    let selectedPair = null;
    let localCandidate = null;
    let remoteCandidate = null;

    stats.forEach(report => {
        if (report.type === 'transport' && report.selectedCandidatePairId) {
            selectedPair = stats.get(report.selectedCandidatePairId) || selectedPair;
        }
        if (report.type === 'candidate-pair' && report.selected) selectedPair = report;
    });

    if (!selectedPair) {
        // fallback: find any candidate-pair with state succeeded
        stats.forEach(report => {
            if (report.type === 'candidate-pair' && report.state === 'succeeded') selectedPair = selectedPair || report;
        });
    }

    if (selectedPair) {
        localCandidate = stats.get(selectedPair.localCandidateId) || stats.get(selectedPair.localCandidateId || selectedPair.localCandidate) || null;
        remoteCandidate = stats.get(selectedPair.remoteCandidateId) || stats.get(selectedPair.remoteCandidateId || selectedPair.remoteCandidate) || null;
    }

    // Print summary
    console.log(`[STATS] for ${remoteId}: selectedPair=`, selectedPair || 'none');
    if (localCandidate) console.log(`[STATS] localCandidate for ${remoteId}:`, summarizeCandidate(localCandidate));
    if (remoteCandidate) console.log(`[STATS] remoteCandidate for ${remoteId}:`, summarizeCandidate(remoteCandidate));

    // Also log full candidate objects for debugging (helpful across browsers)
    if (localCandidate) console.log(`[STATS][full] localCandidate object for ${remoteId}:`, localCandidate);
    if (remoteCandidate) console.log(`[STATS][full] remoteCandidate object for ${remoteId}:`, remoteCandidate);

    // Determine if TURN is used (candidate type relay) and protocol
    const localType = localCandidate && (localCandidate.type || localCandidate.candidateType || localCandidate.candidateType);
    const remoteType = remoteCandidate && (remoteCandidate.type || remoteCandidate.candidateType || remoteCandidate.candidateType);
    const protocol = (localCandidate && (localCandidate.protocol || localCandidate.transport)) || (remoteCandidate && (remoteCandidate.protocol || remoteCandidate.transport)) || 'unknown';

    // Robust TURN detection: inspect candidate fields, candidate string, relayProtocol, or IP match to known TURN servers
    let usingTurn = false;
    try {
        // 1) direct type checks
        if ([localType, remoteType].some(t => String(t).toLowerCase() === 'relay')) usingTurn = true;

        // 2) check relayProtocol field present
        if (!usingTurn && ((localCandidate && localCandidate.relayProtocol) || (remoteCandidate && remoteCandidate.relayProtocol))) usingTurn = true;

        // 3) check 'candidate' SDP string for 'typ relay'
        if (!usingTurn && (localCandidate && localCandidate.candidate && /typ\s+relay/i.test(localCandidate.candidate))) usingTurn = true;
        if (!usingTurn && (remoteCandidate && remoteCandidate.candidate && /typ\s+relay/i.test(remoteCandidate.candidate))) usingTurn = true;

        // 4) check if candidate addresses match any TURN server host/IPs from iceServers
        if (!usingTurn && Array.isArray(window._ICE_SERVERS_FOR_TURN_MATCH)) {
            const turnAddrs = window._ICE_SERVERS_FOR_TURN_MATCH;
            if (localCandidate && localCandidate.address && turnAddrs.includes(String(localCandidate.address))) usingTurn = true;
            if (remoteCandidate && remoteCandidate.address && turnAddrs.includes(String(remoteCandidate.address))) usingTurn = true;
        }
    } catch (e) {
        console.warn('[STATS] error detecting TURN usage', e);
    }

    console.log(`[STATS] transport protocol=${protocol}, usingTURN=${usingTurn}`);

    // If TURN not detected yet, wait a short while and try again once (ICE can change)
    if (!usingTurn) {
        await new Promise(res => setTimeout(res, 800));
        const stats2 = await pc.getStats();
        let selectedPair2 = null;
        stats2.forEach(report => {
            if (report.type === 'transport' && report.selectedCandidatePairId) selectedPair2 = stats2.get(report.selectedCandidatePairId) || selectedPair2;
            if (report.type === 'candidate-pair' && report.selected) selectedPair2 = report;
        });
        if (!selectedPair2) stats2.forEach(report => { if (report.type === 'candidate-pair' && report.state === 'succeeded') selectedPair2 = selectedPair2 || report; });
        const localCandidate2 = selectedPair2 && (stats2.get(selectedPair2.localCandidateId) || stats2.get(selectedPair2.localCandidate) );
        const remoteCandidate2 = selectedPair2 && (stats2.get(selectedPair2.remoteCandidateId) || stats2.get(selectedPair2.remoteCandidate) );
        const localType2 = localCandidate2 && (localCandidate2.type || localCandidate2.candidateType);
        const remoteType2 = remoteCandidate2 && (remoteCandidate2.type || remoteCandidate2.candidateType);
        const usingTurn2 = [localType2, remoteType2].some(t => String(t).toLowerCase() === 'relay');
        if (usingTurn2) console.log(`[STATS] (after retry) usingTURN=true for ${remoteId}`);
        else console.log(`[STATS] (after retry) usingTURN still=false for ${remoteId}`);
    }
}

function summarizeCandidate(c) {
    if (!c) return null;
    return {
        id: c.id || c.candidateId || c.address,
        address: c.address || c.ip || c.candidate || null,
        port: c.port || null,
        protocol: c.protocol || c.transport || null,
        type: c.type || c.candidateType || null,
        relayProtocol: c.relayProtocol || null
    };
}
