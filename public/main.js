// TURN-only testing enabled: ICE is constrained to relay via your TURN server

document.getElementById('join-btn').addEventListener('click', async () => {
    const username = document.getElementById('username').value;
    const explicitRoom = document.getElementById('room-id').value;
    const role = (document.getElementById('role-select') && document.getElementById('role-select').value) || '';
    const company = (document.getElementById('company-select') && document.getElementById('company-select').value) || '';
    const lang = (document.getElementById('language-select') && document.getElementById('language-select').value) || '';
    const companyKey = (company || '').toString().trim().toLowerCase();
    // Prefer company-based room if role+company provided; fallback to explicit room; else block
    const roomId = (role && companyKey) ? `${companyKey}` : explicitRoom;

    if (!username || !roomId) {
    alert('Please enter your name and select role+company or specify a room ID.');
        return;
    }

        // Force TURN-only for testing: provide UDP/TCP/TLS and use relay-only policy
const iceServers = [
    {
        urls: [
            'turn:10.192.2.55:3478?transport=udp',
            'turn:10.192.2.55:3478?transport=tcp',
            'turns:10.192.2.55:5349?transport=tcp'
        ],
        username: 'iqbal123@$$@',
        credential: 'sobari123@$$@'
    }
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

        // Helper to replace outgoing video track for all peers
        const replaceVideoTrackForAll = (track) => {
            Object.values(peers).forEach(p => {
                const sender = p.pc.getSenders().find(s => s.track && s.track.kind === 'video');
                if (sender) sender.replaceTrack(track);
            });
        };

        // share screen
        const shareScreenButton = document.getElementById('share-screen-btn');
        let isSharingScreen = false;
        if (shareScreenButton) {
            shareScreenButton.addEventListener('click', async () => {
                try {
                    if (!isSharingScreen) {
                        const screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true });
                        const screenTrack = screenStream.getVideoTracks()[0];
                        replaceVideoTrackForAll(screenTrack);
                        isSharingScreen = true; shareScreenButton.textContent = 'Stop Sharing';
                        screenTrack.onended = () => {
                            const webcamTrack = stream.getVideoTracks()[0];
                            if (webcamTrack) replaceVideoTrackForAll(webcamTrack);
                            isSharingScreen = false; shareScreenButton.textContent = 'Share Screen';
                        };
                    } else {
                        const webcamTrack = stream.getVideoTracks()[0];
                        if (webcamTrack) replaceVideoTrackForAll(webcamTrack);
                        isSharingScreen = false; shareScreenButton.textContent = 'Share Screen';
                    }
                } catch (err) { console.error('Error sharing screen:', err); }
            });
        }

    // connect to signaling and join
    joinSession({ stream, iceServers, peers, roomId, username, role, lang, setLocalId: id => localId = id });

    // After join, enable call UI once we get roster
    } catch (err) {
        console.error('Error accessing media devices.', err);
    }
});


async function joinSession(opts) {
    const { stream, iceServers, peers, roomId, username, role, lang, setLocalId } = opts;
    // local-only setup: signaling server runs on localhost:8080
    const signalingSocket = new WebSocket((location.protocol === 'https:' ? 'wss' : 'ws') + '://' + location.host);

    let localId = null;
    let roster = [];
    let fullRoster = [];
    let ringingFrom = null; // stores the caller id when receiving a ring
    let inCallWith = null; // current peer id you're in call with
    let ringTimer = null; // timeout for outgoing ring
    let huntAllActive = false; // ring-all (hunt group) active
    let huntWinner = null; // id of first pickup
    let serialActive = false; // serial dialing active
    let serialQueue = []; // ordered list of ids to dial
    let serialIndex = -1; // current index in serialQueue
    let tempPickupUi = false; // temporarily show pickup for non-callees during escalation

    // UI elements for calling
    const callControls = document.getElementById('call-controls');
    const peerSelect = document.getElementById('peer-select');
    const callBtn = document.getElementById('call-btn');
    const endBtn = document.getElementById('end-btn');
    const callAllBtn = document.getElementById('call-all-btn');
    const callModeWrap = document.getElementById('call-mode-wrap');
    const callModeSelect = document.getElementById('call-mode');
    const pickupBtn = document.getElementById('pickup-btn');
    const declineBtn = document.getElementById('decline-btn');
    const callStatus = document.getElementById('call-status');

    // Configure UI by role: caller can only Call All; callee can only Pick Up/Decline
    // We still keep controls present but disable/hide forbidden actions to reduce confusion.
    if (callControls) callControls.style.display = 'block';
    if (role === 'caller') {
        if (callBtn) callBtn.style.display = 'none'; // hide 1:1 call for reception
        if (callAllBtn) callAllBtn.style.display = 'inline-block';
        if (pickupBtn) pickupBtn.style.display = 'none';
        if (declineBtn) declineBtn.style.display = 'none';
        if (peerSelect) peerSelect.parentElement.style.display = 'none';
        if (callModeWrap) callModeWrap.style.display = 'block';
        callStatus.textContent = 'Caller mode: choose Call Mode and press Call All.';
    } else if (role === 'callee') {
        if (callBtn) callBtn.style.display = 'none';
        if (callAllBtn) callAllBtn.style.display = 'none';
        if (pickupBtn) pickupBtn.style.display = 'inline-block';
        if (declineBtn) declineBtn.style.display = 'inline-block';
        if (peerSelect) peerSelect.parentElement.style.display = 'none';
        callStatus.textContent = 'Callee mode: wait for an incoming call and Pick Up.';
    } else {
        // default (legacy) mode: show everything
        callStatus.textContent = 'Joined. You can place or receive calls.';
    }

    signalingSocket.onopen = () => {
        console.log('Connected to the signaling server');
    signalingSocket.send(JSON.stringify({ type: 'join', username, roomId, lang, role }));
        // Start periodic heartbeat to maintain presence
        const HEARTBEAT_MS = 20000;
        setInterval(() => {
            try { signalingSocket.send(JSON.stringify({ type: 'heartbeat' })); } catch(_){}
        }, HEARTBEAT_MS);
    };

    function sendToPeer(type, payload, to) {
        const msg = Object.assign({ type, to }, payload || {});
        signalingSocket.send(JSON.stringify(msg));
    }

    function clearRingTimer() {
        if (ringTimer) {
            clearTimeout(ringTimer);
            ringTimer = null;
        }
    }

    function resetUiState() {
        clearRingTimer();
        ringingFrom = null;
        inCallWith = null;
        huntAllActive = false;
        huntWinner = null;
        serialActive = false;
        serialQueue = [];
        serialIndex = -1;
        if (pickupBtn) pickupBtn.disabled = true;
        if (declineBtn) declineBtn.disabled = true;
        if (endBtn) endBtn.disabled = true;
        if (callBtn) callBtn.disabled = false;
        if (callAllBtn) callAllBtn.disabled = false;
        callStatus.textContent = 'Idle.';
        if (tempPickupUi && role !== 'callee') {
            if (pickupBtn) pickupBtn.style.display = 'none';
            if (declineBtn) declineBtn.style.display = 'none';
            tempPickupUi = false;
        }
    }
    function sortByLongestAvailable(list) {
        return list.slice().sort((a, b) => {
            const ams = (a.lastCallAgoMs == null ? Number.POSITIVE_INFINITY : a.lastCallAgoMs);
            const bms = (b.lastCallAgoMs == null ? Number.POSITIVE_INFINITY : b.lastCallAgoMs);
            if (ams !== bms) return bms - ams; // larger ms = longer since last call
            const ai = parseInt(a.id, 10);
            const bi = parseInt(b.id, 10);
            if (!Number.isNaN(ai) && !Number.isNaN(bi)) return ai - bi;
            return String(a.id).localeCompare(String(b.id));
        });
    }

    function startSerialDial(candidates, timeoutMs) {
        const list = candidates.filter(p => (p.status || 'online') === 'online');
        if (list.length === 0) { callStatus.textContent = 'No available recipients for serial dialing.'; return; }
        serialActive = true;
        serialQueue = list.map(p => p.id);
        serialIndex = 0;
        if (callBtn) callBtn.disabled = true;
        if (callAllBtn) callAllBtn.disabled = true;
        ringNextSerial(timeoutMs);
    }

    function ringNextSerial(timeoutMs) {
        clearRingTimer();
        if (!serialActive || serialIndex < 0 || serialIndex >= serialQueue.length) {
            callStatus.textContent = 'No one responded.';
            resetUiState();
            return;
        }
        const targetId = serialQueue[serialIndex];
        inCallWith = targetId;
        callStatus.textContent = `Ringing #${targetId} (${serialIndex + 1}/${serialQueue.length})...`;
        sendToPeer('ring', { roomId }, targetId);
        ringTimer = setTimeout(() => {
            if (!serialActive) return;
            sendToPeer('cancel', { roomId }, targetId);
            serialIndex++;
            ringNextSerial(timeoutMs);
        }, timeoutMs);
    }

    function closePeer(remoteId) {
        const p = peers[remoteId];
        if (!p) return;
        try { if (p.pc) p.pc.close(); } catch(_){}
        if (p.videoEl) { try { p.videoEl.remove(); } catch(_){} }
        delete peers[remoteId];
    }

    // Helper: log selected candidate pair after connection succeeds
    async function logSelectedCandidatePair(pc, remoteId) {
        try {
            const stats = await pc.getStats();
            let pair = null;
            // Prefer modern 'transport' report to find selected pair
            stats.forEach(report => {
                if (!pair && report.type === 'transport' && report.selectedCandidatePairId) {
                    const cp = stats.get(report.selectedCandidatePairId);
                    if (cp) pair = cp;
                }
            });
            // Fallback: legacy candidate-pair with selected/state=succeeded
            if (!pair) {
                stats.forEach(report => {
                    if (report.type === 'candidate-pair' && (report.selected || report.state === 'succeeded')) {
                        pair = report;
                    }
                });
            }
            if (pair) {
                const local = stats.get && pair.localCandidateId ? stats.get(pair.localCandidateId) : null;
                const remote = stats.get && pair.remoteCandidateId ? stats.get(pair.remoteCandidateId) : null;
                const protocol = (local && local.protocol) || (remote && remote.protocol) || 'unknown';
                const localType = local ? (local.candidateType || local.type) : 'unknown';
                const remoteType = remote ? (remote.candidateType || remote.type) : 'unknown';
                const localAddr = local ? ((local.ip || local.address || 'addr') + (local.port ? ':' + local.port : '')) : '';
                const remoteAddr = remote ? ((remote.ip || remote.address || 'addr') + (remote.port ? ':' + remote.port : '')) : '';
                console.log(`[ICE] success: selected candidate pair for ${remoteId}: protocol=${protocol}, local=${localType}(${localAddr}) -> remote=${remoteType}(${remoteAddr})`);
            } else {
                console.log(`[ICE] connected for ${remoteId}, but no selected candidate pair found in getStats()`);
            }
        } catch (err) {
            console.warn(`[ICE] getStats failed for ${remoteId}`, err);
        }
    }


    function createPeerConnectionFor(remoteId, isInitiator) {
        if (peers[remoteId]) return peers[remoteId].pc;
    const pcConfig = { iceServers, iceTransportPolicy: 'relay' };
    // Force relay-only so all connectivity goes through TURN.
        const pc = new RTCPeerConnection(pcConfig);
        stream.getTracks().forEach(t => pc.addTrack(t, stream));

        // Log ICE gathering progress and completion
        pc.onicegatheringstatechange = () => {
            console.log(`[ICE] gatheringState=${pc.iceGatheringState} for ${remoteId}`);
            if (pc.iceGatheringState === 'complete') {
                console.log(`[ICE] gathering completed for ${remoteId}`);
            }
        };

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

        // Log ICE connection success explicitly (in addition to overall connectionState)
        pc.oniceconnectionstatechange = async () => {
            const s = pc.iceConnectionState;
            console.log(`[ICE] iceConnectionState=${s} for ${remoteId}`);
            if ((s === 'connected' || s === 'completed') && !(peers[remoteId] && peers[remoteId].__loggedIceSuccess)) {
                peers[remoteId] = Object.assign(peers[remoteId] || {}, { __loggedIceSuccess: true });
                await logSelectedCandidatePair(pc, remoteId);
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
                    // Also ensure we log the selected candidate pair on overall connection success
                    if (!(peers[remoteId] && peers[remoteId].__loggedIceSuccess)) {
                        peers[remoteId] = Object.assign(peers[remoteId] || {}, { __loggedIceSuccess: true });
                        await logSelectedCandidatePair(pc, remoteId);
                    }
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

        switch (data.type) {
            case 'roster': {
                fullRoster = (data.roster || []).filter(p => p.id !== localId);
                let incoming = fullRoster.slice();
                // If I'm a caller (digital reception), only show receptionists (callees)
                if (role === 'caller') {
                    incoming = incoming.filter(p => (p.role || '') === 'callee');
                }
                roster = incoming;
                // Update UI
                if (callControls) callControls.style.display = 'block';
                if (peerSelect) {
                    peerSelect.innerHTML = '';
                    roster.forEach(p => {
                        const opt = document.createElement('option');
                        const st = p.status || 'online';
                        const langTag = p.lang ? ` • ${p.lang}` : '';
                        opt.value = p.id;
                        opt.textContent = `${p.username || 'User'} (#${p.id}) • ${st}${langTag}`;
                        // Optionally disable offline/busy entries for 1:1 calls
                        if (st !== 'online') opt.disabled = true;
                        // Keep a concise tooltip without last-call info
                        opt.title = `Status: ${st}${p.lang ? ` | Lang: ${p.lang}` : ''}`;
                        peerSelect.appendChild(opt);
                    });
                }
                callStatus.textContent = roster.length ? 'Select a user to call.' : 'No other users in room yet.';
                break;
            }
            case 'ring-no-match': {
                // Server reports no matching recipients for requested language
                huntAllActive = false;
                huntWinner = null;
                inCallWith = null;
                ringingFrom = null;
                clearRingTimer();
                if (endBtn) endBtn.disabled = true;
                if (callBtn) callBtn.disabled = false;
                if (callAllBtn) callAllBtn.disabled = false;
                const lf = (data.langFilter || '').toString();
                callStatus.textContent = lf ? `No receptionists available for language "${lf}".` : 'No recipients available.';
                break;
            }
            case 'join': {
                // Someone joined the room; roster updates will follow from server. No auto-call.
                break;
            }
            case 'ring': {
                if (!from || from === localId) break;
                // If already busy (in a call or already ringing), auto-reply busy
                if (inCallWith || ringingFrom) {
                    sendToPeer('busy', { roomId }, from);
                    break;
                }
                // Incoming call; enable pickup/decline
                ringingFrom = from;
                inCallWith = null;
                if (pickupBtn) { pickupBtn.disabled = false; }
                if (declineBtn) { declineBtn.disabled = false; }
                // If I'm not a callee, temporarily show pickup UI (for escalation fallback)
                if (role !== 'callee') {
                    if (pickupBtn) pickupBtn.style.display = 'inline-block';
                    if (declineBtn) declineBtn.style.display = 'inline-block';
                    tempPickupUi = true;
                }
                callStatus.textContent = `Incoming call from #${from}.`;
                break;
            }
            case 'busy': {
                if (!from || from === localId) break;
                if (serialActive && inCallWith === from) {
                    callStatus.textContent = `User #${from} is busy. Trying next...`;
                    clearRingTimer();
                    serialIndex++;
                    ringNextSerial(10000);
                } else if (inCallWith === from) {
                    callStatus.textContent = `User #${from} is busy.`;
                    clearRingTimer();
                    inCallWith = null;
                    if (endBtn) endBtn.disabled = true;
                    if (callBtn) callBtn.disabled = false;
                    if (callAllBtn) callAllBtn.disabled = false;
                }
                break;
            }
            case 'cancel': {
                if (!from || from === localId) break;
                if (ringingFrom === from) {
                    callStatus.textContent = `Caller #${from} cancelled the call.`;
                    ringingFrom = null;
                    if (pickupBtn) pickupBtn.disabled = true;
                    if (declineBtn) declineBtn.disabled = true;
                    if (tempPickupUi && role !== 'callee') {
                        if (pickupBtn) pickupBtn.style.display = 'none';
                        if (declineBtn) declineBtn.style.display = 'none';
                        tempPickupUi = false;
                    }
                }
                break;
            }
            case 'decline': {
                if (!from || from === localId) break;
                if (serialActive && inCallWith === from) {
                    callStatus.textContent = `User #${from} declined. Trying next...`;
                    clearRingTimer();
                    serialIndex++;
                    ringNextSerial(10000);
                } else if (inCallWith === from || (peerSelect && peerSelect.value === from)) {
                    callStatus.textContent = `User #${from} declined the call.`;
                    clearRingTimer();
                    inCallWith = null;
                    if (endBtn) endBtn.disabled = true;
                    if (callBtn) callBtn.disabled = false;
                    if (callAllBtn) callAllBtn.disabled = false;
                }
                break;
            }
            case 'pickup': {
                if (!from || from === localId) break;
                // Callee accepted; start WebRTC offer now
                // If hunt-all active and we already have a winner, reply busy to late pickups
                if (huntAllActive && huntWinner && huntWinner !== from) {
                    sendToPeer('busy', { roomId }, from);
                    break;
                }
                inCallWith = from;
                if (huntAllActive && !huntWinner) {
                    huntWinner = from;
                    // Cancel others
                    signalingSocket.send(JSON.stringify({ type: 'cancel', roomId }));
                    callStatus.textContent = `First to answer: #${from}. Connecting...`;
                } else if (serialActive) {
                    // Accept only if it's the currently ringing serial target
                    if (from !== inCallWith) {
                        sendToPeer('busy', { roomId }, from);
                        break;
                    }
                    serialActive = false;
                    callStatus.textContent = `Call accepted by #${from}. Connecting...`;
                } else {
                    callStatus.textContent = `Call accepted by #${from}. Connecting...`;
                }
                clearRingTimer();
                const pc = createPeerConnectionFor(from, true);
                // Offer will be created by createPeerConnectionFor when isInitiator=true
                if (endBtn) endBtn.disabled = false;
                break;
            }
            case 'offer': {
                if (!from || from === localId) break;
                const pc = createPeerConnectionFor(from, false);
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer();
                await pc.setLocalDescription(answer);
                sendToPeer('answer', { answer: pc.localDescription }, from);
                if (endBtn) endBtn.disabled = false;
                break;
            }
            case 'answer': {
                if (!from || from === localId) break;
                const pc = peers[from] && peers[from].pc; if (pc) await pc.setRemoteDescription(new RTCSessionDescription(data.answer));
                if (endBtn) endBtn.disabled = false;
                break;
            }
            case 'candidate': {
                if (!from || from === localId) break;
                const pc = peers[from] && peers[from].pc; if (pc) { try { await pc.addIceCandidate(new RTCIceCandidate(data.candidate)); } catch (e) { console.warn('Add ICE failed', e); } }
                break;
            }
            case 'end': {
                if (!from || from === localId) break;
                // Remote ended the call
                closePeer(from);
                callStatus.textContent = `Call with #${from} ended.`;
                resetUiState();
                break;
            }
            default: console.log('Unknown message type', data.type);
        }
    };

    signalingSocket.onerror = err => console.error('Signaling socket error', err);

    // Caller actions
    if (callBtn) {
        callBtn.onclick = () => {
            const targetId = peerSelect && peerSelect.value;
            if (!targetId) { callStatus.textContent = 'Select someone to call.'; return; }
            // Skip targets that are not online
            const target = (roster || []).find(p => p.id === targetId);
            if (target && target.status && target.status !== 'online') { callStatus.textContent = 'Target is not available.'; return; }
            if (inCallWith || ringingFrom) { callStatus.textContent = 'You are busy.'; return; }
            ringingFrom = null;
            inCallWith = targetId;
            sendToPeer('ring', { roomId }, targetId);
            callStatus.textContent = `Ringing #${targetId}...`;
            // Start ring timeout (25s)
            clearRingTimer();
            ringTimer = setTimeout(() => {
                if (inCallWith === targetId) {
                    callStatus.textContent = `No answer from #${targetId}.`;
                    sendToPeer('cancel', { roomId }, targetId);
                    inCallWith = null;
                    if (endBtn) endBtn.disabled = true;
                    if (callBtn) callBtn.disabled = false;
                    if (callAllBtn) callAllBtn.disabled = false;
                }
            }, 25000);
            if (callBtn) callBtn.disabled = true;
            if (callAllBtn) callAllBtn.disabled = true;
        };
    }

    if (callAllBtn) {
        callAllBtn.onclick = () => {
            if (inCallWith || ringingFrom) { callStatus.textContent = 'You are busy.'; return; }
            // Require language selection for filtering
            const langSelectEl = document.getElementById('language-select');
            const langFilter = (langSelectEl && langSelectEl.value || '').toString().trim().toLowerCase();
            if (!langFilter) { callStatus.textContent = 'Please select a language before Call All.'; return; }

            const mode = (callModeSelect && callModeSelect.value) || 'parallel';

            if (mode === 'parallel') {
                const matches = (fullRoster || []).filter(p => (p.role || '') === 'callee' && (p.status || 'online') === 'online' && (p.lang || '').toString().trim().toLowerCase() === langFilter);
                if (matches.length === 0) { callStatus.textContent = `No receptionists in room for language "${langFilter}".`; return; }
                huntAllActive = true;
                huntWinner = null;
                inCallWith = 'hunt-all';
                signalingSocket.send(JSON.stringify({ type: 'ring', roomId, langFilter }));
                callStatus.textContent = `Ringing ${matches.length} receptionist(s) for language "${langFilter}"...`;
                clearRingTimer();
                ringTimer = setTimeout(() => {
                    if (huntAllActive && !huntWinner) {
                        callStatus.textContent = 'No one picked up.';
                        signalingSocket.send(JSON.stringify({ type: 'cancel', roomId }));
                        resetUiState();
                    }
                }, 25000);
                if (callBtn) callBtn.disabled = true;
                callAllBtn.disabled = true;
                return;
            }

            if (mode === 'serial') {
                const candidates = sortByLongestAvailable((fullRoster || []).filter(p => (p.role || '') === 'callee' && (p.status || 'online') === 'online' && (p.lang || '').toString().trim().toLowerCase() === langFilter));
                if (candidates.length === 0) { callStatus.textContent = `No receptionists available for language "${langFilter}".`; return; }
                startSerialDial(candidates, 10000);
                return;
            }

            if (mode === 'escalation') {
                const perfect = (fullRoster || []).filter(p => (p.role || '') === 'callee' && (p.status || 'online') === 'online' && (p.lang || '').toString().trim().toLowerCase() === langFilter);
                if (perfect.length > 0) {
                    huntAllActive = true;
                    huntWinner = null;
                    inCallWith = 'hunt-all';
                    signalingSocket.send(JSON.stringify({ type: 'ring', roomId, langFilter }));
                    callStatus.textContent = `Ringing ${perfect.length} perfect match(es) for "${langFilter}"...`;
                    clearRingTimer();
                    ringTimer = setTimeout(() => {
                        if (huntAllActive && !huntWinner) {
                            callStatus.textContent = 'No one picked up.';
                            signalingSocket.send(JSON.stringify({ type: 'cancel', roomId }));
                            resetUiState();
                        }
                    }, 25000);
                    if (callBtn) callBtn.disabled = true;
                    callAllBtn.disabled = true;
                    return;
                }
                const anyCallee = (fullRoster || []).filter(p => (p.role || '') === 'callee' && (p.status || 'online') === 'online');
                if (anyCallee.length > 0) {
                    huntAllActive = true;
                    huntWinner = null;
                    inCallWith = 'hunt-all';
                    signalingSocket.send(JSON.stringify({ type: 'ring', roomId }));
                    callStatus.textContent = `No perfect match. Ringing ${anyCallee.length} receptionist(s) (any language)...`;
                    clearRingTimer();
                    ringTimer = setTimeout(() => {
                        if (huntAllActive && !huntWinner) {
                            callStatus.textContent = 'No one picked up.';
                            signalingSocket.send(JSON.stringify({ type: 'cancel', roomId }));
                            resetUiState();
                        }
                    }, 25000);
                    if (callBtn) callBtn.disabled = true;
                    callAllBtn.disabled = true;
                    return;
                }
                const others = sortByLongestAvailable((fullRoster || []).filter(p => (p.status || 'online') === 'online'));
                if (others.length > 0) {
                    callStatus.textContent = 'No receptionists online. Escalating to any online user...';
                    startSerialDial(others, 10000);
                    return;
                }
                callStatus.textContent = 'No one online to receive the call.';
                return;
            }
        };
    }

    // Callee actions
    if (pickupBtn) {
        pickupBtn.onclick = () => {
            if (!ringingFrom) { callStatus.textContent = 'No incoming call.'; return; }
            sendToPeer('pickup', { roomId }, ringingFrom);
            // After pickup, we expect the caller to create offer; if this side initiated, ensure not double-offering
            pickupBtn.disabled = true; declineBtn.disabled = true;
            callStatus.textContent = `You accepted the call from #${ringingFrom}.`;
            inCallWith = ringingFrom; ringingFrom = null;
            if (endBtn) endBtn.disabled = false;
        };
    }

    if (declineBtn) {
        declineBtn.onclick = () => {
            if (!ringingFrom) { callStatus.textContent = 'No incoming call.'; return; }
            sendToPeer('decline', { roomId }, ringingFrom);
            pickupBtn.disabled = true; declineBtn.disabled = true;
            callStatus.textContent = 'Call declined.';
            ringingFrom = null;
        };
    }

    if (endBtn) {
        endBtn.onclick = () => {
            if (!inCallWith) { callStatus.textContent = 'No active call.'; return; }
            const peerId = inCallWith;
            sendToPeer('end', { roomId }, peerId);
            closePeer(peerId);
            callStatus.textContent = 'Call ended.';
            resetUiState();
        };
    }
}
