// BubbleBored Web Client

const state = {
  userId: localStorage.getItem('bb_userId') || generateId(),
  currentBotId: null,
  ws: null,
  reconnectTimer: null,
  reconnectDelay: 1000,
};

localStorage.setItem('bb_userId', state.userId);
init();

function generateId() {
  return 'u_' + Math.random().toString(36).slice(2, 10);
}

async function init() {
  await loadBots();
  connectWs();
  setupInput();
}

// ── Bots ──

async function loadBots() {
  try {
    const res = await fetch('/api/bots');
    const bots = await res.json();
    const list = document.getElementById('bot-list');
    list.innerHTML = '';

    if (bots.length === 0) {
      list.innerHTML = '<div style="padding:16px 14px;color:var(--text-4);font-size:13px">没有可用的 Bot</div>';
      return;
    }

    for (const bot of bots) {
      const el = document.createElement('div');
      el.className = 'bot-item';
      el.dataset.botId = bot.id;
      el.innerHTML = `
        <div class="bot-name">${esc(bot.display_name || bot.id)}<span class="status-dot" id="status-${bot.id}"></span></div>
        <div class="bot-status">点击开始对话</div>
      `;
      el.onclick = () => selectBot(bot.id, bot.display_name || bot.id);
      list.appendChild(el);
    }

    if (bots.length > 0) {
      selectBot(bots[0].id, bots[0].display_name || bots[0].id);
    }
  } catch (e) {
    console.error('load bots error:', e);
  }
}

function selectBot(botId, displayName) {
  state.currentBotId = botId;
  document.getElementById('chat-bot-name').textContent = displayName;
  document.getElementById('empty-state').style.display = 'none';

  const chatView = document.getElementById('chat-view');
  chatView.style.display = 'flex';

  document.getElementById('reset-btn').style.display = '';

  document.querySelectorAll('.bot-item').forEach(el => {
    el.classList.toggle('active', el.dataset.botId === botId);
  });

  loadHistory(botId);
}

async function loadHistory(botId) {
  const msgs = document.getElementById('messages');
  msgs.innerHTML = '';

  try {
    const res = await fetch(`/api/conversations?userId=${state.userId}`);
    const convs = await res.json();
    const conv = convs.find(c => c.bot_id === botId);
    if (!conv) return;

    const msgRes = await fetch(`/api/conversations/${conv.id}/messages`);
    const messages = await msgRes.json();

    for (const msg of messages) {
      appendMessage(msg.sender_type === 'user' ? 'user' : 'bot', msg.content, msg.id);
    }
    scrollToBottom();
  } catch (e) {
    // No history
  }
}

// ── WebSocket ──

function connectWs() {
  if (state.ws && state.ws.readyState <= 1) return;

  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  state.ws = new WebSocket(`${proto}://${location.host}/ws?userId=${state.userId}`);

  state.ws.onopen = () => {
    state.reconnectDelay = 1000;
    document.querySelectorAll('.status-dot').forEach(d => d.classList.add('connected'));
  };

  state.ws.onmessage = (e) => {
    try {
      const msg = JSON.parse(e.data);
      if (msg.type === 'message' && msg.content) {
        clearSurfLog();
        appendMessage('bot', msg.content, msg.messageId);
        scrollToBottom();
      } else if (msg.type === 'error' && msg.content) {
        appendMessage('bot', msg.content);
        scrollToBottom();
      } else if (msg.type === 'surf_status' && msg.content) {
        appendSurfLog(msg.content);
        scrollToBottom();
      }
    } catch {}
  };

  state.ws.onclose = () => {
    document.querySelectorAll('.status-dot').forEach(d => d.classList.remove('connected'));
    state.reconnectTimer = setTimeout(() => {
      state.reconnectDelay = Math.min(state.reconnectDelay * 2, 30000);
      connectWs();
    }, state.reconnectDelay);
  };

  state.ws.onerror = () => {};
}

// ── Messages ──

function appendMessage(type, content, msgId) {
  const msgs = document.getElementById('messages');
  const wrap = document.createElement('div');
  wrap.className = `msg-wrap ${type}`;
  if (msgId) wrap.dataset.msgId = msgId;

  const bubble = document.createElement('div');
  bubble.className = `msg ${type}`;
  bubble.textContent = content;

  const del = document.createElement('button');
  del.className = 'msg-del';
  del.innerHTML = '&times;';
  del.onclick = () => deleteMsg(wrap);

  wrap.appendChild(bubble);
  wrap.appendChild(del);
  msgs.appendChild(wrap);
  return wrap;
}

async function deleteMsg(el) {
  const msgId = el.dataset.msgId;
  if (msgId) {
    try {
      await fetch(`/api/messages/${msgId}`, { method: 'DELETE' });
    } catch {}
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
  if (scroll) {
    requestAnimationFrame(() => { scroll.scrollTop = scroll.scrollHeight; });
  }
}

// ── Send ──

function sendMessage() {
  const input = document.getElementById('msg-input');
  const content = input.value.trim();
  if (!content || !state.currentBotId) return;

  appendMessage('user', content);
  scrollToBottom();

  if (state.ws?.readyState === 1) {
    state.ws.send(JSON.stringify({
      type: 'chat',
      botId: state.currentBotId,
      content,
    }));
  }

  input.value = '';
  autoResize(input);
  updateSendBtn();
}

// ── Input ──

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
  });
}

function autoResize(el) {
  el.style.height = 'auto';
  el.style.height = Math.min(el.scrollHeight, 120) + 'px';
}

function updateSendBtn() {
  const input = document.getElementById('msg-input');
  const btn = document.getElementById('send-btn');
  btn.classList.toggle('ready', input.value.trim().length > 0);
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
  d.textContent = s;
  return d.innerHTML;
}

// ── Reset ──

async function resetConversation() {
  if (!state.currentBotId) return;
  if (!confirm('确定要清空当前对话的所有消息和记忆吗？')) return;

  try {
    const res = await fetch('/api/conversations/reset', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ userId: state.userId, botId: state.currentBotId }),
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
