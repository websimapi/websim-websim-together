import { IFrameBrowserAgent } from 'iframe-browser-agent';

// --- Global State ---
let room; // Will be initialized in main()

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
    browserAgent: null,
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
        // Only host's agent navigates. Viewers just set src.
        if (state.isHost && state.browserAgent) {
             state.browserAgent.navigate(targetUrl);
        } else {
            elements.sharedIframe.src = targetUrl;
        }
        state.lastLoadedIframeUrl = targetUrl;
    }

    // --- Sync Scroll Position ---
    if (!state.isHost && room.roomState.scroll) {
        elements.iframeWrapper.scrollLeft = room.roomState.scroll.x;
        elements.iframeWrapper.scrollTop = room.roomState.scroll.y;
    }
    
    // --- Update overlay pointer events ---
    // If client is host, overlay is transparent to events.
    // Otherwise, it blocks events to the iframe.
    elements.overlay.style.pointerEvents = state.isHost ? 'none' : 'auto';

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
            userItem.dataset.clientId = clientId;

            const isPeerHost = clientId === room.roomState.hostClientId;
            // A user always has control over themselves, used for event listeners.
            const peerHasControl = hasPermission(clientId);

            let roleText = 'Viewer';
            if (isPeerHost) {
                roleText = 'Host';
                userItem.classList.add('is-host');
            } else {
                userItem.classList.add(peerHasControl ? 'has-control' : 'no-control');
                roleText = peerHasControl ? 'Controller' : 'Viewer';
            }
            
            const avatarUrl = peer.avatarUrl || '/default-pfp.png';

            userItem.innerHTML = `
                <img src="${avatarUrl}" alt="${peer.username}">
                <div class="user-info">
                    <div class="username">${peer.username} ${clientId === room.clientId ? '(You)' : ''}</div>
                    <div class="role">${roleText}</div>
                </div>
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
    
    // --- Iframe wrapper scroll (for everyone) ---
    elements.iframeWrapper.addEventListener('wheel', (e) => {
        if (!state.hasControl) return;
        // prevent local scroll for non-hosts to avoid de-sync
        if (!state.isHost) e.preventDefault();
        
        const scrollTarget = state.isHost ? elements.iframeWrapper : null;

        room.send({
            type: 'request_action',
            action: {
                type: 'scroll',
                deltaX: e.deltaX,
                deltaY: e.deltaY,
                // Pass current scroll for host to apply delta correctly
                currentScroll: scrollTarget ? { x: scrollTarget.scrollLeft, y: scrollTarget.scrollTop } : null
            }
        });

    }, { passive: false });

    // --- Control click (for everyone) ---
    document.addEventListener('click', (e) => {
        if (!state.hasControl) return;

        const rect = elements.iframeWrapper.getBoundingClientRect();
        // Check if click is inside the iframe wrapper
        if (e.clientX >= rect.left && e.clientX <= rect.right && e.clientY >= rect.top && e.clientY <= rect.bottom) {
             const clickX = e.clientX - rect.left;
             const clickY = e.clientY - rect.top;
             room.send({
                type: 'request_action',
                action: {
                    type: 'click',
                    x: clickX, // relative to viewport
                    y: clickY, // relative to viewport
                }
            });
        }
    });
    
    // --- Control keyboard input ---
    document.addEventListener('keydown', (e) => {
        // hasControl is checked here instead of canThisClientControl()
        // because we need to check the state that was set during the last render cycle.
        if (!state.hasControl) return;

        // Don't capture input from the URL bar
        if (e.target === elements.urlInput) return;
        
        e.preventDefault();

        // Use e.code for layout-independent key representation
        let key = e.key;
        if (key.length > 1 && key !== 'Backspace') {
             key = `[${key}]`;
        }
       
        room.send({
            type: 'request_action',
            action: {
                type: 'keydown',
                key: e.key,
                code: e.code,
                displayKey: key, // For visual feedback
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

    elements.userList.addEventListener('click', (e) => {
        if (!state.isHost) return;
        const userItem = e.target.closest('.user-item');
        if (!userItem || userItem.classList.contains('is-host')) return;

        const clientId = userItem.dataset.clientId;
        const currentPermissions = room.roomState.permissions || {};
        const userHasControl = currentPermissions[clientId]?.canControl || false;

        room.updateRoomState({
            permissions: {
                ...currentPermissions,
                [clientId]: { canControl: !userHasControl }
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
             // Host performs the action directly
             const action = data.action;
             switch (action.type) {
                case 'click':
                    state.browserAgent?.click(action.x, action.y);
                    // Also broadcast a visual click for all clients
                    room.send({
                        type: 'visual_click',
                        x: action.x + elements.iframeWrapper.getBoundingClientRect().left - elements.iframeWrapper.scrollLeft,
                        y: action.y + elements.iframeWrapper.getBoundingClientRect().top - elements.iframeWrapper.scrollTop,
                    });
                    break;
                case 'scroll':
                    state.browserAgent?.scroll(action.deltaX, action.deltaY);
                    break;
                case 'keydown':
                    state.browserAgent?.type(action);
                    
                    // Update keystroke display state
                    let currentStrokes = room.roomState.lastKeystrokes || '';
                    let newStrokes;
                    if (action.key === 'Backspace') {
                        newStrokes = currentStrokes.slice(0, -1);
                    } else {
                         newStrokes = (currentStrokes + action.displayKey).slice(-50); // Keep last 50 chars
                    }
                    room.updateRoomState({ lastKeystrokes: newStrokes });
                    break;
             }
        }
        return;
    }

    // This is for visual effects for all clients
    if (data.type === 'visual_click') {
        const indicator = document.createElement('div');
        indicator.className = 'click-indicator';
        indicator.style.left = `${data.x}px`;
        indicator.style.top = `${data.y}px`;
        document.body.appendChild(indicator); // Append to body to avoid clipping
        setTimeout(() => indicator.remove(), 500);
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

    // Initialize the room object now that we have a room name.
    room = new WebsimSocket({ room: roomName });
    await room.initialize();
    
    // Determine host
    if (!room.roomState.hostClientId) {
        await room.updateRoomState({
            hostClientId: room.clientId,
            iframeUrl: 'https://websim.com/docs',
            permissions: {},
            lastKeystrokes: '',
            scroll: { x: 0, y: 0 },
        });
    }

    state.isHost = room.roomState.hostClientId === room.clientId;

    if (state.isHost) {
        state.browserAgent = new IFrameBrowserAgent(elements.sharedIframe);
        await state.browserAgent.initialize();

        state.browserAgent.on('navigation', (newUrl) => {
            if (newUrl !== room.roomState.iframeUrl) {
                room.updateRoomState({ iframeUrl: newUrl });
            }
        });

        state.browserAgent.on('scroll', (scroll) => {
             room.updateRoomState({ scroll: { x: scroll.scrollX, y: scroll.scrollY } });
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