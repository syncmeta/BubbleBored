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
  // Chat tone — 'wechat' (multi-bubble, casual) or 'normal' (single-message AI).
  // Default to 'wechat' to preserve existing behaviour.
  chatTone: localStorage.getItem('bb_chatTone') === 'normal' ? 'normal' : 'wechat',
  // 联网搜索 toggle. When on, every send carries metadata.webSearch=true and
  // the backend runs a one-shot Jina search before invoking the LLM.
  // Persisted across reloads — matches ChatGPT's "🔍 search" mental model.
  webSearch: localStorage.getItem('bb_webSearch') === '1',
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
  // Pending uploads — drafts in the composer tray, awaiting send.
  // Each entry: { clientId, file, previewUrl, status, attachmentId?, url?, error? }
  pendingAttachments: [],
  dragCounter: 0,
  // True when the current bot's primary model has no image input (e.g.
  // text-only models). Set in updateChatHeader → refreshAttachAvailability.
  imageUploadBlocked: false,
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

// Renders a "pick which bot" pill row for surf / review modals. Single-select,
// required (no "all bots" row — surf/review always run as one specific bot).
// `selectedId` controls the initial highlight; `onPick(botId)` fires on change.
function renderModalBotPicker(host, opts) {
  if (!host) return;
  host.innerHTML = '';
  const selectedId = opts.selectedId || '';
  const bots = state.bots || [];
  if (bots.length === 0) {
    host.innerHTML = `<div class="modal-status-row">没有配置机器人</div>`;
    return;
  }
  for (const b of bots) {
    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'bot-pick-pill' + (b.id === selectedId ? ' selected' : '');
    pill.dataset.botId = b.id;
    pill.innerHTML =
      `<span class="bot-avatar emoji" style="background:${botColor(b.id)}">${botEmoji(b.id)}</span>` +
      `<span>${esc(b.display_name || b.id)}</span>`;
    pill.addEventListener('click', () => {
      host.querySelectorAll('.bot-pick-pill').forEach(p => p.classList.remove('selected'));
      pill.classList.add('selected');
      if (opts.onPick) opts.onPick(b.id);
    });
    host.appendChild(pill);
  }
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
  renderToneButton();
  renderWebSearchButton();
  renderSkillsChip();
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

// Curated emoji pool for bot avatars. Heavy on faces + friendly creatures so
// every bot ends up with a recognisable little face. Keep this list trimmed
// of anything that might render text-only on older platforms.
const BOT_EMOJI_POOL = [
  '😀','😄','😆','😊','🙂','😉','😌','😎','🤓','🧐','🤠','🥳','🤩','🤖','👽','🤡',
  '👻','💀','😺','😸','😹','😻','🙀','🐶','🐱','🦊','🦝','🐻','🐼','🐨','🐯','🦁',
  '🐮','🐷','🐸','🐵','🙈','🐔','🐧','🐦','🦆','🦉','🦅','🐝','🦋','🐌','🐙','🦑',
  '🐠','🐬','🦈','🐳','🐲','🦖','🦕','🐢','🦎','🐍','🦄','🐴','🦓','🦒','🐘','🦏',
  '🦛','🐪','🦘','🐹','🐭','🐰','🦔','🦦','🦥','🐾','🌵','🌲','🌳','🌴','🌱','🍀',
  '🍄','🌷','🌹','🌻','🌼','🌸','🌺','🌟','⭐','✨','⚡','🔥','💧','🌊','🌈','☀️',
  '🌙','🪐','🛸','🚀','🎈','🎁','🎨','🎭','🎯','🎲','🎮','🕹️','🎵','🎷','🎸','🥁',
];

// Stable hash of botId → both hue and emoji index. Same bot always lands on
// the same pale color and emoji, no storage needed.
function _botHash(botId) {
  const s = botId || '';
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

function botColor(botId) {
  return `hsl(${_botHash(botId) % 360}, 55%, 90%)`;
}

function botEmoji(botId) {
  // Use a different mixing constant so the emoji choice doesn't track the hue.
  const h = _botHash(botId);
  return BOT_EMOJI_POOL[((h * 2654435761) >>> 0) % BOT_EMOJI_POOL.length];
}

// Bot label = display name + the live model tag (provider prefix dropped),
// e.g. "01 · glm-5.1". The model comes from `bot.config.model` (web /api/bots
// embeds the full bot config), so it stays in sync with config edits.
function botModelTag(bot) {
  const slug = bot?.config?.model || bot?.model;
  if (!slug) return '';
  const slash = slug.lastIndexOf('/');
  return slash >= 0 ? slug.slice(slash + 1) : slug;
}

function botLabel(bot) {
  const name = bot?.display_name || bot?.id || '?';
  const tag = botModelTag(bot);
  return tag ? `${name} · ${tag}` : name;
}

function botAvatarHTML(botId) {
  return `<span class="bot-avatar emoji" style="background:${botColor(botId)}">${botEmoji(botId)}</span>`;
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
    root.classList.remove('open');
    return;
  }

  const counts = new Map();
  for (const conv of state.conversations) {
    counts.set(conv.bot_id, (counts.get(conv.bot_id) || 0) + 1);
  }

  // Build a single dropdown trigger + popover. The popover is collapsed by
  // default; toggling adds .open to the wrapper.
  const selBot = state.botFilter ? state.botsById.get(state.botFilter) : null;
  const triggerLabel = selBot
    ? `${esc(selBot.display_name || selBot.id)}`
    : '全部机器人';
  const triggerCount = state.botFilter
    ? (counts.get(state.botFilter) || 0)
    : state.conversations.length;
  const triggerAvatar = selBot
    ? `<span class="bot-avatar emoji" style="background:${botColor(selBot.id)}">${botEmoji(selBot.id)}</span>`
    : '';

  const items = [
    `<button class="bot-dd-item ${state.botFilter === '' ? 'active' : ''}" data-bot="">
       <span class="bot-dd-name">全部机器人</span>
       <span class="bot-dd-count">${state.conversations.length}</span>
     </button>`,
    ...state.bots.map(b => {
      const count = counts.get(b.id) || 0;
      const active = state.botFilter === b.id ? 'active' : '';
      return `
        <button class="bot-dd-item ${active}" data-bot="${esc(b.id)}">
          <span class="bot-avatar emoji" style="background:${botColor(b.id)}">${botEmoji(b.id)}</span>
          <span class="bot-dd-name">${esc(b.display_name || b.id)}</span>
          ${count > 0 ? `<span class="bot-dd-count">${count}</span>` : ''}
        </button>
      `;
    }),
  ].join('');

  root.innerHTML = `
    <button class="bot-dd-trigger" type="button" aria-haspopup="listbox" aria-expanded="false">
      ${triggerAvatar}
      <span class="bot-dd-name">${triggerLabel}</span>
      <span class="bot-dd-count">${triggerCount}</span>
      <svg class="bot-dd-chevron" width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round">
        <path d="M6 9l6 6 6-6"/>
      </svg>
    </button>
    <div class="bot-dd-popover" role="listbox">${items}</div>
  `;

  const trigger = root.querySelector('.bot-dd-trigger');
  const popover = root.querySelector('.bot-dd-popover');

  function close() {
    root.classList.remove('open');
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('mousedown', onOutside, true);
    document.removeEventListener('keydown', onKey, true);
  }
  function open() {
    root.classList.add('open');
    trigger.setAttribute('aria-expanded', 'true');
    document.addEventListener('mousedown', onOutside, true);
    document.addEventListener('keydown', onKey, true);
  }
  function onOutside(e) { if (!root.contains(e.target)) close(); }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    if (root.classList.contains('open')) close();
    else open();
  });
  for (const btn of popover.querySelectorAll('.bot-dd-item')) {
    btn.addEventListener('click', () => {
      setBotFilter(btn.dataset.bot);
      close();
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
    label.textContent = `新对话 · ${botLabel(bot)}`;
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
    const hint = state.botFilter ? '没有该机器人的对话' : '还没有对话';
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
  const botName = bot ? botLabel(bot) : conv.bot_id;
  botEl.innerHTML = `${botAvatarHTML(conv.bot_id)}<span>${esc(botName)}</span>`;

  renderToneButton();
  renderWebSearchButton();
  renderSkillsChip();
  refreshAttachAvailability(bot);
}

// Disable image upload (button + paste + drop) when the bot's model has no
// vision input. Banner under the composer explains why so users don't think
// the button is broken.
async function refreshAttachAvailability(bot) {
  const btn = document.getElementById('attach-btn');
  const tip = document.getElementById('no-vision-tip');
  if (!btn || !tip) return;

  const slug = bot?.config?.model || bot?.model || null;
  // Pre-populate from cached registry if hot.
  let supports = window.modelLookup ? window.modelLookup.supportsImageInput(slug) : null;
  if (supports === null && slug && window.modelLookup) {
    // Cache cold — wait once, then re-check. Keep current state permissive
    // until we know for sure.
    await window.modelLookup.ready();
    supports = window.modelLookup.supportsImageInput(slug);
  }

  // Treat null (unknown) as allowed to avoid false negatives.
  const blocked = supports === false;
  state.imageUploadBlocked = blocked;

  btn.disabled = blocked;
  btn.classList.toggle('disabled', blocked);
  if (blocked) {
    const tag = botModelTag(bot);
    btn.title = `当前模型 ${tag || ''} 不支持识别图片，无法上传`;
    tip.textContent = `当前 Bot 使用的模型${tag ? `（${tag}）` : ''}不支持图像识别，已停用图片上传。在「设置 → Bot → 模型」中切换为带「视觉」标签的模型即可启用。`;
    tip.style.display = 'block';
  } else {
    btn.title = '添加图片  (也可拖放或粘贴)';
    tip.style.display = 'none';
  }
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
    alert('没有可用的机器人');
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
    item.innerHTML = `${botAvatarHTML(bot.id)}<span>${esc(botLabel(bot))}</span>`;
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

// ── Chat tone (微信聊天 / 普通AI) ──

function renderToneButton() {
  const btn = document.getElementById('tone-btn');
  if (!btn) return;
  const isNormal = state.chatTone === 'normal';
  btn.textContent = isNormal ? '普通AI语气' : '微信语气';
  btn.classList.toggle('tone-normal', isNormal);
  btn.title = isNormal
    ? '当前：普通AI语气（单条消息、像 ChatGPT 一样回复）— 点击切换为「微信语气」'
    : '当前：微信语气（短句、多条气泡）— 点击切换为「普通AI语气」';
}

function toggleChatTone() {
  state.chatTone = state.chatTone === 'normal' ? 'wechat' : 'normal';
  localStorage.setItem('bb_chatTone', state.chatTone);
  renderToneButton();
}

// ── 联网搜索 toggle ──

function renderWebSearchButton() {
  const btn = document.getElementById('websearch-btn');
  if (!btn) return;
  btn.classList.toggle('on', state.webSearch);
  btn.title = state.webSearch
    ? '联网搜索：开 — 每次发送都会先搜一遍网络再让机器人作答（点击关闭）'
    : '联网搜索：关 — 机器人只用自身知识作答（点击打开）';
}

function toggleWebSearch() {
  state.webSearch = !state.webSearch;
  localStorage.setItem('bb_webSearch', state.webSearch ? '1' : '0');
  renderWebSearchButton();
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

// Markdown rendering: each bubble is a self-contained markdown island.
// Backend already segments on \n\n with code-fence awareness so cross-segment
// list/heading state never leaks. The raw source is parked on
// `textEl.dataset.raw` so edit mode can show plain text and so we can
// re-render after cancel without an extra round-trip.

let _markedConfigured = false;
function _configureMarked() {
  if (_markedConfigured || !window.marked) return;
  // breaks: a single \n becomes <br> — matches chat-style line breaks where
  // people don't double-newline between thoughts. gfm covers tables / strike
  // / task lists.
  window.marked.setOptions({ breaks: true, gfm: true });
  // Override the link renderer to (a) gate href schemes (no javascript:,
  // data:, vbscript:) and (b) open external links in a new tab safely.
  // marked v12 passes a token object to renderer.link.
  const renderer = new window.marked.Renderer();
  renderer.link = function ({ href, title, tokens }) {
    const text = this.parser.parseInline(tokens);
    const safe = _safeHref(href);
    const t = title ? ` title="${_escAttr(title)}"` : '';
    if (!safe) return `<span class="md-bad-link">${text}</span>`;
    return `<a href="${_escAttr(safe)}"${t} target="_blank" rel="noopener noreferrer">${text}</a>`;
  };
  // Mark fenced code blocks with the language so the toolbar can decide
  // whether to show a Run button.
  renderer.code = function ({ text, lang }) {
    const cls = lang ? ` class="language-${_escAttr(String(lang).toLowerCase())}"` : '';
    return `<pre><code${cls}>${_escHtml(text)}</code></pre>`;
  };
  window.marked.use({ renderer });
  _markedConfigured = true;
}

function _safeHref(href) {
  if (!href) return null;
  const trimmed = String(href).trim();
  // Reject control chars that browsers might normalize away.
  if (/[ -]/.test(trimmed)) return null;
  // Allow relative refs (starting with /, #, ?) and explicit http/https/mailto/tel.
  if (/^(https?:|mailto:|tel:|\/|#|\?)/i.test(trimmed)) return trimmed;
  // Bare domain — treat as https.
  if (/^[a-z0-9.-]+\.[a-z]{2,}(\/|$)/i.test(trimmed)) return 'https://' + trimmed;
  return null;
}

function _escHtml(s) {
  return String(s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
}
function _escAttr(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

const _DOMPURIFY_CONFIG = {
  // Allow the standard markdown-friendly tag set; explicitly forbid <iframe>
  // (the code-runner injects its own iframes via createElement, never via
  // sanitized content) and <style>/<form>/<input>.
  ALLOWED_TAGS: [
    'a', 'abbr', 'b', 'blockquote', 'br', 'code', 'del', 'div', 'em',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'hr', 'i', 'img', 'ins', 'kbd',
    'li', 'mark', 'ol', 'p', 'pre', 's', 'samp', 'small', 'span', 'strong',
    'sub', 'sup', 'table', 'tbody', 'td', 'tfoot', 'th', 'thead', 'tr',
    'u', 'ul', 'details', 'summary',
  ],
  ALLOWED_ATTR: ['href', 'title', 'target', 'rel', 'src', 'alt', 'class', 'colspan', 'rowspan', 'open'],
  // DOMPurify rejects javascript:/data: in href/src by default; this just
  // adds an extra safety net so authors can't sneak in vbscript: either.
  ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel):|[/#?])/i,
  ALLOW_DATA_ATTR: false,
};

function renderMarkdownInto(textEl, raw) {
  const text = raw == null ? '' : String(raw);
  textEl.dataset.raw = text;
  if (!text) {
    textEl.textContent = '';
    return;
  }
  if (!window.marked || !window.DOMPurify) {
    textEl.textContent = text;
    return;
  }
  _configureMarked();
  let html;
  try {
    html = window.marked.parse(text);
  } catch (e) {
    console.warn('marked parse error:', e);
    textEl.textContent = text;
    return;
  }
  textEl.innerHTML = window.DOMPurify.sanitize(html, _DOMPURIFY_CONFIG);
  enhanceCodeBlocks(textEl);
}

function getMessageRaw(textEl) {
  if (!textEl) return '';
  return textEl.dataset.raw ?? textEl.textContent ?? '';
}

// Languages we can run client-side. Anything else gets the copy button only.
const RUNNABLE_LANGS = new Set(['js', 'javascript', 'html']);

function _codeLangFromEl(codeEl) {
  const cls = codeEl.className || '';
  const m = cls.match(/language-([\w+-]+)/);
  return m ? m[1].toLowerCase() : '';
}

function enhanceCodeBlocks(scope) {
  const pres = scope.querySelectorAll('pre');
  for (const pre of pres) {
    if (pre.dataset.enhanced) continue;
    pre.dataset.enhanced = '1';
    const codeEl = pre.querySelector('code');
    if (!codeEl) continue;
    const lang = _codeLangFromEl(codeEl);

    const bar = document.createElement('div');
    bar.className = 'code-toolbar';
    if (lang) {
      const tag = document.createElement('span');
      tag.className = 'code-lang';
      tag.textContent = lang;
      bar.appendChild(tag);
    }

    const copyBtn = document.createElement('button');
    copyBtn.type = 'button';
    copyBtn.className = 'code-btn';
    copyBtn.textContent = '复制';
    copyBtn.addEventListener('click', async () => {
      try {
        await navigator.clipboard.writeText(codeEl.textContent ?? '');
        copyBtn.textContent = '已复制';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1200);
      } catch {
        copyBtn.textContent = '复制失败';
        setTimeout(() => { copyBtn.textContent = '复制'; }, 1500);
      }
    });
    bar.appendChild(copyBtn);

    if (RUNNABLE_LANGS.has(lang)) {
      const runBtn = document.createElement('button');
      runBtn.type = 'button';
      runBtn.className = 'code-btn run';
      runBtn.textContent = '▶ 运行';
      runBtn.addEventListener('click', () => runCodeBlock(pre, codeEl, lang));
      bar.appendChild(runBtn);
    }

    pre.insertBefore(bar, pre.firstChild);
  }
}

// Run a code block in a sandboxed iframe. JS / HTML only — anything else is
// rejected by enhanceCodeBlocks before this is reached. The iframe has
// allow-scripts but NOT allow-same-origin, so it's a fresh cross-origin
// realm with no access to cookies / localStorage / parent DOM. Output is
// captured by overriding console.* before user code runs and posted back
// via window.parent.postMessage. A 5s timeout kills runaway loops.
const RUN_TIMEOUT_MS = 5000;

function runCodeBlock(pre, codeEl, lang) {
  const source = codeEl.textContent ?? '';

  // One output panel per <pre>; subsequent runs overwrite the previous output.
  let panel = pre.nextElementSibling;
  if (!panel || !panel.classList?.contains('code-output')) {
    panel = document.createElement('div');
    panel.className = 'code-output';
    pre.insertAdjacentElement('afterend', panel);
  }
  panel.textContent = '运行中…';
  panel.classList.remove('error');

  const runId = 'r_' + Math.random().toString(36).slice(2, 10);
  const iframe = document.createElement('iframe');
  iframe.setAttribute('sandbox', 'allow-scripts');
  iframe.style.display = 'none';
  iframe.dataset.runId = runId;

  let lines = [];
  let killed = false;
  const flush = () => {
    panel.textContent = lines.join('\n') || '(无输出)';
  };

  const onMessage = (ev) => {
    if (ev.source !== iframe.contentWindow) return;
    const data = ev.data;
    if (!data || data.runId !== runId) return;
    if (data.type === 'log') {
      lines.push(data.text);
      flush();
    } else if (data.type === 'error') {
      lines.push('✗ ' + data.text);
      panel.classList.add('error');
      flush();
      cleanup();
    } else if (data.type === 'done') {
      if (lines.length === 0) panel.textContent = '(无输出)';
      cleanup();
    }
  };
  const cleanup = () => {
    if (killed) return;
    killed = true;
    window.removeEventListener('message', onMessage);
    clearTimeout(timer);
    setTimeout(() => iframe.remove(), 50);
  };
  window.addEventListener('message', onMessage);

  const timer = setTimeout(() => {
    if (killed) return;
    lines.push('⏱ 超时（5s），已中断');
    panel.classList.add('error');
    flush();
    cleanup();
  }, RUN_TIMEOUT_MS);

  // Build the iframe's HTML. For HTML blocks, we render the source as the
  // page body so the user can preview a snippet. For JS, we wrap the source
  // in a try/catch and pipe console.log/info/warn/error/dir back via
  // postMessage. JSON-stringify args to keep transport simple.
  const isHtml = lang === 'html';
  const escSource = source
    .replace(/<\/script>/gi, '<\\/script>')
    .replace(/<!--/g, '<\\!--');
  const RUN_ID_LITERAL = JSON.stringify(runId);
  const bootstrap = `
    (function(){
      var RID=${RUN_ID_LITERAL};
      function fmt(a){
        if (a instanceof Error) return a.stack || (a.name+': '+a.message);
        if (typeof a === 'string') return a;
        try { return JSON.stringify(a, function(k,v){
          if (typeof v === 'function') return '[Function '+(v.name||'')+']';
          if (typeof v === 'undefined') return '[undefined]';
          return v;
        }, 2); } catch(_) { return String(a); }
      }
      function send(type, text){
        try { parent.postMessage({runId:RID, type:type, text:text}, '*'); } catch(_){}
      }
      ['log','info','warn','error','debug','dir'].forEach(function(k){
        var prev = console[k];
        console[k] = function(){
          var parts = [];
          for (var i=0;i<arguments.length;i++) parts.push(fmt(arguments[i]));
          send('log', parts.join(' '));
          if (prev) try { prev.apply(console, arguments); } catch(_){}
        };
      });
      window.addEventListener('error', function(ev){
        send('error', (ev.error && (ev.error.stack || ev.error.message)) || ev.message || 'unknown error');
      });
      window.addEventListener('unhandledrejection', function(ev){
        send('error', 'Unhandled rejection: ' + fmt(ev.reason));
      });
    })();`;

  let srcdoc;
  if (isHtml) {
    srcdoc = `<!doctype html><html><head><meta charset="utf-8"><script>${bootstrap}<\/script></head><body>\n${escSource}\n<script>parent.postMessage({runId:${RUN_ID_LITERAL}, type:'done'}, '*');<\/script></body></html>`;
  } else {
    srcdoc = `<!doctype html><html><head><meta charset="utf-8"></head><body><script>${bootstrap}
try {
${escSource}
} catch (e) {
  parent.postMessage({runId:${RUN_ID_LITERAL}, type:'error', text:(e && (e.stack||e.message))||String(e)}, '*');
}
parent.postMessage({runId:${RUN_ID_LITERAL}, type:'done'}, '*');
<\/script></body></html>`;
  }
  iframe.srcdoc = srcdoc;
  document.body.appendChild(iframe);
}

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
    renderMarkdownInto(textEl, content);
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

  if (type === 'bot' && hasText) {
    // Quick "save as skill" for any bot bubble — captures its raw markdown
    // body as a skill draft. Backend already exists; this is just a faster
    // path than copy-pasting into the 「我」 tab form.
    const save = document.createElement('button');
    save.className = 'msg-save-skill';
    save.type = 'button';
    save.title = '保存为技能';
    save.setAttribute('aria-label', '保存为技能');
    save.innerHTML = `
      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z"/>
        <polyline points="17 21 17 13 7 13 7 21"/>
        <polyline points="7 3 7 8 15 8"/>
      </svg>
    `;
    save.addEventListener('click', () => {
      const textEl = bubble.querySelector('.msg-text');
      openSaveAsSkillModal(getMessageRaw(textEl));
    });
    actions.appendChild(save);
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

  // Edit mode shows raw markdown, not the rendered HTML — otherwise the
  // user would be poking at <strong>/<a> nodes instead of the source they
  // typed. Park the rendered HTML on the side so we can restore it on cancel.
  const originalText = getMessageRaw(textEl);
  const renderedHTML = textEl.innerHTML;
  textEl.textContent = originalText;
  delete textEl.dataset.raw;

  textEl.setAttribute('contenteditable', 'plaintext-only');
  // Fallback for browsers without plaintext-only support: plain contenteditable.
  if (textEl.contentEditable !== 'plaintext-only') {
    textEl.setAttribute('contenteditable', 'true');
  }
  textEl.spellcheck = false;
  textEl.classList.add('editing-text');
  wrap.classList.add('editing');

  edits.set(msgId, { original: originalText, renderedHTML, wrap, textEl });

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
  const { wrap, textEl, original, renderedHTML, onInput, onKey } = e;
  if (onInput) textEl.removeEventListener('input', onInput);
  if (onKey) textEl.removeEventListener('keydown', onKey);
  textEl.removeAttribute('contenteditable');
  textEl.classList.remove('editing-text');
  wrap.classList.remove('editing', 'edited');
  if (!commit) {
    // Restore the rendered markdown HTML on cancel.
    if (renderedHTML !== undefined) {
      textEl.innerHTML = renderedHTML;
      textEl.dataset.raw = original;
    } else {
      textEl.textContent = original;
    }
  }
  // If this was an image-only bubble that we added a blank .msg-text to,
  // remove it on commit/cancel if it's still empty to keep the bubble
  // compact like before. Done BEFORE re-rendering markdown so the textContent
  // check sees the raw user-typed value, not whatever marked produces.
  const bubble = wrap.querySelector('.msg');
  if (bubble?.classList.contains('has-images') && (textEl.textContent ?? '').trim() === '') {
    textEl.remove();
    bubble.classList.add('image-only');
  } else if (commit) {
    // Re-render the new raw text as markdown so the bubble matches what
    // every other rendered bubble looks like.
    renderMarkdownInto(textEl, textEl.textContent ?? '');
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
      metadata: { tone: state.chatTone, webSearch: state.webSearch },
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
  if (state.imageUploadBlocked) {
    flashAttachmentTray();
    return;
  }
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
      if (state.imageUploadBlocked) {
        flashAttachmentTray();
        return;
      }
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
      if (state.imageUploadBlocked) {
        fileInput.value = '';
        flashAttachmentTray();
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
      if (state.imageUploadBlocked) return;
      e.preventDefault();
      state.dragCounter++;
      overlay.classList.add('active');
    });
    chatView.addEventListener('dragover', (e) => {
      if (!isImageDrag(e) || !state.currentConversationId) return;
      if (state.imageUploadBlocked) return;
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
      if (state.imageUploadBlocked) {
        flashAttachmentTray();
        return;
      }
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

// 议论 default lineup — every configured bot joins by default. We resolve
// it lazily from state.bots so the user editing config.yaml flows straight
// through (no slug list to keep in sync).
const DEFAULT_DEBATE_MAX_MSGS = 30;
function getDefaultDebateBotIds() {
  return state.bots.map(b => b.id);
}
function getDebateMaxMsgs() {
  // Prefer the per-session value stamped at creation time; fall back to the
  // localStorage knob (used as the modal default) and finally the global cap.
  const sessionVal = debateState.currentDebate?.max_messages;
  if (Number.isFinite(sessionVal) && sessionVal > 0) return Math.min(sessionVal, 200);
  const v = parseInt(localStorage.getItem('debate-max-msgs') || '', 10);
  return Number.isFinite(v) && v > 0 ? Math.min(v, 200) : DEFAULT_DEBATE_MAX_MSGS;
}
function setDebateMaxMsgs(n) {
  localStorage.setItem('debate-max-msgs', String(n));
}

const debateState = {
  currentDebate: null,           // hydrated debate conv (with topic + bot_ids)
  pickedBotIds: new Set(),       // for the modal
  busyConvIds: new Set(),
  modalMode: 'create',           // 'create' | 'edit'
  es: null,
};

// Stable color from any string id (mirrors botColor()).
function modelColor(slug) {
  let h = 0;
  for (let i = 0; i < (slug || '').length; i++) h = (h * 31 + slug.charCodeAt(i)) | 0;
  const hue = Math.abs(h) % 360;
  return `hsl(${hue}, 60%, 55%)`;
}

// Hook into loadConversations: when on the debate tab, hit the debate-specific
// list endpoint that hydrates topic + bot_ids.
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
  const botDots = (conv.bot_ids ?? []).slice(0, 5).map(id =>
    `<span class="conv-model-dot" style="background:${botColor(id)}" title="${esc(id)}"></span>`
  ).join('');

  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(title)}</span>
      <span class="conv-subtitle">${subtitle}</span>
      <span class="conv-debate-meta">${botDots} <span>· ${conv.round_count_debate ?? 0} 轮</span></span>
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
  const ids = d.bot_ids ?? [];
  const botNames = ids.map(id => state.botsById.get(id)?.display_name || id).join(' · ');
  meta.textContent = `${ids.length} 个机器人 · ${d.round_count_debate ?? 0} 轮 · ${botNames}`;
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
    const botId = m.sender_id || m.metadata?.bot_id || m.metadata?.slug || '';
    const bot = state.botsById.get(botId);
    const name = m.metadata?.display_name || bot?.display_name || botId;
    // Use the bot's underlying model slug for the brand avatar so e.g. a
    // bot named "deepseek-v4-pro" still gets the deepseek logo.
    const modelSlug = bot?.config?.model || botId;
    el.className = 'debate-msg debater';
    el.dataset.botid = botId;
    // Collapse the avatar + name when the previous bubble is from the same speaker.
    const prev = root.lastElementChild;
    if (prev && prev.classList.contains('debater') && prev.dataset.botid === botId) {
      el.classList.add('same-speaker');
    }
    const av = providerAvatarHTML(modelSlug, name);
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
    await fetch(`/api/debate/conversations/${convId}/round`, {
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
    await fetch(`/api/debate/conversations/${convId}/pause`, { method: 'POST' });
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
    await fetch(`/api/debate/conversations/${convId}/clarify`, {
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
    debateState.pickedBotIds = new Set(existingDebate.bot_ids || []);
  } else {
    title.textContent = '新议论';
    submitBtn.textContent = '创建议论';
    topicEl.value = '';
    debateState.pickedBotIds = new Set(getDefaultDebateBotIds());
  }

  const maxEl = document.getElementById('debate-modal-max-msgs');
  if (maxEl) maxEl.value = String(getDebateMaxMsgs());

  renderDebateModalBots();
  document.getElementById('debate-modal').style.display = 'flex';
}

// Multi-select list of configured bots (state.bots). One row per bot with
// a checkbox + display name + the underlying model slug. No search bar —
// the bot list is small and curated.
function renderDebateModalBots() {
  const host = document.getElementById('debate-modal-bots-host');
  if (!host) return;
  host.innerHTML = '';
  const list = document.createElement('div');
  list.className = 'debate-bot-picker';

  if (state.bots.length === 0) {
    list.innerHTML = `<div class="debate-bot-empty">还没配置机器人 — 在 config.yaml 里加几个再来</div>`;
    host.appendChild(list);
    return;
  }

  for (const b of state.bots) {
    const row = document.createElement('label');
    row.className = 'debate-bot-row';
    const checked = debateState.pickedBotIds.has(b.id) ? 'checked' : '';
    const model = b.config?.model || '';
    // Bot name + the model it currently runs as two separate pill tags so it's
    // obvious which underlying brain each participant is using.
    const modelTag = model
      ? `<span class="debate-bot-tag model" title="${esc(model)}">${esc(model)}</span>`
      : '';
    row.innerHTML = `
      <input type="checkbox" data-bot-id="${esc(b.id)}" ${checked}>
      <span class="bot-avatar emoji" style="background:${botColor(b.id)}">${botEmoji(b.id)}</span>
      <span class="debate-bot-tags">
        <span class="debate-bot-tag name">${esc(b.display_name || b.id)}</span>
        ${modelTag}
      </span>
    `;
    const cb = row.querySelector('input');
    cb.addEventListener('change', () => {
      if (cb.checked) debateState.pickedBotIds.add(b.id);
      else debateState.pickedBotIds.delete(b.id);
    });
    list.appendChild(row);
  }
  host.appendChild(list);
}

// Legacy alias kept for any inline onclick attributes that still reference it.
function closeDebateModal(e) { closeModal('debate-modal', e); }

async function submitDebateModal() {
  const ids = Array.from(debateState.pickedBotIds);
  if (ids.length < 2) {
    alert('至少勾两个机器人');
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
        botIds: ids,
        maxMessages,
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
    await selectDebateConv(data.id);
    // Kick off the first round immediately — saves the user one click for the
    // common "create then talk" path.
    runDebateRoundClick();
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
  debateState.es.addEventListener('done', async (e) => {
    try {
      const data = JSON.parse(e.data);
      if (state.currentConversationId === data.conversationId) {
        setDebateBusy(false);
        const tail = data.paused
          ? `Round ${data.round} 已暂停 · ${data.delivered} 条`
          : `Round ${data.round} 完成 · ${data.delivered} 条`;
        setDebateStatus(tail);
        // Re-fetch the conv so the auto-generated round title (and bumped
        // round count) shows up in the header without a manual refresh.
        try {
          const res = await fetch(`/api/debate/conversations/${data.conversationId}`);
          debateState.currentDebate = await res.json();
        } catch {}
        updateDebateHeader();
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
        sender_id: msg.metadata?.bot_id ?? msg.metadata?.slug ?? '',
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
  // it. Empty value means "use this bot's default model" (resolved on the
  // server via the bot's `model` field in config.yaml).
  ensureModelPicker(document.getElementById('portrait-model-host'), {
    value: portraitState.modelOverride || '',
    placeholder: '默认（机器人模型）',
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
//  「你」 tab — basic info + AI picks + skills
// ──────────────────────────────────────────────────────────────────────────

async function loadMeView() {
  await Promise.all([
    loadMyProfile(),
    loadMyPicks(),
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
  if (!confirm(`撤销 "${name}" 的钥匙? 持有者将立即无法访问,所有聊天、画像、附件等数据也会一起清掉。\n此操作不可撤销。`)) return;
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
    invalidateSkillsCache();
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
    invalidateSkillsCache();
  } catch (e) { alert('创建失败：' + e.message); }
}

// ── Skills chip + popover (chat header) ─────────────────────────────────
// A small chat-header pill that shows how many skills are currently enabled
// and opens a popover for quick toggles, mirroring the same /api/skills
// endpoints the 「我」 tab uses. The cache is shared so toggling in either
// place updates the other on next render. The popover has a "前往「我」"
// link for richer editing (description / body / preset reseed).

let _skillsCache = null; // [{ id, name, description, enabled, ... }]
let _skillsCacheAt = 0;
const _SKILLS_CACHE_TTL = 30_000;

function invalidateSkillsCache() {
  _skillsCache = null;
  _skillsCacheAt = 0;
  renderSkillsChip();
}

async function fetchSkillsCached(force) {
  const fresh = !force && _skillsCache && (Date.now() - _skillsCacheAt) < _SKILLS_CACHE_TTL;
  if (fresh) return _skillsCache;
  try {
    const res = await fetch('/api/skills');
    const rows = await res.json();
    if (Array.isArray(rows)) {
      _skillsCache = rows;
      _skillsCacheAt = Date.now();
    }
  } catch (e) {
    console.warn('skills fetch failed:', e);
  }
  return _skillsCache ?? [];
}

async function renderSkillsChip() {
  const btn = document.getElementById('skills-chip-btn');
  if (!btn) return;
  const skills = await fetchSkillsCached(false);
  const enabledCount = skills.filter(s => s.enabled).length;
  // Show the icon always when rendered; show count only when > 0 so
  // "🧩 0" doesn't shout. Hidden entirely if there are no skills at all.
  if (skills.length === 0) {
    btn.textContent = '';
    btn.style.display = 'none';
    return;
  }
  btn.style.display = '';
  btn.textContent = enabledCount > 0 ? `🧩 ${enabledCount}` : '🧩';
  btn.classList.toggle('on', enabledCount > 0);
}

async function toggleSkillsPopover(ev) {
  if (ev) ev.stopPropagation();
  const existing = document.querySelector('.skills-popover');
  if (existing) { existing.remove(); return; }

  const btn = document.getElementById('skills-chip-btn');
  if (!btn) return;
  const skills = await fetchSkillsCached(true);

  const pop = document.createElement('div');
  pop.className = 'skills-popover';
  pop.innerHTML = `
    <div class="skills-popover-head">
      <span>本次对话使用的技能</span>
      <button type="button" class="skills-popover-manage">前往「我」管理 →</button>
    </div>
    <div class="skills-popover-body"></div>
    <div class="skills-popover-foot">
      启用项会拼进系统提示词，按需生效
    </div>
  `;

  const body = pop.querySelector('.skills-popover-body');
  if (skills.length === 0) {
    body.innerHTML = '<div class="me-section-status">还没有技能 — 去「我」标签里添加</div>';
  } else {
    for (const s of skills) {
      const row = document.createElement('label');
      row.className = 'skills-popover-row';
      row.innerHTML = `
        <input type="checkbox" ${s.enabled ? 'checked' : ''}>
        <span class="skills-popover-name">${esc(s.name)}</span>
        ${s.description ? `<span class="skills-popover-desc">${esc(s.description)}</span>` : ''}
      `;
      const cb = row.querySelector('input');
      cb.addEventListener('change', async () => {
        cb.disabled = true;
        await toggleSkillEnabled(s.id, cb.checked);
        s.enabled = cb.checked;
        cb.disabled = false;
        renderSkillsChip();
      });
      body.appendChild(row);
    }
  }

  pop.querySelector('.skills-popover-manage').addEventListener('click', () => {
    pop.remove();
    switchTab('me');
    setTimeout(() => {
      const sect = document.getElementById('me-skills');
      if (sect) sect.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);
  });

  // Anchor below the chip
  const rect = btn.getBoundingClientRect();
  pop.style.top = `${rect.bottom + 6}px`;
  pop.style.right = `${Math.max(8, window.innerWidth - rect.right)}px`;
  document.body.appendChild(pop);

  // Dismiss on outside-click. Wait one tick so the click that opened us
  // doesn't immediately close.
  setTimeout(() => {
    const onDoc = (e) => {
      if (!pop.contains(e.target) && e.target !== btn) {
        pop.remove();
        document.removeEventListener('mousedown', onDoc);
      }
    };
    document.addEventListener('mousedown', onDoc);
  }, 0);
}

// ── Save-as-skill quick path ────────────────────────────────────────────
// Click the 💾 icon on a bot reply to capture its body as a new skill,
// pre-filled in a modal. Reuses POST /api/skills.

function openSaveAsSkillModal(prefillBody) {
  // Reuse / lazily insert a single shared modal.
  let modal = document.getElementById('save-skill-modal');
  if (!modal) {
    modal = document.createElement('div');
    modal.id = 'save-skill-modal';
    modal.className = 'modal-overlay';
    modal.innerHTML = `
      <div class="modal-card" onclick="event.stopPropagation()">
        <div class="modal-head">
          <span>保存为技能</span>
          <button class="modal-close" type="button" aria-label="关闭">×</button>
        </div>
        <div class="modal-body">
          <p class="me-section-hint" style="margin-top:0">技能正文在每次对话开始时拼进系统提示词。先填一句"什么时候用这个技能"，再让机器人按需调用。</p>
          <label class="modal-label">名称（小写，连字符分隔）</label>
          <input type="text" id="save-skill-name" maxlength="64" placeholder="my-skill" autocomplete="off">
          <label class="modal-label">一句话描述</label>
          <input type="text" id="save-skill-desc" maxlength="280" placeholder="什么时候用这个技能" autocomplete="off">
          <label class="modal-label">正文（Markdown）</label>
          <textarea id="save-skill-body" rows="10" placeholder="技能指令…"></textarea>
          <label class="modal-label" style="margin-top:8px;display:flex;gap:6px;align-items:center">
            <input type="checkbox" id="save-skill-enabled" checked>
            <span>立即启用</span>
          </label>
        </div>
        <div class="modal-foot">
          <button type="button" class="btn-ghost" id="save-skill-cancel">取消</button>
          <button type="button" class="btn-primary" id="save-skill-submit">保存</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeSaveAsSkillModal();
    });
    modal.querySelector('.modal-close').addEventListener('click', closeSaveAsSkillModal);
    modal.querySelector('#save-skill-cancel').addEventListener('click', closeSaveAsSkillModal);
    modal.querySelector('#save-skill-submit').addEventListener('click', submitSaveAsSkillModal);
  }
  modal.querySelector('#save-skill-name').value = '';
  modal.querySelector('#save-skill-desc').value = '';
  modal.querySelector('#save-skill-body').value = prefillBody ?? '';
  modal.querySelector('#save-skill-enabled').checked = true;
  modal.style.display = 'flex';
  setTimeout(() => modal.querySelector('#save-skill-name').focus(), 30);
}

function closeSaveAsSkillModal() {
  const modal = document.getElementById('save-skill-modal');
  if (modal) modal.style.display = 'none';
}

async function submitSaveAsSkillModal() {
  const modal = document.getElementById('save-skill-modal');
  if (!modal) return;
  const name = modal.querySelector('#save-skill-name').value.trim();
  const description = modal.querySelector('#save-skill-desc').value.trim();
  const body = modal.querySelector('#save-skill-body').value;
  const enabled = modal.querySelector('#save-skill-enabled').checked;
  if (!name) {
    alert('请填名称');
    modal.querySelector('#save-skill-name').focus();
    return;
  }
  const submit = modal.querySelector('#save-skill-submit');
  submit.disabled = true;
  try {
    const r = await fetch('/api/skills', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, description, body, enabled }),
    });
    if (!r.ok) {
      const err = await r.json().catch(() => ({}));
      throw new Error(err.error || `HTTP ${r.status}`);
    }
    closeSaveAsSkillModal();
    invalidateSkillsCache();
    // If the 「我」 tab is currently visible, refresh its list too.
    if (state.currentTab === 'me') loadMySkills();
  } catch (e) {
    alert('保存失败：' + e.message);
  } finally {
    submit.disabled = false;
  }
}

// ──────────────────────────────────────────────────────────────────────────
//  冲浪 (Surf) — each conv = one run. List + create modal + live log view.
// ──────────────────────────────────────────────────────────────────────────

const surfTabState = {
  current: null,            // hydrated surf conv (with run record)
  modalSelectedBot: '',     // which bot does the surfing (required)
  modalSelectedSource: '',  // optional source message conv id (must belong to selected bot)
  phases: new Map(),        // per-load phase blocks (rebuilt on selectSurfConv)
  activePhase: null,        // most-recent phase name (the one untriaged lines append to)
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

function formatSurfCost(conv) {
  const used = Number(conv?.cost_used_usd ?? 0);
  const budget = Number(conv?.cost_budget_usd ?? 0);
  if (!budget) return '—';
  return `$${used.toFixed(3)} / $${budget.toFixed(2)}`;
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
  const costHint = formatSurfCost(conv);

  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(conv.title || '冲浪')}</span>
      <span class="conv-subtitle">${esc(subtitle)} · ${esc(costHint)}</span>
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
    resetSurfPhases();
    // The result is persisted as a sender_type='bot' row; older runs also
    // wrote a duplicate log row tagged surf:surf_result. Skip the log
    // duplicate so existing convs don't show two identical bubbles.
    for (const m of msgs) {
      if ((m.sender_id || '').endsWith(':surf_result') && m.sender_type === 'log') continue;
      appendSurfRow(m);
    }
    finalizeSurfPhasesIfDone();
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
    formatSurfCost(c),
    c.source_message_conv_id ? `源 ${c.source_message_conv_id.slice(0, 8)}` : '自由冲浪',
    `状态 ${statusLabel(c.status, isActive)}`,
  ];
  meta.textContent = parts.join(' · ');

  document.getElementById('surf-stop-btn').style.display = isActive ? '' : 'none';
  document.getElementById('surf-rerun-btn').style.display = isActive ? 'none' : '';
}

// ── Phase-grouped log (Claude Code style: active expanded, completed
//    auto-collapse to one summary line). Phases are inferred from emit
//    line prefixes (the agent / journal modules write specific tags).
//    State lives on surfTabState.phases keyed by phase name; resetSurfPhases
//    is called whenever a new conv is selected so per-conv groupings don't
//    bleed.

const SURF_PHASES = {
  setup:    { icon: '⚙️',  label: '准备' },
  userlens: { icon: '🧠',  label: '看见这个人' },
  agent:    { icon: '🌊',  label: '冲浪' },
  summary:  { icon: '✍️',  label: '写给你' },
  journal:  { icon: '📓',  label: '日记' },
  final:    { icon: 'ℹ️',  label: '收尾' },
};
const SURF_PHASE_ORDER = ['setup', 'userlens', 'agent', 'summary', 'journal', 'final'];

function classifySurfLine(content) {
  const c = content || '';
  if (/^\[userlens\]/.test(c)) return 'userlens';
  if (/^\[agent\]/.test(c)) return 'agent';
  if (/^[🔍📖📌✋]/.test(c)) return 'agent';
  if (/^\[summary\]/.test(c)) return 'summary';
  if (/^\[journal\]/.test(c)) return 'journal';
  if (/^Surfing triggered/.test(c) || /^预算/.test(c) || /^上下文：/.test(c)) return 'setup';
  if (/^本次未交付/.test(c) || /^已中断/.test(c) || /^⚠️/.test(c)) return 'final';
  return null; // append to most-recent phase
}

function summarizeSurfPhase(name, lines) {
  if (lines.length === 0) return '';
  const last = lines[lines.length - 1];
  switch (name) {
    case 'userlens': {
      const done = lines.find(l => /^\[userlens\] 完成/.test(l));
      return done ? done.replace(/^\[userlens\] /, '') : (last.length > 60 ? last.slice(0, 60) + '…' : last);
    }
    case 'agent': {
      const done = lines.find(l => /^\[agent\] 完成/.test(l));
      if (done) return done.replace(/^\[agent\] /, '');
      const noteCount = lines.filter(l => /^📌/.test(l)).length;
      const searchCount = lines.filter(l => /^🔍/.test(l)).length;
      const readCount = lines.filter(l => /^📖/.test(l)).length;
      return `搜 ${searchCount} · 读 ${readCount} · 笔记 ${noteCount}`;
    }
    case 'journal': {
      const done = lines.find(l => /^\[journal\] 已记/.test(l));
      return done ? done.replace(/^\[journal\] /, '') : last;
    }
    default:
      return last.length > 60 ? last.slice(0, 60) + '…' : last;
  }
}

function resetSurfPhases() {
  surfTabState.phases = new Map();
  surfTabState.activePhase = null;
}

function getOrCreateSurfPhase(name) {
  let phase = surfTabState.phases.get(name);
  if (phase) return phase;

  const log = document.getElementById('surf-log');
  if (!log) return null;

  // Newly active phase collapses the previous active one.
  if (surfTabState.activePhase && surfTabState.activePhase !== name) {
    const prev = surfTabState.phases.get(surfTabState.activePhase);
    if (prev) prev.wrap.dataset.state = 'collapsed';
  }

  const meta = SURF_PHASES[name] || { icon: '·', label: name };
  const wrap = document.createElement('div');
  wrap.className = 'surf-phase';
  wrap.dataset.phase = name;
  wrap.dataset.state = 'open';
  wrap.innerHTML = `
    <button type="button" class="surf-phase-head">
      <span class="phase-chevron">▾</span>
      <span class="phase-icon">${esc(meta.icon)}</span>
      <span class="phase-label">${esc(meta.label)}</span>
      <span class="phase-summary"></span>
    </button>
    <div class="surf-phase-body"></div>
  `;
  const head = wrap.querySelector('.surf-phase-head');
  head.addEventListener('click', () => {
    wrap.dataset.state = wrap.dataset.state === 'open' ? 'collapsed' : 'open';
  });

  // Insert preserving phase order even if events arrive interleaved.
  const targetIdx = SURF_PHASE_ORDER.indexOf(name);
  const existing = Array.from(log.querySelectorAll('.surf-phase'));
  let inserted = false;
  for (const el of existing) {
    const idx = SURF_PHASE_ORDER.indexOf(el.dataset.phase);
    if (idx > targetIdx) {
      log.insertBefore(wrap, el);
      inserted = true;
      break;
    }
  }
  if (!inserted) {
    // Insert before the result bubble if one is already present.
    const bubble = log.querySelector('.surf-result-bubble');
    if (bubble) log.insertBefore(wrap, bubble);
    else log.appendChild(wrap);
  }

  phase = {
    name,
    wrap,
    body: wrap.querySelector('.surf-phase-body'),
    summaryEl: wrap.querySelector('.phase-summary'),
    lines: [],
  };
  surfTabState.phases.set(name, phase);
  surfTabState.activePhase = name;
  return phase;
}

function pushSurfPhaseLine(phase, content, kind) {
  const line = document.createElement('div');
  line.className = 'surf-phase-line' + (kind === 'error' ? ' error' : '');
  line.textContent = content;
  phase.body.appendChild(line);
  phase.lines.push(content);
  phase.summaryEl.textContent = summarizeSurfPhase(phase.name, phase.lines);
}

function appendSurfRow(m) {
  const log = document.getElementById('surf-log');
  if (!log) return;

  const isResult =
    (m.sender_type === 'bot') ||
    (m.sender_id || '').endsWith(':surf_result');

  if (isResult) {
    // Result is the deliverable — its arrival means everything before
    // it is "done", so collapse all lingering phase blocks.
    for (const phase of surfTabState.phases.values()) {
      phase.wrap.dataset.state = 'collapsed';
    }
    surfTabState.activePhase = null;
    const b = document.createElement('div');
    b.className = 'surf-result-bubble';
    b.textContent = m.content;
    log.appendChild(b);
    return;
  }

  const isError = (m.sender_id || '').endsWith(':error');
  const phaseName = classifySurfLine(m.content) ?? surfTabState.activePhase ?? 'setup';
  const phase = getOrCreateSurfPhase(phaseName);
  if (!phase) return;
  pushSurfPhaseLine(phase, m.content, isError ? 'error' : 'info');
}

// Called after a fresh load of all stored messages — if the run is no
// longer active, collapse every phase so the user sees only summaries.
function finalizeSurfPhasesIfDone() {
  const c = surfTabState.current;
  if (!c) return;
  const isActive = state.activeSurfs.has(c.id) || c.active;
  if (isActive) return;
  for (const phase of surfTabState.phases.values()) {
    phase.wrap.dataset.state = 'collapsed';
  }
  surfTabState.activePhase = null;
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
  surfTabState.modalSelectedSource = '';
  document.getElementById('surf-modal-budget').value = '0.30';

  // Default bot: whatever is filtered in the sidebar, else the first configured.
  surfTabState.modalSelectedBot =
    state.botFilter || (state.bots[0]?.id ?? '');

  // Render bot picker; switching bot also reloads the source list (the chosen
  // anchor must belong to the selected bot).
  renderModalBotPicker(document.getElementById('surf-modal-bot-host'), {
    selectedId: surfTabState.modalSelectedBot,
    onPick: (botId) => {
      surfTabState.modalSelectedBot = botId;
      surfTabState.modalSelectedSource = '';
      reloadSurfModalSources();
    },
  });

  document.getElementById('surf-modal').style.display = 'flex';
  reloadSurfModalSources();
}

async function reloadSurfModalSources() {
  const list = document.getElementById('surf-modal-source-list');
  if (!list) return;
  list.innerHTML = '<div class="modal-status-row">加载中…</div>';
  const botId = surfTabState.modalSelectedBot;
  if (!botId) {
    list.innerHTML = `<div class="modal-status-row">先选一个机器人</div>`;
    return;
  }
  try {
    const res = await fetch(`/api/surf/sources?botId=${encodeURIComponent(botId)}`);
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

async function submitSurfModal() {
  if (!surfTabState.modalSelectedBot) { alert('请选一个机器人'); return; }
  const budgetRaw = document.getElementById('surf-modal-budget').value.trim();
  const costBudgetUsd = budgetRaw ? Math.max(0.01, parseFloat(budgetRaw)) : undefined;
  if (budgetRaw && !Number.isFinite(costBudgetUsd)) {
    alert('预算需要填一个数字（USD）');
    return;
  }
  const body = {
    autoStart: true,
    botId: surfTabState.modalSelectedBot,
  };
  if (surfTabState.modalSelectedSource) body.sourceMessageConversationId = surfTabState.modalSelectedSource;
  if (costBudgetUsd) body.costBudgetUsd = costBudgetUsd;

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
  modalSelectedBot: '',
  modalSelectedSource: '',
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
  const dot = isPending ? '<span class="conv-pending-dot"></span>' : '';
  el.innerHTML = `
    <span class="conv-body">
      <span class="conv-title">${esc(conv.title || '回顾')}</span>
      <span class="conv-subtitle">${esc(subtitle)}</span>
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
    c.source_message_conv_id ? `源 ${c.source_message_conv_id.slice(0, 8)}` : '自由回顾',
    `状态 ${statusLabel(c.status, isPending)}`,
  ];
  meta.textContent = parts.join(' · ');
}

// Try to interpret a log row's content as a structured card payload (emitted
// by core/review.ts via emitStep / emitCard / emitClosing). Returns null on
// any parse failure or unknown shape so the caller can fall back to text.
function parseReviewPayload(content) {
  if (typeof content !== 'string' || !content.startsWith('{')) return null;
  try {
    const obj = JSON.parse(content);
    if (obj && (obj.type === 'step' || obj.type === 'card' || obj.type === 'closing')) {
      return obj;
    }
  } catch { /* not JSON */ }
  return null;
}

// Find or create the (single) DOM card for a given step. Steps are keyed by
// step name so a `running` event creates the card and a later `done` event
// updates the same one — that's what gives the "expand-while-running,
// collapse-when-done" feel without juggling multiple instances.
function ensureStepCard(log, stepName) {
  let el = log.querySelector(`.review-step-card[data-step="${stepName}"]`);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'review-step-card running';
  el.dataset.step = stepName;
  el.innerHTML = `
    <div class="rsc-head">
      <span class="rsc-icon"></span>
      <span class="rsc-title"></span>
      <span class="rsc-status"></span>
    </div>
    <div class="rsc-detail"></div>
  `;
  el.querySelector('.rsc-head').addEventListener('click', () => {
    el.classList.toggle('collapsed');
  });
  log.appendChild(el);
  return el;
}

function renderStepCard(log, payload) {
  const el = ensureStepCard(log, payload.step);
  el.querySelector('.rsc-title').textContent = payload.label || payload.step;
  const detail = el.querySelector('.rsc-detail');
  detail.textContent = payload.detail || '';
  el.classList.toggle('has-detail', !!payload.detail);
  el.classList.remove('running', 'done', 'error');
  el.classList.add(payload.status);
  // Auto-collapse when a step finishes — that's the "Claude Code Desktop"
  // affordance: completed beats live as a tidy pill, click to re-expand.
  if (payload.status === 'done') {
    el.classList.add('collapsed');
  }
  if (payload.status === 'error') {
    el.classList.remove('collapsed');
  }
}

const SIDE_LABELS = { you: '你', me: '我' };
const BUCKET_BADGES = {
  limit: { label: '局限', accent: 'limit' },
  grow:  { label: '发扬', accent: 'grow'  },
  keep:  { label: '保持', accent: 'keep'  },
};

function renderResultCard(log, payload) {
  const card = document.createElement('div');
  card.className = `review-result-card side-${payload.side} bucket-${payload.bucket}`;
  const items = Array.isArray(payload.items) ? payload.items : [];
  const badge = BUCKET_BADGES[payload.bucket] || { label: payload.bucket, accent: '' };
  const sideLabel = SIDE_LABELS[payload.side] || payload.side;
  const itemsHtml = items.length === 0
    ? '<div class="rrc-empty">— 无</div>'
    : `<ul class="rrc-list">${items.map(s => `<li>${esc(s)}</li>`).join('')}</ul>`;
  card.innerHTML = `
    <div class="rrc-head">
      <span class="rrc-side">${esc(sideLabel)}</span>
      <span class="rrc-badge accent-${badge.accent}">${esc(badge.label)}</span>
      <span class="rrc-title">${esc(payload.label || '')}</span>
    </div>
    <div class="rrc-body">${itemsHtml}</div>
  `;
  log.appendChild(card);
}

function renderClosingCard(log, payload) {
  if (payload.mode === 'pass') {
    const el = document.createElement('div');
    el.className = 'review-closing-card pass';
    el.textContent = '— 没什么要再补的';
    log.appendChild(el);
    return;
  }
  const el = document.createElement('div');
  el.className = 'review-closing-card note';
  el.innerHTML = `
    <div class="rcc-label">最后一句</div>
    <div class="rcc-text"></div>
  `;
  el.querySelector('.rcc-text').textContent = payload.content || '';
  log.appendChild(el);
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
    // After a user follow-up: chat-style bubble. Before any user input the
    // bot message is the closing line which is already rendered by the
    // closing card; skip duplicate.
    if (!reviewTabState.sawUserMsg) return;
    const b = document.createElement('div');
    b.className = 'review-bot-bubble';
    b.textContent = m.content;
    log.appendChild(b);
    return;
  }

  // Log row — could be a structured card (step / card / closing) or plain text.
  const payload = parseReviewPayload(m.content);
  if (payload?.type === 'step') {
    renderStepCard(log, payload);
    return;
  }
  if (payload?.type === 'card') {
    renderResultCard(log, payload);
    return;
  }
  if (payload?.type === 'closing') {
    renderClosingCard(log, payload);
    return;
  }

  // Plain status / error / followup_started — minimal text row.
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
  reviewTabState.modalSelectedSource = '';
  reviewTabState.modalSelectedBot =
    state.botFilter || (state.bots[0]?.id ?? '');

  renderModalBotPicker(document.getElementById('review-modal-bot-host'), {
    selectedId: reviewTabState.modalSelectedBot,
    onPick: (botId) => {
      reviewTabState.modalSelectedBot = botId;
      reviewTabState.modalSelectedSource = '';
      reloadReviewModalSources();
    },
  });

  document.getElementById('review-modal').style.display = 'flex';
  reloadReviewModalSources();
}

async function reloadReviewModalSources() {
  const list = document.getElementById('review-modal-source-list');
  if (!list) return;
  list.innerHTML = '<div class="modal-status-row">加载中…</div>';
  const botId = reviewTabState.modalSelectedBot;
  if (!botId) {
    list.innerHTML = `<div class="modal-status-row">先选一个机器人</div>`;
    return;
  }
  try {
    const res = await fetch(`/api/review/sources?botId=${encodeURIComponent(botId)}`);
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
  if (!reviewTabState.modalSelectedBot) { alert('请选一个机器人'); return; }
  const body = {
    autoStart: true,
    botId: reviewTabState.modalSelectedBot,
  };
  if (reviewTabState.modalSelectedSource) body.sourceMessageConversationId = reviewTabState.modalSelectedSource;
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
