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
    const cachedAuth = localStorage.getItem('kamatayan_auth');
    if (cachedAuth) {
        const authData = JSON.parse(cachedAuth);
        showApp(authData.role);
    }
    
    try {
        const res = await fetch('api.php?action=check_auth');
        const json = await res.json();
        if (json.status === 'success') {
            localStorage.setItem('kamatayan_auth', JSON.stringify({ role: json.data.role }));
            if (!cachedAuth) showApp(json.data.role);
        } else {
            localStorage.removeItem('kamatayan_auth');
            showLogin();
        }
    } catch (e) {
        if (!cachedAuth) showLogin();
        console.error("Network error during auth check", e);
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
            localStorage.setItem('kamatayan_auth', JSON.stringify({ role: json.data.role }));
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
    localStorage.removeItem('kamatayan_auth');
    await fetch('api.php?action=logout');
    showLogin();
});

function showApp(role) {
    loginView.classList.remove('active');
    appView.classList.add('active');
    if (role === 'admin') btnAdmin.classList.remove('hidden');
    else btnAdmin.classList.add('hidden');
    
    const hashPath = window.location.hash.substring(1);
    loadDir(hashPath ? decodeURIComponent(hashPath) : '');
}

function showLogin() {
    appView.classList.remove('active');
    loginView.classList.add('active');
}

// --- Thumbnail Queue Manager ---
let thumbQueue = [];
let activeThumbs = 0;
const MAX_CONCURRENT_THUMBS = 12;

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

let lazyObserver;
function getObserver() {
    if (!lazyObserver) {
        lazyObserver = new IntersectionObserver((entries, observer) => {
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
        }, { root: null, rootMargin: '0px 0px 500px 0px' });
    }
    return lazyObserver;
}

const dirCache = {};

// --- File Browser ---
async function loadDir(path, forceRefresh = false) {
    clearThumbQueue();
    currentPath = path;
    window.location.hash = path; // Make stateful in URL
    updateBreadcrumbs();
    
    if (!forceRefresh && dirCache[path]) {
        renderDirectoryItems(dirCache[path]);
        fetchMetadata(path, dirCache[path]); // Resume or start fetching metadata if incomplete
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
            sortItems(json.data); // Apply current sort (by name initially)
            renderDirectoryItems(json.data);
            
            // Kick off background metadata fetch
            fetchMetadata(path, json.data);
        }
    } catch (e) {
        console.error(e);
        document.getElementById('loading-spinner').classList.add('hidden');
    }
}

let currentRenderIndex = 0;
const RENDER_BATCH_SIZE = 50;

async function fetchMetadata(path, items) {
    if (items.length === 0) return;
    const progressEl = document.getElementById('meta-progress');
    progressEl.classList.remove('hidden');
    
    const BATCH_SIZE = 100;
    let loaded = 0;
    
    for (let i = 0; i < items.length; i += BATCH_SIZE) {
        if (currentPath !== path) break; // User navigated away
        
        const batch = items.slice(i, i + BATCH_SIZE);
        // Only fetch if they don't have size/modified yet
        const filesToFetch = batch.filter(it => it.type !== 'folder' && it.size === 0 && it.modified === 0).map(it => it.name);
        
        if (filesToFetch.length > 0) {
            try {
                const res = await fetch('api.php?action=get_metadata', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ path, files: filesToFetch })
                });
                const json = await res.json();
                if (json.status === 'success' && currentPath === path) {
                    let needsResort = false;
                    json.data.forEach(meta => {
                        const item = items.find(it => it.name === meta.name);
                        if (item) {
                            if (item.size === 0 && meta.size > 0) needsResort = true;
                            item.size = meta.size;
                            item.modified = meta.modified;
                            
                            // Directly update DOM to prevent scroll jumping and show correct sizes instantly
                            const el = document.querySelector(`.file-item[data-name="${CSS.escape(item.name)}"] .file-meta`);
                            if (el && item.type !== 'folder') {
                                el.innerText = formatBytes(item.size);
                            }
                        }
                    });
                    
                    // If sorted by size/date, only resort the internal array so next render is correct.
                    // We don't re-render the grid immediately to avoid scroll-jumping.
                    const sortVal = document.getElementById('sort-select').value;
                    if (needsResort && (sortVal.includes('size') || sortVal.includes('date'))) {
                        sortItems(currentItems);
                    }
                }
            } catch (e) {
                console.error('Metadata fetch failed', e);
            }
        }
        loaded += batch.length;
        progressEl.innerText = `Loading data... ${Math.min(loaded, items.length)}/${items.length}`;
    }
    
    if (currentPath === path) {
        progressEl.classList.add('hidden');
    }
}

document.getElementById('sort-select').addEventListener('change', () => {
    if (currentItems.length > 0) {
        sortItems(currentItems);
        renderDirectoryItems(currentItems);
    }
});

function sortItems(items) {
    const sortVal = document.getElementById('sort-select').value;
    
    items.sort((a, b) => {
        if (a.type === 'folder' && b.type !== 'folder') return -1;
        if (a.type !== 'folder' && b.type === 'folder') return 1;
        
        switch (sortVal) {
            case 'name_asc': return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
            case 'name_desc': return b.name.toLowerCase().localeCompare(a.name.toLowerCase());
            case 'date_desc': return b.modified - a.modified;
            case 'date_asc': return a.modified - b.modified;
            case 'size_desc': return b.size - a.size;
            case 'size_asc': return a.size - b.size;
            default: return 0;
        }
    });
}

let sentinelObserver;

function getSentinelObserver() {
    if (!sentinelObserver) {
        sentinelObserver = new IntersectionObserver((entries) => {
            if (entries[0].isIntersecting && currentRenderIndex < currentItems.length) {
                renderNextBatch();
            }
        }, { root: null, rootMargin: '400px' });
        
        const sentinel = document.getElementById('scroll-sentinel');
        if (sentinel) sentinelObserver.observe(sentinel);
    }
    return sentinelObserver;
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
    
    currentRenderIndex = 0;
    getSentinelObserver(); // Ensure observer is active
    renderNextBatch();
}

function renderNextBatch() {
    if (currentRenderIndex >= currentItems.length) return;
    
    const end = Math.min(currentRenderIndex + RENDER_BATCH_SIZE, currentItems.length);
    const fragment = document.createDocumentFragment();
    
    for (let i = currentRenderIndex; i < end; i++) {
        const item = currentItems[i];
        const div = document.createElement('div');
        div.className = 'file-item';
        div.dataset.path = item.path;
        div.dataset.type = item.type;
        div.dataset.name = item.name;
        
        let iconHtml = '';
        if (item.type === 'image') {
            iconHtml = `<img class="file-thumb lazy-thumb" data-src="api.php?action=thumbnail&path=${encodeURIComponent(item.path)}&mtime=${item.modified}" src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 1 1'%3E%3C/svg%3E">`;
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
        
        fragment.appendChild(div);
        
        const lazyImg = div.querySelector('.lazy-thumb');
        if (lazyImg) getObserver().observe(lazyImg);
    }
    
    fileGrid.appendChild(fragment);
    currentRenderIndex = end;
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

const btnMenu = document.getElementById('btn-menu');
const navActions = document.getElementById('nav-actions');
if (btnMenu && navActions) {
    btnMenu.addEventListener('click', () => navActions.classList.toggle('open'));
    // Close menu when clicking outside
    document.addEventListener('click', (e) => {
        if (!e.target.closest('.header-right')) {
            navActions.classList.remove('open');
        }
    });
}

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
        const src = `api.php?action=stream&path=${encodeURIComponent(item.path)}&mtime=${item.modified}`;
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

let isZoomed = false;
function toggleZoom(e) {
    const img = lbContent.querySelector('img');
    if (!img) return;
    
    isZoomed = !isZoomed;
    if (isZoomed) {
        const rect = img.getBoundingClientRect();
        const clientX = e.clientX ?? e.changedTouches?.[0]?.clientX ?? rect.left + rect.width / 2;
        const clientY = e.clientY ?? e.changedTouches?.[0]?.clientY ?? rect.top + rect.height / 2;
        
        const x = ((clientX - rect.left) / rect.width) * 100;
        const y = ((clientY - rect.top) / rect.height) * 100;
        
        img.style.transformOrigin = `${x}% ${y}%`;
        img.style.transform = 'scale(3)';
        img.style.cursor = 'zoom-out';
        img.style.transition = 'transform 0.3s ease';
    } else {
        img.style.transform = 'scale(1)';
        img.style.cursor = 'zoom-in';
    }
}

lbContent.addEventListener('dblclick', toggleZoom);

let lastTap = 0;
lbContent.addEventListener('touchend', (e) => {
    const currentTime = new Date().getTime();
    const tapLength = currentTime - lastTap;
    if (tapLength < 300 && tapLength > 0) {
        toggleZoom(e);
        e.preventDefault();
    }
    lastTap = currentTime;
});

document.querySelector('.close-lightbox').addEventListener('click', () => {
    lightbox.classList.add('hidden');
    lbContent.innerHTML = ''; // stop media
    isZoomed = false;
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
window.addEventListener('hashchange', () => {
    const hashPath = window.location.hash.substring(1);
    const decodedPath = decodeURIComponent(hashPath);
    if (decodedPath !== currentPath) {
        loadDir(decodedPath);
    }
});

checkAuth();

// Register Service Worker for PWA
if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('sw.js').catch(err => {
            console.log('ServiceWorker registration failed: ', err);
        });
    });
}
