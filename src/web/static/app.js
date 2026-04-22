// BubbleBored Web Client — multi-conversation

const state = {
  userId: localStorage.getItem('bb_userId') || generateId(),
  bots: [],                      // [{ id, display_name, ... }]
  botsById: new Map(),
  conversations: [],             // [{ id, bot_id, title, last_activity_at, ... }]  sorted DESC
  currentConversationId: null,
  botFilter: localStorage.getItem('bb_botFilter') || '',  // '' = all bots
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  // Pending uploads — drafts in the composer tray, awaiting send.
  // Each entry: { clientId, file, previewUrl, status, attachmentId?, url?, error? }
  pendingAttachments: [],
  dragCounter: 0,
  // conversationIds with an in-flight surf / pending review. Fed from the
  // /api/surf/events and /api/review/events SSE streams; drives the busy
  // state of the chat-header action buttons.
  activeSurfs: new Set(),
  pendingReviews: new Set(),
  surfES: null,
  reviewES: null,
  // Conversations currently showing a bot "正在输入" indicator. Server sends
  // `bot_typing {active}` events; the bubble only renders on the visible
  // conversation, but we track all so it resumes on conv switch.
  typingConvs: new Set(),
};

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

localStorage.setItem('bb_userId', state.userId);
init();

function generateId() {
  return 'u_' + Math.random().toString(36).slice(2, 10);
}

async function init() {
  await loadBots();
  await loadConversations();
  renderBotFilter();
  renderConvList();
  updateNewChatLabel();
  // Auto-select most recent conversation (matches what users expect)
  if (state.conversations.length > 0) {
    selectConversation(state.conversations[0].id);
  }
  connectWs();
  connectSurfReviewEvents();
  setupInput();
  setupGlobalHandlers();
  startRelativeTimeTick();
}

// ── Bots ──

async function loadBots() {
  try {
    const res = await fetch('/api/bots');
    const bots = await res.json();
    state.bots = bots;
    state.botsById = new Map(bots.map(b => [b.id, b]));
  } catch (e) {
    console.error('load bots error:', e);
  }
}

function botColor(botId) {
  // Stable hash → hue. Keeps the same Bot looking the same across sessions.
  let h = 0;
  for (let i = 0; i < botId.length; i++) h = (h * 31 + botId.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 55%, 58%)`;
}

function botInitial(bot) {
  const name = bot?.display_name || bot?.id || '?';
  return name.trim().charAt(0).toUpperCase();
}

function botAvatarHTML(botId) {
  const bot = state.botsById.get(botId);
  return `<span class="bot-avatar" style="background:${botColor(botId)}">${esc(botInitial(bot))}</span>`;
}

// ── Conversations ──

async function loadConversations() {
  try {
    const res = await fetch(`/api/conversations?userId=${encodeURIComponent(state.userId)}`);
    const convs = await res.json();
    state.conversations = Array.isArray(convs) ? convs : [];
  } catch (e) {
    console.error('load conversations error:', e);
    state.conversations = [];
  }
}

function renderBotFilter() {
  const root = document.getElementById('bot-filter');
  if (!root) return;
  if (state.bots.length <= 1) {
    root.innerHTML = '';
    return;
  }

  const counts = new Map();
  for (const conv of state.conversations) {
    counts.set(conv.bot_id, (counts.get(conv.bot_id) || 0) + 1);
  }

  const all = `
    <button class="pill ${state.botFilter === '' ? 'active' : ''}" data-bot="">
      <span>全部</span>
      <span class="pill-count">${state.conversations.length}</span>
    </button>
  `;
  const bots = state.bots.map(b => {
    const count = counts.get(b.id) || 0;
    const active = state.botFilter === b.id ? 'active' : '';
    return `
      <button class="pill ${active}" data-bot="${esc(b.id)}" title="${esc(b.display_name || b.id)}">
        <span class="bot-avatar" style="background:${botColor(b.id)}">${esc(botInitial(b))}</span>
        <span class="pill-label">${esc(b.display_name || b.id)}</span>
        ${count > 0 ? `<span class="pill-count">${count}</span>` : ''}
      </button>
    `;
  }).join('');

  root.innerHTML = all + bots;

  for (const btn of root.querySelectorAll('.pill')) {
    btn.addEventListener('click', () => {
      setBotFilter(btn.dataset.bot);
    });
  }
}

function setBotFilter(botId) {
  state.botFilter = botId || '';
  if (state.botFilter) localStorage.setItem('bb_botFilter', state.botFilter);
  else localStorage.removeItem('bb_botFilter');
  renderBotFilter();
  renderConvList();
  updateNewChatLabel();
}

function updateNewChatLabel() {
  const label = document.getElementById('new-chat-label');
  if (!label) return;
  if (state.botFilter && state.botsById.has(state.botFilter)) {
    const bot = state.botsById.get(state.botFilter);
    label.textContent = `新对话 · ${bot.display_name || bot.id}`;
  } else {
    label.textContent = '新对话';
  }
}

function filteredConversations() {
  if (!state.botFilter) return state.conversations;
  return state.conversations.filter(c => c.bot_id === state.botFilter);
}

function renderConvList() {
  const list = document.getElementById('conv-list');
  list.innerHTML = '';

  const convs = filteredConversations();
  if (convs.length === 0) {
    const hint = state.botFilter ? '没有该 Bot 的对话' : '还没有对话';
    const action = state.botFilter ? '点上面「新对话」开启' : '点上面的「新对话」开始';
    list.innerHTML = `<div class="conv-empty">${esc(hint)}<br>${esc(action)}</div>`;
    return;
  }

  for (const conv of convs) {
    list.appendChild(renderConvItem(conv));
  }
}

function renderConvItem(conv) {
  const el = document.createElement('div');
  el.className = 'conv-item';
  el.dataset.convId = conv.id;
  if (conv.id === state.currentConversationId) el.classList.add('active');

  const titleClass = conv.title ? 'conv-title' : 'conv-title untitled';
  const titleText = conv.title || '新对话';
  const time = conv.last_activity_at ? relTime(conv.last_activity_at) : '';

  el.innerHTML = `
    ${botAvatarHTML(conv.bot_id)}
    <span class="conv-body">
      <span class="${titleClass}">${esc(titleText)}</span>
      ${time ? `<span class="conv-time" data-ts="${conv.last_activity_at}">${esc(time)}</span>` : ''}
    </span>
    <span class="conv-actions">
      <button title="重命名" data-act="rename">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>
        </svg>
      </button>
      <button title="删除" class="danger" data-act="delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    </span>
  `;

  el.addEventListener('click', (e) => {
    const actBtn = e.target.closest('button[data-act]');
    if (actBtn) {
      e.stopPropagation();
      if (actBtn.dataset.act === 'rename') startRename(conv.id, el);
      else if (actBtn.dataset.act === 'delete') deleteConv(conv.id);
      return;
    }
    selectConversation(conv.id);
  });

  return el;
}

function relTime(ts) {
  const diff = Math.floor(Date.now() / 1000) - ts;
  if (diff < 60) return '刚刚';
  if (diff < 3600) return `${Math.floor(diff / 60)} 分钟`;
  if (diff < 86400) return `${Math.floor(diff / 3600)} 小时`;
  if (diff < 604800) return `${Math.floor(diff / 86400)} 天`;
  const d = new Date(ts * 1000);
  return `${d.getMonth() + 1}-${d.getDate()}`;
}

function startRelativeTimeTick() {
  setInterval(() => {
    document.querySelectorAll('.conv-time[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts);
      if (ts) el.textContent = relTime(ts);
    });
  }, 60 * 1000);
}

function selectConversation(convId) {
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return;
  state.currentConversationId = convId;

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';

  // Update active state in sidebar
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  updateChatHeader(conv);
  loadHistory(convId);
  refreshActionBusyState();
}

function updateChatHeader(conv) {
  const titleEl = document.getElementById('chat-title');
  const botEl = document.getElementById('chat-bot');
  titleEl.textContent = conv.title || '新对话';
  titleEl.classList.toggle('untitled', !conv.title);

  const bot = state.botsById.get(conv.bot_id);
  const botName = bot?.display_name || conv.bot_id;
  botEl.innerHTML = `${botAvatarHTML(conv.bot_id)}<span>${esc(botName)}</span>`;
}

async function loadHistory(convId) {
  const msgs = document.getElementById('messages');
  msgs.innerHTML = '';
  try {
    const res = await fetch(`/api/conversations/${convId}/messages`);
    const messages = await res.json();
    for (const m of messages) {
      appendMessage(m.sender_type === 'user' ? 'user' : 'bot', m.content, m.id, {
        attachments: m.attachments,
      });
    }
    // Covers the "empty history but typing in flight" case.
    renderTypingIndicator();
    scrollToBottom();
  } catch (e) {
    console.error('load history error:', e);
  }
}

// ── New chat ──

function onNewChatClick(e) {
  if (e) e.stopPropagation();
  const picker = document.getElementById('bot-picker');
  if (state.bots.length === 0) {
    alert('没有可用的 Bot');
    return;
  }
  // If a specific bot is selected via filter, go straight there
  if (state.botFilter && state.botsById.has(state.botFilter)) {
    createConversation(state.botFilter);
    return;
  }
  if (state.bots.length === 1) {
    createConversation(state.bots[0].id);
    return;
  }
  // Toggle picker
  if (picker.style.display === 'block') {
    picker.style.display = 'none';
    return;
  }
  picker.innerHTML = '';
  for (const bot of state.bots) {
    const item = document.createElement('div');
    item.className = 'bot-pick-item';
    item.innerHTML = `${botAvatarHTML(bot.id)}<span>${esc(bot.display_name || bot.id)}</span>`;
    item.onclick = () => {
      picker.style.display = 'none';
      createConversation(bot.id);
    };
    picker.appendChild(item);
  }
  picker.style.display = 'block';
}

async function createConversation(botId) {
  try {
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, botId }),
    });
    const conv = await res.json();
    if (!conv?.id) {
      alert('创建失败');
      return;
    }
    state.conversations.unshift(conv);
    // If the active filter would hide the new conv, clear it so it stays visible
    if (state.botFilter && state.botFilter !== conv.bot_id) {
      state.botFilter = '';
      localStorage.removeItem('bb_botFilter');
      updateNewChatLabel();
    }
    renderBotFilter();
    renderConvList();
    selectConversation(conv.id);
    document.getElementById('msg-input').focus();
  } catch (e) {
    alert('创建失败: ' + e.message);
  }
}

// ── Rename ──

function startRename(convId, itemEl) {
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return;
  const titleEl = itemEl.querySelector('.conv-title');
  if (!titleEl) return;

  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'conv-title-edit';
  input.value = conv.title || '';
  input.placeholder = '对话标题';
  titleEl.replaceWith(input);
  input.focus();
  input.select();

  const commit = async () => {
    const newTitle = input.value.trim();
    if (newTitle && newTitle !== conv.title) {
      try {
        await fetch(`/api/conversations/${convId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: newTitle }),
        });
        conv.title = newTitle;
        if (convId === state.currentConversationId) updateChatHeader(conv);
      } catch (e) { /* ignore */ }
    }
    renderConvList();
  };

  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    else if (e.key === 'Escape') { input.value = conv.title || ''; input.blur(); }
  });
}

function renameCurrentConversation() {
  if (!state.currentConversationId) return;
  const item = document.querySelector(`.conv-item[data-conv-id="${state.currentConversationId}"]`);
  if (item) startRename(state.currentConversationId, item);
}

// ── Delete ──

async function deleteConv(convId) {
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return;
  const label = conv.title || '这个对话';
  if (!confirm(`删除「${label}」？所有消息都会被清掉，无法恢复。`)) return;

  try {
    await fetch(`/api/conversations/${convId}`, { method: 'DELETE' });
    state.conversations = state.conversations.filter(c => c.id !== convId);
    renderBotFilter();
    if (state.currentConversationId === convId) {
      state.currentConversationId = null;
      const next = filteredConversations();
      if (next.length > 0) {
        renderConvList();
        selectConversation(next[0].id);
      } else if (state.conversations.length > 0) {
        // Fall back to any conversation if filter hides everything
        state.botFilter = '';
        localStorage.removeItem('bb_botFilter');
        renderBotFilter();
        renderConvList();
        selectConversation(state.conversations[0].id);
      } else {
        document.getElementById('chat-view').style.display = 'none';
        document.getElementById('empty-state').style.display = 'flex';
        renderConvList();
      }
    } else {
      renderConvList();
    }
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

function deleteCurrentConversation() {
  if (state.currentConversationId) deleteConv(state.currentConversationId);
}

// ── Surf / Review: trigger + panel jump + busy state ──

async function triggerSurfForCurrent() {
  const convId = state.currentConversationId;
  if (!convId) return;
  if (state.activeSurfs.has(convId)) return;  // already running
  // Optimistic busy — SSE will confirm in a moment
  state.activeSurfs.add(convId);
  refreshActionBusyState();
  try {
    const res = await fetch(`/api/surf/start/${convId}`, { method: 'POST' });
    if (!res.ok && res.status !== 409) {
      state.activeSurfs.delete(convId);
      refreshActionBusyState();
      const body = await res.json().catch(() => ({}));
      alert('触发冲浪失败: ' + (body.error || res.status));
    }
  } catch (e) {
    state.activeSurfs.delete(convId);
    refreshActionBusyState();
    alert('触发冲浪失败: ' + e.message);
  }
}

async function triggerReviewForCurrent() {
  const convId = state.currentConversationId;
  if (!convId) return;
  if (state.pendingReviews.has(convId)) return;
  state.pendingReviews.add(convId);
  refreshActionBusyState();
  try {
    const res = await fetch(`/api/review/trigger/${convId}`, { method: 'POST' });
    if (!res.ok) {
      state.pendingReviews.delete(convId);
      refreshActionBusyState();
      const body = await res.json().catch(() => ({}));
      alert('触发回顾失败: ' + (body.error || res.status));
    }
  } catch (e) {
    state.pendingReviews.delete(convId);
    refreshActionBusyState();
    alert('触发回顾失败: ' + e.message);
  }
}

function openSurfPanelForCurrent() {
  const convId = state.currentConversationId;
  if (!convId) return;
  window.open(`/surf.html?conv=${encodeURIComponent(convId)}`, '_blank');
}

function openReviewPanelForCurrent() {
  const convId = state.currentConversationId;
  if (!convId) return;
  window.open(`/review.html?conv=${encodeURIComponent(convId)}`, '_blank');
}

function refreshActionBusyState() {
  const convId = state.currentConversationId;
  const surfBtn = document.getElementById('surf-btn');
  const reviewBtn = document.getElementById('review-btn');
  if (surfBtn) surfBtn.classList.toggle('busy', !!convId && state.activeSurfs.has(convId));
  if (reviewBtn) reviewBtn.classList.toggle('busy', !!convId && state.pendingReviews.has(convId));
}

// Subscribes to both SSE streams to know, for any conversation under any
// bot, whether a surf / review is currently running. Used purely for the
// header busy indicators — log content still lives in the dedicated panels.
function connectSurfReviewEvents() {
  try {
    state.surfES?.close();
    const surfES = new EventSource('/api/surf/events');
    state.surfES = surfES;
    surfES.addEventListener('init', (e) => {
      try {
        const data = JSON.parse(e.data);
        state.activeSurfs = new Set(Array.isArray(data.active) ? data.active : []);
        refreshActionBusyState();
      } catch {}
    });
    surfES.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.conversationId && !state.activeSurfs.has(data.conversationId)) {
          state.activeSurfs.add(data.conversationId);
          refreshActionBusyState();
        }
      } catch {}
    });
    surfES.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.conversationId && state.activeSurfs.delete(data.conversationId)) {
          refreshActionBusyState();
        }
      } catch {}
    });
  } catch (e) { console.error('surf SSE error:', e); }

  try {
    state.reviewES?.close();
    const reviewES = new EventSource('/api/review/events');
    state.reviewES = reviewES;
    reviewES.addEventListener('init', (e) => {
      try {
        const data = JSON.parse(e.data);
        state.pendingReviews = new Set(Array.isArray(data.pending) ? data.pending : []);
        refreshActionBusyState();
      } catch {}
    });
    reviewES.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.conversationId && !state.pendingReviews.has(data.conversationId)) {
          state.pendingReviews.add(data.conversationId);
          refreshActionBusyState();
        }
      } catch {}
    });
    reviewES.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.conversationId && state.pendingReviews.delete(data.conversationId)) {
          refreshActionBusyState();
        }
      } catch {}
    });
  } catch (e) { console.error('review SSE error:', e); }
}

// ── Reset ──

async function resetCurrentConversation() {
  if (!state.currentConversationId) return;
  if (!confirm('清空当前对话的所有消息和记忆？')) return;

  try {
    const res = await fetch('/api/conversations/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversationId: state.currentConversationId }),
    });
    const data = await res.json();
    if (data.ok) {
      document.getElementById('messages').innerHTML = '';
    } else {
      alert('清空失败: ' + (data.error || '未知错误'));
    }
  } catch (e) {
    alert('清空失败: ' + e.message);
  }
}

// ── WebSocket ──

function connectWs() {
  if (state.ws && state.ws.readyState <= 1) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws?userId=${state.userId}`);

  state.ws.onopen = () => {
    state.reconnectDelay = 1000;
    document.getElementById('ws-status')?.classList.add('connected');
  };

  state.ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      handleWsMessage(msg);
    } catch {}
  };

  state.ws.onclose = () => {
    document.getElementById('ws-status')?.classList.remove('connected');
    state.reconnectTimer = setTimeout(() => {
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
      connectWs();
    }, state.reconnectDelay);
  };

  state.ws.onerror = () => {};
}

function handleWsMessage(msg) {
  if (msg.type === 'message' && msg.content) {
    if (msg.conversationId === state.currentConversationId) {
      clearSurfLog();
      appendMessage('bot', msg.content, msg.messageId);
      scrollToBottom();
    }
    bumpConversationToTop(msg.conversationId);
  } else if (msg.type === 'user_message_ack') {
    // Server finalized a user message with attachments — reconcile the
    // optimistic bubble (using blob URLs) with the canonical URLs + id.
    if (msg.conversationId === state.currentConversationId) {
      reconcileOptimisticUserMessage(msg);
    }
    bumpConversationToTop(msg.conversationId);
  } else if (msg.type === 'error' && msg.content) {
    if (msg.conversationId === state.currentConversationId) {
      appendMessage('bot', msg.content);
      scrollToBottom();
    }
  } else if (msg.type === 'surf_status' && msg.content) {
    if (msg.conversationId === state.currentConversationId) {
      appendSurfLog(msg.content);
      scrollToBottom();
    }
  } else if (msg.type === 'bot_typing' && msg.conversationId) {
    if (msg.active) {
      state.typingConvs.add(msg.conversationId);
    } else {
      state.typingConvs.delete(msg.conversationId);
    }
    if (msg.conversationId === state.currentConversationId) {
      renderTypingIndicator();
      if (msg.active) scrollToBottom();
    }
  } else if (msg.type === 'title_update' && msg.conversationId && msg.title) {
    const conv = state.conversations.find(c => c.id === msg.conversationId);
    if (conv) {
      conv.title = msg.title;
      // Update sidebar item without full re-render to keep scroll position
      const item = document.querySelector(`.conv-item[data-conv-id="${msg.conversationId}"] .conv-title`);
      if (item) {
        item.textContent = msg.title;
        item.classList.remove('untitled');
      }
      if (msg.conversationId === state.currentConversationId) updateChatHeader(conv);
    }
  }
}

function bumpConversationToTop(convId) {
  const idx = state.conversations.findIndex(c => c.id === convId);
  if (idx <= 0) return;
  const [conv] = state.conversations.splice(idx, 1);
  conv.last_activity_at = Math.floor(Date.now() / 1000);
  state.conversations.unshift(conv);
  renderConvList();
}

// ── Typing indicator ──
//
// Shown while the server is preparing a reply (LLM call + segment streaming).
// Server emits `bot_typing {active}` events; we just keep one bubble pinned
// to the bottom of the message list whenever the current conversation is in
// state.typingConvs.

function renderTypingIndicator() {
  const msgs = document.getElementById('messages');
  if (!msgs) return;
  const shouldShow = !!state.currentConversationId
    && state.typingConvs.has(state.currentConversationId);
  let el = document.getElementById('bot-typing');
  if (!shouldShow) {
    if (el) el.remove();
    return;
  }
  if (!el) {
    el = document.createElement('div');
    el.id = 'bot-typing';
    el.className = 'msg-wrap bot typing-wrap';
    el.innerHTML = `
      <div class="msg bot typing" aria-label="正在输入">
        <span class="typing-dots"><i></i><i></i><i></i></span>
      </div>
    `;
    msgs.appendChild(el);
  } else if (el.nextSibling) {
    // Keep pinned to the bottom when new messages appear above it.
    msgs.appendChild(el);
  }
}

// ── Messages ──

// opts.attachments: [{ id, mime, url, width?, height? }]
// opts.clientKey: marker for optimistic bubbles awaiting server ack
function appendMessage(type, content, msgId, opts) {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${type}`;
  if (msgId) wrap.dataset.msgId = msgId;
  if (opts?.clientKey) wrap.dataset.clientKey = opts.clientKey;

  const bubble = document.createElement('div');
  bubble.className = `msg ${type}`;
  const hasText = !!content && content.length > 0;
  const atts = opts?.attachments ?? [];
  if (atts.length > 0) {
    bubble.classList.add('has-images');
    if (!hasText) bubble.classList.add('image-only');
    const gallery = buildImageGallery(atts);
    bubble.appendChild(gallery);
  }
  if (hasText) {
    const textEl = document.createElement('div');
    textEl.className = 'msg-text';
    textEl.textContent = content;
    bubble.appendChild(textEl);
  }

  const actions = document.createElement('div');
  actions.className = 'msg-actions';

  if (type === 'user' && msgId) {
    const edit = document.createElement('button');
    edit.className = 'msg-edit-btn';
    edit.type = 'button';
    edit.title = '编辑';
    edit.setAttribute('aria-label', '编辑');
    edit.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M12 20h9"/>
        <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4L16.5 3.5z"/>
      </svg>
    `;
    edit.addEventListener('click', () => enterEditMode(msgId, wrap));
    actions.appendChild(edit);

    const regen = document.createElement('button');
    regen.className = 'msg-regen';
    regen.type = 'button';
    regen.title = '从这里重来';
    regen.setAttribute('aria-label', '从这里重来');
    regen.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12a9 9 0 1 1-3.51-7.13"/>
        <path d="M21 3v6h-6"/>
      </svg>
    `;
    regen.addEventListener('click', () => regenerateFromUserMessage(msgId, wrap, regen));
    actions.appendChild(regen);
  }

  const del = document.createElement('button');
  del.className = 'msg-del';
  del.type = 'button';
  del.setAttribute('aria-label', '删除');
  del.innerHTML = '&times;';
  del.onclick = () => deleteMsg(wrap);
  actions.appendChild(del);

  wrap.appendChild(bubble);
  wrap.appendChild(actions);
  msgs.appendChild(wrap);
  // Keep the "正在输入" bubble pinned to the bottom if it's live.
  renderTypingIndicator();
  return wrap;
}

// ── Edit a user message ─────────────────────────────────────────────────
// Per-bubble inline edit: the bubble's text node becomes contenteditable
// right where it sits — no replacement editor, no merging of consecutive
// user bubbles. Multiple bubbles can be edited at once; a single floating
// "完成 / 取消" bar appears anchored after the latest edited bubble (visually
// "in the middle" of the user's consecutive run). Edited bubbles get a
// soft yellow tint until 完成 is clicked, at which point it restores.

// messageId → { original, wrap, textEl } for every bubble currently in
// edit mode. Serves as the source of truth for what gets sent on 完成.
const edits = new Map();

function enterEditMode(msgId, wrap) {
  if (edits.has(msgId)) {
    // Already editing this one — just refocus it.
    const e = edits.get(msgId);
    e.textEl.focus();
    placeCaretAtEnd(e.textEl);
    return;
  }

  const bubble = wrap.querySelector('.msg');
  if (!bubble) return;

  // Ensure a .msg-text element exists, even for image-only bubbles — the
  // user may want to add a caption while editing.
  let textEl = bubble.querySelector('.msg-text');
  if (!textEl) {
    textEl = document.createElement('div');
    textEl.className = 'msg-text';
    bubble.appendChild(textEl);
  }

  const originalText = textEl.textContent ?? '';

  textEl.setAttribute('contenteditable', 'plaintext-only');
  // Fallback for browsers without plaintext-only support: plain contenteditable.
  if (textEl.contentEditable !== 'plaintext-only') {
    textEl.setAttribute('contenteditable', 'true');
  }
  textEl.spellcheck = false;
  textEl.classList.add('editing-text');
  wrap.classList.add('editing');

  edits.set(msgId, { original: originalText, wrap, textEl });

  const onInput = () => {
    const current = textEl.textContent ?? '';
    // Yellow tint only when the content actually differs from original.
    wrap.classList.toggle('edited', current !== originalText);
    updateEditBarCount();
  };
  const onKey = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      cancelSingleEdit(msgId);
    }
  };
  textEl.addEventListener('input', onInput);
  textEl.addEventListener('keydown', onKey);
  // Hold handlers on the map so cancel/commit can detach cleanly.
  edits.get(msgId).onInput = onInput;
  edits.get(msgId).onKey = onKey;

  textEl.focus();
  placeCaretAtEnd(textEl);

  renderEditBar();
}

function placeCaretAtEnd(el) {
  const range = document.createRange();
  range.selectNodeContents(el);
  range.collapse(false);
  const sel = window.getSelection();
  if (!sel) return;
  sel.removeAllRanges();
  sel.addRange(range);
}

function exitEditModeSingle(msgId, { commit = false } = {}) {
  const e = edits.get(msgId);
  if (!e) return;
  const { wrap, textEl, original, onInput, onKey } = e;
  if (onInput) textEl.removeEventListener('input', onInput);
  if (onKey) textEl.removeEventListener('keydown', onKey);
  textEl.removeAttribute('contenteditable');
  textEl.classList.remove('editing-text');
  wrap.classList.remove('editing', 'edited');
  if (!commit) {
    // Restore original text on cancel.
    textEl.textContent = original;
  }
  // If this was an image-only bubble that we added a blank .msg-text to,
  // remove it on commit/cancel if it's still empty to keep the bubble
  // compact like before.
  const bubble = wrap.querySelector('.msg');
  if (bubble?.classList.contains('has-images') && textEl.textContent === '') {
    textEl.remove();
    bubble.classList.add('image-only');
  }
  edits.delete(msgId);
}

function cancelSingleEdit(msgId) {
  exitEditModeSingle(msgId, { commit: false });
  if (edits.size === 0) removeEditBar();
  else renderEditBar();
}

function cancelAllEdits() {
  for (const id of Array.from(edits.keys())) {
    exitEditModeSingle(id, { commit: false });
  }
  removeEditBar();
}

// Floating bar with 取消 / 完成. Anchored after the latest (DOM-order) edited
// user bubble — sits literally in the middle of the consecutive-user run.
function renderEditBar() {
  removeEditBar();
  if (edits.size === 0) return;

  const msgs = document.getElementById('messages');
  const editedEls = Array.from(msgs.querySelectorAll('.msg-wrap.editing'));
  if (editedEls.length === 0) return;
  const anchor = editedEls[editedEls.length - 1];

  const bar = document.createElement('div');
  bar.className = 'edit-bar';
  bar.dataset.editBar = '1';

  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.className = 'edit-bar-cancel';
  cancel.textContent = '取消';
  cancel.addEventListener('click', cancelAllEdits);

  const confirm = document.createElement('button');
  confirm.type = 'button';
  confirm.className = 'edit-bar-confirm';
  confirm.addEventListener('click', commitAllEdits);

  bar.appendChild(cancel);
  bar.appendChild(confirm);
  anchor.after(bar);
  updateEditBarCount();
}

function updateEditBarCount() {
  const bar = document.querySelector('.edit-bar');
  if (!bar) return;
  // Count only bubbles whose content actually differs.
  let dirty = 0;
  for (const { textEl, original } of edits.values()) {
    if ((textEl.textContent ?? '') !== original) dirty++;
  }
  const confirm = bar.querySelector('.edit-bar-confirm');
  if (confirm) {
    confirm.textContent = dirty > 1 ? `完成 (${dirty})` : '完成';
    confirm.classList.toggle('dim', dirty === 0);
  }
}

function removeEditBar() {
  document.querySelectorAll('.edit-bar').forEach(el => el.remove());
}

async function commitAllEdits() {
  if (edits.size === 0) return;

  // Collect only changed bubbles. If nothing actually changed, just cancel.
  const changed = [];
  for (const [msgId, { textEl, original }] of edits.entries()) {
    const current = textEl.textContent ?? '';
    if (current !== original) changed.push({ messageId: msgId, content: current });
  }
  if (changed.length === 0) { cancelAllEdits(); return; }

  // Determine the anchor (latest edited message in DOM order). Everything
  // after it will be torn down.
  const msgs = document.getElementById('messages');
  const bubbles = Array.from(msgs.querySelectorAll('.msg-wrap'));
  const editedBubbles = Array.from(msgs.querySelectorAll('.msg-wrap.editing'));
  const anchor = editedBubbles[editedBubbles.length - 1];
  const anchorIdx = bubbles.indexOf(anchor);
  const tail = anchorIdx >= 0 ? bubbles.slice(anchorIdx + 1) : [];

  const hasLaterUser = tail.some(b => b.classList.contains('user'));
  if (hasLaterUser) {
    if (!window.confirm('提交编辑会同时删除后面的消息。继续吗？')) return;
  }

  const bar = document.querySelector('.edit-bar');
  const confirmBtn = bar?.querySelector('.edit-bar-confirm');
  const cancelBtn = bar?.querySelector('.edit-bar-cancel');
  if (confirmBtn) { confirmBtn.disabled = true; confirmBtn.classList.add('loading'); }
  if (cancelBtn) cancelBtn.disabled = true;
  // Lock text editing while the request is in flight.
  for (const { textEl } of edits.values()) {
    textEl.setAttribute('contenteditable', 'false');
  }

  try {
    const res = await fetch(`/api/conversations/${state.currentConversationId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        edits: changed,
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      alert('保存失败: ' + (data.error || `HTTP ${res.status}`));
      if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.classList.remove('loading'); }
      if (cancelBtn) cancelBtn.disabled = false;
      for (const { textEl } of edits.values()) {
        textEl.setAttribute('contenteditable', 'plaintext-only');
      }
      return;
    }

    // Commit locally: drop yellow + editing state on each edited bubble,
    // leave the new content in place. Then tear down tail + let WS stream
    // the new bot reply in.
    for (const id of Array.from(edits.keys())) {
      exitEditModeSingle(id, { commit: true });
    }
    removeEditBar();
    for (const el of tail) el.remove();
    scrollToBottom();
  } catch (e) {
    alert('保存失败: ' + e.message);
    if (confirmBtn) { confirmBtn.disabled = false; confirmBtn.classList.remove('loading'); }
    if (cancelBtn) cancelBtn.disabled = false;
    for (const { textEl } of edits.values()) {
      textEl.setAttribute('contenteditable', 'plaintext-only');
    }
  }
}

// "从这里重来" — click on a user bubble to simulate: I've just finished
// sending this message. Everything after it (the bot reply, any later
// exchanges) gets dropped and the model re-answers from this point.
async function regenerateFromUserMessage(msgId, wrap, btn) {
  if (!state.currentConversationId || !msgId) return;

  // Bubbles to remove = everything strictly AFTER the clicked user bubble.
  // The clicked bubble itself stays put — it's the anchor we're rewinding to.
  const msgs = document.getElementById('messages');
  const bubbles = Array.from(msgs.querySelectorAll('.msg-wrap'));
  const idx = bubbles.indexOf(wrap);
  if (idx < 0) return;
  const tail = bubbles.slice(idx + 1);

  // Warn if the click is mid-history — there are later exchanges that will
  // also be dropped. Skip the confirm when the tail is just the immediate
  // bot reply (the common case: fix a typo, retry).
  const hasLaterUser = tail.some(b => b.classList.contains('user'));
  if (hasLaterUser) {
    if (!confirm('从这里重来会同时删除后面的消息。继续吗？')) return;
  }

  if (btn) btn.disabled = true;

  try {
    const res = await fetch(`/api/conversations/${state.currentConversationId}/regenerate`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messageId: msgId, userId: state.userId }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) {
      alert('重新生成失败: ' + (data.error || `HTTP ${res.status}`));
      if (btn) btn.disabled = false;
      return;
    }
    // Tear down the tail — new bot segments will arrive over WS.
    for (const el of tail) el.remove();
    scrollToBottom();
  } catch (e) {
    alert('重新生成失败: ' + e.message);
    if (btn) btn.disabled = false;
  }
}

function buildImageGallery(attachments) {
  const gallery = document.createElement('div');
  gallery.className = 'msg-gallery';
  if (attachments.length === 1) gallery.classList.add('single');
  for (const att of attachments) {
    if (!att || !att.url) continue;
    const btn = document.createElement('button');
    btn.className = 'msg-img-btn';
    btn.type = 'button';
    btn.addEventListener('click', () => openImageViewer(att.url));
    const img = document.createElement('img');
    img.src = att.url;
    img.alt = '图片';
    img.loading = 'lazy';
    if (att.width && att.height) {
      img.width = att.width;
      img.height = att.height;
    }
    btn.appendChild(img);
    gallery.appendChild(btn);
  }
  return gallery;
}

function reconcileOptimisticUserMessage(msg) {
  const attachments = (msg.metadata?.attachments) || [];
  if (attachments.length === 0) return;
  // Match by the first attachment's id — the client tray holds the same ids.
  const ids = new Set(attachments.map(a => a.id));
  const msgs = document.getElementById('messages');
  // Look for an optimistic bubble whose client-key was tagged with one of
  // these ids. clientKey = comma-separated attachment ids.
  let match = null;
  for (const el of msgs.querySelectorAll('.msg-wrap.user[data-client-key]')) {
    const keyIds = el.dataset.clientKey.split(',');
    if (keyIds.some(id => ids.has(id))) { match = el; break; }
  }
  if (!match) return;
  match.dataset.msgId = msg.messageId;
  delete match.dataset.clientKey;
  // Replace gallery imgs' blob URLs with canonical /uploads/<id> URLs so
  // they keep working after page refresh (the blob URLs are session-local).
  const imgs = match.querySelectorAll('.msg-img-btn img');
  attachments.forEach((att, i) => {
    const img = imgs[i];
    if (!img) return;
    // Revoke any blob URL now that the network image is available.
    const prev = img.src;
    if (prev.startsWith('blob:')) {
      img.addEventListener('load', () => URL.revokeObjectURL(prev), { once: true });
    }
    img.src = att.url;
  });
}

async function deleteMsg(el) {
  const msgId = el.dataset.msgId;
  if (msgId) {
    try { await fetch(`/api/messages/${msgId}`, { method: 'DELETE' }); } catch {}
  }
  el.remove();
}

function appendSurfLog(content) {
  const msgs = document.getElementById('messages');
  let container = msgs.querySelector('.surf-log');
  if (!container) {
    container = document.createElement('div');
    container.className = 'surf-log';
    msgs.appendChild(container);
  }
  const entry = document.createElement('div');
  entry.className = 'surf-log-entry';
  entry.textContent = content;
  container.appendChild(entry);
}

function clearSurfLog() {
  const msgs = document.getElementById('messages');
  const log = msgs.querySelector('.surf-log');
  if (log) log.remove();
}

function scrollToBottom() {
  const scroll = document.querySelector('.messages-scroll');
  if (scroll) requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
}

// ── Send ──

function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!state.currentConversationId) return;

  // Include only successfully-uploaded attachments. Failed/uploading ones
  // are left in the tray so the user can retry or remove them.
  const readyAtts = state.pendingAttachments.filter(a => a.status === 'ok' && a.attachmentId);
  if (!content && readyAtts.length === 0) return;
  // Guard: if there are still in-flight uploads, nudge the user rather than
  // silently dropping them.
  const inflight = state.pendingAttachments.some(a => a.status === 'uploading');
  if (inflight) {
    flashAttachmentTray();
    return;
  }

  const attObjs = readyAtts.map(a => ({
    id: a.attachmentId,
    mime: a.file.type,
    url: a.previewUrl, // blob: URL — swapped to /uploads/<id> on ack
    width: a.width,
    height: a.height,
  }));
  const clientKey = readyAtts.map(a => a.attachmentId).join(',');

  appendMessage('user', content, undefined, {
    attachments: attObjs,
    clientKey: clientKey || undefined,
  });
  scrollToBottom();
  bumpConversationToTop(state.currentConversationId);

  if (state.ws?.readyState === 1) {
    const conv = state.conversations.find(c => c.id === state.currentConversationId);
    const payload = {
      type: 'chat',
      botId: conv?.bot_id,
      conversationId: state.currentConversationId,
      content,
    };
    const ids = readyAtts.map(a => a.attachmentId);
    if (ids.length > 0) payload.attachmentIds = ids;
    state.ws.send(JSON.stringify(payload));
  }

  // Clear the tray — ownership of blob URLs is now with the bubble. They
  // get revoked once the network image loads after ack.
  state.pendingAttachments = [];
  renderAttachmentTray();

  input.value = '';
  autoResize(input);
  updateSendBtn();
}

// ── Attachments: upload, tray, drag, paste ──

function onAttachClick() {
  document.getElementById('file-input').click();
}

function validateFile(file) {
  if (!ACCEPTED_IMAGE_TYPES.includes(file.type)) {
    return `不支持的格式：${file.type || '未知'}`;
  }
  if (file.size === 0) return '文件为空';
  if (file.size > MAX_UPLOAD_BYTES) {
    return `文件过大（${(file.size / 1024 / 1024).toFixed(1)}MB，上限 10MB）`;
  }
  return null;
}

function addFilesToTray(files) {
  for (const file of files) {
    const err = validateFile(file);
    const entry = {
      clientId: 'a_' + Math.random().toString(36).slice(2, 10),
      file,
      previewUrl: URL.createObjectURL(file),
      status: err ? 'error' : 'uploading',
      error: err || undefined,
      attachmentId: undefined,
      url: undefined,
      width: undefined,
      height: undefined,
    };
    state.pendingAttachments.push(entry);
    if (!err) uploadEntry(entry);
  }
  renderAttachmentTray();
  updateSendBtn();
}

async function uploadEntry(entry) {
  try {
    const fd = new FormData();
    fd.append('file', entry.file);
    if (state.currentConversationId) {
      fd.append('conversationId', state.currentConversationId);
    }
    const res = await fetch('/api/upload', { method: 'POST', body: fd });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data?.id) {
      entry.status = 'error';
      entry.error = data?.error || `HTTP ${res.status}`;
    } else {
      entry.status = 'ok';
      entry.attachmentId = data.id;
      entry.url = data.url;
    }
  } catch (e) {
    entry.status = 'error';
    entry.error = e?.message || '上传失败';
  }
  // Probe natural dimensions for nicer inline rendering in the bubble.
  try {
    const dims = await readImageDimensions(entry.file);
    entry.width = dims.width;
    entry.height = dims.height;
  } catch { /* non-fatal */ }
  renderAttachmentTray();
  updateSendBtn();
}

function readImageDimensions(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      const r = { width: img.naturalWidth, height: img.naturalHeight };
      URL.revokeObjectURL(url);
      resolve(r);
    };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('decode')); };
    img.src = url;
  });
}

function removeAttachment(clientId) {
  const idx = state.pendingAttachments.findIndex(a => a.clientId === clientId);
  if (idx < 0) return;
  const [removed] = state.pendingAttachments.splice(idx, 1);
  if (removed?.previewUrl?.startsWith('blob:')) URL.revokeObjectURL(removed.previewUrl);
  renderAttachmentTray();
  updateSendBtn();
}

function renderAttachmentTray() {
  const tray = document.getElementById('attachment-tray');
  if (!tray) return;
  if (state.pendingAttachments.length === 0) {
    tray.innerHTML = '';
    tray.classList.remove('populated');
    return;
  }
  tray.classList.add('populated');
  tray.innerHTML = '';
  for (const a of state.pendingAttachments) {
    const item = document.createElement('div');
    item.className = `tray-item ${a.status}`;
    item.title = a.file.name + (a.error ? ` — ${a.error}` : '');

    const img = document.createElement('img');
    img.src = a.previewUrl;
    img.alt = '';
    item.appendChild(img);

    if (a.status === 'uploading') {
      const spin = document.createElement('div');
      spin.className = 'tray-spinner';
      item.appendChild(spin);
    } else if (a.status === 'error') {
      const err = document.createElement('div');
      err.className = 'tray-err';
      err.textContent = '!';
      item.appendChild(err);
    }

    const x = document.createElement('button');
    x.className = 'tray-remove';
    x.type = 'button';
    x.innerHTML = '&times;';
    x.setAttribute('aria-label', '移除');
    x.addEventListener('click', () => removeAttachment(a.clientId));
    item.appendChild(x);

    tray.appendChild(item);
  }
}

function flashAttachmentTray() {
  const tray = document.getElementById('attachment-tray');
  if (!tray) return;
  tray.classList.remove('flash');
  // Trigger reflow so the animation restarts even on rapid retry.
  void tray.offsetWidth;
  tray.classList.add('flash');
}

// ── Image viewer ──

function openImageViewer(url) {
  const viewer = document.getElementById('image-viewer');
  const img = document.getElementById('image-viewer-img');
  if (!viewer || !img) return;
  img.src = url;
  viewer.classList.add('open');
  viewer.setAttribute('aria-hidden', 'false');
}

function closeImageViewer(e) {
  if (e) e.stopPropagation();
  const viewer = document.getElementById('image-viewer');
  const img = document.getElementById('image-viewer-img');
  if (!viewer || !img) return;
  // If click originated on the image itself, let it pass through instead of
  // closing — only close on backdrop / close-button.
  if (e && e.target === img) return;
  viewer.classList.remove('open');
  viewer.setAttribute('aria-hidden', 'true');
  img.src = '';
}

// ── Input ──

// Throttled ticker: notifies the server the user is still composing. The
// server's debounce layer uses these ticks to decide whether to delay the
// LLM request while the user is mid-typing.
let lastTypingTickAt = 0;
function sendTypingTick() {
  if (!state.currentConversationId) return;
  if (state.ws?.readyState !== 1) return;
  const now = Date.now();
  if (now - lastTypingTickAt < 400) return; // throttle
  lastTypingTickAt = now;
  try {
    state.ws.send(JSON.stringify({
      type: 'typing_tick',
      conversationId: state.currentConversationId,
    }));
  } catch {}
}

function setupInput() {
  const input = document.getElementById('msg-input');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });

  input.addEventListener('input', () => {
    autoResize(input);
    updateSendBtn();
    sendTypingTick();
  });

  // Paste images from clipboard
  input.addEventListener('paste', (e) => {
    if (!state.currentConversationId) return;
    const items = e.clipboardData?.items || [];
    const files = [];
    for (const item of items) {
      if (item.kind === 'file' && item.type?.startsWith('image/')) {
        const f = item.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length > 0) {
      e.preventDefault();
      addFilesToTray(files);
    }
  });

  // File picker
  const fileInput = document.getElementById('file-input');
  if (fileInput) {
    fileInput.addEventListener('change', () => {
      if (!state.currentConversationId) {
        alert('先选或开一个对话');
        fileInput.value = '';
        return;
      }
      const files = Array.from(fileInput.files || []);
      if (files.length > 0) addFilesToTray(files);
      fileInput.value = ''; // reset so same file can be picked again
    });
  }

  // Drag-and-drop anywhere in the chat view
  const chatView = document.getElementById('chat-view');
  const overlay = document.getElementById('drop-overlay');
  if (chatView && overlay) {
    const isImageDrag = (e) => {
      const dt = e.dataTransfer;
      if (!dt) return false;
      // `types` is the authoritative probe during dragover — `files` is only
      // populated on drop in some browsers.
      return Array.from(dt.types || []).includes('Files');
    };
    chatView.addEventListener('dragenter', (e) => {
      if (!isImageDrag(e) || !state.currentConversationId) return;
      e.preventDefault();
      state.dragCounter++;
      overlay.classList.add('active');
    });
    chatView.addEventListener('dragover', (e) => {
      if (!isImageDrag(e) || !state.currentConversationId) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });
    chatView.addEventListener('dragleave', (e) => {
      if (!isImageDrag(e)) return;
      state.dragCounter = Math.max(0, state.dragCounter - 1);
      if (state.dragCounter === 0) overlay.classList.remove('active');
    });
    chatView.addEventListener('drop', (e) => {
      if (!isImageDrag(e)) return;
      e.preventDefault();
      state.dragCounter = 0;
      overlay.classList.remove('active');
      if (!state.currentConversationId) return;
      const files = Array.from(e.dataTransfer?.files || []).filter(f => f.type?.startsWith('image/'));
      if (files.length > 0) addFilesToTray(files);
    });
  }
}

function setupGlobalHandlers() {
  // Close bot picker when clicking elsewhere
  document.addEventListener('click', (e) => {
    const picker = document.getElementById('bot-picker');
    const wrap = document.querySelector('.new-chat-wrap');
    if (picker.style.display === 'block' && wrap && !wrap.contains(e.target)) {
      picker.style.display = 'none';
    }
  });

  // Keyboard shortcuts
  document.addEventListener('keydown', (e) => {
    const mod = e.metaKey || e.ctrlKey;
    // ⌘/Ctrl + N → new chat
    if (mod && !e.shiftKey && !e.altKey && (e.key === 'n' || e.key === 'N')) {
      // Don't hijack when user is typing in an input/textarea (unless it's the msg input)
      const tgt = e.target;
      if (tgt && (tgt.tagName === 'INPUT' || tgt.tagName === 'TEXTAREA') && tgt.id !== 'msg-input') return;
      e.preventDefault();
      onNewChatClick(null);
    }
    // Escape closes bot picker / image viewer
    if (e.key === 'Escape') {
      const viewer = document.getElementById('image-viewer');
      if (viewer?.classList.contains('open')) {
        closeImageViewer();
        return;
      }
      const picker = document.getElementById('bot-picker');
      if (picker && picker.style.display === 'block') picker.style.display = 'none';
    }
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function updateSendBtn() {
  const input = document.getElementById('msg-input');
  const btn = document.getElementById('send-btn');
  const hasText = input.value.trim().length > 0;
  const hasReadyAttachment = state.pendingAttachments.some(a => a.status === 'ok');
  const canSend = !!state.currentConversationId && (hasText || hasReadyAttachment);
  btn.classList.toggle('ready', canSend);
}

// ── Audit ──

function showAudit() {
  document.getElementById('audit-panel').style.display = 'block';
  loadAudit();
}

function hideAudit() {
  document.getElementById('audit-panel').style.display = 'none';
}

async function loadAudit() {
  try {
    const summaryRes = await fetch('/api/audit/summary?groupBy=task_type');
    const summary = await summaryRes.json();

    let html = '<h3>按任务类型</h3><table><tr><th>类型</th><th>次数</th><th>Input</th><th>Output</th><th>费用</th></tr>';
    for (const r of summary) {
      html += `<tr><td>${r.group_key}</td><td>${r.count}</td><td>${fmt(r.total_input)}</td><td>${fmt(r.total_output)}</td><td>${r.total_cost ? '$' + r.total_cost.toFixed(4) : '-'}</td></tr>`;
    }
    html += '</table>';

    const modelRes = await fetch('/api/audit/summary?groupBy=model');
    const models = await modelRes.json();

    html += '<h3>按模型</h3><table><tr><th>模型</th><th>次数</th><th>Input</th><th>Output</th><th>费用</th></tr>';
    for (const r of models) {
      html += `<tr><td>${shortModel(r.group_key)}</td><td>${r.count}</td><td>${fmt(r.total_input)}</td><td>${fmt(r.total_output)}</td><td>${r.total_cost ? '$' + r.total_cost.toFixed(4) : '-'}</td></tr>`;
    }
    html += '</table>';

    document.getElementById('audit-summary').innerHTML = html;

    const detailRes = await fetch('/api/audit/details?limit=50');
    const details = await detailRes.json();

    let dhtml = '<h3>最近调用</h3><table><tr><th>时间</th><th>类型</th><th>模型</th><th>In</th><th>Out</th><th>延迟</th><th>费用</th></tr>';
    for (const r of details) {
      const t = new Date(r.created_at * 1000).toLocaleString('zh-CN', { hour12: false });
      dhtml += `<tr><td>${t}</td><td>${r.task_type}</td><td>${shortModel(r.model)}</td><td>${fmt(r.input_tokens)}</td><td>${fmt(r.output_tokens)}</td><td>${r.latency_ms ? r.latency_ms + 'ms' : '-'}</td><td>${r.cost_usd ? '$' + r.cost_usd.toFixed(4) : '-'}</td></tr>`;
    }
    dhtml += '</table>';

    document.getElementById('audit-details').innerHTML = dhtml;
  } catch (e) {
    console.error('audit error:', e);
  }
}

function fmt(n) {
  if (!n) return '0';
  if (n > 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n > 1e3) return (n / 1e3).toFixed(1) + 'K';
  return String(n);
}

function shortModel(m) {
  if (!m) return '-';
  return m.split('/').pop().slice(0, 24);
}

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}
