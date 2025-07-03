const room = new WebsimSocket();

const elements = {
    lobbyContainer: document.getElementById('lobby-container'),
    roomNameInput: document.getElementById('room-name-input'),
    joinRoomBtn: document.getElementById('join-room-btn'),
    appContainer: document.getElementById('app-container'),
    hostControls: document.getElementById('host-controls'),
    urlInput: document.getElementById('url-input'),
    userList: document.getElementById('user-list'),
    iframeWrapper: document.getElementById('iframe-wrapper'),
    sharedIframe: document.getElementById('shared-iframe'),
    overlay: document.getElementById('overlay'),
    keystrokeDisplay: document.getElementById('keystroke-display'),
};

const state = {
    isHost: false,
    hasControl: false,
    cursors: {},
    lastLoadedIframeUrl: '',
};

function hasPermission(clientId) {
    if (room.roomState.hostClientId === clientId) return true;
    const permissions = room.roomState.permissions || {};
    return permissions[clientId]?.canControl || false;
}

function canThisClientControl() {
    return state.isHost || hasPermission(room.clientId);
}

function render() {
    if (!room.roomState || !room.presence) return;

    state.isHost = room.roomState.hostClientId === room.clientId;
    state.hasControl = canThisClientControl();

    // --- Render Host/Viewer UI ---
    elements.hostControls.classList.toggle('hidden', !state.isHost);
    
    // Keystroke display and URL input are only visible to host
    if(state.isHost) {
        elements.keystrokeDisplay.textContent = room.roomState.lastKeystrokes || '';
        if (document.activeElement !== elements.urlInput) {
            elements.urlInput.value = room.roomState.iframeUrl || '';
        }
    }

    // --- Sync Iframe URL ---
    const targetUrl = room.roomState.iframeUrl || 'about:blank';
    if (targetUrl !== state.lastLoadedIframeUrl) {
        elements.sharedIframe.src = targetUrl;
        state.lastLoadedIframeUrl = targetUrl;
    }
    
    // --- Update overlay pointer events ---
    // If user has control, overlay is transparent to events to allow interaction
    // Otherwise, it blocks events to the iframe.
    elements.overlay.style.pointerEvents = state.hasControl ? 'none' : 'auto';

    // --- Render Cursors ---
    const seenCursors = new Set();
    for (const [clientId, presence] of Object.entries(room.presence)) {
        if (clientId === room.clientId || !presence.mouseX || !presence.mouseY) continue;

        let cursorEl = document.getElementById(`cursor-${clientId}`);
        if (!cursorEl) {
            cursorEl = document.createElement('div');
            cursorEl.id = `cursor-${clientId}`;
            cursorEl.className = 'remote-cursor';
            cursorEl.innerHTML = `
                <img src="/cursor.png" alt="cursor">
                <span class="cursor-label"></span>
            `;
            document.body.appendChild(cursorEl); // Append to body to avoid iframe wrapper clipping
        }

        const peerInfo = room.peers[clientId];
        if (peerInfo) {
            cursorEl.querySelector('.cursor-label').textContent = peerInfo.username;
        }

        // Adjust cursor position based on iframe wrapper's scroll and offset
        const rect = elements.iframeWrapper.getBoundingClientRect();
        const cursorX = presence.mouseX - elements.iframeWrapper.scrollLeft + rect.left;
        const cursorY = presence.mouseY - elements.iframeWrapper.scrollTop + rect.top;

        cursorEl.style.left = `${cursorX}px`;
        cursorEl.style.top = `${cursorY}px`;
        cursorEl.style.display = 'block';
        seenCursors.add(cursorEl.id);
    }
    
    // Hide cursors of disconnected users
    document.querySelectorAll('.remote-cursor').forEach(el => {
        if (!seenCursors.has(el.id)) {
            el.style.display = 'none';
        }
    });

    // --- Render Permissions Panel (Host only) ---
    if (state.isHost) {
        elements.userList.innerHTML = '';
        for (const [clientId, peer] of Object.entries(room.peers)) {
            const userItem = document.createElement('li');
            userItem.className = 'user-item';

            const isPeerHost = clientId === room.roomState.hostClientId;
            const peerHasControl = hasPermission(clientId);

            let roleText = 'Viewer';
            if (isPeerHost) roleText = 'Host';
            else if (peerHasControl) roleText = 'Controller';

            userItem.innerHTML = `
                <img src="${peer.avatarUrl}" alt="${peer.username}">
                <div class="user-info">
                    <div class="username">${peer.username} ${clientId === room.clientId ? '(You)' : ''}</div>
                    <div class="role">${roleText}</div>
                </div>
                ${!isPeerHost ? `
                <label for="control-${clientId}">Control:</label>
                <input type="checkbox" id="control-${clientId}" data-client-id="${clientId}" ${peerHasControl ? 'checked' : ''}>
                ` : ''}
            `;
            elements.userList.appendChild(userItem);
        }
    }
}

function setupLobbyListeners() {
    function joinRoom() {
        const roomName = elements.roomNameInput.value.trim();
        if (roomName) {
            const url = new URL(window.location);
            url.searchParams.set('room', roomName);
            window.location.href = url.href;
        }
    }

    elements.joinRoomBtn.addEventListener('click', joinRoom);
    elements.roomNameInput.addEventListener('keyup', (e) => {
        if (e.key === 'Enter') {
            joinRoom();
        }
    });
}

function setupAppEventListeners() {
    // --- Mouse movement ---
    document.addEventListener('mousemove', (e) => {
        // Calculate position relative to the iframe wrapper's content area
        const rect = elements.iframeWrapper.getBoundingClientRect();
        const mouseX = e.clientX - rect.left + elements.iframeWrapper.scrollLeft;
        const mouseY = e.clientY - rect.top + elements.iframeWrapper.scrollTop;
        room.updatePresence({ mouseX, mouseY });
    });
    
    // --- Iframe wrapper scroll ---
    elements.iframeWrapper.addEventListener('wheel', (e) => {
        if (!state.hasControl) return;
        e.preventDefault(); // prevent local scroll
        
        room.send({
            type: 'request_action',
            action: {
                type: 'scroll',
                deltaX: e.deltaX,
                deltaY: e.deltaY,
            }
        });

    }, { passive: false });

    // --- Control click ---
    document.addEventListener('click', (e) => {
        if (!state.hasControl) return;

        const rect = elements.iframeWrapper.getBoundingClientRect();
        // Check if click is inside the iframe wrapper
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
             room.send({
                type: 'request_action',
                action: {
                    type: 'click',
                    x: e.pageX,
                    y: e.pageY,
                }
            });
        }
    });
    
    // --- Control keyboard input ---
    document.addEventListener('keydown', (e) => {
        if (!state.hasControl) return;

        // Don't capture input from the URL bar
        if (e.target === elements.urlInput) return;
        
        e.preventDefault();

        let key = e.key;
        if (key.length > 1) { // e.g., 'Backspace', 'Enter'
            key = `[${key}]`;
        }

        room.send({
            type: 'request_action',
            action: {
                type: 'keydown',
                key: key,
            }
        });
    });

    // --- Host controls ---
    elements.urlInput.addEventListener('change', (e) => {
        if (!state.isHost) return;
        let url = e.target.value.trim();
        if (url && !url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        room.updateRoomState({ iframeUrl: url });
    });

    elements.userList.addEventListener('change', (e) => {
        if (!state.isHost || e.target.type !== 'checkbox') return;

        const clientId = e.target.dataset.clientId;
        const canControl = e.target.checked;

        const permissions = room.roomState.permissions || {};
        room.updateRoomState({
            permissions: {
                ...permissions,
                [clientId]: { canControl }
            }
        });
    });
}

function handleRoomMessages(event) {
    const data = event.data;
    const fromClientId = data.clientId;

    // Host processes action requests from authorized controllers
    if (state.isHost && data.type === 'request_action') {
        if (hasPermission(fromClientId)) {
             // Host relays the action to everyone
            room.send({ ...data.action, relayedByHost: true });
        }
        return;
    }
    
    // All clients (including host) perform actions relayed by the host
    if (!data.relayedByHost) return;

    switch (data.type) {
        case 'click':
            const indicator = document.createElement('div');
            indicator.className = 'click-indicator';
            indicator.style.left = `${data.x}px`;
            indicator.style.top = `${data.y}px`;
            document.body.appendChild(indicator); // Append to body to avoid clipping
            setTimeout(() => indicator.remove(), 500);
            break;
        case 'scroll':
            elements.iframeWrapper.scrollTop += data.deltaY;
            elements.iframeWrapper.scrollLeft += data.deltaX;
            break;
        case 'keydown':
            let key = data.key;
            const currentStrokes = room.roomState.lastKeystrokes || '';
            let newStrokes;
            if (key === 'Backspace') {
                newStrokes = currentStrokes.slice(0, -1);
            } else {
                 if (key.length > 1) key = `[${key}]`;
                 newStrokes = (currentStrokes + key).slice(-50); // Keep last 50 chars
            }
            // Only host updates the room state for keystrokes
            if (state.isHost) {
                room.updateRoomState({ lastKeystrokes: newStrokes });
            }
            break;
    }
}

async function main() {
    const urlParams = new URLSearchParams(window.location.search);
    const roomName = urlParams.get('room');

    if (!roomName) {
        elements.appContainer.classList.add('hidden');
        elements.lobbyContainer.classList.remove('hidden');
        setupLobbyListeners();
        return;
    }
    
    elements.lobbyContainer.classList.add('hidden');
    elements.appContainer.classList.remove('hidden');

    await room.initialize();
    
    // Determine host
    if (!room.roomState.hostClientId) {
        await room.updateRoomState({
            hostClientId: room.clientId,
            iframeUrl: 'https://websim.com/docs',
            permissions: {},
            lastKeystrokes: '',
        });
    }

    room.subscribePresence(render);
    room.subscribeRoomState(render);
    room.onmessage = handleRoomMessages;
    
    // Initial render
    render();
    
    setupAppEventListeners();
}

main();