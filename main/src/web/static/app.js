// PendingBot Web Client — multi-conversation
//
// Architecture:
//   The app shell (sidebar conv-list + main work area) is generic. Every tab
//   plugs into TAB_REGISTRY with its own load / render / select / new-chat /
//   ws-handler hooks. The six dispatch functions below (loadConversations,
//   renderConvList, onNewChatClick, selectConversation, handleWsMessage,
//   applyTabView) are the only shell-level entry points; they delegate to
//   whatever the current tab registered.
//
// To add a tab: define its functions, register a TAB_REGISTRY entry at the
// bottom of its section, add a button in index.html.

// 画像 lost its top-level rail button in v2 — folded into 「我」 because
// most of its UX is "stuff about you" (memos / schedule / bills / etc.).
// The tab id stays in FEATURE_TABS so switchTab('portrait') from inside
// 「我」 still works and the existing portrait view code is untouched —
// only the rail entrypoint moved.
const FEATURE_TABS = ['message', 'debate', 'surf', 'review', 'me', 'portrait', 'keys'];

const TAB_LABELS = {
  message:  '消息',
  debate:   '议论',
  surf:     '冲浪',
  review:   '回顾',
  me:       '我',
  portrait: '画像',
  keys:     '钥匙',
};

// Each tab registers itself at the bottom of its section. Shape:
//   loadConvs?:        async () => void
//   renderItem?:       (conv) => HTMLElement
//   onNewChat?:        (e) => void           — what "新对话" triggers
//   selectConv?:       (convId) => void      — what clicking a list item does
//   wsHandler?:        (msg) => boolean      — return true to mark consumed
//   view:              string                — id-suffix in <main> (e.g. 'chat')
//   emptyHint:         string                — conv-list empty placeholder
//   emptyHintNoSel:    string                — main-area empty-state text
//   onActivate?:       () => void            — fired when tab becomes active
//   alwaysShowView?:   bool                  — always show `view` even with no convId
const TAB_REGISTRY = {};

const state = {
  userId: null,        // populated from /api/me after auth
  displayName: '',
  isAdmin: false,
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
  // Keys here are SURF conv ids, not message conv ids — the surf-tab list
  // uses this to badge running runs.
  activeSurfs: new Set(),
  // Message conv ids that currently have a surf bound to them as source —
  // drives the chat-header surf button busy indicator.
  surfingFromMessage: new Set(),
  pendingReviews: new Set(),
  reviewingFromMessage: new Set(),
  surfES: null,
  reviewES: null,
  // Conversations currently showing a bot "正在输入" indicator. Server sends
  // `bot_typing {active}` events; the header label only renders on the visible
  // conversation, but we track all so it resumes on conv switch.
  typingConvs: new Set(),
};

const ACCEPTED_IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/gif', 'image/webp'];
const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;

// All API calls reuse the same fetch wrapper so the pb_session cookie rides
// along automatically. Centralising it also gives us a single place to peel
// off 401 responses → re-render the login screen.
const fetchOpts = (extra) => ({ credentials: 'include', ...(extra || {}) });
const _origFetch = window.fetch.bind(window);
window.fetch = (input, init) => _origFetch(input, fetchOpts(init));

bootAuth();

async function bootAuth() {
  // If the URL carries an invite token (?invite=…) — usually because the
  // server redirected /i/<token> here — surface the redeem form pre-filled.
  const params = new URLSearchParams(location.search);
  const inviteToken = params.get('invite');

  let me = null;
  try {
    const r = await fetch('/api/me');
    if (r.ok) me = await r.json();
  } catch {}

  if (me && me.user_id) {
    state.userId = me.user_id;
    state.displayName = me.display_name;
    state.isAdmin = !!me.is_admin;
    init();
    return;
  }

  renderLoginScreen(inviteToken);
}

function renderLoginScreen(prefillToken) {
  document.body.innerHTML = `
    <div class="login-shell">
      <form id="login-form" class="login-card">
        <h1>进入 PendingBot</h1>
        <p>凭管理员发的邀请链接进入。token 会自动从 URL 读取，也可以手动粘贴。</p>
        <label>邀请 token</label>
        <input id="login-token" required value="${prefillToken ? esc(prefillToken) : ''}">
        <label>叫你什么</label>
        <input id="login-name" required maxlength="40" placeholder="比如：阿橙">
        <button type="submit" class="btn-primary login-submit">进入</button>
        <div id="login-error" class="login-error"></div>
      </form>
    </div>`;
  document.getElementById('login-form').addEventListener('submit', async (e) => {
    e.preventDefault();
    const token = document.getElementById('login-token').value.trim();
    const displayName = document.getElementById('login-name').value.trim();
    const errEl = document.getElementById('login-error');
    errEl.textContent = '';
    try {
      const r = await fetch('/api/invites/redeem', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token, displayName }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        errEl.textContent = j.error || `兑换失败 (${r.status})`;
        return;
      }
      // Cookie is set by the server response; reload to drop the ?invite=
      // and let bootAuth() take the happy path.
      location.replace(location.pathname);
    } catch (err) {
      errEl.textContent = String(err);
    }
  });
}

function generateId() {
  return 'u_' + Math.random().toString(36).slice(2, 10);
}

// Sugar: the active tab's conversation list. Many call sites still want the
// "current" view of conversations without caring about feature partitioning.
Object.defineProperty(state, 'conversations', {
  get() { return state.convsByTab[state.currentTab] || []; },
  set(v) { state.convsByTab[state.currentTab] = v; },
});

// ── Utilities ──────────────────────────────────────────────────────────

function esc(s) {
  const d = document.createElement('div');
  d.textContent = s ?? '';
  return d.innerHTML;
}

// Modal close: collapses the previous closeXxxModal helpers. If `e` is given,
// only close when the click hit the overlay backdrop (not the card).
function closeModal(modalId, e) {
  if (e && e.target.id !== modalId) return;
  const el = document.getElementById(modalId);
  if (el) el.style.display = 'none';
}

// Legacy helper: used to embed ?userId= in GET URLs. Auth is now cookie-
// based, so it returns "" — call sites that string-concat it keep working
// without churn. Remove when no longer referenced.
function userParam() { return ''; }

const STATUS_LABELS = {
  pending: '待运行',
  running: '运行中',
  done:    '完成',
  error:   '出错',
  aborted: '中断',
};
function statusLabel(status, active) {
  if (active) return '运行中';
  return STATUS_LABELS[status] ?? status;
}

// Mounts a model picker into `host` once; subsequent calls just reset the
// value. Replaces 4 copy-pasted "if !mounted then create else setValue" blocks.
function ensureModelPicker(host, opts) {
  if (!host) return null;
  if (host.firstChild && host.firstChild.setValue) {
    host.firstChild.setValue(opts.value ?? '');
    return host.firstChild;
  }
  host.innerHTML = '';
  const picker = createModelPicker(opts);
  host.appendChild(picker);
  return picker;
}

// Renders a vanilla conv-list. Replaces the 5 near-identical "list.innerHTML
// = empty hint else forEach renderItem" blocks.
function renderConvListInto(items, emptyHint, renderItem) {
  const list = document.getElementById('conv-list');
  if (!list) return;
  list.innerHTML = '';
  if (!items || items.length === 0) {
    list.innerHTML = `<div class="conv-empty">${esc(emptyHint).replace(/\n/g, '<br>')}</div>`;
    return;
  }
  for (const c of items) list.appendChild(renderItem(c));
}

// Renders a "pick a source 消息 conversation" picker — used by surf / review
// / portrait modals. `onPick(convId|'')` fires on each selection change.
function renderSourcePicker(host, sources, opts) {
  if (!host) return;
  host.innerHTML = '';
  const select = (row, id) => {
    host.querySelectorAll('.source-list-row').forEach(r => r.classList.remove('selected'));
    row.classList.add('selected');
    if (opts.onPick) opts.onPick(id);
  };
  if (opts.withNoneRow) {
    const noneRow = document.createElement('div');
    noneRow.className = 'source-list-row selected';
    noneRow.innerHTML =
      `<span class="sl-title">${esc(opts.noneLabel || '— 不绑定 —')}</span>` +
      (opts.noneHint ? `<span class="sl-meta">${esc(opts.noneHint)}</span>` : '');
    noneRow.addEventListener('click', () => select(noneRow, ''));
    host.appendChild(noneRow);
  }
  if (Array.isArray(sources)) {
    for (const conv of sources) {
      const row = document.createElement('div');
      row.className = 'source-list-row';
      row.innerHTML = `
        <span class="sl-title">${esc(conv.title || '新对话')}</span>
        <span class="sl-meta">${conv.round_count ?? 0} 轮 · ${esc(relTime(conv.last_activity_at))}</span>
      `;
      row.addEventListener('click', () => select(row, conv.id));
      host.appendChild(row);
    }
  }
}

// Find a conv-list row by id without relying on an attribute selector (CSS
// selectors choke on ids that contain quotes or special chars).
function findConvItem(convId) {
  const list = document.getElementById('conv-list');
  if (!list) return null;
  for (const el of list.querySelectorAll('.conv-item')) {
    if (el.dataset.convId === convId) return el;
  }
  return null;
}

// ── Init / tab dispatch ────────────────────────────────────────────────

async function init() {
  // Admin-gated rail buttons. Hidden for non-admin so they don't see a
  // 403-on-click. The endpoints themselves still enforce admin server-side.
  if (state.isAdmin) {
    const adminBtn = document.getElementById('rail-admin-btn');
    if (adminBtn) adminBtn.hidden = false;
  }
  await loadBots();
  setupFeatureTabs();
  await loadConversations();
  renderBotFilter();
  renderConvList();
  updateNewChatLabel();
  applyTabView();
  // Auto-select most recent conversation in the active tab (only meaningful
  // for the message tab; other tabs need a modal first).
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
  for (const btn of document.querySelectorAll('.rail-tab')) {
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
  for (const btn of document.querySelectorAll('.rail-tab')) {
    btn.classList.toggle('active', btn.dataset.tab === tabId);
  }
  await loadConversations();
  renderBotFilter();
  renderConvList();
  updateNewChatLabel();
  applyTabView();
}

// Decide which view in <main> is visible based on the current tab and whether
// a conversation is selected. Replaces 6 different `applyTabView` patches that
// each manually toggled all 6 view elements via inline style.
function applyTabView() {
  const tab = state.currentTab;
  const cfg = TAB_REGISTRY[tab];
  document.getElementById('app').dataset.activeTab = tab;

  const titleEl = document.getElementById('sidebar-title');
  if (titleEl) titleEl.textContent = TAB_LABELS[tab] || '';

  let view;
  if (cfg?.alwaysShowView) {
    view = cfg.view;
  } else if (state.currentConversationId && cfg?.view) {
    view = cfg.view;
  } else {
    view = 'empty';
    const text = document.getElementById('empty-state-text');
    if (text) text.textContent = cfg?.emptyHintNoSel ?? '选个对话，或者开个新的';
  }
  document.getElementById('main').dataset.activeView = view;

  if (cfg?.onActivate) cfg.onActivate();
}

// Tab-aware dispatchers. Each tab supplies its own implementation via
// TAB_REGISTRY; the message tab's defaults live with this file's chat code
// (see _messageLoadConvs / _messageSelectConv / etc.) and are wired up at the
// bottom of the message section.

async function loadConversations() {
  const cfg = TAB_REGISTRY[state.currentTab];
  if (cfg?.loadConvs) await cfg.loadConvs();
}

function renderConvList() {
  const cfg = TAB_REGISTRY[state.currentTab];
  if (!cfg) {
    const list = document.getElementById('conv-list');
    if (list) list.innerHTML = '';
    return;
  }
  if (cfg.render) { cfg.render(); return; }      // full override (e.g. message tab's bot-filter)
  if (!cfg.renderItem) {
    const list = document.getElementById('conv-list');
    if (list) list.innerHTML = '';
    return;
  }
  renderConvListInto(state.convsByTab[state.currentTab] || [], cfg.emptyHint, cfg.renderItem);
}

function onNewChatClick(e) {
  const cfg = TAB_REGISTRY[state.currentTab];
  if (cfg?.onNewChat) cfg.onNewChat(e);
}

function selectConversation(convId) {
  const cfg = TAB_REGISTRY[state.currentTab];
  if (cfg?.selectConv) cfg.selectConv(convId);
}

function handleWsMessage(msg) {
  // Tab-specific handlers (e.g. debate intercepting clarify/debater messages)
  // get first crack. Returning true marks the message consumed.
  for (const cfg of Object.values(TAB_REGISTRY)) {
    if (cfg.wsHandler && cfg.wsHandler(msg) === true) return;
  }
  defaultMessageWsHandler(msg);
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

async function _messageLoadConvs() {
  try {
    const url = `/api/conversations?feature=message`;
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

// Message-tab list render — the message tab applies an additional bot-filter
// step on top of state.conversations, which the generic dispatcher doesn't
// know about, so we keep a custom render here and wire it via TAB_REGISTRY.
function _messageRenderConvList() {
  const list = document.getElementById('conv-list');
  list.innerHTML = '';
  const convs = filteredConversations();
  if (convs.length === 0) {
    const hint = state.botFilter ? '没有该 Bot 的对话' : '还没有对话';
    const action = state.botFilter ? '点上面「新对话」开启' : '点上面的「新对话」开始';
    list.innerHTML = `<div class="conv-empty">${esc(hint)}<br>${esc(action)}</div>`;
    return;
  }
  for (const conv of convs) list.appendChild(renderConvItem(conv));
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
        <svg width="12" height="12"><use href="#icon-pencil"/></svg>
      </button>
      <button title="删除" class="danger" data-act="delete">
        <svg width="12" height="12"><use href="#icon-trash"/></svg>
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
    if (document.hidden) return;       // skip while tab is in background
    document.querySelectorAll('.conv-time[data-ts]').forEach(el => {
      const ts = parseInt(el.dataset.ts);
      if (ts) el.textContent = relTime(ts);
    });
  }, 60 * 1000);
}

function _messageSelectConv(convId) {
  const conv = state.conversations.find(c => c.id === convId);
  if (!conv) return;
  state.currentConversationId = convId;

  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });

  applyTabView();
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

function _messageOnNewChat(e) {
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
      body: JSON.stringify({ botId, featureType }),
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
  const item = findConvItem(state.currentConversationId);
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

// In-message surf trigger: creates a 冲浪 tab conversation pinned to this
// message conv as source, runs it, and pipes the final message back into the
// chat (preserved UX). The full run record lives in the new surf conv.
async function triggerSurfForCurrent() {
  const convId = state.currentConversationId;
  if (!convId) return;
  if (state.activeSurfs.has(convId)) return;
  state.activeSurfs.add(convId);
  refreshActionBusyState();
  try {
    const res = await fetch('/api/surf/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sourceMessageConversationId: convId,
        autoStart: true,
      }),
    });
    if (!res.ok) {
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

// In-message review trigger: creates a 回顾 tab conversation pinned to this
// message conv as source, runs it, and (if the verdict isn't [OK]) appends
// the conclusion back into the chat.
async function triggerReviewForCurrent() {
  const convId = state.currentConversationId;
  if (!convId) return;
  if (state.reviewingFromMessage.has(convId)) return;
  state.reviewingFromMessage.add(convId);
  refreshActionBusyState();
  try {
    const res = await fetch(`/api/review/trigger/${convId}`, { method: 'POST' });
    if (!res.ok) {
      state.reviewingFromMessage.delete(convId);
      refreshActionBusyState();
      const body = await res.json().catch(() => ({}));
      alert('触发回顾失败: ' + (body.error || res.status));
    }
  } catch (e) {
    state.reviewingFromMessage.delete(convId);
    refreshActionBusyState();
    alert('触发回顾失败: ' + e.message);
  }
}

function refreshActionBusyState() {
  const convId = state.currentConversationId;
  const surfBtn = document.getElementById('surf-btn');
  const reviewBtn = document.getElementById('review-btn');
  // The chat-header buttons live on the message tab; busy = there's a surf
  // / review in flight whose source is this message conv.
  if (surfBtn) surfBtn.classList.toggle('busy', !!convId && state.surfingFromMessage.has(convId));
  if (reviewBtn) reviewBtn.classList.toggle('busy', !!convId && state.reviewingFromMessage.has(convId));
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
        state.surfingFromMessage = new Set(Array.isArray(data.sources) ? data.sources : []);
        refreshActionBusyState();
      } catch {}
    });
    surfES.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        let changed = false;
        if (data.surfConvId && !state.activeSurfs.has(data.surfConvId)) {
          state.activeSurfs.add(data.surfConvId);
          changed = true;
        }
        if (data.sourceMessageConvId && !state.surfingFromMessage.has(data.sourceMessageConvId)) {
          state.surfingFromMessage.add(data.sourceMessageConvId);
          changed = true;
        }
        if (changed) refreshActionBusyState();
        // Live-update the surf view's status / log if the user is watching it
        if (window.handleSurfSseLog) window.handleSurfSseLog(data);
      } catch {}
    });
    surfES.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data);
        let changed = false;
        if (data.surfConvId && state.activeSurfs.delete(data.surfConvId)) changed = true;
        if (data.sourceMessageConvId && state.surfingFromMessage.delete(data.sourceMessageConvId)) {
          changed = true;
        }
        if (changed) refreshActionBusyState();
        if (window.handleSurfSseDone) window.handleSurfSseDone(data);
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
        state.reviewingFromMessage = new Set(Array.isArray(data.sources) ? data.sources : []);
        refreshActionBusyState();
      } catch {}
    });
    reviewES.addEventListener('log', (e) => {
      try {
        const data = JSON.parse(e.data);
        let changed = false;
        if (data.reviewConvId && !state.pendingReviews.has(data.reviewConvId)) {
          state.pendingReviews.add(data.reviewConvId);
          changed = true;
        }
        if (data.sourceMessageConvId && !state.reviewingFromMessage.has(data.sourceMessageConvId)) {
          state.reviewingFromMessage.add(data.sourceMessageConvId);
          changed = true;
        }
        if (changed) refreshActionBusyState();
        if (window.handleReviewSseLog) window.handleReviewSseLog(data);
      } catch {}
    });
    reviewES.addEventListener('done', (e) => {
      try {
        const data = JSON.parse(e.data);
        let changed = false;
        if (data.reviewConvId && state.pendingReviews.delete(data.reviewConvId)) changed = true;
        if (data.sourceMessageConvId && state.reviewingFromMessage.delete(data.sourceMessageConvId)) {
          changed = true;
        }
        if (changed) refreshActionBusyState();
        if (window.handleReviewSseDone) window.handleReviewSseDone(data);
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
  state.ws = new WebSocket(`${proto}://${location.host}/ws`);

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

function defaultMessageWsHandler(msg) {
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
      const item = findConvItem(msg.conversationId)?.querySelector('.conv-title');
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

TAB_REGISTRY.message = {
  view: 'chat',
  loadConvs: _messageLoadConvs,
  render: _messageRenderConvList,
  onNewChat: _messageOnNewChat,
  selectConv: _messageSelectConv,
  emptyHintNoSel: '选个对话，或者开个新的',
};

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
      body: JSON.stringify({ messageId: msgId }),
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
  // Only close on backdrop / close-button. Use contains() rather than ===
  // so clicks that bubble up from inside the image (e.g. selection handles)
  // also pass through.
  if (e && img.contains(e.target)) return;
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

  // Tear down outgoing connections on page unload so the server doesn't hold
  // sockets open and the next reload starts clean.
  window.addEventListener('beforeunload', () => {
    state.surfES?.close();
    state.reviewES?.close();
    debateState.es?.close();
    if (state.ws && state.ws.readyState <= 1) {
      try { state.ws.close(); } catch {}
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

// ──────────────────────────────────────────────────────────────────────────
//  议论 (Debate) — multi-agent group chat, user can only inject 辟谣
// ──────────────────────────────────────────────────────────────────────────

// Default debate line-up — the 5 mainstream slugs we suggest when the user
// opens the modal without an existing debate to clone from. Edits go straight
// to model_slugs in debate_settings; the picker can swap in anything else
// from OpenRouter's full list.
const DEFAULT_DEBATE_SLUGS = [
  'z-ai/glm-5.1',
  'z-ai/glm-4.5-air:free',
  'deepseek/deepseek-v4-flash',
  'deepseek/deepseek-v4-pro',
  'minimax/minimax-m2.7',
  'tencent/hy3-preview:free',
  'google/gemini-3.1-flash-lite-preview',
];

const DEFAULT_DEBATE_MAX_MSGS = 30;
function getDebateMaxMsgs() {
  const v = parseInt(localStorage.getItem('debate-max-msgs') || '', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 200) : DEFAULT_DEBATE_MAX_MSGS;
}
function setDebateMaxMsgs(n) {
  localStorage.setItem('debate-max-msgs', String(n));
}

const debateState = {
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

// Hook into loadConversations: when on the debate tab, hit the debate-specific
// list endpoint that hydrates topic + model_slugs.
async function loadDebateConversations() {
  try {
    const res = await fetch(`/api/debate/conversations`);
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
          <svg width="12" height="12"><use href="#icon-trash"/></svg>
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
  applyTabView();

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
  const modelNames = (d.model_slugs ?? []).join(' · ');
  meta.textContent = `${(d.model_slugs ?? []).length} 个模型 · ${d.round_count_debate ?? 0} 轮 · ${modelNames}`;
}

// ── Provider brand avatars ──
// Maps an OpenRouter slug prefix (the part before the `/`) to the model
// vendor's official-ish logo file (under /logos/) plus a brand color and
// glyph fallback. `logo` files were sourced from each company's site /
// the Iconify "logos" set / Simple Icons. When `logo` is absent we render
// a colored circle with the `text` glyph instead.
const PROVIDER_BRANDS = {
  'anthropic':   { logo: 'anthropic',   bg: '#D97757', text: 'A' },
  'openai':      { logo: 'openai',      bg: '#10A37F', text: 'O' },
  'deepseek':    { logo: 'deepseek',    bg: '#4D6BFE', text: '深' },
  'google':      { logo: 'google',      bg: '#1A73E8', text: 'G' },
  'z-ai':        { logo: 'z-ai',        bg: '#6E45E2', text: '智' },
  'zhipu':       { logo: 'z-ai',        bg: '#6E45E2', text: '智' },
  'tencent':     { logo: 'tencent',     bg: '#0052D9', text: '腾' },
  'minimax':     { logo: 'minimax',     bg: '#E73562', text: 'M' },
  'x-ai':        { logo: 'x-ai',        bg: '#0E0E0E', text: '𝕏' },
  'meta-llama':  { logo: 'meta-llama',  bg: '#0866FF', text: 'M' },
  'mistralai':   { logo: 'mistralai',   bg: '#FA520F', text: 'M' },
  'mistral':     { logo: 'mistralai',   bg: '#FA520F', text: 'M' },
  'qwen':        { logo: 'qwen',        bg: '#623AE7', text: '通' },
  'alibaba':     { logo: 'alibaba',     bg: '#FF6A00', text: '通' },
  'perplexity':  { logo: 'perplexity',  bg: '#1FB8CD', text: 'PX' },
  'nvidia':      { logo: 'nvidia',      bg: '#76B900', text: 'N' },
  'moonshotai':  { logo: 'moonshotai',  bg: '#0F172A', text: '月' },
  'cohere':      {                       bg: '#39594D', text: 'C' },
  'baichuan':    {                       bg: '#1F8FFF', text: '百' },
  '01-ai':       {                       bg: '#1F2937', text: '零' },
};

function providerKey(slug) {
  const s = (slug || '').toLowerCase();
  const slash = s.indexOf('/');
  return slash > 0 ? s.slice(0, slash) : s;
}

// Returns { mode, ... } describing how to render the avatar circle.
//   mode 'logo' → white circle with brand image inside
//   mode 'glyph' → colored circle with white text
function providerAvatarHTML(slug, displayName) {
  const key = providerKey(slug);
  const brand = PROVIDER_BRANDS[key];
  if (brand?.logo) {
    return {
      mode: 'logo',
      html: `<img src="/logos/${brand.logo}.svg" alt="${esc(key)}" loading="lazy">`,
    };
  }
  if (brand?.text) {
    return {
      mode: 'glyph',
      bg: brand.bg,
      html: `<span class="debate-avatar-text">${esc(brand.text)}</span>`,
    };
  }
  // Unknown provider — hashed color + initials from the model name.
  const src = (displayName || slug || '').trim();
  const tail = src.includes('/') ? src.split('/').pop() : src;
  const cleaned = (tail || '').replace(/[^a-zA-Z0-9一-鿿]/g, '');
  let glyph = '?';
  if (cleaned) {
    const m = cleaned.match(/[一-鿿]/);
    glyph = m ? m[0] : cleaned.slice(0, 2).toUpperCase();
  }
  return {
    mode: 'glyph',
    bg: modelColor(slug),
    html: `<span class="debate-avatar-text">${esc(glyph)}</span>`,
  };
}

function appendDebateMessage(m) {
  const root = document.getElementById('debate-messages');
  if (!root) return;
  const el = document.createElement('div');

  const senderType = m.sender_type || (m.metadata?.sender_kind === 'clarify' ? 'user' : 'debater');
  if (senderType === 'user' || m.metadata?.sender_kind === 'clarify') {
    el.className = 'debate-msg clarify';
    el.textContent = m.content;
  } else {
    const slug = m.sender_id || m.metadata?.slug || '';
    const name = m.metadata?.display_name || slug;
    el.className = 'debate-msg debater';
    el.dataset.slug = slug;
    // Collapse the avatar + name when the previous bubble is from the same speaker.
    const prev = root.lastElementChild;
    if (prev && prev.classList.contains('debater') && prev.dataset.slug === slug) {
      el.classList.add('same-speaker');
    }
    const av = providerAvatarHTML(slug, name);
    const avatarAttr = av.mode === 'logo'
      ? 'class="debate-avatar has-logo"'
      : `class="debate-avatar" style="background:${av.bg}"`;
    el.innerHTML = `
      <div ${avatarAttr}>${av.html}</div>
      <div class="debate-body-wrap">
        <div class="debate-who"><span>${esc(name)}</span></div>
        <div class="debate-body">${esc(m.content)}</div>
      </div>
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

function setDebateBusy(busy) {
  const round = document.getElementById('debate-round-btn');
  const pause = document.getElementById('debate-pause-btn');
  if (round) {
    round.disabled = !!busy;
    round.classList.toggle('busy', !!busy);
  }
  if (pause) {
    pause.style.display = busy ? '' : 'none';
    pause.disabled = false;
  }
}

async function runDebateRoundClick() {
  const convId = state.currentConversationId;
  if (!convId) return;
  setDebateBusy(true);
  setDebateStatus('议论中…');
  try {
    await fetch(`/api/debate/round/${convId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ maxMessages: getDebateMaxMsgs() }),
    });
    // Server fires messages over WS + a `done` event over SSE; we'll
    // re-enable the button on `done`.
  } catch (e) {
    setDebateStatus(`出错：${e.message}`);
    setDebateBusy(false);
  }
}

async function pauseDebateRoundClick() {
  const convId = state.currentConversationId;
  if (!convId) return;
  const pause = document.getElementById('debate-pause-btn');
  if (pause) pause.disabled = true;
  setDebateStatus('暂停中… 等当前这条说完');
  try {
    await fetch(`/api/debate/pause/${convId}`, { method: 'POST' });
  } catch (e) {
    setDebateStatus(`暂停失败：${e.message}`);
    if (pause) pause.disabled = false;
  }
}

async function injectDebateClarification() {
  const convId = state.currentConversationId;
  if (!convId) return;
  const input = document.getElementById('debate-clarify-input');
  const content = input.value.trim();
  if (!content) return;
  input.value = '';
  setDebateBusy(true);
  setDebateStatus('注入并开始下一轮…');
  try {
    await fetch(`/api/debate/inject/${convId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content, autoRound: true, maxMessages: getDebateMaxMsgs() }),
    });
  } catch (e) {
    setDebateStatus(`出错：${e.message}`);
    setDebateBusy(false);
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
    debateState.pickedModelSlugs = new Set(DEFAULT_DEBATE_SLUGS);
  }

  const maxEl = document.getElementById('debate-modal-max-msgs');
  if (maxEl) maxEl.value = String(getDebateMaxMsgs());

  renderDebateModalModels();
  document.getElementById('debate-modal').style.display = 'flex';
}

// Mounts a multi-select model picker into the modal. Replaces the older
// always-visible checkbox list with a searchable dropdown so the modal stays
// short when the model library grows.
function renderDebateModalModels() {
  const host = document.getElementById('debate-modal-models-host');
  if (!host) return;
  host.innerHTML = '';
  const picker = createModelPicker({
    multi: true,
    values: Array.from(debateState.pickedModelSlugs),
    placeholder: '搜索并勾选要参与的模型 …',
    onChange: (set) => {
      debateState.pickedModelSlugs = new Set(set);
    },
  });
  host.appendChild(picker);
}

// Legacy alias kept for any inline onclick attributes that still reference it.
function closeDebateModal(e) { closeModal('debate-modal', e); }

async function submitDebateModal() {
  const slugs = Array.from(debateState.pickedModelSlugs);
  if (slugs.length < 2) {
    alert('至少勾两个模型');
    return;
  }
  const topic = document.getElementById('debate-modal-topic').value.trim();
  const maxEl = document.getElementById('debate-modal-max-msgs');
  const maxParsed = parseInt(maxEl?.value || '', 10);
  const maxMessages = Number.isFinite(maxParsed) && maxParsed > 0
    ? Math.min(maxParsed, 200)
    : DEFAULT_DEBATE_MAX_MSGS;
  setDebateMaxMsgs(maxMessages);

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
      if (state.currentConversationId === data.conversationId) {
        setDebateBusy(false);
        const tail = data.paused
          ? `Round ${data.round} 已暂停 · ${data.delivered} 条`
          : `Round ${data.round} 完成 · ${data.delivered} 条`;
        setDebateStatus(tail);
        if (debateState.currentDebate) {
          debateState.currentDebate.round_count_debate = data.round;
          updateDebateHeader();
        }
      }
      if (state.currentTab === 'debate') {
        loadDebateConversations().then(renderConvList);
      }
    } catch {}
  });
  debateState.es.onerror = () => { /* EventSource auto-reconnects */ };
}

TAB_REGISTRY.debate = {
  view: 'debate',
  loadConvs: loadDebateConversations,
  renderItem: renderDebateConvItem,
  selectConv: selectDebateConv,
  onNewChat: (e) => { if (e) e.stopPropagation(); openDebateModal('create'); },
  emptyHint: '还没有议论\n点上面「新对话」开启',
  emptyHintNoSel: '点「新对话」开启一场议论',
  // Intercept clarify / debater WS messages so they land in the debate view
  // instead of the normal chat bubble path.
  wsHandler(msg) {
    const kind = msg?.metadata?.sender_kind;
    if (kind !== 'debater' && kind !== 'clarify') return false;
    if (msg.conversationId === state.currentConversationId && state.currentTab === 'debate') {
      appendDebateMessage({
        sender_type: kind === 'clarify' ? 'user' : 'debater',
        sender_id: msg.metadata?.slug ?? '',
        content: msg.content,
        metadata: msg.metadata,
      });
      scrollDebateToBottom();
    }
    return true;
  },
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
  modelOverride: '',        // optional per-generation model slug
};

async function loadPortraitConversations() {
  try {
    const res = await fetch(`/api/portrait/conversations`);
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
  const kindBadges = (conv.kinds ?? []).map(k => {
    const safe = PORTRAIT_KINDS.includes(k) ? k : 'default';
    return `<span class="conv-model-dot" data-kind="${esc(safe)}" title="${esc(PORTRAIT_KIND_LABELS[k] ?? k)}"></span>`;
  }).join('');
  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(conv.title || '画像')}</span>
      <span class="conv-debate-meta">${kindBadges} <span>· ${conv.portrait_count ?? 0} 项</span></span>
    </span>
    <span class="conv-actions">
      <button title="删除" class="danger" data-act="delete">
        <svg width="12" height="12"><use href="#icon-trash"/></svg>
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

async function selectPortraitConv(convId) {
  state.currentConversationId = convId;
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });
  applyTabView();

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

  // Mount the per-generation model picker once; subsequent renders just reset
  // it. Empty value means "use the system default for portrait" (resolved on
  // the server via modelFor('portrait')).
  ensureModelPicker(document.getElementById('portrait-model-host'), {
    value: portraitState.modelOverride || '',
    placeholder: '默认（系统分配）',
    allowCustomSlug: true,
    onChange: (slug) => { portraitState.modelOverride = slug || ''; },
  });

  // Feed: each existing portrait gets a section (most recent first per kind)
  const feed = document.getElementById('portrait-feed');
  feed.innerHTML = '';
  const portraits = d.portraits ?? [];
  if (portraits.length === 0) {
    feed.innerHTML = '<div class="portrait-empty">还没有生成任何画像 — 点上面任一卡片来生成</div>';
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
  sec.className = `portrait-section portrait-section--${p.kind}`;
  const items = (p.content?.items) ?? [];
  const head = document.createElement('div');
  head.className = 'portrait-section-head';
  // The first <span> picks up its color from
  // .portrait-section--<kind> .portrait-section-head > span:first-child in CSS.
  head.innerHTML = `
    <span class="ps-dot"></span>
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
    wrap.className = 'pi-table-wrap';
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
    wrap.className = 'pi-table-wrap';
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
    const body = { kind, withImage };
    if (portraitState.modelOverride) body.model = portraitState.modelOverride;
    const res = await fetch(`/api/portrait/generate/${state.currentConversationId}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
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
  list.innerHTML = '<div class="modal-status-row">加载中…</div>';
  document.getElementById('portrait-modal').style.display = 'flex';

  try {
    const res = await fetch(`/api/portrait/sources`);
    const sources = await res.json();
    if (!Array.isArray(sources) || sources.length === 0) {
      list.innerHTML = '<div class="modal-status-row">还没有任何消息会话 — 先去「消息」聊几句。</div>';
      return;
    }
    renderSourcePicker(list, sources, {
      // Portrait flow creates a new conv on click (no separate submit step),
      // so the "selection" is single-shot — onPick fires once, and we let
      // createPortraitConv take over from there.
      onPick: (id) => { if (id) createPortraitConv(id); },
    });
  } catch (e) {
    list.innerHTML = `<div class="modal-status-row error">加载失败：${esc(e.message)}</div>`;
  }
}

function closePortraitModal(e) { closeModal('portrait-modal', e); }

async function createPortraitConv(sourceConversationId) {
  try {
    const res = await fetch('/api/portrait/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
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

TAB_REGISTRY.portrait = {
  view: 'portrait',
  loadConvs: loadPortraitConversations,
  renderItem: renderPortraitConvItem,
  selectConv: selectPortraitConv,
  onNewChat: (e) => { if (e) e.stopPropagation(); openPortraitModal(); },
  emptyHint: '还没有画像\n点上面「新对话」选个源会话',
  emptyHintNoSel: '点「新对话」选源会话生成画像',
};


// ──────────────────────────────────────────────────────────────────────────
//  「你」 tab — basic info + AI picks + per-task model assignments
// ──────────────────────────────────────────────────────────────────────────

async function loadMeView() {
  await Promise.all([
    loadMyProfile(),
    loadMyPicks(),
    loadMeAssignments(),
    loadMySkills(),
  ]);
}

TAB_REGISTRY.me = {
  view: 'me',
  alwaysShowView: true,
  onActivate: loadMeView,
};

// ── 钥匙 tab — iOS API key management ───────────────────────────────────────

TAB_REGISTRY.keys = {
  view: 'keys',
  alwaysShowView: true,
  onActivate: loadKeysList,
};

// Cache of detected server URLs — refreshed each time the keys tab opens
// so the dropdown reflects the host the admin is currently on (LAN IP vs.
// localhost matters for which option is "current").
let _keysServerUrls = null;

async function loadKeysList() {
  const root = document.getElementById('keys-list');
  if (!root) return;
  root.innerHTML = '<div class="me-section-status">加载中…</div>';
  try {
    const [rowsRes, urlsRes] = await Promise.all([
      fetch('/api/keys'),
      fetch('/api/keys/server-urls'),
    ]);
    const rows = await rowsRes.json();
    _keysServerUrls = await urlsRes.json();
    populateBaseUrlDropdown();
    if (!Array.isArray(rows) || rows.length === 0) {
      root.innerHTML = '<div class="me-section-status">还没有钥匙。在上面填个名称然后创建一把。</div>';
      return;
    }
    root.innerHTML = '';
    for (const row of rows) {
      root.appendChild(renderKeyRow(row));
    }
  } catch (e) {
    root.innerHTML = `<div class="me-section-status">加载失败: ${esc(String(e))}</div>`;
  }
}

function populateBaseUrlDropdown() {
  const sel = document.getElementById('keys-new-baseurl');
  const warn = document.getElementById('keys-baseurl-warning');
  if (!sel || !_keysServerUrls) return;
  sel.innerHTML = '';
  for (const opt of _keysServerUrls.options) {
    const o = document.createElement('option');
    o.value = opt.url;
    o.textContent = `${opt.label}${opt.isCurrent ? '  · 你正在用' : ''}`;
    if (opt.url === _keysServerUrls.primary) o.selected = true;
    sel.appendChild(o);
  }
  // Custom-entry option always at the bottom.
  const custom = document.createElement('option');
  custom.value = '__custom__';
  custom.textContent = '自定义…';
  sel.appendChild(custom);

  if (warn) {
    if (_keysServerUrls.warning) {
      warn.style.display = 'block';
      warn.textContent = '⚠ ' + _keysServerUrls.warning;
    } else {
      warn.style.display = 'none';
    }
  }

  // Replace the select with a free-text input if user picks "自定义".
  sel.onchange = () => {
    if (sel.value === '__custom__') {
      const url = prompt('输入完整 URL (含 http:// 或 https://):', 'https://');
      if (url && /^https?:\/\//i.test(url)) {
        // Insert as a new option at top, select it.
        const o = document.createElement('option');
        o.value = url.replace(/\/+$/, '');
        o.textContent = `自定义: ${o.value}`;
        o.selected = true;
        sel.insertBefore(o, sel.firstChild);
      } else {
        // Cancelled or invalid — revert to primary.
        for (const o of sel.options) if (o.value === _keysServerUrls.primary) { o.selected = true; break; }
      }
    }
  };
}

function renderKeyRow(row) {
  const wrap = document.createElement('div');
  wrap.className = 'keys-row';
  if (row.revoked_at) wrap.classList.add('revoked');
  const lastUsed = row.last_used_at
    ? `${relTime(row.last_used_at)}前使用过`
    : '从未使用';
  const created = `${relTime(row.created_at)}前`;
  const status = row.revoked_at
    ? '<span class="keys-badge revoked">已撤销</span>'
    : (row.has_share_link ? '<span class="keys-badge pending">待领取</span>' : '<span class="keys-badge active">已激活</span>');
  const baseUrlBit = row.share_base_url
    ? `<div class="keys-row-meta">分享地址 <code>${esc(row.share_base_url)}</code></div>`
    : '';
  wrap.innerHTML = `
    <div class="keys-row-main">
      <div class="keys-row-name">${esc(row.name)} ${status}</div>
      <div class="keys-row-meta">
        <code>${esc(row.key_prefix)}…</code>
        · ${esc(lastUsed)}
        · 创建于 ${esc(created)}
      </div>
      ${baseUrlBit}
    </div>
    <div class="keys-row-actions"></div>
  `;
  const actions = wrap.querySelector('.keys-row-actions');
  if (!row.revoked_at) {
    if (row.has_share_link) {
      const shareBtn = document.createElement('button');
      shareBtn.className = 'btn-soft';
      shareBtn.textContent = '查看分享链接';
      shareBtn.onclick = () => showExistingShare(row.id);
      actions.appendChild(shareBtn);
    } else {
      const reShareBtn = document.createElement('button');
      reShareBtn.className = 'btn-soft';
      reShareBtn.textContent = '重新生成分享链接';
      reShareBtn.onclick = () => rotateShare(row.id);
      actions.appendChild(reShareBtn);
    }
    const revokeBtn = document.createElement('button');
    revokeBtn.className = 'btn-soft danger';
    revokeBtn.textContent = '撤销';
    revokeBtn.onclick = () => revokeKey(row.id, row.name);
    actions.appendChild(revokeBtn);
  }
  return wrap;
}

async function createNewKey() {
  const nameEl = document.getElementById('keys-new-name');
  const baseUrlSel = document.getElementById('keys-new-baseurl');
  const includeAlts = document.getElementById('keys-include-alts')?.checked ?? true;
  const name = (nameEl?.value ?? '').trim();
  if (!name) { nameEl?.focus(); return; }
  const baseURL = baseUrlSel?.value;
  if (!baseURL || baseURL === '__custom__') {
    alert('请选择或输入服务器地址');
    return;
  }
  // Build alt list = every other detected option, except loopback + the primary
  // we just picked. The iOS client probes these in order if `baseURL` is
  // unreachable from where it is.
  let altURLs = [];
  if (includeAlts && _keysServerUrls) {
    altURLs = _keysServerUrls.options
      .filter(o => o.source !== 'loopback' && o.url !== baseURL)
      .map(o => o.url);
  }
  try {
    const res = await fetch('/api/keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, baseURL, altURLs }),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const out = await res.json();
    if (nameEl) nameEl.value = '';
    showKeyModal({ key: out.key, share_url: out.share_url, id: out.id, share_base_url: out.share_base_url });
    loadKeysList();
  } catch (e) {
    alert(`创建失败: ${e}`);
  }
}

function showKeyModal({ key, share_url, id }) {
  document.getElementById('keys-show-key').value = key ?? '';
  document.getElementById('keys-show-share').value = share_url ?? '';
  const qrHost = document.getElementById('keys-show-qr');
  if (qrHost) {
    qrHost.innerHTML = `<img src="/api/keys/${encodeURIComponent(id)}/qr?t=${Date.now()}" alt="二维码" loading="lazy">`;
  }
  document.getElementById('keys-show-modal').style.display = 'flex';
}

async function showExistingShare(id) {
  try {
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}/share`);
    if (!res.ok) {
      // No live share link — offer to rotate (mints a fresh one)
      if (confirm('该钥匙暂无分享链接,生成一条新的?')) await rotateShare(id);
      return;
    }
    const out = await res.json();
    document.getElementById('keys-show-key').value = '（已隐藏 — 完整钥匙仅在创建时显示一次）';
    document.getElementById('keys-show-share').value = out.share_url ?? '';
    const qrHost = document.getElementById('keys-show-qr');
    if (qrHost) {
      qrHost.innerHTML = `<img src="/api/keys/${encodeURIComponent(id)}/qr?t=${Date.now()}" alt="二维码" loading="lazy">`;
    }
    document.getElementById('keys-show-modal').style.display = 'flex';
  } catch (e) {
    alert(`加载失败: ${e}`);
  }
}

async function rotateShare(id) {
  try {
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}/share/rotate`, { method: 'POST' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    await loadKeysList();
    await showExistingShare(id);
  } catch (e) {
    alert(`生成分享链接失败: ${e}`);
  }
}

async function revokeKey(id, name) {
  if (!confirm(`撤销 "${name}" 的钥匙? 持有者将立即无法访问。\n此操作不可撤销。`)) return;
  try {
    const res = await fetch(`/api/keys/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    loadKeysList();
  } catch (e) {
    alert(`撤销失败: ${e}`);
  }
}

function copyToClipboard(elementId, btn) {
  const el = document.getElementById(elementId);
  if (!el) return;
  el.select();
  navigator.clipboard.writeText(el.value).then(() => {
    if (btn) {
      const old = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => { btn.textContent = old; }, 1200);
    }
  }).catch(() => {
    document.execCommand('copy');
    if (btn) btn.textContent = '已复制';
  });
}

const ASSIGNMENT_LABELS = {
  chat:       ['对话回复',     '消息 tab 的常规聊天回复'],
  review:     ['会话内自审',   '消息 tab 的周期性回顾，会话中的自审'],
  surfing:    ['冲浪',         '冲浪 tab 的 planner / curator'],
  title:      ['标题生成',     '会话标题（cheap）'],
  perception: ['广泛感知',     '任务阶段 / 跨会话焦点的轻量推断'],
  portrait:   ['画像生成',     '画像 tab 的 5 种生成器'],
};

async function loadMeAssignments() {
  const root = document.getElementById('me-assignments-list');
  root.innerHTML = '<div class="me-section-status">加载中…</div>';
  try {
    const res = await fetch('/api/me/model-assignments');
    const map = await res.json();
    root.innerHTML = '';
    for (const taskType of Object.keys(ASSIGNMENT_LABELS)) {
      const [name, hint] = ASSIGNMENT_LABELS[taskType];
      const row = document.createElement('div');
      row.className = 'me-assignments-row';
      const labelEl = document.createElement('div');
      labelEl.innerHTML = `<label>${esc(name)}<span class="me-assignments-hint">${esc(hint)}</span></label>`;
      const pickerHolder = document.createElement('div');
      const picker = createModelPicker({
        value: map[taskType] ?? '',
        allowCustomSlug: true,
        onChange: (slug) => saveAssignment(taskType, slug),
      });
      pickerHolder.appendChild(picker);
      row.appendChild(labelEl);
      row.appendChild(pickerHolder);
      root.appendChild(row);
    }
  } catch (e) {
    root.innerHTML = `<div class="me-section-status error">${esc(e.message)}</div>`;
  }
}

async function saveAssignment(taskType, slug) {
  try {
    await fetch('/api/me/model-assignments', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ [taskType]: slug }),
    });
  } catch (e) {
    alert('保存失败：' + e.message);
  }
}

async function loadMyProfile() {
  try {
    const res = await fetch(`/api/me/profile`);
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
      body: JSON.stringify({ displayName, bio }),
    });
    const saved = document.getElementById('me-profile-saved');
    saved.hidden = false;
    setTimeout(() => { saved.hidden = true; }, 1800);
  } catch (e) { alert('保存失败：' + e.message); }
  finally { btn.disabled = false; }
}

async function loadMyPicks() {
  const root = document.getElementById('me-picks-list');
  root.innerHTML = '<div class="me-section-status">加载中…</div>';
  try {
    const res = await fetch(`/api/me/picks`);
    const picks = await res.json();
    if (!Array.isArray(picks) || picks.length === 0) {
      root.innerHTML = '<div class="me-section-status">还没有 AI 收藏</div>';
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
    root.innerHTML = `<div class="me-section-status error">加载失败：${esc(e.message)}</div>`;
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
        title,
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

// ── Skills (Anthropic-style Agent Skills) ───────────────────────────────────
// Skill rows live in the 「我」 tab as a per-user catalog. Toggling `enabled`
// flips whether the skill body gets stitched into the system prompt at chat
// time. Bundled presets (source = anthropic/skills:*) are seeded disabled on
// first GET; the user opts in.

async function loadMySkills() {
  const root = document.getElementById('me-skills-list');
  if (!root) return;
  root.innerHTML = '<div class="me-section-status">加载中…</div>';
  try {
    const res = await fetch('/api/skills');
    const skills = await res.json();
    if (!Array.isArray(skills) || skills.length === 0) {
      root.innerHTML = '<div class="me-section-status">还没有技能。展开下面的「新建技能」来添加，或刷新预设。</div>';
      return;
    }
    root.innerHTML = '';
    for (const s of skills) root.appendChild(renderSkillCard(s));
  } catch (e) {
    root.innerHTML = `<div class="me-section-status error">加载失败：${esc(e.message)}</div>`;
  }
}

function renderSkillCard(s) {
  const card = document.createElement('div');
  card.className = 'skill-card' + (s.enabled ? ' enabled' : '');
  card.dataset.id = s.id;

  const sourceLine = s.is_preset && s.source_url
    ? `<span class="skill-source">来自 <a href="${esc(s.source_url)}" target="_blank" rel="noopener">${esc(s.source || '')}</a></span>`
    : (s.source && s.source !== 'user' ? `<span class="skill-source">${esc(s.source)}</span>` : '<span class="skill-source">本地</span>');
  const licenseLine = s.license ? `<span class="skill-license">${esc(s.license)}</span>` : '';

  card.innerHTML = `
    <div class="skill-head">
      <label class="skill-toggle">
        <input type="checkbox" ${s.enabled ? 'checked' : ''}>
        <span class="skill-name">${esc(s.name)}</span>
      </label>
      <div class="skill-meta-actions">
        <button class="btn-soft skill-edit-btn">编辑</button>
        <button class="btn-soft danger skill-del-btn">删除</button>
      </div>
    </div>
    ${s.description ? `<div class="skill-desc">${esc(s.description)}</div>` : ''}
    <div class="skill-meta">
      ${sourceLine}
      ${licenseLine}
      <span class="skill-meta-len">${s.body_length} 字符</span>
    </div>
    <div class="skill-edit" hidden></div>
  `;

  card.querySelector('.skill-toggle input').addEventListener('change', (ev) => {
    toggleSkillEnabled(s.id, ev.target.checked);
  });
  card.querySelector('.skill-edit-btn').addEventListener('click', () => {
    openSkillEditor(card, s.id);
  });
  card.querySelector('.skill-del-btn').addEventListener('click', () => {
    deleteSkillCard(s);
  });
  return card;
}

async function toggleSkillEnabled(id, enabled) {
  try {
    await fetch(`/api/skills/${id}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled }),
    });
    const card = document.querySelector(`.skill-card[data-id="${id}"]`);
    if (card) card.classList.toggle('enabled', enabled);
  } catch (e) {
    alert('保存失败：' + e.message);
    loadMySkills();
  }
}

async function openSkillEditor(card, id) {
  const slot = card.querySelector('.skill-edit');
  if (!slot.hidden) { slot.hidden = true; slot.innerHTML = ''; return; }
  slot.innerHTML = '<div class="me-section-status">加载中…</div>';
  slot.hidden = false;
  try {
    const res = await fetch(`/api/skills/${id}`);
    const full = await res.json();
    slot.innerHTML = `
      <div class="me-form">
        <label>名称<input type="text" class="sk-edit-name" value="${esc(full.name)}" maxlength="64"></label>
        <label>描述<input type="text" class="sk-edit-desc" value="${esc(full.description || '')}" maxlength="280"></label>
        <label>正文（Markdown）<textarea class="sk-edit-body" rows="14">${esc(full.body || '')}</textarea></label>
        <div style="display:flex;gap:8px">
          <button class="btn-primary sk-save">保存</button>
          <button class="btn-soft sk-cancel">取消</button>
        </div>
      </div>
    `;
    slot.querySelector('.sk-save').addEventListener('click', async () => {
      const patch = {
        name: slot.querySelector('.sk-edit-name').value.trim(),
        description: slot.querySelector('.sk-edit-desc').value,
        body: slot.querySelector('.sk-edit-body').value,
      };
      try {
        const r = await fetch(`/api/skills/${id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        });
        if (!r.ok) {
          const err = await r.json().catch(() => ({}));
          throw new Error(err.error || `HTTP ${r.status}`);
        }
        loadMySkills();
      } catch (e) { alert('保存失败：' + e.message); }
    });
    slot.querySelector('.sk-cancel').addEventListener('click', () => {
      slot.hidden = true; slot.innerHTML = '';
    });
  } catch (e) {
    slot.innerHTML = `<div class="me-section-status error">加载失败：${esc(e.message)}</div>`;
  }
}

async function deleteSkillCard(s) {
  const note = s.is_preset
    ? `删除「${s.name}」预设？再次刷新会从预设重新拉回（如果你没改过）。`
    : `删除技能「${s.name}」？此操作不可撤销。`;
  if (!confirm(note)) return;
  try {
    await fetch(`/api/skills/${s.id}`, { method: 'DELETE' });
    loadMySkills();
  } catch (e) { alert('删除失败：' + e.message); }
}

async function createSkillFromForm() {
  const name = document.getElementById('me-skill-new-name').value.trim();
  const description = document.getElementById('me-skill-new-desc').value.trim();
  const body = document.getElementById('me-skill-new-body').value;
  if (!name) { alert('请填名称'); return; }
  try {
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, body, enabled: true }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    document.getElementById('me-skill-new-name').value = '';
    document.getElementById('me-skill-new-desc').value = '';
    document.getElementById('me-skill-new-body').value = '';
    loadMySkills();
  } catch (e) { alert('创建失败：' + e.message); }
}

// ──────────────────────────────────────────────────────────────────────────
//  冲浪 (Surf) — each conv = one run. List + create modal + live log view.
// ──────────────────────────────────────────────────────────────────────────

const surfTabState = {
  current: null,            // hydrated surf conv (with run record)
  modalSelectedSource: '',  // optional source message conv id
  modalModelSlug: '',
};

async function loadSurfConversations() {
  try {
    const res = await fetch(`/api/surf/conversations`);
    state.convsByTab.surf = await res.json();
    if (!Array.isArray(state.convsByTab.surf)) state.convsByTab.surf = [];
  } catch (e) {
    console.error('load surf convs:', e);
    state.convsByTab.surf = [];
  }
}

function statusLabel(status, active) {
  if (active) return '运行中';
  return ({
    pending: '待运行',
    running: '运行中',
    done: '完成',
    error: '出错',
    aborted: '中断',
  })[status] ?? status;
}

function renderSurfConvItem(conv) {
  const el = document.createElement('div');
  el.className = 'conv-item';
  el.dataset.convId = conv.id;
  if (conv.id === state.currentConversationId) el.classList.add('active');

  const isActive = state.activeSurfs.has(conv.id) || conv.active;
  const status = statusLabel(conv.status, isActive);
  const dot = isActive ? '<span class="conv-pending-dot"></span>' : '';
  const subtitle = conv.source_message_conv_id
    ? `源 · ${conv.source_message_conv_id.slice(0, 8)}`
    : '自由冲浪';
  const modelHint = conv.model_slug ? conv.model_slug.split('/').pop() : '';

  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(conv.title || '冲浪')}</span>
      <span class="conv-subtitle">${esc(subtitle)} · ${esc(modelHint)}</span>
      <span class="conv-debate-meta">${esc(status)}${dot ? ' ' + dot : ''}</span>
    </span>
    <span class="conv-actions">
      <button title="删除" class="danger" data-act="delete">
          <svg width="12" height="12"><use href="#icon-trash"/></svg>
      </button>
    </span>
  `;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'delete') deleteSurfConv(conv.id);
      return;
    }
    selectSurfConv(conv.id);
  });
  return el;
}

async function selectSurfConv(convId) {
  state.currentConversationId = convId;
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });
  applyTabView();

  try {
    const res = await fetch(`/api/surf/conversations/${convId}`);
    surfTabState.current = await res.json();
  } catch { surfTabState.current = null; }

  updateSurfHeader();

  // Load persisted log + result messages
  try {
    const res = await fetch(`/api/surf/conversations/${convId}/messages`);
    const msgs = await res.json();
    const log = document.getElementById('surf-log');
    log.innerHTML = '';
    // The result is persisted as a sender_type='bot' row; older runs also
    // wrote a duplicate log row tagged surf:surf_result. Skip the log
    // duplicate so existing convs don't show two identical bubbles.
    for (const m of msgs) {
      if ((m.sender_id || '').endsWith(':surf_result') && m.sender_type === 'log') continue;
      appendSurfRow(m);
    }
    scrollSurfToBottom();
  } catch (e) {
    console.error('load surf msgs:', e);
  }
}

function updateSurfHeader() {
  const c = surfTabState.current;
  const title = document.getElementById('surf-title');
  const meta = document.getElementById('surf-meta');
  if (!c) {
    title.textContent = '冲浪';
    meta.textContent = '';
    return;
  }
  title.textContent = c.title || '冲浪';
  const isActive = state.activeSurfs.has(c.id) || c.active;
  const parts = [
    `模型 ${c.model_slug ?? '—'}`,
    c.source_message_conv_id ? `源 ${c.source_message_conv_id.slice(0, 8)}` : '自由冲浪',
    `状态 ${statusLabel(c.status, isActive)}`,
  ];
  meta.textContent = parts.join(' · ');

  document.getElementById('surf-stop-btn').style.display = isActive ? '' : 'none';
  document.getElementById('surf-rerun-btn').style.display = isActive ? 'none' : '';
}

function appendSurfRow(m) {
  const log = document.getElementById('surf-log');
  if (!log) return;

  // surf:surf_result kind → render as a chat-style bubble (the deliverable);
  // sender_type='bot' rows that didn't carry the type tag are also results.
  const isResult =
    (m.sender_type === 'bot') ||
    (m.sender_id || '').endsWith(':surf_result');

  if (isResult) {
    const b = document.createElement('div');
    b.className = 'surf-result-bubble';
    b.textContent = m.content;
    log.appendChild(b);
    return;
  }

  const row = document.createElement('div');
  const isError = (m.sender_id || '').endsWith(':error');
  const isBridges = (m.sender_id || '').endsWith(':surf_bridges');
  row.className = 'surf-log-line' + (isError ? ' error' : '') + (isBridges ? ' bridges' : '');
  const ts = m.created_at
    ? new Date(m.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false })
    : '';
  row.innerHTML = `
    <span class="surf-log-time">${esc(ts)}</span>
    <span class="surf-log-text">${esc(m.content)}</span>
  `;
  log.appendChild(row);
}

function scrollSurfToBottom() {
  const log = document.getElementById('surf-log');
  if (!log) return;
  const scroller = log.parentElement;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

// SSE log/done callbacks invoked from the existing surf SSE listener.
window.handleSurfSseLog = function (data) {
  if (!data) return;
  if (state.currentConversationId !== data.surfConvId) {
    // Refresh conv list metadata so badges update
    if (state.currentTab === 'surf') {
      loadSurfConversations().then(renderConvList);
    }
    return;
  }
  appendSurfRow({
    sender_type: 'log',
    sender_id: `surf:${data.type}`,
    content: data.content,
    created_at: Math.floor((data.timestamp ?? Date.now()) / 1000),
  });
  scrollSurfToBottom();
};

window.handleSurfSseDone = function (data) {
  if (!data) return;
  if (state.currentConversationId === data.surfConvId) {
    // Refresh the header (final status) + reload messages to pick up the
    // bot-message bubble that landed at the very end.
    selectSurfConv(data.surfConvId);
  }
  if (state.currentTab === 'surf') {
    loadSurfConversations().then(renderConvList);
  }
};

async function deleteSurfConv(convId) {
  if (!confirm('删除这次冲浪？')) return;
  try {
    await fetch(`/api/surf/conversations/${convId}`, { method: 'DELETE' });
    state.convsByTab.surf = state.convsByTab.surf.filter(c => c.id !== convId);
    if (state.currentConversationId === convId) {
      state.currentConversationId = null;
      applyTabView();
    }
    renderConvList();
  } catch (e) { alert('删除失败：' + e.message); }
}

function deleteCurrentSurf() {
  if (state.currentConversationId) deleteSurfConv(state.currentConversationId);
}

async function rerunCurrentSurf() {
  if (!state.currentConversationId) return;
  try {
    await fetch(`/api/surf/run/${state.currentConversationId}`, { method: 'POST' });
  } catch (e) { alert('启动失败：' + e.message); }
}

async function stopCurrentSurf() {
  if (!state.currentConversationId) return;
  try {
    await fetch(`/api/surf/stop/${state.currentConversationId}`, { method: 'POST' });
  } catch (e) { alert('中断失败：' + e.message); }
}

// ── Surf modal (create new surf) ──

async function openSurfModal() {
  ensureModelPicker(document.getElementById('surf-modal-model-host'), {
    value: '',
    placeholder: '默认（系统的「冲浪」分配）',
    allowCustomSlug: true,
    onChange: (slug) => { surfTabState.modalModelSlug = slug || ''; },
  });
  surfTabState.modalSelectedSource = '';
  surfTabState.modalModelSlug = '';
  document.getElementById('surf-modal-budget').value = '10';

  // Reset vector-direction controls each time the modal opens. Re-running
  // onSurfDirectionChange() after the radio reset keeps the manual-fields
  // visibility in sync with the radio (otherwise a leftover state from a
  // prior open could show the wrong subset).
  const autoRadio = document.querySelector('input[name="surf-direction"][value="auto"]');
  if (autoRadio) autoRadio.checked = true;
  document.getElementById('surf-modal-vector-topic').value = '';
  document.getElementById('surf-modal-vector-mode').value = 'depth';
  document.getElementById('surf-modal-vector-fresh').value = '';
  onSurfDirectionChange();

  // Load source candidates
  const list = document.getElementById('surf-modal-source-list');
  list.innerHTML = '<div class="modal-status-row">加载中…</div>';
  document.getElementById('surf-modal').style.display = 'flex';
  try {
    const res = await fetch(`/api/surf/sources`);
    const sources = await res.json();
    renderSourcePicker(list, sources, {
      withNoneRow: true,
      noneLabel: '— 不绑定（自由冲浪） —',
      noneHint: 'planner 几乎无上下文',
      onPick: (id) => { surfTabState.modalSelectedSource = id; },
    });
  } catch (e) {
    list.innerHTML = `<div class="modal-status-row error">加载失败：${esc(e.message)}</div>`;
  }
}

function closeSurfModal(e) { closeModal('surf-modal', e); }

function onSurfDirectionChange() {
  const dir = document.querySelector('input[name="surf-direction"]:checked')?.value || 'auto';
  document.getElementById('surf-manual-fields').style.display = dir === 'manual' ? 'flex' : 'none';
  if (dir === 'manual') onSurfModeChange();
}

function onSurfModeChange() {
  const mode = document.getElementById('surf-modal-vector-mode').value;
  document.getElementById('surf-modal-vector-fresh').style.display = mode === 'fresh' ? 'block' : 'none';
}

async function submitSurfModal() {
  const budgetRaw = document.getElementById('surf-modal-budget').value.trim();
  const budget = budgetRaw ? Math.max(1, parseInt(budgetRaw)) : undefined;
  const body = {
    autoStart: true,
  };
  if (surfTabState.modalSelectedSource) body.sourceMessageConversationId = surfTabState.modalSelectedSource;
  if (surfTabState.modalModelSlug) body.modelSlug = surfTabState.modalModelSlug;
  if (budget) body.budget = budget;

  const dir = document.querySelector('input[name="surf-direction"]:checked')?.value || 'auto';
  if (dir === 'manual') {
    const topic = document.getElementById('surf-modal-vector-topic').value.trim();
    if (!topic) { alert('请填 topic 或切回自动选'); return; }
    const mode = document.getElementById('surf-modal-vector-mode').value;
    const override = { topic, mode };
    if (mode === 'fresh') {
      const fresh = document.getElementById('surf-modal-vector-fresh').value.trim();
      if (fresh) override.freshness_window = fresh;
    }
    body.vectorOverride = override;
  } else if (dir === 'serendipity') {
    body.forceSerendipity = true;
  }

  try {
    const res = await fetch('/api/surf/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) { alert('创建失败：' + data.error); return; }
    closeSurfModal();
    await loadSurfConversations();
    renderConvList();
    selectSurfConv(data.id);
  } catch (e) { alert('创建失败：' + e.message); }
}

TAB_REGISTRY.surf = {
  view: 'surf',
  loadConvs: loadSurfConversations,
  renderItem: renderSurfConvItem,
  selectConv: selectSurfConv,
  onNewChat: (e) => { if (e) e.stopPropagation(); openSurfModal(); },
  emptyHint: '还没有冲浪\n点上面「新对话」开启一次',
  emptyHintNoSel: '点「新对话」开启一次冲浪',
};


// ──────────────────────────────────────────────────────────────────────────
//  回顾 (Review) — each conv = one review run. Same shape as 冲浪.
// ──────────────────────────────────────────────────────────────────────────

const reviewTabState = {
  current: null,
  sawUserMsg: false,        // toggles bubble style for bot messages
  modalSelectedSource: '',
  modalModelSlug: '',
};

async function loadReviewConversations() {
  try {
    const res = await fetch(`/api/review/conversations`);
    state.convsByTab.review = await res.json();
    if (!Array.isArray(state.convsByTab.review)) state.convsByTab.review = [];
  } catch (e) {
    console.error('load review convs:', e);
    state.convsByTab.review = [];
  }
}

function renderReviewConvItem(conv) {
  const el = document.createElement('div');
  el.className = 'conv-item';
  el.dataset.convId = conv.id;
  if (conv.id === state.currentConversationId) el.classList.add('active');
  const isPending = state.pendingReviews.has(conv.id) || conv.has_pending;
  const status = statusLabel(conv.status, isPending);
  const subtitle = conv.source_message_conv_id
    ? `源 · ${conv.source_message_conv_id.slice(0, 8)}`
    : '自由回顾';
  const modelHint = conv.model_slug ? conv.model_slug.split('/').pop() : '';
  const dot = isPending ? '<span class="conv-pending-dot"></span>' : '';
  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(conv.title || '回顾')}</span>
      <span class="conv-subtitle">${esc(subtitle)} · ${esc(modelHint)}</span>
      <span class="conv-debate-meta">${esc(status)}${dot ? ' ' + dot : ''}</span>
    </span>
    <span class="conv-actions">
      <button title="删除" class="danger" data-act="delete">
          <svg width="12" height="12"><use href="#icon-trash"/></svg>
      </button>
    </span>
  `;
  el.addEventListener('click', (e) => {
    const act = e.target.closest('button[data-act]');
    if (act) {
      e.stopPropagation();
      if (act.dataset.act === 'delete') deleteReviewConv(conv.id);
      return;
    }
    selectReviewConv(conv.id);
  });
  return el;
}

async function selectReviewConv(convId) {
  state.currentConversationId = convId;
  document.querySelectorAll('.conv-item').forEach(el => {
    el.classList.toggle('active', el.dataset.convId === convId);
  });
  applyTabView();

  // Reset per-conv local state — without this, switching from a conv with
  // user followups to one without leaves sawUserMsg=true and the first bot
  // bubble renders as a chat reply instead of the formal review conclusion.
  reviewTabState.sawUserMsg = false;

  try {
    const res = await fetch(`/api/review/conversations/${convId}`);
    reviewTabState.current = await res.json();
  } catch { reviewTabState.current = null; }
  updateReviewHeader();

  // The first bot message in a review conv is the structured self-review
  // conclusion (formal bubble); any bot message *after* a user followup is a
  // chat reply. sawUserMsg drives that switch in appendReviewRow.
  try {
    const res = await fetch(`/api/review/conversations/${convId}/messages`);
    const msgs = await res.json();
    const log = document.getElementById('review-log');
    log.innerHTML = '';
    for (const m of msgs) {
      appendReviewRow(m);
      if (m.sender_type === 'user') reviewTabState.sawUserMsg = true;
    }
    scrollReviewToBottom();
  } catch (e) { console.error('load review msgs:', e); }
}

function updateReviewHeader() {
  const c = reviewTabState.current;
  const title = document.getElementById('review-title');
  const meta = document.getElementById('review-meta');
  if (!c) {
    title.textContent = '回顾';
    meta.textContent = '';
    return;
  }
  title.textContent = c.title || '回顾';
  const isPending = state.pendingReviews.has(c.id);
  const parts = [
    `模型 ${c.model_slug ?? '—'}`,
    c.source_message_conv_id ? `源 ${c.source_message_conv_id.slice(0, 8)}` : '自由回顾',
    `状态 ${statusLabel(c.status, isPending)}`,
  ];
  meta.textContent = parts.join(' · ');
}

function appendReviewRow(m) {
  const log = document.getElementById('review-log');
  if (!log) return;

  if (m.sender_type === 'user') {
    const b = document.createElement('div');
    b.className = 'review-user-bubble';
    b.textContent = m.content;
    log.appendChild(b);
    return;
  }

  if (m.sender_type === 'bot') {
    // First bot message = formal self-review conclusion. Anything after a
    // user follow-up is a chat reply (rendered as a normal bubble).
    const isFollowup = reviewTabState.sawUserMsg;
    const b = document.createElement('div');
    b.className = isFollowup ? 'review-bot-bubble' : 'review-result-bubble';
    b.textContent = m.content;
    log.appendChild(b);
    return;
  }

  const row = document.createElement('div');
  const isError = (m.sender_id || '').endsWith(':error');
  row.className = 'surf-log-line' + (isError ? ' error' : '');
  const ts = m.created_at
    ? new Date(m.created_at * 1000).toLocaleTimeString('zh-CN', { hour12: false })
    : '';
  row.innerHTML = `
    <span class="surf-log-time">${esc(ts)}</span>
    <span class="surf-log-text">${esc(m.content)}</span>
  `;
  log.appendChild(row);
}

function scrollReviewToBottom() {
  const log = document.getElementById('review-log');
  if (!log) return;
  const scroller = log.parentElement;
  if (scroller) scroller.scrollTop = scroller.scrollHeight;
}

window.handleReviewSseLog = function (data) {
  if (!data) return;
  if (state.currentConversationId !== data.reviewConvId) {
    if (state.currentTab === 'review') {
      loadReviewConversations().then(renderConvList);
    }
    return;
  }
  appendReviewRow({
    sender_type: 'log',
    sender_id: `review:${data.kind}`,
    content: data.content,
    created_at: Math.floor((data.timestamp ?? Date.now()) / 1000),
  });
  scrollReviewToBottom();
};

window.handleReviewSseDone = function (data) {
  if (!data) return;
  if (state.currentConversationId === data.reviewConvId) {
    selectReviewConv(data.reviewConvId);
  }
  if (state.currentTab === 'review') {
    loadReviewConversations().then(renderConvList);
  }
};

async function sendReviewMessage() {
  const input = document.getElementById('review-msg-input');
  if (!input) return;
  const content = input.value.trim();
  if (!content) return;
  if (!state.currentConversationId) return;

  const convId = state.currentConversationId;

  // Optimistic render — append user bubble immediately so the screen feels
  // responsive. The next loadReview… reload (from SSE 'done') will reconcile.
  appendReviewRow({
    sender_type: 'user',
    sender_id: 'me',
    content,
    created_at: Math.floor(Date.now() / 1000),
  });
  reviewTabState.sawUserMsg = true;
  scrollReviewToBottom();

  input.value = '';
  autoResize(input);

  try {
    const res = await fetch(`/api/review/conversations/${convId}/message`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ content }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      alert('发送失败：' + (err.error || res.status));
    }
  } catch (e) {
    alert('发送失败：' + e.message);
  }
}

function setupReviewInput() {
  const input = document.getElementById('review-msg-input');
  if (!input || input.dataset.wired === '1') return;
  input.dataset.wired = '1';
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendReviewMessage();
    }
  });
  input.addEventListener('input', () => autoResize(input));
}
// Wire the review input once the DOM is ready. This file runs at the bottom
// of the body, so the textarea already exists by now.
setupReviewInput();

async function deleteReviewConv(convId) {
  if (!confirm('删除这次回顾？')) return;
  try {
    await fetch(`/api/review/conversations/${convId}`, { method: 'DELETE' });
    state.convsByTab.review = state.convsByTab.review.filter(c => c.id !== convId);
    if (state.currentConversationId === convId) {
      state.currentConversationId = null;
      applyTabView();
    }
    renderConvList();
  } catch (e) { alert('删除失败：' + e.message); }
}

function deleteCurrentReview() {
  if (state.currentConversationId) deleteReviewConv(state.currentConversationId);
}

async function rerunCurrentReview() {
  if (!state.currentConversationId) return;
  try { await fetch(`/api/review/run/${state.currentConversationId}`, { method: 'POST' }); }
  catch (e) { alert('启动失败：' + e.message); }
}

// ── Review modal ──

async function openReviewModal() {
  ensureModelPicker(document.getElementById('review-modal-model-host'), {
    value: '',
    placeholder: '默认（系统的「会话内自审」分配）',
    allowCustomSlug: true,
    onChange: (slug) => { reviewTabState.modalModelSlug = slug || ''; },
  });
  reviewTabState.modalSelectedSource = '';
  reviewTabState.modalModelSlug = '';

  const list = document.getElementById('review-modal-source-list');
  list.innerHTML = '<div class="modal-status-row">加载中…</div>';
  document.getElementById('review-modal').style.display = 'flex';
  try {
    const res = await fetch(`/api/review/sources`);
    const sources = await res.json();
    renderSourcePicker(list, sources, {
      withNoneRow: true,
      noneLabel: '— 不绑定（自由回顾） —',
      noneHint: '仅基于本回顾会话历史',
      onPick: (id) => { reviewTabState.modalSelectedSource = id; },
    });
  } catch (e) {
    list.innerHTML = `<div class="modal-status-row error">加载失败：${esc(e.message)}</div>`;
  }
}

function closeReviewModal(e) { closeModal('review-modal', e); }

async function submitReviewModal() {
  const body = { autoStart: true };
  if (reviewTabState.modalSelectedSource) body.sourceMessageConversationId = reviewTabState.modalSelectedSource;
  if (reviewTabState.modalModelSlug) body.modelSlug = reviewTabState.modalModelSlug;
  try {
    const res = await fetch('/api/review/conversations', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.error) { alert('创建失败：' + data.error); return; }
    closeReviewModal();
    await loadReviewConversations();
    renderConvList();
    selectReviewConv(data.id);
  } catch (e) { alert('创建失败：' + e.message); }
}

TAB_REGISTRY.review = {
  view: 'review',
  loadConvs: loadReviewConversations,
  renderItem: renderReviewConvItem,
  selectConv: selectReviewConv,
  onNewChat: (e) => { if (e) e.stopPropagation(); openReviewModal(); },
  emptyHint: '还没有回顾\n点上面「新对话」开启一次',
  emptyHintNoSel: '点「新对话」开启一次回顾',
};

// ── Auth: logout + admin panel ────────────────────────────────────────────

async function logoutAndReload() {
  try {
    await fetch('/api/logout', { method: 'POST' });
  } catch {}
  // Reload — bootAuth will see no cookie and render the login screen.
  location.replace(location.pathname);
}

// Admin panel — three-tab modal styled with the same .modal-* classes as
// the rest of the app (avoids the inline-style mess and matches dark mode).
async function showAdminPanel() {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';
  overlay.id = 'admin-modal';
  overlay.style.display = 'flex';
  overlay.innerHTML = `
    <div class="modal-card admin-modal-card" onclick="event.stopPropagation()">
      <div class="modal-head">
        <span>管理后台</span>
        <button class="modal-close" data-close aria-label="关闭">×</button>
      </div>
      <div class="admin-tabs" role="tablist">
        <button class="admin-tab active" data-pane="invites" role="tab">邀请</button>
        <button class="admin-tab" data-pane="users" role="tab">用户</button>
        <button class="admin-tab" data-pane="audit" role="tab">Token 用量</button>
      </div>
      <div class="modal-body">
        <div class="admin-pane active" data-pane="invites">
          <div class="admin-create-row">
            <input id="admin-invite-note" placeholder="备注（可选，比如：给老婆）">
            <button id="admin-invite-create" class="btn-primary">新建邀请</button>
          </div>
          <div id="admin-invite-list"></div>
        </div>
        <div class="admin-pane" data-pane="users">
          <div id="admin-user-list"></div>
        </div>
        <div class="admin-pane" data-pane="audit">
          <div id="admin-audit-table"></div>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);

  overlay.addEventListener('click', (e) => {
    if (e.target.dataset.close !== undefined || e.target === overlay) overlay.remove();
  });
  overlay.querySelectorAll('.admin-tab').forEach(t => t.addEventListener('click', () => {
    overlay.querySelectorAll('.admin-tab').forEach(x => x.classList.toggle('active', x === t));
    overlay.querySelectorAll('.admin-pane').forEach(p =>
      p.classList.toggle('active', p.dataset.pane === t.dataset.pane));
  }));
  document.getElementById('admin-invite-create').addEventListener('click', adminCreateInvite);
  document.getElementById('admin-invite-note').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') adminCreateInvite();
  });

  await Promise.all([adminLoadInvites(), adminLoadUsers(), adminLoadAudit()]);
}

function adminFormatTime(ts) {
  if (!ts) return '';
  const d = new Date(ts * 1000);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

async function adminLoadInvites() {
  const root = document.getElementById('admin-invite-list');
  if (!root) return;
  root.innerHTML = '<div class="admin-empty">加载中…</div>';
  try {
    const r = await fetch('/api/invites');
    const list = await r.json();
    if (!Array.isArray(list) || list.length === 0) {
      root.innerHTML = '<div class="admin-empty">还没有邀请，新建一条发出去吧</div>';
      return;
    }
    root.innerHTML = '';
    for (const inv of list) {
      const used = !!inv.redeemed_at;
      const tag = used
        ? '<span class="admin-tag admin-tag-used">已用</span>'
        : '<span class="admin-tag admin-tag-pending">待用</span>';
      const note = inv.note ? esc(inv.note) : '<span style="color:var(--text-4)">（无备注）</span>';
      const row = document.createElement('div');
      row.className = 'admin-row';
      row.innerHTML = `
        <div class="admin-row-main">
          <div class="admin-row-title">${note} ${tag}</div>
          <div class="admin-row-sub">${esc(inv.share_url)}</div>
          <div class="admin-row-meta">建于 ${esc(adminFormatTime(inv.created_at))}${used ? ' · 已被兑换' : ''}</div>
        </div>
        <div class="admin-row-actions">
          ${used ? '' : `<button class="btn-mini" data-copy="${esc(inv.share_url)}">复制链接</button>`}
          ${used ? '' : `<button class="btn-mini danger" data-revoke="${esc(inv.id)}">撤销</button>`}
        </div>`;
      root.appendChild(row);
    }
    root.querySelectorAll('[data-copy]').forEach(b => b.addEventListener('click', () => {
      navigator.clipboard.writeText(b.dataset.copy);
      const original = b.textContent;
      b.textContent = '已复制';
      setTimeout(() => { b.textContent = original; }, 1200);
    }));
    root.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', async () => {
      if (!confirm('撤销这条邀请？')) return;
      await fetch(`/api/invites/${b.dataset.revoke}`, { method: 'DELETE' });
      adminLoadInvites();
    }));
  } catch (e) {
    root.innerHTML = `<div class="admin-empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function adminCreateInvite() {
  const input = document.getElementById('admin-invite-note');
  const note = input.value.trim();
  try {
    const r = await fetch('/api/invites', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ note: note || undefined }),
    });
    if (!r.ok) {
      const j = await r.json().catch(() => ({}));
      alert('创建失败：' + (j.error || r.status));
      return;
    }
    input.value = '';
    adminLoadInvites();
  } catch (e) { alert('创建失败：' + e.message); }
}

async function adminLoadUsers() {
  const root = document.getElementById('admin-user-list');
  if (!root) return;
  root.innerHTML = '<div class="admin-empty">加载中…</div>';
  try {
    const r = await fetch('/api/admin/users');
    const list = await r.json();
    const visible = (Array.isArray(list) ? list : []).filter(u => u.channel !== 'system');
    if (visible.length === 0) {
      root.innerHTML = '<div class="admin-empty">还没有用户</div>';
      return;
    }
    root.innerHTML = '';
    for (const u of visible) {
      const row = document.createElement('div');
      row.className = 'admin-row';
      const adminTag = u.is_admin ? '<span class="admin-tag admin-tag-admin">admin</span>' : '';
      const channelTag = `<span class="admin-tag admin-tag-system">${esc(u.channel)}</span>`;
      row.innerHTML = `
        <div class="admin-row-main">
          <div class="admin-row-title">${esc(u.display_name)} ${adminTag} ${channelTag}</div>
          <div class="admin-row-meta">加入于 ${esc(adminFormatTime(u.created_at))}</div>
        </div>
        <div class="admin-row-actions">
          <button class="btn-mini" data-toggle="${esc(u.id)}" data-cur="${u.is_admin ? 1 : 0}">
            ${u.is_admin ? '降为普通' : '设为 admin'}
          </button>
        </div>`;
      root.appendChild(row);
    }
    root.querySelectorAll('[data-toggle]').forEach(b => b.addEventListener('click', async () => {
      const next = b.dataset.cur === '1' ? false : true;
      const r = await fetch(`/api/admin/users/${b.dataset.toggle}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ isAdmin: next }),
      });
      if (!r.ok) {
        const j = await r.json().catch(() => ({}));
        alert(j.error || `失败 (${r.status})`);
        return;
      }
      adminLoadUsers();
    }));
  } catch (e) {
    root.innerHTML = `<div class="admin-empty">加载失败：${esc(e.message)}</div>`;
  }
}

async function adminLoadAudit() {
  const root = document.getElementById('admin-audit-table');
  if (!root) return;
  root.innerHTML = '<div class="admin-empty">加载中…</div>';
  try {
    const r = await fetch('/api/admin/audit/summary?groupBy=user');
    const rows = await r.json();
    if (!Array.isArray(rows) || rows.length === 0) {
      root.innerHTML = '<div class="admin-empty">还没有 token 记录</div>';
      return;
    }
    const thead = `<thead><tr>
      <th>用户</th>
      <th class="num">调用</th>
      <th class="num">输入</th>
      <th class="num">输出</th>
      <th class="num">合计</th>
      <th class="num">cost ($)</th>
    </tr></thead>`;
    const tbody = rows.map(row => `<tr>
      <td>${esc(row.group_label || row.group_key || '—')}</td>
      <td class="num">${row.count ?? 0}</td>
      <td class="num">${(row.total_input ?? 0).toLocaleString()}</td>
      <td class="num">${(row.total_output ?? 0).toLocaleString()}</td>
      <td class="num-strong">${(row.total_tokens ?? 0).toLocaleString()}</td>
      <td class="num">${row.total_cost != null ? Number(row.total_cost).toFixed(4) : '—'}</td>
    </tr>`).join('');
    root.innerHTML = `<table class="admin-table">${thead}<tbody>${tbody}</tbody></table>`;
  } catch (e) {
    root.innerHTML = `<div class="admin-empty">加载失败：${esc(e.message)}</div>`;
  }
}
