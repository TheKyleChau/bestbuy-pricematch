// ==UserScript==
// @name         Best Buy Price Match
// @namespace    https://github.com/kylechau/bestbuy-pricematch
// @version      4.0.0
// @description  Auto-submits Best Buy price match requests for all eligible items on any order page
// @author       Kyle Chau
// @updateURL    https://bestbuy.kyle.jp/bestbuy-pricematch.user.js
// @downloadURL  https://bestbuy.kyle.jp/bestbuy-pricematch.user.js
// @match        https://www.bestbuy.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_addStyle
// @grant        unsafeWindow
// @connect      www.bestbuy.com
// @run-at       document-start
// ==/UserScript==

(function () {
  'use strict';

  GM_addStyle(`
    #bbpm-panel {
      position: fixed; top: 80px; right: 16px; z-index: 2147483647; width: 340px;
      max-width: calc(100vw - 32px); background: #fff; color: #1d252c;
      border: 1px solid #c5d8f4; border-radius: 6px;
      box-shadow: 0 10px 30px rgba(0,0,0,.18);
      font-family: Arial, Helvetica, sans-serif; font-size: 13px; overflow: hidden;
    }
    #bbpm-header {
      display: flex; align-items: center; justify-content: space-between;
      padding: 11px 14px; background: #0046be; color: #fff;
      font-size: 14px; font-weight: 700; cursor: pointer; user-select: none;
    }
    #bbpm-toggle { font-size: 18px; }
    #bbpm-body { padding: 10px 12px; max-height: 480px; overflow-y: auto; }
    #bbpm-panel.collapsed #bbpm-body { display: none; }
    #bbpm-submit-all {
      display: block; width: 100%; margin: 0 0 10px; padding: 9px 14px;
      background: #0046be; color: #fff; font-size: 13px; font-weight: 700;
      border: none; border-radius: 4px; cursor: pointer; text-align: center;
    }
    #bbpm-submit-all:hover:not(:disabled) { background: #003da5; }
    #bbpm-submit-all:disabled { background: #9aa1b4; cursor: not-allowed; }
    .bbpm-msg { margin: 4px 0; color: #46505a; line-height: 1.5; }
    .bbpm-err { color: #b00020; background: #fff4f4; border: 1px solid #f2b8b5; border-radius: 4px; padding: 6px 10px; }
    .bbpm-list { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 8px; }
    .bbpm-item { padding: 8px; background: #f8fbff; border: 1px solid #dde8f8; border-radius: 4px; }
    .bbpm-item-name { font-weight: 600; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; margin-bottom: 4px; }
    .bbpm-item-meta { color: #46505a; font-size: 12px; margin-bottom: 4px; }
    .bbpm-item-status { font-size: 12px; font-weight: 600; padding: 3px 8px; border-radius: 10px; display: inline-block; }
    .bbpm-status-pending  { background: #e5f0ff; color: #0046be; }
    .bbpm-status-running  { background: #fff8e0; color: #866000; }
    .bbpm-status-success  { background: #e6f4ea; color: #1a7336; }
    .bbpm-status-skipped  { background: #f0f0f0; color: #666; }
    .bbpm-status-error    { background: #fff4f4; color: #b00020; }
  `);

  // ── SPA navigation detection ──────────────────────────────────────────────────
  // Best Buy is a React SPA — patch history methods to detect route changes.

  const log = (...args) => console.log('[BBPriceMatch]', ...args);
  const err = (...args) => console.error('[BBPriceMatch]', ...args);

  let currentOrderId = null;

  function onRouteChange() {
    const match = location.pathname.match(/\/orders\/order-details\/([^/]+)/);
    const newOrderId = match ? match[1] : null;

    log('Route change →', location.pathname, '| orderId:', newOrderId);

    if (newOrderId === currentOrderId) { log('Same order, skipping'); return; }
    currentOrderId = newOrderId;

    removePanel();

    if (!newOrderId) { log('Not an order detail page, panel removed'); return; }

    waitForBody(() => {
      log('Body ready, attaching panel for', newOrderId);
      attachPanel(newOrderId);
    });
  }

  const _pushState = history.pushState.bind(history);
  history.pushState = function (...args) {
    _pushState(...args);
    onRouteChange();
  };

  const _replaceState = history.replaceState.bind(history);
  history.replaceState = function (...args) {
    _replaceState(...args);
    onRouteChange();
  };

  window.addEventListener('popstate', onRouteChange);

  // Run on initial load too
  onRouteChange();

  // ── DOM helpers ───────────────────────────────────────────────────────────────

  function waitForBody(cb) {
    if (document.body) { cb(); return; }
    const obs = new MutationObserver(() => {
      if (document.body) { obs.disconnect(); cb(); }
    });
    obs.observe(document.documentElement, { childList: true });
  }

  function removePanel() {
    const existing = document.getElementById('bbpm-panel');
    if (existing) existing.remove();
  }

  function attachPanel(orderId) {
    removePanel();
    const panel = buildPanel();
    document.body.appendChild(panel);
    fetchOrderAndRender(orderId);
  }

  // ── Panel skeleton ────────────────────────────────────────────────────────────

  function buildPanel() {
    const el = document.createElement('div');
    el.id = 'bbpm-panel';

    const header = document.createElement('div');
    header.id = 'bbpm-header';
    const title = document.createElement('span');
    title.textContent = '🏷️ Price Match';
    const toggle = document.createElement('span');
    toggle.id = 'bbpm-toggle';
    toggle.textContent = '−';
    header.append(title, toggle);
    header.addEventListener('click', () => {
      const collapsed = el.classList.toggle('collapsed');
      toggle.textContent = collapsed ? '+' : '−';
    });

    const body = document.createElement('div');
    body.id = 'bbpm-body';
    setMsg(body, 'Loading order…');

    el.append(header, body);
    return el;
  }

  // ── Fetch order and render ────────────────────────────────────────────────────

  function fetchOrderAndRender(orderId) {
    const url = `https://www.bestbuy.com/profile/ss/api/v1/orders/${orderId}`;
    log('Fetching order:', url);
    bbGet(
      url,
      data => {
        const items = data?.order?.items ?? [];
        const ola   = data?.orderLineAttributes ?? {};
        log('Order API response — total items:', items.length, '| orderLineAttributes keys:', Object.keys(ola).length);
        const eligible = items
          .filter(item => (ola[String(item.id)] ?? {}).isPriceMatchAllowed === true)
          .map(item => ({
            id:   String(item.id),
            sku:  String(item.sku || ''),
            name: item.itemDesc || `SKU ${item.sku}`,
            qty:  item.qty || item.quantity || 1,
          }))
          .sort((a, b) => b.qty - a.qty); // multi-qty items first
        log('Eligible items:', eligible.length, eligible.map(i => `${i.name} (id=${i.id}, qty=${i.qty})`));
        renderItemList(eligible, orderId);
      },
      e => { err('Order fetch failed:', e); setBodyError(e); }
    );
  }

  // ── Item list UI ──────────────────────────────────────────────────────────────

  function renderItemList(items, orderId) {
    const body = document.getElementById('bbpm-body');
    if (!body) return;
    body.textContent = '';

    if (!items.length) {
      setMsg(body, 'No price-match eligible items on this order.');
      return;
    }

    const btn = document.createElement('button');
    btn.id = 'bbpm-submit-all';
    btn.textContent = `Submit All Price Matches (${items.length})`;
    btn.addEventListener('click', () => submitAll(items, orderId, btn));
    body.appendChild(btn);

    const list = document.createElement('ul');
    list.className = 'bbpm-list';
    items.forEach(item => list.appendChild(buildItemRow(item)));
    body.appendChild(list);
  }

  function buildItemRow(item) {
    const li = document.createElement('li');
    li.className = 'bbpm-item';
    li.id = `bbpm-item-${item.id}`;

    const nameEl = document.createElement('div');
    nameEl.className = 'bbpm-item-name';
    nameEl.title = item.name;
    nameEl.textContent = item.name.length > 48 ? item.name.slice(0, 45) + '…' : item.name;

    const metaEl = document.createElement('div');
    metaEl.className = 'bbpm-item-meta';
    metaEl.textContent = `SKU ${item.sku}${item.qty > 1 ? ` × ${item.qty}` : ''}`;

    const statusEl = document.createElement('span');
    statusEl.className = 'bbpm-item-status bbpm-status-pending';
    statusEl.textContent = 'Pending';

    li.append(nameEl, metaEl, statusEl);
    return li;
  }

  // ── Submit all in parallel ────────────────────────────────────────────────────

  async function submitAll(items, orderId, btn) {
    btn.disabled = true;
    btn.textContent = 'Submitting…';

    const prId = (unsafeWindow.metaLayer ?? window.metaLayer)?.env?.prId ?? '';
    log('Submit all triggered — items:', items.length, '| prId present:', !!prId);
    items.forEach(item => setItemStatus(item.id, 'running', 'Submitting…'));

    const outcomes = await Promise.all(items.map(item => submitOne(item, orderId, prId)));

    const successCount = outcomes.filter(o => o === 'success').length;
    const skipCount    = outcomes.filter(o => o === 'skipped').length;
    const errorCount   = outcomes.filter(o => o === 'error').length;
    log(`Final: ${successCount} success, ${skipCount} skipped, ${errorCount} errors`);
    btn.textContent = `Done — ${successCount} submitted, ${skipCount} skipped, ${errorCount} errors`;
  }

  async function submitOne(item, orderId, prId) {
    const MAX_RETRIES = 3;
    const referer = `https://www.bestbuy.com/profile/ss/orders/order-details/${orderId}/view/price-match/${item.id}`;
    const infoUrl = `https://www.bestbuy.com/profile/ss/api/v1/orders/${orderId}/lines/${item.id}/price-match/info`;
    const postUrl = `https://www.bestbuy.com/profile/ss/api/v1/${orderId}/${item.id}/price-match-check`;

    log(`[${item.id}] Fetching info:`, infoUrl);
    try {
      const info = await bbGetAsync(infoUrl, prId, referer);
      log(`[${item.id}] Info response:`, info);

      if (info.errorCode || !info.isPriceMatchEligible) {
        const reason = info.message || info.errorCode || 'not eligible';
        log(`[${item.id}] Skipped:`, reason);
        setItemStatus(item.id, 'skipped', `Skipped: ${reason}`);
        return 'skipped';
      }

      const body = {
        askPrice:       info.offerPrice,
        competitorId:   40,
        competitorName: 'Best Buy',
        customerEmail:  info.customerEmail,
        orderEmail:     info.customerEmail,
        sku:            item.sku,
        storeId:        960,
        userName:       'OSS',
      };
      log(`[${item.id}] POST body:`, body);

      let lastError;
      for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
        if (attempt > 1) {
          log(`[${item.id}] Retry ${attempt - 1}/${MAX_RETRIES - 1} — last error:`, lastError);
          setItemStatus(item.id, 'running', `Retry ${attempt - 1}/${MAX_RETRIES - 1}…`);
        }
        try {
          log(`[${item.id}] Attempt ${attempt}/${MAX_RETRIES} → POST`, postUrl);
          const result = await bbPostAsync(postUrl, body, prId, referer);
          log(`[${item.id}] Attempt ${attempt} result:`, result);
          if (result.errorCode) { lastError = result.message || result.errorCode; continue; }

          const discount = info.discount || 0;
          const saved = discount > 0
            ? `Saved $${discount.toFixed(2)}`
            : `Submitted (code ${result.responseCode})`;
          log(`[${item.id}] Success:`, saved, '| info.discount (line total):', discount);
          setItemStatus(item.id, 'success', saved);
          return 'success';
        } catch (e) {
          lastError = e.message;
          err(`[${item.id}] Attempt ${attempt} threw:`, e);
        }
      }

      err(`[${item.id}] Failed after ${MAX_RETRIES} tries:`, lastError);
      setItemStatus(item.id, 'error', `Failed after ${MAX_RETRIES} tries: ${lastError}`);
      return 'error';
    } catch (e) {
      err(`[${item.id}] Unexpected error:`, e);
      setItemStatus(item.id, 'error', `Error: ${e.message}`);
      return 'error';
    }
  }

  // ── Status / body helpers ─────────────────────────────────────────────────────

  function setItemStatus(itemId, state, text) {
    const li = document.getElementById(`bbpm-item-${itemId}`);
    if (!li) return;
    const el = li.querySelector('.bbpm-item-status');
    if (!el) return;
    el.className = `bbpm-item-status bbpm-status-${state}`;
    el.textContent = text;
  }

  function setMsg(container, text) {
    container.textContent = '';
    const p = document.createElement('p');
    p.className = 'bbpm-msg';
    p.textContent = text;
    container.appendChild(p);
  }

  function setBodyError(msg) {
    const body = document.getElementById('bbpm-body');
    if (!body) return;
    body.textContent = '';
    const p = document.createElement('p');
    p.className = 'bbpm-msg bbpm-err';
    p.textContent = msg;
    body.appendChild(p);
  }

  // ── HTTP helpers ──────────────────────────────────────────────────────────────

  function makeHeaders(prId, hasBody, referer) {
    const h = { Accept: 'application/json', 'x-client': 'OSS' };
    if (prId) h['x-pr-id'] = prId;
    if (hasBody) h['Content-Type'] = 'application/json; charset=utf-8';
    if (referer) h['Referer'] = referer;
    return h;
  }

  function bbGet(url, onSuccess, onError) {
    GM_xmlhttpRequest({
      method: 'GET', url,
      headers: makeHeaders('', false, location.href),
      withCredentials: true,
      onload(res) {
        log('GET', url, '→ status', res.status);
        if (res.status !== 200) { err('bbGet non-200:', res.status, url); onError(`API error (${res.status})`); return; }
        try { onSuccess(JSON.parse(res.responseText)); }
        catch { err('bbGet JSON parse error', url); onError('JSON parse error'); }
      },
      onerror(res) { err('bbGet network error', url, res); onError('Network error'); },
    });
  }

  function bbGetAsync(url, prId, referer) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET', url,
        headers: makeHeaders(prId, false, referer),
        withCredentials: true,
        onload(res) {
          log('GET', url, '→ status', res.status);
          if (res.status < 200 || res.status >= 300) err('bbGetAsync non-2xx:', res.status, url);
          try { resolve(JSON.parse(res.responseText)); }
          catch { err('bbGetAsync JSON parse error', url); reject(new Error('JSON parse error')); }
        },
        onerror(res) { err('bbGetAsync network error', url, res); reject(new Error('Network error')); },
      });
    });
  }

  function bbPostAsync(url, body, prId, referer) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'POST', url,
        headers: makeHeaders(prId, true, referer),
        data: JSON.stringify(body),
        withCredentials: true,
        onload(res) {
          log('POST', url, '→ status', res.status);
          if (res.status < 200 || res.status >= 300) err('bbPostAsync non-2xx:', res.status, url);
          try { resolve(JSON.parse(res.responseText)); }
          catch { err('bbPostAsync JSON parse error', url); reject(new Error('JSON parse error')); }
        },
        onerror(res) { err('bbPostAsync network error', url, res); reject(new Error('Network error')); },
      });
    });
  }
})();
