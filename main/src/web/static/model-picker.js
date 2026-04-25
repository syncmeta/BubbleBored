// Reusable searchable model picker.
//
// Two flavors share the same store:
//   single-select  → createModelPicker({ value, onChange })
//   multi-select   → createModelPicker({ values: Set, onChange, multi: true })
//
// Both render a button that opens a popover with a search input and a
// scrollable list, fed by /api/openrouter/models (proxy to OpenRouter's
// public model registry, ~400 models). Selecting items updates the underlying
// state and triggers onChange. The popover closes on outside click or Escape.
//
// All copy is Chinese-first. The component is style-tokens-aware (uses CSS
// variables already defined in tokens.css / style.css).

(function () {
  // Cached list across pickers (5-min TTL — backend caches 10min on top).
  let cachedModels = null;
  let cachedAt = 0;
  let cachedPromise = null;
  const CACHE_TTL_MS = 5 * 60 * 1000;

  async function loadOpenRouterModels() {
    const now = Date.now();
    if (cachedModels && now - cachedAt < CACHE_TTL_MS) return cachedModels;
    if (cachedPromise) return cachedPromise;
    cachedPromise = fetch('/api/openrouter/models')
      .then(r => r.ok ? r.json() : [])
      .then(list => {
        cachedModels = Array.isArray(list) ? list : [];
        cachedAt = Date.now();
        cachedPromise = null;
        return cachedModels;
      })
      .catch(e => {
        cachedPromise = null;
        console.error('[model-picker] load error', e);
        return [];
      });
    return cachedPromise;
  }

  // Force a refresh — exposed for callers that want to drop the cache
  // (e.g. after a manual "刷新模型列表" click).
  function invalidateModelCache() {
    cachedModels = null;
    cachedAt = 0;
    cachedPromise = null;
  }

  function fmtPrice(p) {
    if (!p) return '';
    const n = parseFloat(p);
    if (!isFinite(n) || n === 0) return p === '0' ? '免费' : '';
    // OpenRouter price is per token. Show $/Mtok with two sig figs.
    const perM = n * 1_000_000;
    if (perM < 0.01) return `$${perM.toFixed(4)}/M`;
    if (perM < 1) return `$${perM.toFixed(3)}/M`;
    return `$${perM.toFixed(2)}/M`;
  }
  function fmtCtx(n) {
    if (!n) return '';
    if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M ctx`;
    if (n >= 1000) return `${Math.round(n / 1000)}K ctx`;
    return `${n} ctx`;
  }

  function modelMatches(m, q) {
    if (!q) return true;
    const lower = q.toLowerCase();
    return (
      (m.display_name || '').toLowerCase().includes(lower) ||
      (m.slug || '').toLowerCase().includes(lower) ||
      (m.provider || '').toLowerCase().includes(lower)
    );
  }

  function escHtml(s) {
    const d = document.createElement('div');
    d.textContent = s ?? '';
    return d.innerHTML;
  }

  // Build the picker. Returns a DOM element.
  //   opts.multi: false → single value (string)
  //               true  → Set<string> values
  //   opts.value / opts.values: initial selection
  //   opts.onChange(next): called on every change
  //   opts.placeholder: button text when empty
  //   opts.minSelect: for multi, min count to allow saving (UI only)
  //   opts.allowCustomSlug: if true, search box can submit a free-form slug
  function createModelPicker(opts = {}) {
    const multi = !!opts.multi;
    let value = opts.value ?? '';
    let values = new Set(opts.values ?? []);
    const onChange = opts.onChange || (() => {});

    const wrap = document.createElement('div');
    wrap.className = 'model-picker-wrap';

    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'model-picker-trigger';

    const popover = document.createElement('div');
    popover.className = 'model-picker-popover';
    popover.style.display = 'none';

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = '搜索模型 / slug / provider';
    search.className = 'model-picker-search';

    const list = document.createElement('div');
    list.className = 'model-picker-list';

    popover.appendChild(search);
    popover.appendChild(list);
    wrap.appendChild(btn);
    wrap.appendChild(popover);

    function modelByslug(slug) {
      return (cachedModels ?? []).find(m => m.slug === slug);
    }

    function renderTrigger() {
      if (multi) {
        const count = values.size;
        if (count === 0) {
          btn.textContent = opts.placeholder || '选择模型 …';
          btn.classList.add('empty');
        } else {
          const names = Array.from(values).map(s => {
            const m = modelByslug(s);
            return m ? m.display_name : s;
          });
          btn.textContent = `已选 ${count} 个：${names.join('、')}`;
          btn.classList.remove('empty');
        }
      } else {
        if (!value) {
          btn.textContent = opts.placeholder || '选择模型 …';
          btn.classList.add('empty');
        } else {
          const m = modelByslug(value);
          btn.textContent = m ? `${m.display_name} · ${m.slug}` : value;
          btn.classList.remove('empty');
        }
      }
    }

    function renderList() {
      const q = search.value.trim();
      const all = cachedModels ?? [];
      const filtered = all.filter(m => modelMatches(m, q));
      list.innerHTML = '';

      if (filtered.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'model-picker-empty';
        if (q && opts.allowCustomSlug) {
          empty.innerHTML = `没有匹配。<button type="button" class="link" data-act="add-custom">把 "${escHtml(q)}" 当作 slug 用</button>`;
          empty.querySelector('button').addEventListener('click', () => {
            select(q);
          });
        } else {
          empty.textContent = q ? '没有匹配的模型。' : '加载 OpenRouter 模型列表失败 — 检查网络/API key';
        }
        list.appendChild(empty);
        return;
      }

      for (const m of filtered) {
        const row = document.createElement('div');
        row.className = 'model-picker-row';
        const isSelected = multi ? values.has(m.slug) : value === m.slug;
        if (isSelected) row.classList.add('selected');
        const ctxStr = fmtCtx(m.context_length);
        const priceStr = fmtPrice(m.pricing?.prompt);
        const meta = [ctxStr, priceStr].filter(Boolean).join(' · ');
        row.innerHTML = `
          ${multi ? `<input type="checkbox" ${isSelected ? 'checked' : ''}>` : ''}
          <span class="mp-name">${escHtml(m.display_name)}</span>
          <span class="mp-slug">${escHtml(m.slug)}</span>
          <span class="mp-provider">${escHtml(m.provider || '')}${meta ? ` · ${escHtml(meta)}` : ''}</span>
        `;
        row.addEventListener('click', () => select(m.slug));
        list.appendChild(row);
      }
    }

    function select(slug) {
      if (multi) {
        if (values.has(slug)) values.delete(slug);
        else values.add(slug);
        renderTrigger();
        renderList();
        onChange(values);
      } else {
        value = slug;
        renderTrigger();
        close();
        onChange(value);
      }
    }

    function open() {
      popover.style.display = 'block';
      search.value = '';
      renderList();
      // Position below the trigger if possible — fall back to relative
      // anchoring inside the wrap.
      setTimeout(() => search.focus(), 0);
      document.addEventListener('mousedown', onOutside, true);
      document.addEventListener('keydown', onKey, true);
    }
    function close() {
      popover.style.display = 'none';
      document.removeEventListener('mousedown', onOutside, true);
      document.removeEventListener('keydown', onKey, true);
    }
    function toggle() {
      if (popover.style.display === 'block') close();
      else open();
    }
    function onOutside(e) {
      if (!wrap.contains(e.target)) close();
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
    }

    btn.addEventListener('click', async (e) => {
      e.preventDefault();
      e.stopPropagation();
      if (popover.style.display !== 'block') {
        await loadOpenRouterModels();
        open();
      } else {
        close();
      }
    });
    search.addEventListener('input', renderList);

    // Initial render — assume cache may already be warm; otherwise the
    // trigger shows the placeholder until the user opens the popover.
    loadOpenRouterModels().then(() => {
      renderTrigger();
    });
    renderTrigger();

    // Imperative API so consumers can update value externally (e.g. when
    // the modal reopens with a different conversation).
    wrap.setValue = (v) => {
      value = v ?? '';
      renderTrigger();
    };
    wrap.setValues = (v) => {
      values = new Set(v ?? []);
      renderTrigger();
    };
    wrap.getValue = () => value;
    wrap.getValues = () => values;
    wrap.refresh = async () => {
      invalidateModelCache();
      await loadOpenRouterModels();
      renderTrigger();
      if (popover.style.display === 'block') renderList();
    };

    return wrap;
  }

  // Expose globally — app.js can grab them off window.
  window.createModelPicker = createModelPicker;
  window.invalidateModelCache = invalidateModelCache;
  window.loadOpenRouterModels = loadOpenRouterModels;
})();
