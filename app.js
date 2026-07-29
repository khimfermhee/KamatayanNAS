// DOM Elements
const loginView = document.getElementById('login-view');
const appView = document.getElementById('app-view');
const loginForm = document.getElementById('login-form');
const btnLogout = document.getElementById('btn-logout');
const btnAdmin = document.getElementById('btn-admin');
const fileGrid = document.getElementById('file-grid');
const breadcrumbsContainer = document.getElementById('breadcrumbs');
const btnHome = document.getElementById('btn-home');

let currentPath = '';
let contextTarget = null;
let currentItems = [];
let mediaItems = [];
let currentMediaIndex = -1;

// --- Authentication ---
async function checkAuth() {
    try {
        const res = await fetch('api.php?action=check_auth');
        const json = await res.json();
        if (json.status === 'success') {
            showApp(json.data.role);
        } else {
            showLogin();
        }
    } catch (e) {
        showLogin();
    }
}

loginForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('username').value;
    const password = document.getElementById('password').value;
    
    const btn = loginForm.querySelector('button[type="submit"]');
    const originalText = btn.innerText;
    btn.innerHTML = '<i class="fas fa-circle-notch btn-spinner"></i> Logging in...';
    btn.disabled = true;
    
    try {
        const res = await fetch('api.php?action=login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });
        const json = await res.json();
        if (json.status === 'success') {
            showApp(json.data.role);
        } else {
            document.getElementById('login-error').innerText = json.message;
        }
    } catch (e) {
        document.getElementById('login-error').innerText = 'Network error';
    } finally {
        btn.innerHTML = originalText;
        btn.disabled = false;
    }
});

btnLogout.addEventListener('click', async () => {
    await fetch('api.php?action=logout');
    showLogin();
});

function showApp(role) {
    loginView.classList.remove('active');
    appView.classList.add('active');
    if (role === 'admin') btnAdmin.classList.remove('hidden');
    else btnAdmin.classList.add('hidden');
    loadDir('');
}

function showLogin() {
    appView.classList.remove('active');
    loginView.classList.add('active');
}

// --- Thumbnail Queue Manager ---
let thumbQueue = [];
let activeThumbs = 0;
const MAX_CONCURRENT_THUMBS = 4;

function processThumbQueue() {
    if (activeThumbs >= MAX_CONCURRENT_THUMBS || thumbQueue.length === 0) return;
    
    activeThumbs++;
    const target = thumbQueue.shift();
    
    const img = target.el;
    img.onload = img.onerror = () => {
        activeThumbs--;
        processThumbQueue();
    };
    img.src = target.src;
}

function clearThumbQueue() {
    thumbQueue = [];
}

const lazyObserver = new IntersectionObserver((entries, observer) => {
    entries.forEach(entry => {
        if (entry.isIntersecting) {
            const el = entry.target;
            const src = el.dataset.src;
            if (src) {
                thumbQueue.push({ el, src });
                el.removeAttribute('data-src');
                observer.unobserve(el);
                processThumbQueue();
            }
        }
    });
}, { rootMargin: '200px' });

const dirCache = {};

// --- File Browser ---
async function loadDir(path, forceRefresh = false) {
    clearThumbQueue();
    currentPath = path;
    updateBreadcrumbs();
    
    if (!forceRefresh && dirCache[path]) {
        renderDirectoryItems(dirCache[path]);
        return;
    }
    
    document.getElementById('loading-spinner').classList.remove('hidden');
    fileGrid.innerHTML = '';
    document.getElementById('empty-state').classList.add('hidden');
    
    try {
        const res = await fetch(`api.php?action=list_dir&path=${encodeURIComponent(path)}`);
        const json = await res.json();
        
        document.getElementById('loading-spinner').classList.add('hidden');
        
        if (json.status === 'success') {
            dirCache[path] = json.data;
            renderDirectoryItems(json.data);
        }
    } catch (e) {
        console.error(e);
        document.getElementById('loading-spinner').classList.add('hidden');
    }
}

function renderDirectoryItems(items) {
    fileGrid.innerHTML = '';
    document.getElementById('empty-state').classList.add('hidden');
    
    currentItems = items;
    mediaItems = currentItems.filter(i => ['image', 'video', 'audio'].includes(i.type));
    
    if (currentItems.length === 0) {
        document.getElementById('empty-state').classList.remove('hidden');
        return;
    }
    
    currentItems.forEach(item => {
        const div = document.createElement('div');
        div.className = 'file-item';
        div.dataset.path = item.path;
        div.dataset.type = item.type;
        div.dataset.name = item.name;
        
        let iconHtml = '';
        if (item.type === 'image') {
            iconHtml = `<img class="file-thumb lazy-thumb" data-src="api.php?action=thumbnail&path=${encodeURIComponent(item.path)}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E">`;
        } else if (item.type === 'folder') {
            iconHtml = `<div class="file-icon folder"><i class="fas fa-folder"></i></div>`;
        } else if (item.type === 'video') {
            iconHtml = `<div style="position:relative; width:100%; height:120px; margin-bottom:1rem;">
                          <video class="file-thumb" style="margin-bottom:0;" src="api.php?action=stream&path=${encodeURIComponent(item.path)}#t=0.1" preload="metadata" muted></video>
                          <i class="fas fa-play-circle" style="position:absolute; top:50%; left:50%; transform:translate(-50%, -50%); font-size:2rem; color:rgba(255,255,255,0.8); text-shadow:0 2px 4px rgba(0,0,0,0.5); pointer-events:none;"></i>
                        </div>`;
        } else if (item.type === 'audio') {
            iconHtml = `<div class="file-icon audio"><i class="fas fa-music"></i></div>`;
        } else {
            iconHtml = `<div class="file-icon"><i class="fas fa-file"></i></div>`;
        }
        
        const sizeStr = item.type === 'folder' ? '' : formatBytes(item.size);
        
        div.innerHTML = `
            ${iconHtml}
            <div class="file-name" title="${item.name}">${item.name}</div>
            <div class="file-meta">${sizeStr}</div>
        `;
        
        div.addEventListener('click', () => handleItemClick(item));
        div.addEventListener('contextmenu', (e) => showContextMenu(e, item));
        
        fileGrid.appendChild(div);
        
        const lazyImg = div.querySelector('.lazy-thumb');
        if (lazyImg) lazyObserver.observe(lazyImg);
    });
}

function handleItemClick(item) {
    if (item.type === 'folder') {
        loadDir(item.path);
    } else if (['image', 'video', 'audio'].includes(item.type)) {
        openLightbox(item);
    } else {
        window.open(`api.php?action=stream&path=${encodeURIComponent(item.path)}`, '_blank');
    }
}

function updateBreadcrumbs() {
    breadcrumbsContainer.innerHTML = '';
    if (!currentPath) return;
    
    const parts = currentPath.split('/');
    let buildPath = '';
    
    parts.forEach((part, index) => {
        buildPath += (index === 0 ? '' : '/') + part;
        const currentBuildPath = buildPath;
        
        const sep = document.createElement('span');
        sep.className = 'breadcrumb-separator';
        sep.innerText = ' / ';
        breadcrumbsContainer.appendChild(sep);
        
        const el = document.createElement('span');
        el.className = 'breadcrumb-item';
        el.innerText = part;
        el.addEventListener('click', () => loadDir(currentBuildPath));
        
        breadcrumbsContainer.appendChild(el);
    });
}

btnHome.addEventListener('click', () => loadDir(''));

// --- Context Menu ---
const contextMenu = document.getElementById('context-menu');
document.addEventListener('click', () => contextMenu.classList.add('hidden'));

function showContextMenu(e, item) {
    e.preventDefault();
    contextTarget = item;
    contextMenu.style.top = `${e.clientY}px`;
    contextMenu.style.left = `${e.clientX}px`;
    contextMenu.classList.remove('hidden');
}

document.getElementById('ctx-view').addEventListener('click', () => {
    if (contextTarget) handleItemClick(contextTarget);
});

document.getElementById('ctx-delete').addEventListener('click', async () => {
    if (!contextTarget || !confirm(`Delete ${contextTarget.name}?`)) return;
    const res = await fetch('api.php?action=delete_file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: contextTarget.path })
    });
    const json = await res.json();
    if (json.status === 'success') loadDir(currentPath);
    else alert(json.message);
});

// Copy Dialog
const copyModal = document.getElementById('copy-modal');
document.getElementById('ctx-copy').addEventListener('click', () => {
    if (!contextTarget) return;
    document.getElementById('copy-source-name').innerText = contextTarget.name;
    document.getElementById('copy-dest-path').value = currentPath ? currentPath + '/copy_' + contextTarget.name : 'copy_' + contextTarget.name;
    copyModal.classList.remove('hidden');
});
document.querySelector('.close-copy').addEventListener('click', () => copyModal.classList.add('hidden'));
document.getElementById('confirm-copy-btn').addEventListener('click', async () => {
    const dest = document.getElementById('copy-dest-path').value;
    const res = await fetch('api.php?action=copy_file', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ source: contextTarget.path, dest })
    });
    const json = await res.json();
    if (json.status === 'success') {
        copyModal.classList.add('hidden');
        loadDir(currentPath);
    } else {
        alert(json.message);
    }
});

// --- Lightbox ---
const lightbox = document.getElementById('lightbox');
const lbContent = document.getElementById('lightbox-content');
const lbInfo = document.getElementById('lb-info');

function openLightbox(item) {
    currentMediaIndex = mediaItems.findIndex(i => i.path === item.path);
    renderLightboxItem();
    lightbox.classList.remove('hidden');
}

function renderLightboxItem() {
    if (currentMediaIndex < 0 || currentMediaIndex >= mediaItems.length) return;
    const item = mediaItems[currentMediaIndex];
    lbInfo.innerText = `${currentMediaIndex + 1} / ${mediaItems.length} - ${item.name}`;
    
    if (item.type === 'image') {
        const src = `api.php?action=preview&path=${encodeURIComponent(item.path)}`;
        lbContent.innerHTML = `<i class="fas fa-circle-notch lb-spinner" id="lb-loader"></i>
                               <img src="${src}" alt="${item.name}" onload="document.getElementById('lb-loader')?.remove()" onerror="document.getElementById('lb-loader')?.remove()">`;
    } else if (item.type === 'video') {
        const src = `api.php?action=stream&path=${encodeURIComponent(item.path)}`;
        lbContent.innerHTML = `<video src="${src}" controls autoplay></video>`;
    } else if (item.type === 'audio') {
        const src = `api.php?action=stream&path=${encodeURIComponent(item.path)}`;
        lbContent.innerHTML = `<audio src="${src}" controls autoplay></audio>`;
    }
}

document.querySelector('.close-lightbox').addEventListener('click', () => {
    lightbox.classList.add('hidden');
    lbContent.innerHTML = ''; // stop media
});

document.getElementById('lb-prev').addEventListener('click', () => {
    if (currentMediaIndex > 0) { currentMediaIndex--; renderLightboxItem(); }
});
document.getElementById('lb-next').addEventListener('click', () => {
    if (currentMediaIndex < mediaItems.length - 1) { currentMediaIndex++; renderLightboxItem(); }
});

document.addEventListener('keydown', (e) => {
    if (lightbox.classList.contains('hidden')) return;
    if (e.key === 'Escape') { lightbox.classList.add('hidden'); lbContent.innerHTML = ''; }
    if (e.key === 'ArrowLeft' && currentMediaIndex > 0) { currentMediaIndex--; renderLightboxItem(); }
    if (e.key === 'ArrowRight' && currentMediaIndex < mediaItems.length - 1) { currentMediaIndex++; renderLightboxItem(); }
});

// Touch Swipe Support for Mobile
let touchStartX = 0;
let touchEndX = 0;

lightbox.addEventListener('touchstart', e => {
    touchStartX = e.changedTouches[0].screenX;
});

// Prevent browser from doing pull-to-refresh or back gestures while swiping images
lightbox.addEventListener('touchmove', e => {
    e.preventDefault();
}, { passive: false });

lightbox.addEventListener('touchend', e => {
    touchEndX = e.changedTouches[0].screenX;
    handleSwipe();
});

function handleSwipe() {
    const swipeThreshold = 50;
    if (touchEndX < touchStartX - swipeThreshold) {
        // Swiped left -> Next
        if (currentMediaIndex < mediaItems.length - 1) { currentMediaIndex++; renderLightboxItem(); }
    }
    if (touchEndX > touchStartX + swipeThreshold) {
        // Swiped right -> Prev
        if (currentMediaIndex > 0) { currentMediaIndex--; renderLightboxItem(); }
    }
}

// --- Admin ---
const adminModal = document.getElementById('admin-modal');
btnAdmin.addEventListener('click', () => {
    adminModal.classList.remove('hidden');
    loadUsers();
});
document.querySelector('.close-modal').addEventListener('click', () => adminModal.classList.add('hidden'));

async function loadUsers() {
    const res = await fetch('api.php?action=list_users');
    const json = await res.json();
    const ul = document.getElementById('user-list');
    ul.innerHTML = '';
    if (json.status === 'success') {
        json.data.forEach(u => {
            const li = document.createElement('li');
            li.innerHTML = `
                <span>${u.username} (${u.role})</span>
                <button class="icon-btn danger" onclick="deleteUser(${u.id})"><i class="fas fa-trash"></i></button>
            `;
            ul.appendChild(li);
        });
    }
}

document.getElementById('add-user-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('new-username').value;
    const password = document.getElementById('new-password').value;
    const role = document.getElementById('new-role').value;
    
    const res = await fetch('api.php?action=create_user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password, role })
    });
    const json = await res.json();
    document.getElementById('admin-msg').innerText = json.message;
    if (json.status === 'success') {
        e.target.reset();
        loadUsers();
    }
});

async function deleteUser(id) {
    if (!confirm('Delete user?')) return;
    await fetch('api.php?action=delete_user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id })
    });
    loadUsers();
}

// Utils
function formatBytes(bytes, decimals = 2) {
    if (bytes === 0) return '0 Bytes';
    const k = 1024, dm = decimals < 0 ? 0 : decimals;
    const sizes = ['Bytes', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(dm)) + ' ' + sizes[i];
}

// Init
checkAuth();

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.log('ServiceWorker registration failed: ', err);
        });
    });
}
