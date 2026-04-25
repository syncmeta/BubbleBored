// PendingBot Web Client — multi-conversation

// Top-level feature tabs. message is the existing chat experience; the rest
// are independent activities populated in later phases.
const FEATURE_TABS = ['message', 'surf', 'review', 'debate', 'portrait', 'me'];

const state = {
  userId: localStorage.getItem('bb_userId') || generateId(),
  bots: [],                      // [{ id, display_name, ... }]
  botsById: new Map(),
  // Conversations per feature tab (only the active tab is loaded; others are
  // lazy-loaded on tab switch). Keyed by tab id.
  convsByTab: { message: [], surf: [], review: [], debate: [], portrait: [] },
  currentConversationId: null,
  currentTab: localStorage.getItem('bb_currentTab') || 'message',
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
  // `bot_typing {active}` events; the header label only renders on the visible
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

// Sugar: the active tab's conversation list. Many call sites still want the
// "current" view of conversations without caring about feature partitioning.
Object.defineProperty(state, 'conversations', {
  get() { return state.convsByTab[state.currentTab] || []; },
  set(v) { state.convsByTab[state.currentTab] = v; },
});

async function init() {
  await loadBots();
  setupFeatureTabs();
  await loadConversations();
  renderBotFilter();
  renderConvList();
  updateNewChatLabel();
  applyTabView();
  // Auto-select most recent conversation in the active tab (only meaningful
  // for the message tab; other tabs land on the placeholder anyway).
  if (state.currentTab === 'message' && state.conversations.length > 0) {
    selectConversation(state.conversations[0].id);
  }
  connectWs();
  connectSurfReviewEvents();
  setupInput();
  setupGlobalHandlers();
  startRelativeTimeTick();
}

function setupFeatureTabs() {
  const root = document.getElementById('feature-tabs');
  if (!root) return;
  for (const btn of root.querySelectorAll('.feature-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === state.currentTab);
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  }
}

async function switchTab(tabId) {
  if (!FEATURE_TABS.includes(tabId)) return;
  if (tabId === state.currentTab) return;
  state.currentTab = tabId;
  localStorage.setItem('bb_currentTab', tabId);
  // Clear selection on tab change — convId is tab-scoped
  state.currentConversationId = null;
  for (const btn of document.querySelectorAll('.feature-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  }
  await loadConversations();
  renderBotFilter();
  renderConvList();
  updateNewChatLabel();
  applyTabView();
}

// Show the right main pane for the active tab. The chat-view stays alive
// behind the placeholder so reselecting message-tab conversations is instant.
function applyTabView() {
  const empty = document.getElementById('empty-state');
  const chat = document.getElementById('chat-view');
  const debate = document.getElementById('debate-view');
  const placeholder = document.getElementById('placeholder-view');
  const meView = document.getElementById('me-view');

  // Default: hide all
  if (empty) empty.style.display = 'none';
  if (chat) chat.style.display = 'none';
  if (debate) debate.style.display = 'none';
  if (placeholder) placeholder.style.display = 'none';
  if (meView) meView.style.display = 'none';

  if (state.currentTab === 'me') {
    if (meView) meView.style.display = 'flex';
    return;
  }
  if (state.currentTab === 'message') {
    if (state.currentConversationId) {
      if (chat) chat.style.display = 'flex';
    } else {
      if (empty) empty.style.display = 'flex';
    }
    return;
  }
  if (state.currentTab === 'debate') {
    if (state.currentConversationId) {
      if (debate) debate.style.display = 'flex';
    } else {
      if (empty) empty.style.display = 'flex';
      const txt = document.getElementById('empty-state-text');
      if (txt) txt.textContent = '点「新对话」开启一场议论';
    }
    return;
  }
  // Other tabs (surf / review / portrait): placeholder
  if (state.currentConversationId) {
    if (placeholder) placeholder.style.display = 'flex';
    const text = document.getElementById('placeholder-text');
    if (text) {
      text.textContent = ({
        surf: '冲浪独立流将在后续阶段实现 — 该会话已记录。',
        review: '回顾独立流将在后续阶段实现 — 该会话已记录。',
        portrait: '画像将在 Phase 2 实现 — 选源会话、生成多种数字痕迹。',
      })[state.currentTab] ?? '施工中';
    }
  } else {
    if (empty) empty.style.display = 'flex';
    const txt = document.getElementById('empty-state-text');
    if (txt) {
      txt.textContent = ({
        surf: '点「新对话」开启一段冲浪',
        review: '点「新对话」开启一次回顾',
        portrait: '点「新对话」选源会话生成画像',
      })[state.currentTab] ?? '选个对话，或者开个新的';
    }
  }
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
  // 'me' tab has no conversations
  if (state.currentTab === 'me') {
    return;
  }
  try {
    const url = `/api/conversations?userId=${encodeURIComponent(state.userId)}&feature=${state.currentTab}`;
    const res = await fetch(url);
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

  // Update active state in sidebar
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  if (state.currentTab !== 'message') {
    // Non-message tabs land on the placeholder for now; their full UI lands
    // in the per-feature phase.
    applyTabView();
    return;
  }

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('chat-view').style.display = 'flex';
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
    const featureType = state.currentTab === 'me' ? 'message' : state.currentTab;
    const res = await fetch('/api/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, botId, featureType }),
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
// Server emits `bot_typing {active}` events; we toggle a "正在输入..." label
// in the chat header beside the conversation title whenever the current
// conversation is in state.typingConvs.

function renderTypingIndicator() {
  const el = document.getElementById('chat-typing');
  if (!el) return;
  const shouldShow = !!state.currentConversationId
    && state.typingConvs.has(state.currentConversationId);
  el.hidden = !shouldShow;
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

// ──────────────────────────────────────────────────────────────────────────
//  议论 (Debate) — multi-agent group chat, user can only inject 辟谣
// ──────────────────────────────────────────────────────────────────────────

const debateState = {
  providerModels: [],            // [{ id, provider, slug, display_name, enabled }]
  currentDebate: null,           // hydrated debate conv (with topic + model_slugs)
  pickedModelSlugs: new Set(),   // for the modal
  busyConvIds: new Set(),
  modalMode: 'create',           // 'create' | 'edit'
  es: null,
};

// Stable color from a model slug (mirrors botColor()).
function modelColor(slug) {
  let h = 0;
  for (let i = 0; i < (slug || '').length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

function modelDisplayName(slug) {
  const found = debateState.providerModels.find(m => m.slug === slug);
  return found?.display_name ?? slug;
}

async function loadProviderModels() {
  try {
    const res = await fetch('/api/debate/provider-models');
    debateState.providerModels = await res.json();
  } catch (e) {
    console.error('load provider models error:', e);
    debateState.providerModels = [];
  }
}

// Hook into loadConversations: when on the debate tab, hit the debate-specific
// list endpoint that hydrates topic + model_slugs.
async function loadDebateConversations() {
  try {
    const res = await fetch(`/api/debate/conversations?userId=${encodeURIComponent(state.userId)}`);
    const list = await res.json();
    state.convsByTab.debate = Array.isArray(list) ? list : [];
  } catch (e) {
    console.error('load debate convs error:', e);
    state.convsByTab.debate = [];
  }
}

function renderDebateConvItem(conv) {
  const el = document.createElement('div');
  el.className = 'conv-item';
  el.dataset.convId = conv.id;
  if (conv.id === state.currentConversationId) el.classList.add('active');

  const title = conv.title || '议论';
  const subtitle = conv.topic ? esc(conv.topic) : '（无议题）';
  const modelDots = (conv.model_slugs ?? []).slice(0, 5).map(slug =>
    `<span class="conv-model-dot" style="background:${modelColor(slug)}" title="${esc(slug)}"></span>`
  ).join('');

  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(title)}</span>
      <span class="conv-subtitle">${subtitle}</span>
      <span class="conv-debate-meta">${modelDots} <span>· ${conv.round_count_debate ?? 0} 轮</span></span>
    </span>
    <span class="conv-actions">
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
      if (actBtn.dataset.act === 'delete') deleteDebateConv(conv.id);
      return;
    }
    selectDebateConv(conv.id);
  });
  return el;
}

async function selectDebateConv(convId) {
  state.currentConversationId = convId;
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  // Hide other panes, show debate-view
  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('placeholder-view').style.display = 'none';
  document.getElementById('me-view').style.display = 'none';
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('debate-view').style.display = 'flex';

  try {
    const res = await fetch(`/api/debate/conversations/${convId}`);
    debateState.currentDebate = await res.json();
  } catch {
    debateState.currentDebate = null;
  }
  updateDebateHeader();

  // Load history
  try {
    const res = await fetch(`/api/debate/conversations/${convId}/messages`);
    const msgs = await res.json();
    const root = document.getElementById('debate-messages');
    root.innerHTML = '';
    for (const m of msgs) appendDebateMessage(m);
    scrollDebateToBottom();
  } catch (e) {
    console.error('debate history load:', e);
  }
}

function updateDebateHeader() {
  const d = debateState.currentDebate;
  const title = document.getElementById('debate-title');
  const meta = document.getElementById('debate-meta');
  if (!d) {
    title.textContent = '议论';
    meta.textContent = '';
    return;
  }
  title.textContent = d.topic || d.title || '议论';
  const modelNames = (d.model_slugs ?? []).map(modelDisplayName).join(' · ');
  meta.textContent = `${(d.model_slugs ?? []).length} 个模型 · ${d.round_count_debate ?? 0} 轮 · ${modelNames}`;
}

function appendDebateMessage(m) {
  const root = document.getElementById('debate-messages');
  if (!root) return;
  const el = document.createElement('div');

  // Distinguish row kinds by sender_type. Debater messages are tagged with
  // their slug; clarify rows are user injections.
  const senderType = m.sender_type || (m.metadata?.sender_kind === 'clarify' ? 'user' : 'debater');
  if (senderType === 'user' || m.metadata?.sender_kind === 'clarify') {
    el.className = 'debate-msg clarify';
    el.textContent = m.content;
  } else {
    const slug = m.sender_id || m.metadata?.slug || '';
    const name = m.metadata?.display_name || modelDisplayName(slug);
    el.className = 'debate-msg debater';
    el.innerHTML = `
      <div class="debate-who">
        <span class="debate-who-dot" style="background:${modelColor(slug)}"></span>
        <span>${esc(name)}</span>
      </div>
      <div class="debate-body">${esc(m.content)}</div>
    `;
  }
  root.appendChild(el);
}

function scrollDebateToBottom() {
  const root = document.getElementById('debate-messages');
  if (!root) return;
  const scroller = root.parentElement;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

async function runDebateRoundClick() {
  const convId = state.currentConversationId;
  if (!convId) return;
  const btn = document.getElementById('debate-round-btn');
  btn.disabled = true;
  btn.classList.add('busy');
  setDebateStatus('议论中…');
  try {
    await fetch(`/api/debate/round/${convId}`, { method: 'POST' });
    // Server fires messages over WS + a `done` event over SSE; we'll
    // re-enable the button on `done`.
  } catch (e) {
    setDebateStatus(`出错：${e.message}`);
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

async function injectDebateClarification() {
  const convId = state.currentConversationId;
  if (!convId) return;
  const input = document.getElementById('debate-clarify-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  const btn = document.getElementById('debate-round-btn');
  btn.disabled = true;
  btn.classList.add('busy');
  setDebateStatus('注入并开始下一轮…');
  try {
    await fetch(`/api/debate/inject/${convId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, autoRound: true }),
    });
  } catch (e) {
    setDebateStatus(`出错：${e.message}`);
    btn.disabled = false;
    btn.classList.remove('busy');
  }
}

function setDebateStatus(text) {
  const el = document.getElementById('debate-status');
  if (el) el.textContent = text || '';
}

async function deleteDebateConv(convId) {
  if (!confirm('删除这场议论？')) return;
  try {
    await fetch(`/api/debate/conversations/${convId}`, { method: 'DELETE' });
    state.convsByTab.debate = state.convsByTab.debate.filter(c => c.id !== convId);
    if (state.currentConversationId === convId) {
      state.currentConversationId = null;
      applyTabView();
    }
    renderConvList();
  } catch (e) {
    alert('删除失败: ' + e.message);
  }
}

function deleteCurrentDebate() {
  if (state.currentConversationId) deleteDebateConv(state.currentConversationId);
}

// ── Modal: create / edit debate ──

async function openDebateModal(mode = 'create', existingDebate = null) {
  await loadProviderModels();
  debateState.modalMode = mode;
  const title = document.getElementById('debate-modal-title');
  const submitBtn = document.getElementById('debate-modal-submit');
  const topicEl = document.getElementById('debate-modal-topic');

  if (mode === 'edit' && existingDebate) {
    title.textContent = '改设置';
    submitBtn.textContent = '保存';
    topicEl.value = existingDebate.topic || '';
    debateState.pickedModelSlugs = new Set(existingDebate.model_slugs || []);
  } else {
    title.textContent = '新议论';
    submitBtn.textContent = '创建议论';
    topicEl.value = '';
    // Pre-pick all enabled models for first-run convenience
    debateState.pickedModelSlugs = new Set(
      debateState.providerModels.filter(m => m.enabled).map(m => m.slug)
    );
  }

  renderDebateModalModels();
  document.getElementById('debate-modal').style.display = 'flex';
}

function renderDebateModalModels() {
  const root = document.getElementById('debate-modal-models');
  if (!root) return;
  if (debateState.providerModels.length === 0) {
    root.innerHTML = '<div style="padding:14px;color:var(--text-4);font-size:12.5px;text-align:center">还没有模型，先去「你」tab 添加。</div>';
    return;
  }
  root.innerHTML = debateState.providerModels.map(m => {
    const checked = debateState.pickedModelSlugs.has(m.slug) ? 'checked' : '';
    return `
      <label class="model-picker-row">
        <input type="checkbox" data-slug="${esc(m.slug)}" ${checked}>
        <span class="mp-name">${esc(m.display_name)}</span>
        <span class="mp-slug">${esc(m.slug)}</span>
        <span class="mp-provider">${esc(m.provider)}</span>
      </label>
    `;
  }).join('');
  root.querySelectorAll('input[type="checkbox"]').forEach(cb => {
    cb.addEventListener('change', () => {
      const slug = cb.dataset.slug;
      if (cb.checked) debateState.pickedModelSlugs.add(slug);
      else debateState.pickedModelSlugs.delete(slug);
    });
  });
}

function closeDebateModal(e) {
  if (e && e.target.id !== 'debate-modal') return;
  document.getElementById('debate-modal').style.display = 'none';
}

async function submitDebateModal() {
  const slugs = Array.from(debateState.pickedModelSlugs);
  if (slugs.length < 2) {
    alert('至少勾两个模型');
    return;
  }
  const topic = document.getElementById('debate-modal-topic').value.trim();

  if (debateState.modalMode === 'edit' && debateState.currentDebate) {
    // For Phase 1 edit just deletes & recreates; keep simple.
    alert('暂不支持编辑现有议论，请新建一场');
    return;
  }

  try {
    const res = await fetch('/api/debate/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        topic: topic || null,
        modelSlugs: slugs,
      }),
    });
    const data = await res.json();
    if (!data?.id) {
      alert('创建失败：' + (data?.error ?? 'unknown'));
      return;
    }
    closeDebateModal();
    await loadDebateConversations();
    renderConvList();
    selectDebateConv(data.id);
  } catch (e) {
    alert('创建失败: ' + e.message);
  }
}

function openDebateEditor() {
  if (!debateState.currentDebate) return;
  openDebateModal('edit', debateState.currentDebate);
}

// ── Debate SSE ──

function connectDebateEvents() {
  if (debateState.es) return;
  debateState.es = new EventSource('/api/debate/events');
  debateState.es.addEventListener('log', (e) => {
    try {
      const data = JSON.parse(e.data);
      if (data.conversationId === state.currentConversationId) {
        if (data.kind === 'error') setDebateStatus(`⚠️ ${data.content}`);
        else setDebateStatus(data.content);
      }
    } catch {}
  });
  debateState.es.addEventListener('done', (e) => {
    try {
      const data = JSON.parse(e.data);
      const btn = document.getElementById('debate-round-btn');
      if (state.currentConversationId === data.conversationId) {
        if (btn) { btn.disabled = false; btn.classList.remove('busy'); }
        setDebateStatus(`Round ${data.round} 完成 · ${data.delivered} 条`);
        // Refresh round counter on the current debate
        if (debateState.currentDebate) {
          debateState.currentDebate.round_count_debate = data.round;
          updateDebateHeader();
        }
      }
      // Refresh sidebar list to update round counts
      if (state.currentTab === 'debate') {
        loadDebateConversations().then(renderConvList);
      }
    } catch {}
  });
  debateState.es.onerror = () => { /* EventSource auto-reconnects */ };
}

// ── Hooks into the existing app shell ──

// Patch loadConversations: route debate tab to its own endpoint.
const __origLoadConversations = loadConversations;
loadConversations = async function() {
  if (state.currentTab === 'debate') {
    await loadDebateConversations();
    return;
  }
  return __origLoadConversations();
};

// Patch renderConvList: render debate items differently.
const __origRenderConvList = renderConvList;
renderConvList = function() {
  if (state.currentTab !== 'debate') return __origRenderConvList();
  const list = document.getElementById('conv-list');
  list.innerHTML = '';
  const convs = state.conversations;
  if (convs.length === 0) {
    list.innerHTML = '<div class="conv-empty">还没有议论<br>点上面「新对话」开启</div>';
    return;
  }
  for (const c of convs) list.appendChild(renderDebateConvItem(c));
};

// Patch onNewChatClick: open the debate modal instead.
const __origOnNewChatClick = onNewChatClick;
onNewChatClick = function(e) {
  if (state.currentTab === 'debate') {
    if (e) e.stopPropagation();
    openDebateModal('create');
    return;
  }
  return __origOnNewChatClick(e);
};

// Patch selectConversation: route debate convs to selectDebateConv.
const __origSelectConversation = selectConversation;
selectConversation = function(convId) {
  if (state.currentTab === 'debate') {
    selectDebateConv(convId);
    return;
  }
  __origSelectConversation(convId);
};

// Patch handleWsMessage so debate messages land in the debate view.
const __origHandleWsMessage = handleWsMessage;
handleWsMessage = function(msg) {
  const kind = msg?.metadata?.sender_kind;
  if (kind === 'debater' || kind === 'clarify') {
    if (msg.conversationId === state.currentConversationId && state.currentTab === 'debate') {
      appendDebateMessage({
        sender_type: kind === 'clarify' ? 'user' : 'debater',
        sender_id: msg.metadata?.slug ?? '',
        content: msg.content,
        metadata: msg.metadata,
      });
      scrollDebateToBottom();
    }
    return;
  }
  return __origHandleWsMessage(msg);
};

// Kick off SSE on page load; the connection is cheap and lets the debate view
// react to round-done even when the user opens the tab later.
connectDebateEvents();


// ──────────────────────────────────────────────────────────────────────────
//  画像 (Portrait) — pick a source 消息 conv, generate 5 imagined-asset kinds
// ──────────────────────────────────────────────────────────────────────────

const PORTRAIT_KINDS = ['moments', 'memos', 'schedule', 'alarms', 'bills'];
const PORTRAIT_KIND_LABELS = {
  moments: '朋友圈',
  memos: '备忘录',
  schedule: '日程',
  alarms: '闹钟',
  bills: '账单',
};

const portraitState = {
  current: null,            // hydrated portrait conv (with portraits[])
  busyKinds: new Set(),     // kinds currently generating
};

async function loadPortraitConversations() {
  try {
    const res = await fetch(`/api/portrait/conversations?userId=${encodeURIComponent(state.userId)}`);
    state.convsByTab.portrait = await res.json();
    if (!Array.isArray(state.convsByTab.portrait)) state.convsByTab.portrait = [];
  } catch (e) {
    console.error('load portrait convs error:', e);
    state.convsByTab.portrait = [];
  }
}

function renderPortraitConvItem(conv) {
  const el = document.createElement('div');
  el.className = 'conv-item';
  el.dataset.convId = conv.id;
  if (conv.id === state.currentConversationId) el.classList.add('active');
  const kindBadges = (conv.kinds ?? []).map(k =>
    `<span class="conv-model-dot" style="background:${kindColor(k)}" title="${esc(PORTRAIT_KIND_LABELS[k] ?? k)}"></span>`
  ).join('');
  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(conv.title || '画像')}</span>
      <span class="conv-debate-meta">${kindBadges} <span>· ${conv.portrait_count ?? 0} 项</span></span>
    </span>
    <span class="conv-actions">
      <button title="删除" class="danger" data-act="delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>
        </svg>
      </button>
    </span>
  `;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'delete') deletePortraitConv(conv.id);
      return;
    }
    selectPortraitConv(conv.id);
  });
  return el;
}

function kindColor(kind) {
  return ({
    moments:  '#3b82f6',
    memos:    '#f59e0b',
    schedule: '#10b981',
    alarms:   '#ef4444',
    bills:    '#8b5cf6',
  })[kind] ?? '#64748b';
}

async function selectPortraitConv(convId) {
  state.currentConversationId = convId;
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  document.getElementById('empty-state').style.display = 'none';
  document.getElementById('placeholder-view').style.display = 'none';
  document.getElementById('me-view').style.display = 'none';
  document.getElementById('chat-view').style.display = 'none';
  document.getElementById('debate-view').style.display = 'none';
  document.getElementById('portrait-view').style.display = 'flex';

  try {
    const res = await fetch(`/api/portrait/conversations/${convId}`);
    portraitState.current = await res.json();
  } catch {
    portraitState.current = null;
  }

  // Load chat thread
  try {
    const res = await fetch(`/api/portrait/conversations/${convId}/messages`);
    portraitState.current.messages = await res.json();
  } catch {
    portraitState.current.messages = [];
  }

  renderPortraitView();
}

function renderPortraitView() {
  const d = portraitState.current;
  const title = document.getElementById('portrait-title');
  const meta = document.getElementById('portrait-meta');
  if (!d) {
    title.textContent = '画像';
    meta.textContent = '';
    return;
  }
  title.textContent = d.title || '画像';
  meta.textContent = `源会话 · ${d.sourceConversationId?.slice(0, 8) ?? '—'} · 已生成 ${(d.portraits ?? []).length} 项`;

  // Re-bind the kind buttons to the active conv
  document.querySelectorAll('.portrait-kind-btn').forEach(btn => {
    btn.onclick = () => generatePortraitOfKind(btn.dataset.kind);
    btn.classList.toggle('busy', portraitState.busyKinds.has(btn.dataset.kind));
  });

  // Feed: each existing portrait gets a section (most recent first per kind)
  const feed = document.getElementById('portrait-feed');
  feed.innerHTML = '';
  const portraits = d.portraits ?? [];
  if (portraits.length === 0) {
    feed.innerHTML = '<div class="conv-empty" style="padding:32px 0">还没有生成任何画像 — 点上面任一卡片来生成</div>';
  } else {
    for (const p of portraits) feed.appendChild(renderPortraitSection(p));
  }

  // Chat thread
  const thread = document.createElement('div');
  thread.className = 'portrait-chat-thread';
  for (const m of (d.messages ?? [])) {
    const b = document.createElement('div');
    b.className = `portrait-chat-bubble ${m.sender_type === 'user' ? 'user' : 'bot'}`;
    b.textContent = m.content;
    thread.appendChild(b);
  }
  feed.appendChild(thread);
}

function renderPortraitSection(p) {
  const sec = document.createElement('div');
  sec.className = 'portrait-section';
  const items = (p.content?.items) ?? [];
  const head = document.createElement('div');
  head.className = 'portrait-section-head';
  head.innerHTML = `
    <span style="display:inline-block;width:8px;height:8px;border-radius:50%;background:${kindColor(p.kind)}"></span>
    <span>${esc(PORTRAIT_KIND_LABELS[p.kind] ?? p.kind)}</span>
    <span class="ps-when">${esc(new Date(p.created_at * 1000).toLocaleString())}</span>
    <button data-pid="${esc(p.id)}" data-act="regen">重新生成</button>
    <button data-pid="${esc(p.id)}" data-act="del">删除</button>
  `;
  head.querySelectorAll('button').forEach(btn => {
    btn.addEventListener('click', () => {
      if (btn.dataset.act === 'regen') generatePortraitOfKind(p.kind);
      else if (btn.dataset.act === 'del') deletePortraitAsset(btn.dataset.pid);
    });
  });
  sec.appendChild(head);

  if (p.kind === 'moments') {
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'pi-card';
      let html = `
        <div class="pi-when">${esc(it.posted_relative ?? '')}</div>
        <div class="pi-text">${esc(it.text ?? '')}</div>
      `;
      if (it.image_prompt) {
        html += `<div class="pi-img-placeholder">[配图：${esc(it.image_prompt)}]</div>`;
      }
      if (Array.isArray(it.comments) && it.comments.length > 0) {
        html += `<div class="pi-comments">` + it.comments.map(c =>
          `<div><span class="pi-comment-author">${esc(c.author ?? '')}</span>：${esc(c.text ?? '')}</div>`
        ).join('') + `</div>`;
      }
      if (it.ai_note) html += `<div class="pi-ai-note">— AI 备注：${esc(it.ai_note)}</div>`;
      card.innerHTML = html;
      sec.appendChild(card);
    }
  } else if (p.kind === 'memos') {
    for (const it of items) {
      const card = document.createElement('div');
      card.className = 'pi-memo';
      let html = `
        ${it.title ? `<div class="pi-memo-title">${esc(it.title)}</div>` : ''}
        <div class="pi-text">${esc(it.body ?? '')}</div>
        ${it.posted_relative ? `<div class="pi-when">${esc(it.posted_relative)}</div>` : ''}
      `;
      if (it.image_prompt) html += `<div class="pi-img-placeholder">[图：${esc(it.image_prompt)}]</div>`;
      if (it.ai_note) html += `<div class="pi-ai-note">— ${esc(it.ai_note)}</div>`;
      card.innerHTML = html;
      sec.appendChild(card);
    }
  } else if (p.kind === 'schedule') {
    const wrap = document.createElement('div');
    wrap.style = 'border:1px solid var(--border-light); border-radius:8px; overflow:hidden;';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = 'pi-row';
      row.innerHTML = `
        <span class="pi-when">${esc(it.day ?? '')} ${esc(it.when ?? '')}</span>
        <span class="pi-title">${esc(it.title ?? '')}${it.details ? ` · <span class="pi-extra">${esc(it.details)}</span>` : ''}</span>
      `;
      wrap.appendChild(row);
    }
    sec.appendChild(wrap);
  } else if (p.kind === 'alarms') {
    const wrap = document.createElement('div');
    wrap.style = 'border:1px solid var(--border-light); border-radius:8px; overflow:hidden;';
    for (const it of items) {
      const row = document.createElement('div');
      row.className = `pi-row ${it.enabled === false ? 'disabled' : ''}`;
      row.innerHTML = `
        <span class="pi-time">${esc(it.time ?? '')}</span>
        <span class="pi-title">${esc(it.label ?? '')}</span>
        <span class="pi-extra">${esc(it.repeat ?? '一次性')}</span>
        <span class="pi-toggle"></span>
      `;
      wrap.appendChild(row);
    }
    sec.appendChild(wrap);
  } else if (p.kind === 'bills') {
    const table = document.createElement('table');
    table.className = 'pi-bills-table';
    table.innerHTML = `<thead><tr><th>日期</th><th>商家</th><th>类别</th><th class="pi-amount">金额</th></tr></thead>`;
    const tbody = document.createElement('tbody');
    for (const it of items) {
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td>${esc(it.date ?? '')}</td>
        <td>${esc(it.merchant ?? '')}${it.note ? ` · <span style="color:var(--text-4);font-size:11px">${esc(it.note)}</span>` : ''}</td>
        <td><span class="pi-cat">${esc(it.category ?? '其它')}</span></td>
        <td class="pi-amount">${esc(it.amount ?? '')}</td>
      `;
      tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    sec.appendChild(table);
  }

  return sec;
}

async function generatePortraitOfKind(kind) {
  if (!PORTRAIT_KINDS.includes(kind)) return;
  if (!state.currentConversationId) return;
  if (portraitState.busyKinds.has(kind)) return;

  portraitState.busyKinds.add(kind);
  document.querySelectorAll('.portrait-kind-btn').forEach(btn => {
    if (btn.dataset.kind === kind) btn.classList.add('busy');
  });

  const withImage = !!document.getElementById('portrait-with-image').checked;

  try {
    const res = await fetch(`/api/portrait/generate/${state.currentConversationId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind, withImage }),
    });
    const data = await res.json();
    if (data.error) {
      alert('生成失败：' + data.error);
    } else {
      // Refresh the portrait view from the server (drops the placeholder)
      await selectPortraitConv(state.currentConversationId);
    }
  } catch (e) {
    alert('生成失败：' + e.message);
  } finally {
    portraitState.busyKinds.delete(kind);
    document.querySelectorAll('.portrait-kind-btn').forEach(btn => {
      if (btn.dataset.kind === kind) btn.classList.remove('busy');
    });
  }
}

async function deletePortraitAsset(portraitId) {
  if (!confirm('删除这一组画像？')) return;
  try {
    await fetch(`/api/portrait/portraits/${portraitId}`, { method: 'DELETE' });
    if (state.currentConversationId) await selectPortraitConv(state.currentConversationId);
  } catch (e) { alert('删除失败：' + e.message); }
}

async function deletePortraitConv(convId) {
  if (!confirm('删除这个画像会话（含所有生成的画像）？')) return;
  try {
    await fetch(`/api/portrait/conversations/${convId}`, { method: 'DELETE' });
    state.convsByTab.portrait = state.convsByTab.portrait.filter(c => c.id !== convId);
    if (state.currentConversationId === convId) {
      state.currentConversationId = null;
      applyTabView();
    }
    renderConvList();
  } catch (e) { alert('删除失败: ' + e.message); }
}

function deleteCurrentPortrait() {
  if (state.currentConversationId) deletePortraitConv(state.currentConversationId);
}

async function sendPortraitChat() {
  const convId = state.currentConversationId;
  if (!convId) return;
  const input = document.getElementById('portrait-chat-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  const btn = document.getElementById('portrait-chat-send');
  btn.disabled = true;
  try {
    const res = await fetch(`/api/portrait/chat/${convId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    const data = await res.json();
    if (data.error) {
      alert('出错：' + data.error);
    } else {
      // Append both user + reply to the local thread
      portraitState.current.messages = portraitState.current.messages ?? [];
      portraitState.current.messages.push({ sender_type: 'user', content });
      portraitState.current.messages.push({ sender_type: 'bot', content: data.reply });
      renderPortraitView();
    }
  } catch (e) {
    alert('出错：' + e.message);
  } finally {
    btn.disabled = false;
  }
}

// ── Source-pick modal (new portrait conv) ──

async function openPortraitModal() {
  const list = document.getElementById('portrait-source-list');
  list.innerHTML = '<div style="padding:14px;color:var(--text-4);font-size:12px">加载中…</div>';
  document.getElementById('portrait-modal').style.display = 'flex';

  try {
    const res = await fetch(`/api/portrait/sources?userId=${encodeURIComponent(state.userId)}`);
    const sources = await res.json();
    if (!Array.isArray(sources) || sources.length === 0) {
      list.innerHTML = '<div style="padding:20px;color:var(--text-4);font-size:12.5px;text-align:center">还没有任何消息会话 — 先去「消息」聊几句。</div>';
      return;
    }
    list.innerHTML = '';
    for (const conv of sources) {
      const row = document.createElement('div');
      row.className = 'source-list-row';
      row.innerHTML = `
        <span class="sl-title">${esc(conv.title || '新对话')}</span>
        <span class="sl-meta">${conv.round_count ?? 0} 轮 · ${relTime(conv.last_activity_at)}</span>
      `;
      row.addEventListener('click', () => createPortraitConv(conv.id));
      list.appendChild(row);
    }
  } catch (e) {
    list.innerHTML = `<div style="padding:14px;color:var(--text-4)">加载失败：${esc(e.message)}</div>`;
  }
}

function closePortraitModal(e) {
  if (e && e.target.id !== 'portrait-modal') return;
  document.getElementById('portrait-modal').style.display = 'none';
}

async function createPortraitConv(sourceConversationId) {
  try {
    const res = await fetch('/api/portrait/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId,
        sourceConversationId,
      }),
    });
    const data = await res.json();
    if (!data?.id) {
      alert('创建失败：' + (data?.error ?? 'unknown'));
      return;
    }
    closePortraitModal();
    await loadPortraitConversations();
    renderConvList();
    selectPortraitConv(data.id);
  } catch (e) { alert('创建失败：' + e.message); }
}

// ── Hooks into the existing app shell ──

const __origLoadConversations2 = loadConversations;
loadConversations = async function() {
  if (state.currentTab === 'portrait') { await loadPortraitConversations(); return; }
  return __origLoadConversations2();
};

const __origRenderConvList2 = renderConvList;
renderConvList = function() {
  if (state.currentTab !== 'portrait') return __origRenderConvList2();
  const list = document.getElementById('conv-list');
  list.innerHTML = '';
  const convs = state.conversations;
  if (convs.length === 0) {
    list.innerHTML = '<div class="conv-empty">还没有画像<br>点上面「新对话」选个源会话</div>';
    return;
  }
  for (const c of convs) list.appendChild(renderPortraitConvItem(c));
};

const __origOnNewChatClick2 = onNewChatClick;
onNewChatClick = function(e) {
  if (state.currentTab === 'portrait') {
    if (e) e.stopPropagation();
    openPortraitModal();
    return;
  }
  return __origOnNewChatClick2(e);
};

const __origSelectConversation2 = selectConversation;
selectConversation = function(convId) {
  if (state.currentTab === 'portrait') { selectPortraitConv(convId); return; }
  __origSelectConversation2(convId);
};

// Patch applyTabView so portrait tab opens the portrait-view rather than the
// generic placeholder.
const __origApplyTabView = applyTabView;
applyTabView = function() {
  if (state.currentTab === 'portrait') {
    const empty = document.getElementById('empty-state');
    document.getElementById('chat-view').style.display = 'none';
    document.getElementById('debate-view').style.display = 'none';
    document.getElementById('placeholder-view').style.display = 'none';
    document.getElementById('me-view').style.display = 'none';
    if (state.currentConversationId) {
      empty.style.display = 'none';
      document.getElementById('portrait-view').style.display = 'flex';
    } else {
      document.getElementById('portrait-view').style.display = 'none';
      empty.style.display = 'flex';
      const txt = document.getElementById('empty-state-text');
      if (txt) txt.textContent = '点「新对话」选源会话生成画像';
    }
    return;
  }
  // Hide portrait-view when leaving the tab
  document.getElementById('portrait-view').style.display = 'none';

  if (state.currentTab === 'me') {
    document.getElementById('chat-view').style.display = 'none';
    document.getElementById('debate-view').style.display = 'none';
    document.getElementById('portrait-view').style.display = 'none';
    document.getElementById('placeholder-view').style.display = 'none';
    document.getElementById('empty-state').style.display = 'none';
    document.getElementById('me-view').style.display = 'flex';
    loadMeView();
    return;
  }
  return __origApplyTabView();
};


// ──────────────────────────────────────────────────────────────────────────
//  「你」 tab — basic info + AI picks + provider models
// ──────────────────────────────────────────────────────────────────────────

async function loadMeView() {
  await Promise.all([loadMyProfile(), loadMyPicks(), loadMeProviderModels()]);
}

async function loadMyProfile() {
  try {
    const res = await fetch(`/api/me/profile?userId=${encodeURIComponent(state.userId)}`);
    const p = await res.json();
    document.getElementById('me-display-name').value = p.display_name ?? '';
    document.getElementById('me-bio').value = p.bio ?? '';
  } catch (e) { /* ignore */ }
}

async function saveMyProfile() {
  const displayName = document.getElementById('me-display-name').value.trim();
  const bio = document.getElementById('me-bio').value.trim();
  const btn = document.getElementById('me-save-profile');
  btn.disabled = true;
  try {
    await fetch('/api/me/profile', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, displayName, bio }),
    });
    const saved = document.getElementById('me-profile-saved');
    saved.hidden = false;
    setTimeout(() => { saved.hidden = true; }, 1800);
  } catch (e) { alert('保存失败：' + e.message); }
  finally { btn.disabled = false; }
}

async function loadMyPicks() {
  const root = document.getElementById('me-picks-list');
  root.innerHTML = '<div style="color:var(--text-4);font-size:12px;padding:8px 0">加载中…</div>';
  try {
    const res = await fetch(`/api/me/picks?userId=${encodeURIComponent(state.userId)}`);
    const picks = await res.json();
    if (!Array.isArray(picks) || picks.length === 0) {
      root.innerHTML = '<div style="color:var(--text-4);font-size:12px;padding:14px 0">还没有 AI 收藏</div>';
      return;
    }
    root.innerHTML = '';
    for (const p of picks) {
      const card = document.createElement('div');
      card.className = 'pick-card';
      const titleHtml = p.url
        ? `<a href="${esc(p.url)}" target="_blank" rel="noopener">${esc(p.title)}</a>`
        : esc(p.title);
      const when = new Date(p.picked_at * 1000).toLocaleString();
      const by = p.picked_by_bot_id
        ? `${esc(p.picked_by_bot_id)} 收藏`
        : '手动添加';
      card.innerHTML = `
        <button class="pick-remove" data-id="${esc(p.id)}">×</button>
        <div class="pick-title">${titleHtml}</div>
        ${p.summary ? `<div class="pick-summary">${esc(p.summary)}</div>` : ''}
        <div class="pick-meta">${esc(by)} · ${esc(when)}</div>
        ${p.why_picked ? `<div class="pick-why">${esc(p.why_picked)}</div>` : ''}
      `;
      card.querySelector('.pick-remove').addEventListener('click', () => removePick(p.id));
      root.appendChild(card);
    }
  } catch (e) {
    root.innerHTML = `<div style="color:var(--red);font-size:12px;padding:8px 0">加载失败：${esc(e.message)}</div>`;
  }
}

async function addManualPick() {
  const title = document.getElementById('me-pick-title').value.trim();
  if (!title) return;
  const url = document.getElementById('me-pick-url').value.trim();
  const summary = document.getElementById('me-pick-summary').value.trim();
  try {
    await fetch('/api/me/picks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        userId: state.userId, title,
        url: url || undefined,
        summary: summary || undefined,
      }),
    });
    document.getElementById('me-pick-title').value = '';
    document.getElementById('me-pick-url').value = '';
    document.getElementById('me-pick-summary').value = '';
    loadMyPicks();
  } catch (e) { alert('添加失败：' + e.message); }
}

async function removePick(id) {
  try {
    await fetch(`/api/me/picks/${id}`, { method: 'DELETE' });
    loadMyPicks();
  } catch (e) { alert('删除失败：' + e.message); }
}

async function loadMeProviderModels() {
  const root = document.getElementById('me-provider-models');
  root.innerHTML = '<div style="color:var(--text-4);font-size:12px;padding:14px;text-align:center">加载中…</div>';
  try {
    const res = await fetch('/api/me/provider-models');
    const list = await res.json();
    debateState.providerModels = list;
    if (!Array.isArray(list) || list.length === 0) {
      root.innerHTML = '<div style="color:var(--text-4);font-size:12px;padding:14px;text-align:center">还没添加任何模型</div>';
      return;
    }
    root.innerHTML = '';
    for (const m of list) {
      const row = document.createElement('div');
      row.className = 'model-picker-row';
      row.innerHTML = `
        <input type="checkbox" data-id="${esc(m.id)}" ${m.enabled ? 'checked' : ''}>
        <span class="mp-name">${esc(m.display_name)}</span>
        <span class="mp-slug">${esc(m.slug)}</span>
        <span class="mp-provider">${esc(m.provider)}</span>
        <button class="pick-remove" data-id="${esc(m.id)}" title="删除">×</button>
      `;
      row.querySelector('input').addEventListener('change', (e) => {
        toggleProviderModel(m.id, e.target.checked);
      });
      row.querySelector('button.pick-remove').addEventListener('click', () => {
        removeProviderModel(m.id);
      });
      root.appendChild(row);
    }
  } catch (e) {
    root.innerHTML = `<div style="color:var(--red);font-size:12px;padding:14px">${esc(e.message)}</div>`;
  }
}

async function addProviderModel() {
  const provider = document.getElementById('me-new-provider').value.trim();
  const slug = document.getElementById('me-new-slug').value.trim();
  const displayName = document.getElementById('me-new-name').value.trim();
  if (!slug || !displayName) {
    alert('slug 和显示名都要填');
    return;
  }
  try {
    const res = await fetch('/api/me/provider-models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ provider, slug, displayName }),
    });
    const data = await res.json();
    if (data.error) { alert(data.error); return; }
    document.getElementById('me-new-provider').value = '';
    document.getElementById('me-new-slug').value = '';
    document.getElementById('me-new-name').value = '';
    loadMeProviderModels();
  } catch (e) { alert('添加失败：' + e.message); }
}

async function toggleProviderModel(id, enabled) {
  try {
    await fetch(`/api/me/provider-models/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
  } catch (e) { /* ignore */ }
}

async function removeProviderModel(id) {
  if (!confirm('删除这个模型？')) return;
  try {
    await fetch(`/api/me/provider-models/${id}`, { method: 'DELETE' });
    loadMeProviderModels();
  } catch (e) { alert('删除失败：' + e.message); }
}
