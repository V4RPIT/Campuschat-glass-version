/* Campus Chat – frontend logic (no framework, no build step).
   Sections: helpers · auth · boot · communities/channels · DMs · messages · profile */
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); // always escape user text (XSS)
const isRemembered = localStorage.getItem('campus.remember') === 'true';
let token = isRemembered ? (localStorage.token || sessionStorage.token) : null;
if (!isRemembered) {
  localStorage.removeItem('token');
  sessionStorage.removeItem('token');
}
window.addEventListener('beforeunload', () => {
  if (localStorage.getItem('campus.remember') !== 'true') {
    localStorage.removeItem('token');
    sessionStorage.removeItem('token');
  }
});
let me, socket, comms = [], cur = {};   // cur = {type:'ch'|'dm', id, name}
let activeComm = null;
const attachments = new Map();
const messagesById = new Map();
const typingUsers = new Map();
let typingTimer, typingHeartbeat, typingTarget = null, typingActive = false, sending = false;
let uploadedFile = null, uploadedAttachment = null;
let replyingTo = null, notificationItems = [];
let dialogResolve = null, dialogReturnWindow = null;
let pinnedChats = new Set();
let activeWindow = null, searchScope = null, searchTimer = null, searchRequest = 0, presencePeer = null;
const windowCloseTimers = new WeakMap();
const messageMenuTimers = new WeakMap();

const pinnedStorageKey = () => `campus.pinnedChats.${me.id}`;
const pinKey = (type, id) => `${type}:${String(id).toLowerCase()}`;
const popupDuration = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 20 : 180;
function loadPinnedChats() {
  try {
    const saved = JSON.parse(localStorage.getItem(pinnedStorageKey()) || '[]');
    if (!Array.isArray(saved) || saved.some(key => typeof key !== 'string')) throw new Error('Invalid pinned chat data');
    pinnedChats = new Set(saved);
  } catch (error) {
    pinnedChats = new Set();
    toast('Could not load your pinned chats. Your saved pins may be unavailable.', 'error');
    console.error('Could not load pinned chats:', error);
  }
}
function togglePinnedChat(key) {
  const wasPinned = pinnedChats.has(key);
  if (wasPinned) pinnedChats.delete(key);
  else pinnedChats.add(key);
  try {
    localStorage.setItem(pinnedStorageKey(), JSON.stringify([...pinnedChats]));
    return true;
  } catch (error) {
    if (wasPinned) pinnedChats.add(key);
    else pinnedChats.delete(key);
    toast('Could not save this pinned chat. Check your browser storage settings.', 'error');
    console.error('Could not save pinned chats:', error);
    return false;
  }
}

function updateFavicon(theme) {
  const fav = $('#appFavicon');
  const favFallback = $('#appFaviconFallback');
  if (fav) fav.href = theme === 'light' ? 'campus_monogram_badge_black.svg' : 'campus_monogram_badge_white.svg';
  if (favFallback) favFallback.href = theme === 'light' ? 'campus_monogram_badge_black.png' : 'campus_monogram_badge_white.png';
}

function setTheme(theme) {
  document.documentElement.dataset.theme = theme;
  updateThemeControl();
  updateFavicon(theme);
  try {
    localStorage.setItem('campus.theme', theme);
  } catch (error) {
    toast('Theme changed, but could not be saved for your next visit.', 'error');
    console.error('Could not save theme preference:', error);
  }
}
function updateThemeControl() {
  const theme = document.documentElement.dataset.theme === 'light' ? 'light' : 'dark';
  $('#themeToggleBtn').innerHTML = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg><span>Switch to ${theme === 'dark' ? 'light' : 'dark'} mode</span>`;
  $('#themeToggleBtn').setAttribute('aria-pressed', String(theme === 'light'));
}

function closeWindow(windowElement = activeWindow) {
  if (!windowElement) return;
  if (activeWindow === windowElement) activeWindow = null;
  if (windowElement.id === 'searchPanel') {
    clearTimeout(searchTimer);
    searchRequest++;
  }
  clearTimeout(windowCloseTimers.get(windowElement));
  windowElement.classList.remove('is-closing');
  if (windowElement.matches('details')) {
    if (!windowElement.open) return;
    windowElement.classList.add('is-closing');
    windowCloseTimers.set(windowElement, setTimeout(() => {
      windowCloseTimers.delete(windowElement);
      windowElement.open = false;
      windowElement.classList.remove('is-closing');
    }, popupDuration()));
    return;
  }
  if (windowElement instanceof HTMLDialogElement) {
    if (!windowElement.open) return;
    windowElement.classList.add('is-closing');
    windowCloseTimers.set(windowElement, setTimeout(() => {
      windowCloseTimers.delete(windowElement);
      if (windowElement.open) windowElement.close();
      windowElement.classList.remove('is-closing');
    }, popupDuration()));
    return;
  }
  if (windowElement.hidden) return;
  windowElement.classList.add('is-closing');
  windowCloseTimers.set(windowElement, setTimeout(() => {
    windowCloseTimers.delete(windowElement);
    windowElement.hidden = true;
    windowElement.classList.remove('is-closing');
    if (windowElement.id === 'profilePanel') $('#app').classList.remove('profile-open');
  }, popupDuration()));
}
function openWindow(windowElement, openAction = () => {
  windowElement.hidden = false;
  if (windowElement.matches('details')) windowElement.open = true;
}) {
  if (activeWindow && activeWindow !== windowElement) closeWindow(activeWindow);
  activeWindow = windowElement;
  clearTimeout(windowCloseTimers.get(windowElement));
  windowCloseTimers.delete(windowElement);
  windowElement.classList.remove('is-closing');
  openAction();
  if (windowElement.id === 'profilePanel') $('#app').classList.add('profile-open');
}
function positionMessageMenu(menu) {
  const popup = menu.querySelector('.message-menu-list');
  const trigger = menu.querySelector('summary');
  const bounds = $('#msgs').getBoundingClientRect();
  if (!popup || !trigger) return;
  menu.classList.remove('menu-opens-left', 'menu-opens-right');
  const popupWidth = popup.getBoundingClientRect().width;
  const triggerBounds = trigger.getBoundingClientRect();
  const roomRight = bounds.right - triggerBounds.right;
  const roomLeft = triggerBounds.left - bounds.left;
  menu.classList.add(roomRight >= popupWidth + 8 || roomRight >= roomLeft ? 'menu-opens-right' : 'menu-opens-left');
}
function positionContextMenu(menu) {
  const popup = menu.querySelector('.context-menu-list');
  const trigger = menu.querySelector('summary');
  if (!popup || !trigger) return;

  // Clear previous inline positioning overrides to measure true size
  popup.style.top = '';
  popup.style.bottom = '';
  popup.style.left = '';
  popup.style.right = '';

  const triggerRect = trigger.getBoundingClientRect();
  const vh = window.innerHeight;
  const vw = window.innerWidth;

  // Header / top bar menus must always open downwards below the trigger
  if (menu.closest('#sideTop') || menu.closest('#title') || menu.classList.contains('community-menu')) {
    popup.style.top = 'calc(100% + 6px)';
    popup.style.bottom = 'auto';
  } else if (menu.closest('#me')) {
    // Bottom dock must always open upwards above the trigger
    popup.style.bottom = 'calc(100% + 6px)';
    popup.style.top = 'auto';
  } else {
    // Dynamic vertical calculation for channel/message rows
    const roomBelow = vh - triggerRect.bottom;
    const roomAbove = triggerRect.top;
    if (roomBelow < 160 && roomAbove > roomBelow) {
      popup.style.bottom = 'calc(100% + 6px)';
      popup.style.top = 'auto';
    } else {
      popup.style.top = 'calc(100% + 6px)';
      popup.style.bottom = 'auto';
    }
  }

  // Ensure horizontal alignment stays comfortably within viewport
  const popupRect = popup.getBoundingClientRect();
  if (popupRect.right > vw - 10) {
    popup.style.right = '0px';
    popup.style.left = 'auto';
  } else if (popupRect.left < 10) {
    popup.style.left = '0px';
    popup.style.right = 'auto';
  }
}
document.addEventListener('click', event => {
  if (activeWindow?.id === 'actionDialog' && dialogReturnWindow?.contains(event.target)) return;
  if (activeWindow instanceof HTMLDialogElement && event.target === activeWindow) {
    if (activeWindow.id === 'actionDialog') finishDialog(null);
    else closeWindow(activeWindow);
    return;
  }
  const summary = event.target.closest('summary');
  if (summary && summary.parentElement.matches('details.context-menu, details.message-menu')) {
    event.preventDefault();
    const menu = summary.parentElement;
    if (menu.open && !menu.classList.contains('is-closing')) closeWindow(menu);
    else {
      openWindow(menu);
      if (menu.matches('.message-menu')) requestAnimationFrame(() => positionMessageMenu(menu));
      else if (menu.matches('.context-menu')) requestAnimationFrame(() => positionContextMenu(menu));
    }
    return;
  }
  if (activeWindow && !activeWindow.contains(event.target) &&
      !event.target.closest('[data-window-trigger], [data-profile], .context-menu-list, .message-menu-list')) closeWindow(activeWindow);
});
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape') return;
  if (activeWindow && !(activeWindow instanceof HTMLDialogElement)) closeWindow(activeWindow);
  closeMobileNav();
});

// ───── helpers ─────
async function api(path, method = 'GET', body) {
  const r = await fetch('/api' + path, { method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: 'Bearer ' + token } : {}) }, body: body ? JSON.stringify(body) : undefined });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) {
    const fallback = r.status === 404
      ? `API endpoint not found (HTTP 404). Restart the latest server.js or redeploy the latest version.`
      : `The request failed (HTTP ${r.status}). Check the server logs and try again.`;
    throw new Error(d.error || fallback);
  }
  return d;
}
const av = u => u.avatar ? `<img class="av" src="${esc(u.avatar)}" alt="${esc(u.username)}'s profile picture">` : `<span class="av" aria-label="${esc(u.username)}">${esc(u.username[0].toUpperCase())}</span>`;
const displayTime = value => value ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : 'Unknown';
const displayDate = value => value ? new Date(value).toLocaleDateString([], { dateStyle: 'medium' }) : 'Unknown';
function formatLastSeen(value) {
  if (!value) return 'unknown';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'unknown';
  const now = new Date();
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  if (date.toDateString() === now.toDateString()) return `today at ${time}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (date.toDateString() === yesterday.toDateString()) return `yesterday at ${time}`;
  return `on ${date.toLocaleDateString([], { dateStyle: 'medium' })} at ${time}`;
}
function updatePeerPresence(data) {
  if (!data || data.username?.toLowerCase() !== presencePeer?.toLowerCase()) return;
  const status = data.online ? 'online' : `last seen ${formatLastSeen(data.lastSeen)}`;
  $('#peerPresence').textContent = status;
  $('#peerPresence').classList.toggle('is-online', Boolean(data.online));
  $('#peerPresence').hidden = false;
  if ($('#profilePanel').open && $('#profileContent').dataset.username?.toLowerCase() === data.username.toLowerCase()) {
    const profileStatus = $('#profilePresence');
    if (profileStatus) {
      profileStatus.textContent = status;
      profileStatus.classList.toggle('is-online', Boolean(data.online));
    }
  }
}
function setConversationHeader(label, peer = null) {
  $('#titleText').textContent = label;
  presencePeer = peer;
  $('#chatPeerButton').classList.toggle('is-profile-link', Boolean(peer));
  $('#chatPeerButton').disabled = !peer;
  $('#chatSearchBtn').hidden = !cur.type;
  $('#clearChatBtn').disabled = !cur.type;
  $('#peerPresence').hidden = !peer;
  $('#peerPresence').textContent = peer ? 'checking status…' : '';
  $('#peerPresence').classList.remove('is-online');
  if (!peer) watchPeerPresence(null);
}
function watchPeerPresence(username) {
  if (!socket?.connected) return;
  socket.emit('watch-presence', username);
}
async function openProfile(username) {
  const panel = $('#profilePanel');
  $('#profileContent').dataset.username = username;
  $('#profileContent').innerHTML = '<p class="profile-loading">Loading profile…</p>';
  openWindow(panel, () => panel.showModal());
  try {
    const user = await api(`/users/${encodeURIComponent(username)}/profile`);
    if (!panel.open || $('#profileContent').dataset.username !== username) return;
    $('#profileContent').innerHTML = `<div class="profile-hero">${av(user)}<h2>${esc(user.username)}</h2>${user.flair ? `<span class="flair">${esc(user.flair)}</span>` : ''}</div>` +
      `<div class="profile-details"><section><h3>Status</h3><p id="profilePresence" class="${user.online ? 'is-online' : ''}">${user.online ? 'online' : `last seen ${formatLastSeen(user.lastSeen)}`}</p></section>` +
      `<section><h3>About</h3><p>${esc(user.bio || 'No bio yet.')}</p></section>` +
      `<section><h3>Joined</h3><p>${user.created ? new Date(user.created).toLocaleDateString([], { dateStyle: 'medium' }) : 'Unknown'}</p></section></div>`;
    if (username.toLowerCase() === presencePeer?.toLowerCase()) watchPeerPresence(username);
  } catch (error) {
    if (panel.open) $('#profileContent').innerHTML = `<p class="profile-error">${esc(error.message)}</p>`;
  }
}
function openSearch(scope = null) {
  clearTimeout(searchTimer);
  searchRequest++;
  searchScope = scope;
  $('#searchHeading').textContent = scope
    ? `Search ${scope.type === 'dm' ? `@ ${scope.id}` : `# ${scope.name || ''}`}`
    : 'Search all your chats';
  $('#searchInput').value = '';
  $('#searchResults').replaceChildren();
  $('#searchHint').textContent = 'Type at least 2 characters';
  openWindow($('#searchPanel'), () => $('#searchPanel').showModal());
  requestAnimationFrame(() => $('#searchInput').focus());
}
async function runSearch() {
  const query = $('#searchInput').value.trim();
  const request = ++searchRequest;
  if (query.length < 2) {
    $('#searchResults').replaceChildren();
    $('#searchHint').textContent = 'Type at least 2 characters';
    return;
  }
  $('#searchHint').textContent = 'Searching…';
  const params = new URLSearchParams({ q: query });
  if (searchScope?.type === 'ch') params.set('channel', searchScope.id);
  if (searchScope?.type === 'dm') params.set('dm', searchScope.id);
  try {
    const results = await api(`/search?${params}`);
    if (request !== searchRequest || !$('#searchPanel').open) return;
    $('#searchHint').textContent = results.length ? `${results.length}${results.length === 50 ? '+' : ''} result${results.length === 1 ? '' : 's'}` : 'No matching messages';
    $('#searchResults').innerHTML = results.map(result => {
      const location = result.channel_id
        ? `${esc(result.community_name)} · # ${esc(result.channel_name)}`
        : `@ ${esc(result.dm_peer)}`;
      const preview = result.body || (result.attachment?.name ? `Attachment: ${result.attachment.name}` : 'Message');
      return `<button class="search-result" type="button" data-search-message="${result.id}" data-channel="${result.channel_id || ''}" data-community="${result.community_id || ''}" data-peer="${esc(result.dm_peer || '')}"><b>${esc(result.username)} · ${location}</b><span>${esc(preview)}</span><time>${displayTime(result.ts)}</time></button>`;
    }).join('');
  } catch (error) {
    if (request !== searchRequest || !$('#searchPanel').open) return;
    $('#searchHint').textContent = error.message;
    $('#searchResults').replaceChildren();
  }
}
function toast(message, type = 'info') {
  const item = document.createElement('div');
  item.className = `toast toast-${type} glass3d`;
  item.setAttribute('role', type === 'error' ? 'alert' : 'status');
  item.innerHTML = `<span class="toast-text">${esc(message)}</span>`;
  $('#toastRegion').append(item);
  requestAnimationFrame(() => item.classList.add('visible'));
  setTimeout(() => {
    item.classList.remove('visible');
    setTimeout(() => item.remove(), 220);
  }, 4200);
}
function showDialog({ title, message = '', input = false, value = '', placeholder = '', confirmLabel = 'Continue', danger = false, preserveWindow = false }) {
  const dialog = $('#actionDialog');
  $('#actionDialogTitle').textContent = title;
  $('#actionDialogMessage').textContent = message;
  $('#actionDialogInput').hidden = !input;
  $('#actionDialogInput').value = value;
  $('#actionDialogInput').placeholder = placeholder;
  $('#actionDialogConfirm').textContent = confirmLabel;
  $('#actionDialogConfirm').classList.toggle('danger-button', danger);
  if (preserveWindow && activeWindow && activeWindow !== dialog) {
    dialogReturnWindow = activeWindow;
    activeWindow = dialog;
    clearTimeout(windowCloseTimers.get(dialog));
    windowCloseTimers.delete(dialog);
    dialog.classList.remove('is-closing');
    dialog.showModal();
  } else {
    dialogReturnWindow = null;
    openWindow(dialog, () => dialog.showModal());
  }
  if (input) $('#actionDialogInput').focus();
  else $('#actionDialogConfirm').focus();
  return new Promise(resolve => { dialogResolve = resolve; });
}
function finishDialog(value) {
  const resolve = dialogResolve;
  const returnWindow = dialogReturnWindow;
  dialogResolve = null;
  dialogReturnWindow = null;
  closeWindow($('#actionDialog'));
  setTimeout(() => {
    if (returnWindow?.open && !activeWindow) activeWindow = returnWindow;
    if (resolve) resolve(value);
  }, popupDuration());
}
$('#actionDialogForm').onsubmit = event => {
  event.preventDefault();
  finishDialog($('#actionDialogInput').hidden ? true : $('#actionDialogInput').value);
};
$('#actionDialogCancel').onclick = () => finishDialog(null);
$('#actionDialog').addEventListener('cancel', event => {
  event.preventDefault();
  finishDialog(null);
});
$('#actionDialog').addEventListener('close', () => {
  if (dialogResolve) finishDialog(null);
});
function shrink(file, max, q) {          // resize an uploaded image in the browser so it stays small
  return new Promise(res => { const r = new FileReader(); r.onload = () => { const i = new Image(); i.onload = () => {
    const k = Math.min(1, max / Math.max(i.width, i.height)), c = document.createElement('canvas');
    c.width = i.width * k; c.height = i.height * k; c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); res(c.toDataURL('image/jpeg', q)); };
    i.src = r.result; }; r.readAsDataURL(file); });
}

// ───── auth (login / signup / recover share one form) ─────
let mode = 'login';
function switchAuthMode(m) {
  mode = m;
  document.querySelectorAll('.tabs button').forEach(x => x.classList.toggle('on', x.dataset.m === m));
  $('#x').hidden = mode !== 'recover'; $('#inv').hidden = mode !== 'signup'; $('#err').textContent = '';
  const wrapX = $('#wrap-x'), wrapInv = $('#wrap-inv');
  if (wrapX) wrapX.hidden = mode !== 'recover';
  if (wrapInv) wrapInv.hidden = mode !== 'signup';
  $('#p').placeholder = mode === 'recover' ? 'New password (8+ characters)' : 'Password (8+ characters)';
  const authOpts = $('#authOptionsRow');
  if (authOpts) authOpts.hidden = mode !== 'login';
  const footerPrompt = $('#authFooterPrompt');
  if (footerPrompt) {
    if (mode === 'signup') {
      footerPrompt.innerHTML = `Already have an account? <button type="button" class="auth-inline-link" data-switch-mode="login">Sign in</button>`;
    } else if (mode === 'recover') {
      footerPrompt.innerHTML = `Remembered your password? <button type="button" class="auth-inline-link" data-switch-mode="login">Sign in</button>`;
    } else {
      footerPrompt.innerHTML = `Don&apos;t have an account? <button type="button" class="auth-inline-link" data-switch-mode="signup">Sign up</button>`;
    }
  }
}

document.querySelectorAll('.tabs button').forEach(b => b.onclick = () => switchAuthMode(b.dataset.m));
$('#forgotPasswordLink')?.addEventListener('click', () => switchAuthMode('recover'));
$('#authFooterPrompt')?.addEventListener('click', e => {
  const target = e.target.closest('[data-switch-mode]');
  if (target) switchAuthMode(target.dataset.switchMode);
});
if ($('#rememberMeCheckbox')) {
  $('#rememberMeCheckbox').checked = isRemembered;
}

$('#passwordVisibilityBtn').onclick = () => {
  const password = $('#p');
  const visible = password.type === 'password';
  password.type = visible ? 'text' : 'password';
  $('#passwordVisibilityBtn').textContent = visible ? 'Hide' : 'Show';
  $('#passwordVisibilityBtn').setAttribute('aria-label', `${visible ? 'Hide' : 'Show'} password`);
  $('#passwordVisibilityBtn').setAttribute('aria-pressed', String(visible));
};
$('#authForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const d = await api('/' + mode, 'POST', { username: $('#u').value.trim(), password: $('#p').value, code: $('#x').value, invite: $('#inv').value, website: $('#hp').value });
    token = d.token;
    const rememberMeChecked = $('#rememberMeCheckbox')?.checked;
    if (rememberMeChecked) {
      localStorage.setItem('campus.remember', 'true');
      localStorage.setItem('token', d.token);
    } else {
      localStorage.removeItem('campus.remember');
      localStorage.removeItem('token');
      sessionStorage.setItem('token', d.token);
    }
    if (d.recoveryCode) await showDialog({
      title: 'Save your recovery code',
      message: `${d.recoveryCode}\n\nThis code is shown only once. Store it somewhere safe to recover your account.`,
      confirmLabel: 'I saved it'
    });
    boot();
  } catch (err) { $('#err').textContent = err.message; }
};

// ───── boot ─────
async function boot() {
  try { me = await api('/me'); } catch { return; }
  loadPinnedChats();
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#meName').textContent = me.username; $('#meAv').innerHTML = av(me);
  api('/notifications').then(updateNotificationBadge).catch(() => {});
  socket?.disconnect();
  socket = io({ auth: { token } });
  socket.on('msg', onMsg);
  socket.on('typing', onTyping);
  socket.on('presence', updatePeerPresence);
  socket.on('warn', t => toast(t, 'error'));
  socket.on('notifications-updated', data => {
    updateNotificationBadge(data);
    if ($('#notificationsPanel').open) loadNotifications();
    if (!activeComm) showDMs();
  });
  socket.on('message-deleted', onMessageDeleted);
  socket.on('channel-deleted', onChannelDeleted);
  socket.on('community-deleted', onCommunityDeleted);
  socket.on('connect', () => {
    if ($('#text').value.trim()) startTyping();
    watchPeerPresence(presencePeer);
  });
  socket.on('disconnect', () => {
    if (presencePeer) {
      $('#peerPresence').textContent = 'reconnecting…';
      $('#peerPresence').classList.remove('is-online');
      const profileStatus = $('#profilePresence');
      if (profileStatus && $('#profileContent').dataset.username?.toLowerCase() === presencePeer.toLowerCase()) {
        profileStatus.textContent = 'reconnecting…';
        profileStatus.classList.remove('is-online');
      }
    }
  });
  await loadComms(); await showDMs(); loadNotifications();
  if (!cur.type && comms.length) openComm(comms[0].id);
}

const dmIconSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="22" height="22" fill="currentColor" fill-rule="evenodd"><path d="M 269 32 L 300 36 L 316 40 L 329 44 L 340 48 L 349 52 L 358 56 L 365 60 L 372 64 L 378 68 L 384 72 L 390 76 L 395 80 L 400 84 L 405 88 L 409 92 L 413 96 L 417 100 L 421 104 L 425 108 L 428 112 L 431 116 L 435 120 L 438 124 L 440 128 L 443 132 L 446 136 L 448 140 L 450 144 L 453 148 L 455 152 L 457 156 L 459 160 L 461 164 L 462 168 L 464 172 L 465 176 L 467 180 L 468 184 L 470 188 L 471 192 L 472 196 L 473 200 L 474 204 L 475 208 L 475 212 L 476 216 L 477 220 L 477 224 L 478 228 L 478 232 L 478 236 L 479 240 L 479 244 L 479 248 L 479 252 L 479 256 L 479 260 L 479 264 L 478 268 L 478 272 L 478 276 L 477 280 L 477 284 L 476 288 L 475 292 L 474 296 L 474 300 L 473 304 L 472 308 L 471 312 L 469 316 L 468 320 L 467 324 L 465 328 L 464 332 L 462 336 L 461 340 L 459 344 L 457 348 L 455 352 L 453 356 L 451 360 L 448 364 L 446 368 L 443 372 L 441 376 L 438 380 L 435 384 L 432 388 L 429 392 L 425 396 L 422 400 L 418 404 L 414 408 L 410 412 L 406 416 L 401 420 L 396 424 L 391 428 L 386 432 L 380 436 L 373 440 L 367 444 L 359 448 L 351 452 L 341 456 L 331 460 L 318 464 L 300 468 L 101 472 L 90 476 L 64 476 L 59 472 L 56 468 L 53 464 L 52 460 L 51 456 L 51 452 L 52 448 L 53 444 L 54 440 L 55 436 L 56 432 L 57 428 L 59 424 L 60 420 L 61 416 L 62 412 L 63 408 L 64 404 L 65 400 L 66 396 L 67 392 L 69 388 L 70 384 L 71 380 L 71 376 L 69 372 L 67 368 L 64 364 L 62 360 L 59 356 L 57 352 L 55 348 L 53 344 L 51 340 L 50 336 L 48 332 L 46 328 L 45 324 L 43 320 L 42 316 L 41 312 L 40 308 L 39 304 L 38 300 L 37 296 L 36 292 L 35 288 L 35 284 L 34 280 L 33 276 L 33 272 L 33 268 L 32 264 L 32 260 L 32 256 L 32 252 L 32 248 L 32 244 L 32 240 L 33 236 L 33 232 L 33 228 L 34 224 L 34 220 L 35 216 L 35 212 L 36 208 L 37 204 L 38 200 L 39 196 L 40 192 L 41 188 L 42 184 L 44 180 L 45 176 L 47 172 L 48 168 L 50 164 L 52 160 L 54 156 L 56 152 L 58 148 L 60 144 L 62 140 L 65 136 L 67 132 L 70 128 L 73 124 L 76 120 L 79 116 L 82 112 L 86 108 L 89 104 L 93 100 L 97 96 L 101 92 L 106 88 L 110 84 L 115 80 L 120 76 L 126 72 L 132 68 L 138 64 L 145 60 L 153 56 L 161 52 L 170 48 L 181 44 L 194 40 L 210 36 L 241 32 Z M 129 256 A 31 31 0 1 0 191 256 A 31 31 0 1 0 129 256 Z M 225 256 A 31 31 0 1 0 287 256 A 31 31 0 1 0 225 256 Z M 321 256 A 31 31 0 1 0 383 256 A 31 31 0 1 0 321 256 Z"/></svg>`;
const sendArrowSVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512" width="20" height="20" fill="currentColor"><path d="M 49 21 L 61 25 L 69 29 L 77 33 L 85 37 L 94 41 L 102 45 L 110 49 L 118 53 L 126 57 L 135 61 L 143 65 L 151 69 L 159 73 L 167 77 L 176 81 L 184 85 L 192 89 L 200 93 L 208 97 L 217 101 L 225 105 L 233 109 L 241 113 L 249 117 L 258 121 L 266 125 L 274 129 L 282 133 L 290 137 L 299 141 L 307 145 L 315 149 L 323 153 L 331 157 L 340 161 L 348 165 L 356 169 L 364 173 L 372 177 L 381 181 L 389 185 L 397 189 L 405 193 L 413 197 L 422 201 L 430 205 L 438 209 L 446 213 L 454 217 L 463 221 L 471 225 L 477 229 L 481 233 L 484 237 L 486 241 L 488 245 L 489 249 L 490 253 L 490 256 L 489 260 L 489 264 L 487 268 L 485 272 L 483 276 L 479 280 L 474 284 L 467 288 L 459 292 L 450 296 L 442 300 L 434 304 L 426 308 L 418 312 L 409 316 L 401 320 L 393 324 L 385 328 L 377 332 L 368 336 L 360 340 L 352 344 L 344 348 L 336 352 L 327 356 L 319 360 L 311 364 L 303 368 L 295 372 L 286 376 L 278 380 L 270 384 L 262 388 L 254 392 L 245 396 L 237 400 L 229 404 L 221 408 L 213 412 L 204 416 L 196 420 L 188 424 L 180 428 L 172 432 L 163 436 L 155 440 L 147 444 L 139 448 L 131 452 L 122 456 L 114 460 L 106 464 L 98 468 L 90 472 L 81 476 L 73 480 L 65 484 L 57 488 L 45 490 L 33 486 L 28 482 L 25 478 L 23 474 L 22 470 L 21 466 L 21 462 L 22 458 L 22 454 L 23 450 L 24 446 L 25 442 L 26 438 L 27 434 L 28 430 L 29 426 L 30 422 L 31 418 L 32 414 L 33 410 L 34 406 L 35 402 L 36 398 L 37 394 L 38 390 L 39 386 L 40 382 L 41 378 L 42 374 L 43 370 L 44 366 L 45 362 L 46 358 L 47 354 L 48 350 L 49 346 L 50 342 L 51 338 L 52 334 L 53 330 L 54 326 L 55 322 L 56 318 L 57 314 L 58 310 L 59 306 L 60 302 L 61 298 L 62 294 L 65 290 L 78 286 L 114 282 L 150 278 L 186 274 L 222 270 L 250 266 L 254 262 L 256 258 L 256 256 L 255 252 L 253 248 L 247 244 L 213 240 L 177 236 L 141 232 L 105 228 L 70 224 L 64 220 L 62 216 L 61 212 L 60 208 L 59 204 L 58 200 L 57 196 L 56 192 L 55 188 L 54 184 L 53 180 L 52 176 L 51 172 L 50 168 L 49 164 L 48 160 L 47 156 L 46 152 L 45 148 L 44 144 L 43 140 L 42 136 L 41 132 L 40 128 L 39 124 L 38 120 L 37 116 L 36 112 L 35 108 L 34 104 L 33 100 L 32 96 L 31 92 L 30 88 L 29 84 L 28 80 L 27 76 L 26 72 L 25 68 L 24 64 L 23 60 L 22 56 L 22 52 L 21 48 L 21 44 L 22 40 L 24 36 L 26 32 L 29 28 L 35 24 Z"/></svg>`;

async function copyInviteCode(code, triggerEl) {
  if (!code) return;
  try {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      await navigator.clipboard.writeText(code);
    } else {
      const t = document.createElement('textarea');
      t.value = code;
      t.style.position = 'fixed';
      t.style.left = '-9999px';
      t.style.top = '-9999px';
      document.body.appendChild(t);
      t.focus();
      t.select();
      document.execCommand('copy');
      document.body.removeChild(t);
    }
    toast(`Copied invite code: ${code}`, 'info');
    if (triggerEl) {
      const badge = triggerEl.querySelector('.invite-copy-badge, .intro-copy-hint') || triggerEl;
      const originalHTML = badge.innerHTML;
      badge.classList.add('copied');
      badge.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"></polyline></svg> <span class="copy-text">Copied!</span>`;
      setTimeout(() => {
        badge.classList.remove('copied');
        badge.innerHTML = originalHTML;
      }, 2000);
    }
  } catch (err) {
    console.error('Failed to copy invite code:', err);
    toast(`Invite code: ${code}`, 'info');
  }
}

// ───── communities & channels ─────
async function loadComms() {
  comms = await api('/communities');
  $('#rail').innerHTML = `<button id="dmBtn" title="Direct messages" aria-label="Direct messages">${dmIconSVG}<span id="dmUnreadDot" class="rail-unread-dot" hidden></span></button>` +
    comms.map(c => `<button data-id="${c.id}" title="${esc(c.name)}" aria-label="${esc(c.name)}">${c.avatar ? `<img class="community-icon-rail" src="${esc(c.avatar)}" alt="">` : esc(c.name.slice(0, 2).toUpperCase())}<span class="rail-unread-dot" data-comm-unread="${c.id}" hidden></span></button>`).join('') +
    `<button id="addBtn" data-window-trigger title="Create or join">＋</button>`;
  $('#dmBtn').onclick = showDMs;
  updateRailUnreadDots();
  $('#addBtn').onclick = async () => {
    try {
      const choice = await showDialog({ title: 'Join or create a community', message: 'Enter an invite code to join, or leave this blank to create a new community.', input: true, placeholder: 'Invite code' });
      if (choice === null) return;
      let c;
      if (choice.trim()) c = await api('/communities/join', 'POST', { code: choice });
      else {
        const name = await showDialog({ title: 'Create a community', input: true, placeholder: 'Community name' });
        if (name === null) return;
        c = await api('/communities', 'POST', { name });
      }
      await loadComms(); openComm(c.id);
    } catch (err) { toast(err.message, 'error'); }
  };
  document.querySelectorAll('#rail [data-id]').forEach(b => b.onclick = () => openComm(+b.dataset.id));
}
function markRail(id) { document.querySelectorAll('#rail button').forEach(b => b.classList.toggle('on', b.dataset.id == id || (id === 'dm' && b.id === 'dmBtn'))); }
function closeMobileNav() {
  if (!document.body.classList.contains('mobile-nav-open') || document.body.classList.contains('mobile-nav-closing')) return;
  document.body.classList.add('mobile-nav-closing');
  setTimeout(() => {
    document.body.classList.remove('mobile-nav-open', 'mobile-nav-closing');
    $('#mobileNavBackdrop').hidden = true;
  }, popupDuration() + 20);
}
$('#mobileMenuBtn').onclick = () => {
  if (document.body.classList.contains('mobile-nav-open')) {
    closeMobileNav();
    return;
  }
  if (activeWindow) closeWindow(activeWindow);
  document.body.classList.remove('mobile-nav-closing');
  document.body.classList.add('mobile-nav-open');
  $('#mobileNavBackdrop').hidden = false;
};
$('#mobileNavBackdrop').onclick = closeMobileNav;

async function openComm(id, preferredChannelId, aroundId) {
  closeMobileNav();
  const c = activeComm = await api('/communities/' + id);
  markRail(id);
  $('#sideTop').innerHTML = `<div class="community-identity">${c.avatar ? `<img class="community-icon" src="${esc(c.avatar)}" alt="">` : `<span class="community-icon community-icon-fallback">${esc(c.name.slice(0, 2).toUpperCase())}</span>`}<span>${esc(c.name)}</span></div><button id="globalSearchBtn" class="side-search-button" type="button" data-window-trigger aria-label="Search all your chats" title="Search all your chats">⌕</button>` +
    (c.owner === me.id ? '<details class="context-menu community-menu"><summary aria-label="Community options" title="Community options">⋮</summary><div class="context-menu-list glass glass3d"><button type="button" data-community-action="add-channel">Add subgroup</button><button type="button" data-community-action="edit-details">Change details</button></div></details>' : '');
  const channelRow = ch => `<div class="channel-row"><div class="item ${cur.type === 'ch' && cur.id === ch.id ? 'on' : ''}" data-ch="${ch.id}"># ${esc(ch.name)}</div>` +
    `<button class="pin-button ${pinnedChats.has(pinKey('channel', ch.id)) ? 'is-pinned' : ''}" type="button" data-toggle-pin="${pinKey('channel', ch.id)}" aria-label="${pinnedChats.has(pinKey('channel', ch.id)) ? 'Unpin' : 'Pin'} #${esc(ch.name)}" aria-pressed="${pinnedChats.has(pinKey('channel', ch.id))}" title="${pinnedChats.has(pinKey('channel', ch.id)) ? 'Unpin chat' : 'Pin chat'}">★</button>` +
    (c.owner === me.id ? `<details class="context-menu channel-menu"><summary aria-label="Options for #${esc(ch.name)}" title="Subgroup options">⋮</summary><div class="context-menu-list glass glass3d"><button type="button" data-rename="${ch.id}">Rename subgroup</button><button type="button" class="delete-channel" data-delete-channel="${ch.id}">Delete subgroup</button></div></details>` : '') +
    '</div>';
  const pinnedChannels = c.channels.filter(ch => pinnedChats.has(pinKey('channel', ch.id)));
  const otherChannels = c.channels.filter(ch => !pinnedChats.has(pinKey('channel', ch.id)));
  $('#sideList').innerHTML = `<button type="button" class="item invite-code" id="copyInviteCodeBtn" title="Click to copy invite code (${esc(c.code)})" aria-label="Copy community invite code ${esc(c.code)}">` +
    `<span class="invite-code-info">Invite code: <b>${esc(c.code)}</b></span>` +
    `<span class="invite-copy-badge" aria-hidden="true">` +
      `<svg class="copy-icon" viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">` +
        `<rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>` +
        `<path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>` +
      `</svg>` +
      `<span class="copy-text">Copy</span>` +
    `</span>` +
  `</button>` +
  (pinnedChannels.length ? `<div class="side-section-title">Starred</div>${pinnedChannels.map(channelRow).join('')}` : '') +
  `<div class="side-section-title">Subgroups</div>${otherChannels.map(channelRow).join('') || (pinnedChannels.length ? '' : '<div class="item empty-dms">No subgroups yet</div>')}`;
  const copyBtn = $('#copyInviteCodeBtn');
  if (copyBtn) copyBtn.onclick = () => copyInviteCode(c.code, copyBtn);
  document.querySelectorAll('[data-ch]').forEach(el => el.onclick = () => openChannel(c.channels.find(x => x.id == el.dataset.ch)));
  document.querySelectorAll('[data-toggle-pin]').forEach(button => button.onclick = async event => {
    event.stopPropagation();
    if (!togglePinnedChat(button.dataset.togglePin)) return;
    try { await openComm(id, cur.type === 'ch' ? cur.id : undefined); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#sideTop [data-community-action="add-channel"]')?.addEventListener('click', async event => {
    closeWindow(event.currentTarget.closest('details'));
    const name = await showDialog({ title: 'Create a subgroup', input: true, placeholder: 'Subgroup name' });
    if (!name) return;
    try { await api(`/communities/${id}/channels`, 'POST', { name }); await openComm(id); }
    catch (error) { toast(error.message, 'error'); }
  });
  $('#sideTop [data-community-action="edit-details"]')?.addEventListener('click', event => {
    closeWindow(event.currentTarget.closest('details'));
    $('#communityAvatarFile').value = '';
    $('#communityName').value = c.name;
    $('#communityDescription').value = c.description || '';
    $('#communityCreated').textContent = displayDate(c.created);
    if ($('#communityCodeDisplay')) $('#communityCodeDisplay').textContent = c.code || '';
    const modalCopyBtn = $('#copyCommModalCodeBtn');
    if (modalCopyBtn) modalCopyBtn.onclick = () => copyInviteCode(c.code, modalCopyBtn);
    $('#communityAvatarPreview').innerHTML = c.avatar
      ? `<img class="av" src="${esc(c.avatar)}" alt="${esc(c.name)} community picture">`
      : `<span class="av">${esc(c.name.slice(0, 1).toUpperCase())}</span>`;
    openWindow($('#communityDlg'), () => $('#communityDlg').showModal());
  });
  document.querySelectorAll('[data-rename]').forEach(el => el.onclick = async () => {
    closeWindow(el.closest('details'));
    const channel = c.channels.find(x => x.id == el.dataset.rename);
    const name = await showDialog({ title: 'Rename subgroup', message: `Choose a new name for #${channel.name}.`, input: true, value: channel.name, placeholder: 'Subgroup name', confirmLabel: 'Save' });
    if (name === null) return;
    try {
      await api(`/communities/${id}/channels/${channel.id}`, 'PUT', { name });
      await openComm(id, channel.id);
    } catch (err) { toast(err.message, 'error'); }
  });
  document.querySelectorAll('[data-delete-channel]').forEach(button => button.onclick = async () => {
    closeWindow(button.closest('details'));
    const channel = c.channels.find(item => item.id === Number(button.dataset.deleteChannel));
    if (!await showDialog({
      title: 'Delete subgroup?',
      message: `#${channel.name}, its messages, replies, and attached files will be permanently deleted for everyone.`,
      confirmLabel: 'Delete subgroup',
      danger: true
    })) return;
    try {
      await api(`/communities/${id}/channels/${channel.id}`, 'DELETE');
      const remaining = c.channels.find(item => item.id !== channel.id);
      if (cur.type === 'ch' && cur.id === channel.id) {
        if (remaining) await openComm(id, remaining.id);
        else {
          cur = {};
          setConversationHeader('No subgroups yet');
          $('#msgs').replaceChildren();
        }
      }
      toast(`Deleted #${channel.name}`, 'success');
    } catch (error) { toast(error.message, 'error'); }
  });
  const selectedChannel = c.channels.find(channel => channel.id === preferredChannelId) || c.channels[0];
  if (selectedChannel) await openChannel(selectedChannel, aroundId);
  else {
  cur = {};
  setConversationHeader('No subgroups yet');
  $('#msgs').replaceChildren();
  }
}
async function openChannel(ch, aroundId) {
  closeMobileNav();
  stopTyping();
  clearTypingIndicators();
  cur = { type: 'ch', id: ch.id };
  document.querySelectorAll('[data-ch]').forEach(el => el.classList.toggle('on', el.dataset.ch == ch.id));
  setConversationHeader('# ' + ch.name);
  const params = new URLSearchParams({ channel: ch.id });
  if (aroundId) params.set('around', aroundId);
  render(await api('/messages?' + params));
  markConversationRead({ channel: ch.id });
  if (aroundId) requestAnimationFrame(() => $(`[data-message="${aroundId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

// ───── direct messages ─────
async function showDMs() {
  closeMobileNav();
  stopTyping();
  clearTypingIndicators();
  markRail('dm'); activeComm = null;
  $('#sideTop').innerHTML = `<span>Direct messages</span><div class="side-top-actions"><button id="globalSearchBtn" class="side-search-button" type="button" data-window-trigger aria-label="Search all your chats" title="Search all your chats">⌕</button><button id="newDm" data-window-trigger title="New DM">＋</button></div>`;
  $('#newDm').onclick = async () => { const username = await showDialog({ title: 'New direct message', input: true, placeholder: 'Username' }); if (username?.trim()) openDM(username.trim()); };
  const list = await api('/dms');
  const dmItem = u => {
    const key = pinKey('dm', u.username);
    const pinned = pinnedChats.has(key);
    const unreadCount = Number(u.unread_count) || 0;
    let subtitleHTML = '';
    if (unreadCount === 1) {
      subtitleHTML = `<span class="dm-preview dm-unread-text"><b>${esc(u.latest_unread_body || 'New message')}</b></span>`;
    } else if (unreadCount > 1) {
      subtitleHTML = `<span class="dm-preview dm-unread-text"><b>${unreadCount}+ unread messages</b></span>`;
    } else if (u.latest_body) {
      subtitleHTML = `<span class="dm-preview dm-muted-text">${esc(u.latest_body)}</span>`;
    }
    return `<div class="dm-row"><div class="item dm-item ${cur.type === 'dm' && cur.id.toLowerCase() === u.username.toLowerCase() ? 'on' : ''}" data-peer="${esc(u.username)}">` +
      `${av(u)}` +
      `<div class="dm-info">` +
        `<div class="dm-name-row"><span class="dm-username">${esc(u.username)}</span>${unreadCount > 0 ? `<span class="dm-unread-badge">${unreadCount}</span>` : ''}</div>` +
        subtitleHTML +
      `</div>` +
      `</div><button class="pin-button ${pinned ? 'is-pinned' : ''}" type="button" data-toggle-pin="${key}" aria-label="${pinned ? 'Unpin' : 'Pin'} chat with ${esc(u.username)}" aria-pressed="${pinned}" title="${pinned ? 'Unpin chat' : 'Pin chat'}">★</button></div>`;
  };
  const starred = list.filter(user => pinnedChats.has(pinKey('dm', user.username)));
  const messages = list.filter(user => !pinnedChats.has(pinKey('dm', user.username)));
  $('#sideList').innerHTML = (starred.length ? `<div class="side-section-title">Starred</div>${starred.map(dmItem).join('')}` : '') +
    `<div class="side-section-title">Messages</div>${messages.map(dmItem).join('') || (!starred.length ? '<div class="item empty-dms">No chats yet</div>' : '')}`;
  document.querySelectorAll('[data-peer]').forEach(el => el.onclick = () => openDM(el.dataset.peer));
  document.querySelectorAll('#sideList [data-toggle-pin]').forEach(button => button.onclick = async event => {
    event.stopPropagation();
    if (!togglePinnedChat(button.dataset.togglePin)) return;
    try { await showDMs(); }
    catch (error) { toast(error.message, 'error'); }
  });
}
async function openDM(username, aroundId) {
  closeMobileNav();
  stopTyping();
  clearTypingIndicators();
  cur = { type: 'dm', id: username };
  const params = new URLSearchParams({ dm: username });
  if (aroundId) params.set('around', aroundId);
  try { render(await api('/messages?' + params)); } catch (e) { return toast(e.message, 'error'); }
  setConversationHeader('@ ' + username, username);
  document.querySelectorAll('[data-peer]').forEach(item => item.classList.toggle('on', item.dataset.peer.toLowerCase() === username.toLowerCase()));
  watchPeerPresence(username);
  markConversationRead({ dm: username });
  if (aroundId) requestAnimationFrame(() => $(`[data-message="${aroundId}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
}

$('#chatPeerButton').onclick = () => {
  if (cur.type === 'dm') openProfile(cur.id);
};
$('#chatSearchBtn').onclick = () => cur.type && openSearch({ ...cur, name: $('#titleText').textContent.replace(/^#\s*/, '') });
updateThemeControl();
$('#themeToggleBtn').onclick = () => {
  const menu = $('#userMenu');
  setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  closeWindow(menu);
};
$('#clearChatBtn').onclick = async () => {
  if (!cur.type) return;
  const target = cur.type === 'ch' ? { channel: cur.id } : { dm: cur.id };
  const label = cur.type === 'ch' ? `# ${$('#titleText').textContent.replace(/^#\s*/, '')}` : `@ ${cur.id}`;
  closeWindow($('#chatOptions'));
  const confirmed = await showDialog({
    title: 'Clear this chat from your view?',
    message: `Messages in ${label} will disappear from your view. Other people will keep their message history, and new messages will still appear for you.`,
    confirmLabel: 'Clear chat',
    danger: true
  });
  if (!confirmed) return;
  try {
    await api('/conversations/clear', 'POST', target);
    render([]);
    cancelReply();
    await loadNotifications();
    toast('Chat cleared from your view', 'success');
  } catch (error) {
    toast(error.message, 'error');
  }
};
$('#closeProfileBtn').onclick = () => closeWindow($('#profilePanel'));
$('#closeSearchBtn').onclick = () => closeWindow($('#searchPanel'));
$('#searchInput').oninput = () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 180);
};
$('#sideTop').onclick = event => {
  if (event.target.closest('#globalSearchBtn')) openSearch();
};
$('#searchResults').onclick = async event => {
  const result = event.target.closest('[data-search-message]');
  if (!result) return;
  closeWindow($('#searchPanel'));
  const messageId = Number(result.dataset.searchMessage);
  try {
    if (result.dataset.channel) await openComm(Number(result.dataset.community), Number(result.dataset.channel), messageId);
    else {
      await showDMs();
      await openDM(result.dataset.peer, messageId);
    }
  } catch (error) { toast(error.message, 'error'); }
};

// ───── messages ─────
function currentTypingTarget() {
  return cur.type === 'ch' ? { channel: cur.id } : cur.type === 'dm' ? { dm: cur.id } : null;
}
function emitTyping(target, typing) {
  if (target && socket?.connected) socket.emit('typing', { ...target, typing });
}
function stopTyping() {
  clearTimeout(typingTimer);
  clearInterval(typingHeartbeat);
  if (typingActive) emitTyping(typingTarget, false);
  typingTarget = null;
  typingActive = false;
}
function startTyping() {
  const target = currentTypingTarget();
  if (!target || !socket?.connected) return;
  const key = JSON.stringify(target);
  if (typingTarget && JSON.stringify(typingTarget) !== key) stopTyping();
  if (!typingActive) {
    typingTarget = target;
    typingActive = true;
    emitTyping(typingTarget, true);
    typingHeartbeat = setInterval(() => emitTyping(typingTarget, true), 2000);
  }
  clearTimeout(typingTimer);
  typingTimer = setTimeout(stopTyping, 4000);
}
function clearTypingIndicators() {
  typingUsers.forEach(user => clearTimeout(user.timer));
  typingUsers.clear();
  const status = $('#typingStatus');
  if (status) {
    status.hidden = true;
    status.innerHTML = '';
  }
}
function onTyping(event) {
  if (event.user_id === me.id) return;
  const matches = cur.type === 'ch'
    ? event.channel_id === cur.id
    : cur.type === 'dm' && event.peer === cur.id;
  if (!matches) return;
  const key = event.user_id;
  clearTimeout(typingUsers.get(key)?.timer);
  if (event.typing) {
    const entry = { username: event.username };
    entry.timer = setTimeout(() => { typingUsers.delete(key); renderTypingStatus(); }, 5500);
    typingUsers.set(key, entry);
  } else typingUsers.delete(key);
  renderTypingStatus();
}
function renderTypingStatus() {
  const names = [...typingUsers.values()].map(user => user.username);
  let status = $('#typingStatus');
  if (!status) {
    status = document.createElement('div');
    status.id = 'typingStatus';
    status.className = 'typing-chat-bubble';
    status.setAttribute('aria-live', 'polite');
    $('#msgs').appendChild(status);
  } else if (status.parentElement !== $('#msgs')) {
    $('#msgs').appendChild(status);
  }

  if (!names.length) {
    status.hidden = true;
    status.innerHTML = '';
    return;
  }

  status.hidden = false;
  const dotsHTML = `<span class="typing-dots"><span></span><span></span><span></span></span>`;

  if (cur.type === 'dm') {
    // WhatsApp / Instagram style: only dots animation inside received chat bubble
    status.className = 'typing-chat-bubble typing-dm';
    status.innerHTML = `<div class="bubble glass3d">${dotsHTML}</div>`;
  } else {
    // Group / Community section: dots + user is typing / +n users are typing
    status.className = 'typing-chat-bubble typing-group';
    let text = '';
    if (names.length === 1) {
      text = `${names[0]} is typing…`;
    } else if (names.length === 2) {
      text = `${names[0]} and ${names[1]} are typing…`;
    } else {
      text = `${names[0]} and +${names.length - 1} users are typing…`;
    }
    status.innerHTML = `<div class="bubble glass3d">${dotsHTML}<span class="typing-names">${esc(text)}</span></div>`;
  }

  requestAnimationFrame(() => {
    $('#msgs').scrollTop = 1e9;
  });
}
const msgHTML = m => {
  messagesById.set(m.id, m);
  if (m.attachment) attachments.set(m.id, m.attachment);
  const isImg = /^https?:\/\/\S+\.(png|jpe?g|gif|webp)(\?\S*)?$/i.test(m.body || '');
  const file = m.attachment ? `<button class="attachment" type="button" data-file="${m.id}">📎 ${esc(m.attachment.name)}</button>` : '';
  const quote = m.reply ? `<button class="reply-quote" type="button" data-jump="${m.reply.id}"><b>${esc(m.reply.username)}</b><span>${m.reply.deleted ? 'Original message deleted' : esc(m.reply.body || (m.reply.attachment_name ? '📎 ' + m.reply.attachment_name : 'Message'))}</span></button>` : '';
  const canDelete = m.user_id === me.id || (m.channel_id && activeComm?.owner === me.id);
  const menu = `<details class="message-menu"><summary aria-label="Message actions" title="Message actions">⋮</summary><div class="message-menu-list glass3d"><button type="button" data-reply="${m.id}">Reply</button>${canDelete ? `<button type="button" class="delete-action" data-delete="${m.id}">Delete</button>` : ''}</div></details>`;
  const own = m.user_id === me.id;
  const group = m.channel_id !== null;
  const profileAvatar = (group && !own)
    ? `<details class="context-menu profile-actions"><summary aria-label="Open ${esc(m.username)}'s profile options" title="Profile options">${av(m)}</summary><div class="context-menu-list glass glass3d"><button type="button" data-profile="${esc(m.username)}">Check profile</button></div></details>`
    : '';
  return `<article class="msg ${own ? 'msg-own' : 'msg-received'} ${group ? 'msg-group' : 'msg-direct'}" data-message="${m.id}">` +
    `${profileAvatar}<div class="msg-stack">` +
    `${group && !own ? `<div class="msg-meta"><b>${esc(m.username)}</b>${m.flair ? `<span class="flair">${esc(m.flair)}</span>` : ''}</div>` : ''}` +
    `<div class="bubble glass3d">${quote}${m.body ? `<div class="body">${isImg ? `<img src="${esc(m.body)}" loading="lazy">` : esc(m.body)}</div>` : ''}${file}` +
    `<time>${new Date(m.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</time></div></div>${menu}</article>`;
};
$('#msgs').addEventListener('pointerover', event => {
  if (event.pointerType === 'touch') return;
  const message = event.target.closest('.msg');
  if (!message || event.relatedTarget instanceof Node && message.contains(event.relatedTarget)) return;
  clearTimeout(messageMenuTimers.get(message));
  messageMenuTimers.delete(message);
  message.classList.add('menu-visible');
});
$('#msgs').addEventListener('pointerout', event => {
  if (event.pointerType === 'touch') return;
  const message = event.target.closest('.msg');
  if (!message || event.relatedTarget instanceof Node && message.contains(event.relatedTarget)) return;
  clearTimeout(messageMenuTimers.get(message));
  messageMenuTimers.set(message, setTimeout(() => {
    messageMenuTimers.delete(message);
    if (!message.matches(':hover') && !message.querySelector('.message-menu:focus-within') &&
        !message.querySelector('.message-menu[open]')) message.classList.remove('menu-visible');
  }, 4000));
});
function render(list) {
  attachments.clear();
  messagesById.clear();
  let introHTML = '';
  if (cur.type === 'dm') {
    introHTML = `<div class="chat-intro-card">` +
      `<div class="chat-intro-avatar av" style="width: 76px; height: 76px; font-size: 26px; margin-bottom: 12px; display: grid; place-items: center; background: var(--accent-gradient); color: #fff; border-radius: 50%;">${esc(cur.id[0].toUpperCase())}</div>` +
      `<div class="chat-intro-name">@${esc(cur.id)}</div>` +
      `<div class="chat-intro-subtitle">Direct message history</div>` +
      `<div class="chat-intro-pill glass3d"><span>This is the start of your direct messages with @${esc(cur.id)}.</span></div>` +
      `</div>`;
  } else if (cur.type === 'ch') {
    const chName = $('#titleText').textContent.replace(/^#\s*/, '');
    const commAvatar = activeComm?.avatar
      ? `<img class="chat-intro-avatar community-intro-avatar" src="${esc(activeComm.avatar)}" alt="${esc(activeComm.name)}">`
      : `<div class="chat-intro-avatar community-intro-avatar av" style="font-size: 26px; display: grid; place-items: center; background: var(--accent-gradient); color: #fff;">${esc(activeComm?.name ? activeComm.name.slice(0, 2).toUpperCase() : '#')}</div>`;
    introHTML = `<div class="chat-intro-card">` +
      commAvatar +
      `<div class="chat-intro-name"># ${esc(chName)}</div>` +
      `<div class="chat-intro-subtitle">${activeComm ? esc(activeComm.name) + ' Community' : 'Subgroup'}</div>` +
      (activeComm?.code ? `<button type="button" class="chat-intro-code-pill glass3d" id="introCopyCodeBtn" title="Click to copy community invite code (${esc(activeComm.code)})"><span class="intro-code-label">Invite code:</span> <b>${esc(activeComm.code)}</b> <span class="intro-copy-hint">Copy</span></button>` : '') +
      `<div class="chat-intro-pill glass3d"><span>Welcome to #${esc(chName)}! Send a message to start chatting.</span></div>` +
      `</div>`;
  }
  $('#msgs').innerHTML = introHTML + list.map(msgHTML).join('') +
    `<div id="typingStatus" class="typing-chat-bubble" aria-live="polite" hidden></div>`;
  const introCopyBtn = $('#introCopyCodeBtn');
  if (introCopyBtn && activeComm?.code) {
    introCopyBtn.onclick = () => copyInviteCode(activeComm.code, introCopyBtn);
  }
  $('#msgs').scrollTop = 1e9;
}
function onMsg(m) {
  if (cur.type === 'ch' && m.channel_id === cur.id || cur.type === 'dm' && m.peer === cur.id) {
    const typingEl = $('#typingStatus');
    if (typingEl) {
      typingEl.insertAdjacentHTML('beforebegin', msgHTML(m));
    } else {
      $('#msgs').insertAdjacentHTML('beforeend', msgHTML(m));
    }
    $('#msgs').scrollTop = 1e9;
    if (m.user_id !== me.id) markConversationRead(currentTypingTarget());
  } else if (m.peer && !activeComm) showDMs();                // new DM from someone → refresh list
}
function setReply(message) {
  replyingTo = message;
  $('#replyPreview').innerHTML = `<div><b>Replying to ${esc(message.username)}</b><span>${esc(message.body || (message.attachment?.name ? '📎 ' + message.attachment.name : 'Message'))}</span></div><button type="button" id="cancelReply" aria-label="Cancel reply">×</button>`;
  $('#replyPreview').hidden = false;
  $('#text').focus();
}
function onMessageDeleted(event) {
  const matches = cur.type === 'ch'
    ? event.channel_id === cur.id
    : cur.type === 'dm' && event.peer === cur.id;
  if (matches) {
    $(`[data-message="${event.id}"]`)?.remove();
    messagesById.delete(event.id);
    attachments.delete(event.id);
    if (replyingTo?.id === event.id) cancelReply();
  }
  loadNotifications();
}
function onChannelDeleted(event) {
  if (cur.type !== 'ch' || cur.id !== event.channel_id) return;
  cur = {};
  setConversationHeader('This subgroup was deleted');
  $('#msgs').replaceChildren();
  if (activeComm?.id === event.community_id) openComm(event.community_id);
}
async function onCommunityDeleted(event) {
  const communityId = Number(event.community_id);
  const wasActive = activeComm?.id === communityId;
  let pinsChanged = false;
  (event.channel_ids || []).forEach(channelId => {
    pinsChanged = pinnedChats.delete(pinKey('channel', channelId)) || pinsChanged;
  });
  if (pinsChanged) {
    try { localStorage.setItem(pinnedStorageKey(), JSON.stringify([...pinnedChats])); }
    catch (error) {
      toast('The deleted community was removed, but its saved pins could not be cleaned up.', 'error');
      console.error('Could not update pinned chats after community deletion:', error);
    }
  }
  try {
    await loadComms();
    await loadNotifications();
    if (!wasActive) return;
    if (activeWindow === $('#communityDlg')) closeWindow($('#communityDlg'));
    activeComm = null;
    cur = {};
    cancelReply();
    stopTyping();
    clearTypingIndicators();
    setConversationHeader('Community deleted');
    $('#msgs').replaceChildren();
    if (comms.length) await openComm(comms[0].id);
    else await showDMs();
  } catch (error) {
    toast(error.message || 'Could not refresh after community deletion', 'error');
  }
}
let notificationSummary = { unread: 0, has_dm_unread: false, unread_communities: [] };

function updateRailUnreadDots() {
  const dmDot = $('#dmUnreadDot');
  if (dmDot) dmDot.hidden = !notificationSummary.has_dm_unread;
  document.querySelectorAll('[data-comm-unread]').forEach(dot => {
    const cid = Number(dot.dataset.commUnread);
    dot.hidden = !notificationSummary.unread_communities?.includes(cid);
  });
}

function updateNotificationBadge(data = {}) {
  const unread = Number(data.unread) || 0;
  notificationSummary.unread = unread;
  if (data.has_dm_unread !== undefined) notificationSummary.has_dm_unread = !!data.has_dm_unread;
  if (data.unread_communities !== undefined) notificationSummary.unread_communities = Array.isArray(data.unread_communities) ? data.unread_communities : [];

  const badge = $('#notificationBadge');
  if (badge) {
    badge.hidden = unread < 1;
    badge.textContent = unread > 99 ? '99+' : (unread > 9 ? String(unread) : '');
    badge.classList.toggle('has-count', unread > 9);
    badge.classList.toggle('is-dot', unread <= 9 && unread > 0);
  }
  const headingBadge = $('#notificationsHeadingBadge');
  if (headingBadge) {
    headingBadge.hidden = unread < 1;
    headingBadge.textContent = unread > 99 ? '99+' : String(unread);
  }
  $('#notificationBtn')?.setAttribute('aria-label', unread ? `Notifications, ${unread} unread` : 'Notifications');

  updateRailUnreadDots();
}

async function loadNotifications() {
  try {
    const result = await api('/notifications');
    notificationItems = result.items;
    updateNotificationBadge(result);
    $('#notificationList').innerHTML = notificationItems.length
      ? notificationItems.map(item => {
        const target = item.channel_id ? `# ${esc(item.channel_name)}` : `@ ${esc(item.dm_peer)}`;
        const preview = item.body || (item.attachment?.name ? `📎 ${item.attachment.name}` : 'Message');
        return `<button class="notification-item${item.is_read ? '' : ' unread'}" type="button" data-notification="${item.notification_id}"><b>${esc(item.username)} · ${target}</b><span>${esc(preview)}</span><time>${new Date(item.ts).toLocaleString([], { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}</time></button>`;
      }).join('')
      : '<p class="empty-notifications">No notifications yet</p>';
  } catch (error) {
    $('#notificationList').innerHTML = '<p class="empty-notifications">Could not load notifications</p>';
    console.error('Could not load notifications:', error);
  }
}
async function markConversationRead(target) {
  if (!target) return;
  try {
    const result = await api('/notifications/read', 'POST', target);
    updateNotificationBadge(result);
  } catch (error) { console.error('Could not mark notifications as read:', error); }
}
$('#notificationBtn').onclick = () => {
  const panel = $('#notificationsPanel');
  if (activeWindow !== panel) {
    openWindow(panel, () => {
      panel.showModal();
      loadNotifications();
    });
  } else closeWindow(panel);
};
$('#closeNotificationsBtn')?.addEventListener('click', () => closeWindow($('#notificationsPanel')));
$('#notificationList').onclick = async event => {
  const item = event.target.closest('[data-notification]');
  if (!item) return;
  const notification = notificationItems.find(entry => entry.notification_id === Number(item.dataset.notification));
  if (!notification) return;
  closeWindow($('#notificationsPanel'));
  try {
    await api('/notifications/read', 'POST', { notificationId: notification.notification_id });
    await loadNotifications();
    if (notification.channel_id) await openComm(notification.community_id, notification.channel_id);
    else {
      await showDMs();
      await openDM(notification.dm_peer);
    }
    requestAnimationFrame(() => $(`[data-message="${notification.id}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }));
  } catch (error) { toast(error.message, 'error'); }
};
$('#markAllRead').onclick = async () => {
  try {
    const result = await api('/notifications/read', 'POST', { all: true });
    updateNotificationBadge(result);
    await loadNotifications();
  } catch (error) { toast(error.message, 'error'); }
};
function cancelReply() {
  replyingTo = null;
  $('#replyPreview').hidden = true;
  $('#replyPreview').replaceChildren();
}
$('#msgs').onclick = async event => {
  const profileButton = event.target.closest('[data-profile]');
  if (profileButton) {
    const menu = profileButton.closest('details');
    closeWindow(menu);
    openProfile(profileButton.dataset.profile);
    return;
  }
  const replyButton = event.target.closest('[data-reply]');
  if (replyButton) {
    const message = messagesById.get(Number(replyButton.dataset.reply));
    if (message) setReply(message);
    closeWindow(replyButton.closest('details'));
    return;
  }
  const deleteButton = event.target.closest('[data-delete]');
  if (deleteButton) {
    if (!await showDialog({ title: 'Delete message?', message: 'This message will be deleted for everyone in this conversation.', confirmLabel: 'Delete message', danger: true })) return;
    try {
      await api(`/messages/${deleteButton.dataset.delete}`, 'DELETE');
    } catch (error) { toast(error.message, 'error'); }
    return;
  }
  const jump = event.target.closest('[data-jump]');
  if (jump) {
    document.querySelector(`[data-message="${jump.dataset.jump}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    return;
  }
  const fileButton = event.target.closest('[data-file]');
  if (!fileButton) return;
  const attachment = attachments.get(Number(fileButton.dataset.file));
  if (!attachment) return;
  try {
    let blob;
    if (attachment.id) {
      const response = await fetch(`/api/attachments/${attachment.id}`, { headers: { Authorization: 'Bearer ' + token } });
      if (!response.ok) {
        const result = await response.json().catch(() => ({}));
        throw new Error(result.error || 'Could not download that file');
      }
      blob = await response.blob();
    } else {
      const raw = atob(attachment.data.split(',')[1]);
      const bytes = Uint8Array.from(raw, char => char.charCodeAt(0));
      blob = new Blob([bytes], { type: attachment.type || 'application/octet-stream' });
    }
    const url = URL.createObjectURL(blob), link = document.createElement('a');
    link.href = url; link.download = attachment.name; document.body.append(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60000);
  } catch (error) { toast(error.message || 'Could not download that file', 'error'); }
};
let swipeStart = null;
$('#msgs').addEventListener('pointerdown', event => {
  const message = event.target.closest('.msg');
  if (!message || event.target.closest('button, summary')) return;
  swipeStart = { id: Number(message.dataset.message), x: event.clientX, y: event.clientY };
});
$('#msgs').addEventListener('pointerup', event => {
  if (!swipeStart) return;
  const start = swipeStart;
  swipeStart = null;
  const dx = event.clientX - start.x, dy = event.clientY - start.y;
  if (Math.abs(dx) < 64 || Math.abs(dx) < Math.abs(dy) * 1.4 || getSelection()?.toString()) return;
  const messageElement = event.target.closest('.msg');
  const message = messagesById.get(start.id);
  if (messageElement?.dataset.message == start.id && message) setReply(message);
});
$('#msgs').addEventListener('pointercancel', () => { swipeStart = null; });
$('#replyPreview').onclick = event => {
  if (event.target.closest('#cancelReply')) cancelReply();
};
$('#attachBtn').onclick = () => $('#fileInput').click();
$('#fileInput').onchange = () => {
  const file = $('#fileInput').files[0];
  uploadedFile = null;
  uploadedAttachment = null;
  if (file && file.size > 50 * 1024 * 1024) {
    toast('Files must be no larger than 50 MB', 'error');
    $('#fileInput').value = '';
    $('#filePreview').hidden = true;
    $('#composer').classList.remove('has-file');
    return;
  }
  $('#filePreview').hidden = !file;
  $('#filePreview').textContent = file ? file.name : '';
  $('#composer').classList.toggle('has-file', Boolean(file));
};
function uploadAttachment(file) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', new URL('/api/attachments', location.origin));
    request.setRequestHeader('Authorization', 'Bearer ' + token);
    request.setRequestHeader('Content-Type', 'application/octet-stream');
    request.setRequestHeader('X-File-Name', encodeURIComponent(file.name));
    request.setRequestHeader('X-File-Type', file.type || 'application/octet-stream');
    request.upload.onprogress = event => {
      if (!event.lengthComputable) return;
      $('#filePreview').textContent = `Uploading ${Math.round(event.loaded / event.total * 100)}% · ${file.name}`;
    };
    request.onload = () => {
      let result;
      try { result = JSON.parse(request.responseText); }
      catch {
        const message = request.status === 404
          ? 'The server does not have the upload endpoint yet. Restart the latest server.js or redeploy the latest version, then reload the app.'
          : `Upload failed (HTTP ${request.status}): ${request.responseText.slice(0, 160) || 'No response from server'}`;
        return reject(new Error(message));
      }
      if (request.status < 200 || request.status >= 300) {
        const message = request.status === 404
          ? 'Upload endpoint not found. Restart the latest server.js or redeploy the latest version, then reload the app.'
          : result.error || `Upload failed (HTTP ${request.status})`;
        return reject(new Error(message));
      }
      resolve(result);
    };
    request.onerror = () => reject(new Error('Upload failed. Check your connection and try again.'));
    request.onabort = () => reject(new Error('Upload was cancelled.'));
    request.send(file);
  });
}
$('#text').oninput = () => {
  if (!$('#text').value.trim()) return stopTyping();
  startTyping();
};
$('#text').onblur = stopTyping;
$('#composer').onsubmit = e => {
  e.preventDefault();
  stopTyping();
  const body = $('#text').value.trim();
  const file = $('#fileInput').files[0];
  if ((!body && !file) || !cur.type) return;
  if (sending) return;
  if (file && file.size > 50 * 1024 * 1024) {
    toast('Files must be no larger than 50 MB', 'error');
    return;
  }
  if (!socket?.connected) {
    toast('You are offline. Reconnect before sending your message.', 'error');
    return;
  }
  const target = currentTypingTarget();
  const sendButton = $('#composer button[type="submit"]');
  const sendSpinnerSVG = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2.5" style="animation: spin 0.8s linear infinite;"><circle cx="12" cy="12" r="10" stroke-opacity="0.25"></circle><path d="M12 2a10 10 0 0 1 10 10" stroke="currentColor"></path></svg>`;
  const setSendState = state => {
    sendButton.disabled = state !== 'idle';
    sendButton.innerHTML = state === 'idle' ? sendArrowSVG : sendSpinnerSVG;
  };
  sending = true;
  setSendState('sending');
  const send = attachmentId => {
    setSendState('sending');
    socket.timeout(30000).emit('send', { ...target, body, attachmentId, replyToId: replyingTo?.id ?? null }, (timeout, result) => {
      sending = false;
      setSendState('idle');
      if (timeout || !result?.ok) {
        toast(timeout ? 'Message could not be sent. Please try again.' : result?.error || 'Message could not be sent.', 'error');
        return;
      }
      $('#text').value = '';
      $('#fileInput').value = '';
      $('#filePreview').hidden = true;
      $('#filePreview').textContent = '';
      $('#composer').classList.remove('has-file');
      uploadedFile = null;
      uploadedAttachment = null;
      cancelReply();
    });
  };
  if (file) {
    if (uploadedFile === file && uploadedAttachment) {
      send(uploadedAttachment.id);
    } else {
      setSendState('uploading');
      uploadAttachment(file).then(result => {
        uploadedFile = file;
        uploadedAttachment = result;
        $('#filePreview').textContent = `Uploaded · ${file.name}`;
        send(result.id);
      }).catch(err => {
        sending = false;
        setSendState('idle');
        toast(err.message, 'error');
      });
    }
  } else send(null);
};
// ───── profile settings ─────
$('#setBtn').onclick = () => {
  $('#avFile').value = '';
  $('#flair').value = me.flair;
  $('#bio').value = me.bio;
  $('#userEditorName').textContent = me.username;
  $('#userCreated').textContent = displayDate(me.created);
  $('#userAvatarPreview').innerHTML = av(me);
  openWindow($('#dlg'), () => $('#dlg').showModal());
};
document.querySelectorAll('[data-close-editor]').forEach(button => {
  button.onclick = () => closeWindow(button.closest('dialog'));
});
$('#closeDlg').onclick = () => closeWindow($('#dlg'));
$('#dlg').addEventListener('cancel', event => {
  event.preventDefault();
  closeWindow($('#dlg'));
});
$('#communityDlg').addEventListener('cancel', event => {
  event.preventDefault();
  closeWindow($('#communityDlg'));
});
['#profilePanel', '#notificationsPanel', '#searchPanel'].forEach(sel => {
  $(sel)?.addEventListener('cancel', event => {
    event.preventDefault();
    closeWindow($(sel));
  });
});
$('#logout').onclick = () => {
  localStorage.removeItem('token');
  sessionStorage.removeItem('token');
  localStorage.removeItem('campus.remember');
  location.reload();
};
$('#setForm').onsubmit = async e => {
  e.preventDefault();
  try {
    const f = $('#avFile').files[0];
    if (f && !f.type.startsWith('image/')) throw new Error('Choose an image file');
    me = await api('/me', 'PUT', { avatar: f ? await shrink(f, 128, .8) : me.avatar, bio: $('#bio').value, flair: $('#flair').value }); // avatar saved to server
    $('#meAv').innerHTML = av(me);
    $('#avFile').value = '';
    closeWindow($('#dlg')); toast('Profile saved', 'success');
  } catch (err) { toast(err.message, 'error'); }
};

$('#communityForm').onsubmit = async event => {
  event.preventDefault();
  const community = activeComm;
  if (!community || community.owner !== me.id) return;
  try {
    const file = $('#communityAvatarFile').files[0];
    if (file && !file.type.startsWith('image/')) throw new Error('Choose an image file');
    await api(`/communities/${community.id}`, 'PUT', {
      name: $('#communityName').value,
      description: $('#communityDescription').value,
      avatar: file ? await shrink(file, 160, .82) : community.avatar || ''
    });
    $('#communityAvatarFile').value = '';
    closeWindow($('#communityDlg'));
    await loadComms();
    await openComm(community.id, cur.type === 'ch' ? cur.id : undefined);
    toast('Community details saved', 'success');
  } catch (error) { toast(error.message || 'Could not update community details', 'error'); }
};
$('#deleteCommunityBtn').onclick = async () => {
  const community = activeComm;
  if (!community || community.owner !== me.id) return;
  const confirmed = await showDialog({
    title: 'Delete this community permanently?',
    message: `“${community.name}”, all of its channels, messages, replies, notifications, and attached files will be permanently deleted for every member. This cannot be undone.`,
    confirmLabel: 'Delete community',
    danger: true,
    preserveWindow: true
  });
  if (!confirmed) return;
  try {
    const result = await api(`/communities/${community.id}`, 'DELETE');
    await onCommunityDeleted({ community_id: result.id, channel_ids: result.channel_ids });
    toast(`Deleted “${community.name}” and its content`, 'success');
  } catch (error) { toast(error.message || 'Could not delete community', 'error'); }
};
$('#avFile').onchange = async () => {
  const file = $('#avFile').files[0];
  if (!file) return;
  try {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
    $('#userAvatarPreview').innerHTML = `<img class="av" src="${esc(await shrink(file, 128, .8))}" alt="${esc(me.username)}'s profile picture">`;
  } catch (error) { $('#avFile').value = ''; toast(error.message, 'error'); }
};
$('#communityAvatarFile').onchange = async () => {
  const file = $('#communityAvatarFile').files[0];
  if (!file) return;
  try {
    if (!file.type.startsWith('image/')) throw new Error('Choose an image file');
    $('#communityAvatarPreview').innerHTML = `<img class="av" src="${esc(await shrink(file, 160, .82))}" alt="Community picture preview">`;
  } catch (error) { $('#communityAvatarFile').value = ''; toast(error.message, 'error'); }
};

// ───── 3D interactive card tilt motion ─────
function enable3dCardMotion(el, maxTilt = 14) {
  if (!el) return;
  let rafId = null;

  el.addEventListener('mouseenter', () => {
    el.classList.add('is-tilting');
  });

  el.addEventListener('mousemove', e => {
    const rect = el.getBoundingClientRect();
    if (!rect.width || !rect.height) return;
    const x = e.clientX - rect.left - rect.width / 2;
    const y = e.clientY - rect.top - rect.height / 2;

    const rotY = (x / (rect.width / 2)) * maxTilt;
    const rotX = -(y / (rect.height / 2)) * maxTilt;

    if (rafId) cancelAnimationFrame(rafId);
    rafId = requestAnimationFrame(() => {
      el.style.transform = `perspective(1000px) rotateX(${rotX.toFixed(2)}deg) rotateY(${rotY.toFixed(2)}deg) scale3d(1.02, 1.02, 1.02)`;
    });
  });

  el.addEventListener('mouseleave', () => {
    if (rafId) cancelAnimationFrame(rafId);
    el.classList.remove('is-tilting');
    el.style.transform = `perspective(1000px) rotateX(0deg) rotateY(0deg) scale3d(1, 1, 1)`;
  });
}

enable3dCardMotion($('#auth'), 14);

if (token) boot();
