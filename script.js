const room = new WebsimSocket();

const elements = {
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
};

function hasPermission(clientId) {
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
    
    // Keystroke display is only visible to host, who has the controls div
    if(state.isHost) {
        elements.keystrokeDisplay.textContent = room.roomState.lastKeystrokes || '';
    }

    // --- Sync Iframe URL ---
    const targetUrl = room.roomState.iframeUrl || 'about:blank';
    if (elements.sharedIframe.src !== targetUrl) {
        elements.sharedIframe.src = targetUrl;
    }

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
                <img src="cursor.png" alt="cursor">
                <span class="cursor-label"></span>
            `;
            elements.overlay.appendChild(cursorEl);
        }

        const peerInfo = room.peers[clientId];
        if (peerInfo) {
            cursorEl.querySelector('.cursor-label').textContent = peerInfo.username;
        }

        cursorEl.style.left = `${presence.mouseX}px`;
        cursorEl.style.top = `${presence.mouseY}px`;
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

function setupEventListeners() {
    // --- Mouse movement ---
    document.addEventListener('mousemove', (e) => {
        // We use pageX/pageY to get coordinates relative to the whole page
        room.updatePresence({ mouseX: e.pageX, mouseY: e.pageY });
    });
    
    // --- Iframe wrapper scroll ---
    elements.iframeWrapper.addEventListener('wheel', (e) => {
        if (!state.hasControl) return;
        e.preventDefault(); // prevent local scroll
        
        const newScrollTop = elements.iframeWrapper.scrollTop + e.deltaY;
        const newScrollLeft = elements.iframeWrapper.scrollLeft + e.deltaX;
        
        // Broadcast the scroll event
        room.send({
            type: 'scroll',
            scrollTop: newScrollTop,
            scrollLeft: newScrollLeft,
        });

    }, { passive: false });

    // --- Control click ---
    document.addEventListener('click', (e) => {
        if (!state.hasControl) return;

        const rect = elements.iframeWrapper.getBoundingClientRect();
        // Check if click is inside the iframe wrapper
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
             room.send({
                type: 'click',
                x: e.pageX,
                y: e.pageY,
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

        const currentStrokes = room.roomState.lastKeystrokes || '';
        let newStrokes;
        if (e.key === 'Backspace') {
            newStrokes = currentStrokes.slice(0, -1);
        } else {
            newStrokes = (currentStrokes + key).slice(-50); // Keep last 50 chars
        }
        
        room.updateRoomState({ lastKeystrokes: newStrokes });
    });

    // --- Host controls ---
    elements.urlInput.addEventListener('change', (e) => {
        if (!state.isHost) return;
        let url = e.target.value.trim();
        if (!url.startsWith('http://') && !url.startsWith('https://')) {
            url = 'https://' + url;
        }
        room.updateRoomState({ iframeUrl: url });
    });

    elements.userList.addEventListener('change', (e) => {
        if (!state.isHost || e.target.type !== 'checkbox') return;

        const clientId = e.target.dataset.clientId;
        const canControl = e.target.checked;

        room.updateRoomState({
            permissions: {
                ...room.roomState.permissions,
                [clientId]: { canControl }
            }
        });
    });
}

function handleRoomMessages(event) {
    const data = event.data;
    switch (data.type) {
        case 'click':
            const indicator = document.createElement('div');
            indicator.className = 'click-indicator';
            indicator.style.left = `${data.x}px`;
            indicator.style.top = `${data.y}px`;
            elements.overlay.appendChild(indicator);
            setTimeout(() => indicator.remove(), 500);
            break;
        case 'scroll':
            // All clients, including the sender, will scroll to the same position
            // ensuring sync. This is idempotent.
            elements.iframeWrapper.scrollTop = data.scrollTop;
            elements.iframeWrapper.scrollLeft = data.scrollLeft;
            break;
    }
}

async function main() {
    await room.initialize();
    
    // Determine host
    if (!room.roomState.hostClientId) {
        await room.updateRoomState({
            hostClientId: room.clientId,
            iframeUrl: 'https://websim.com',
            permissions: {},
            lastKeystrokes: '',
        });
    }

    room.subscribePresence(render);
    room.subscribeRoomState(render);
    room.onmessage = handleRoomMessages;
    
    // Initial render
    render();
    
    setupEventListeners();
}

main();

