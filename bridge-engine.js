/**
 * Ciego — Private Pool Bridge (Multi-coin + Splits)
 * 
 * Supports: SOL, USDC, USDT, USD1 on Solana
 * Split mode: splits amount into 2-3 parallel private pool exchanges
 * each going to the SAME recipient from DIFFERENT different source wallets.
 * 
 * This makes amount-matching analysis nearly impossible.
 */
(function() {
  'use strict';

  function getBase() {
    const loc = window.location;
    const path = loc.pathname;
    const m = path.match(/^\/preview\/[^/]+/) || path.match(/^\/[^/]+/);
    return m ? m[0] : '';
  }

  // Ticker mapping for Solana tokens
  // Same-token routes: USDC→USDC, USDT→USDT, USD1→USD1 (recipient gets same token)
  const COIN_MAP = {
    'SOL':  { from: 'sol',     to: 'sol',     label: 'SOL',  icon: '⚡' },
    'USDC': { from: 'usdcsol', to: 'usdcsol', label: 'USDC', icon: '💵' },
    'USDT': { from: 'usdtsol', to: 'usdtsol', label: 'USDT', icon: '💵' },
    'USD1': { from: 'usd1sol', to: 'usd1sol', label: 'USD1', icon: '💵' },
  };

  async function cnFetch(endpoint, opts = {}) {
    const base = getBase();
    const url = `${base}/bridge${endpoint}`;
    const resp = await fetch(url, opts);
    const text = await resp.text();
    let d;
    try { d = JSON.parse(text); } catch(e) { throw new Error(`Bridge: invalid response: ${text.slice(0,100)}`); }
    if (d.error) throw new Error(d.message || d.error);
    return d;
  }

  async function cnGet(endpoint) { return cnFetch(endpoint); }

  async function cnPost(data) {
    return cnFetch('/transactions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  // Get minimum amount for a given pair
  async function getMinAmount(coinSymbol) {
    const coin = COIN_MAP[(coinSymbol || 'SOL').toUpperCase()] || COIN_MAP.SOL;
    const pair = `${coin.from}_${coin.to}`;
    const d = await cnGet(`/min-amount/${pair}`);
    return d.minAmount;
  }

  // Get estimated output for a given pair
  async function getEstimate(amount, coinSymbol) {
    const coin = COIN_MAP[(coinSymbol || 'SOL').toUpperCase()] || COIN_MAP.SOL;
    const pair = `${coin.from}_${coin.to}`;
    const d = await cnGet(`/exchange-amount/${amount}/${pair}`);
    return d.estimatedAmount;
  }

  // Check exchange status
  async function getStatus(exchangeId) {
    const d = await cnGet(`/transactions/${exchangeId}/bridge-status`);
    return d;
  }

  /**
   * Create a single bridge exchange
   */
  async function createSingleExchange(amount, coinSymbol, recipientSolAddress, refundAddress) {
    const coin = COIN_MAP[(coinSymbol || 'SOL').toUpperCase()] || COIN_MAP.SOL;
    const exchange = await cnPost({
      from: coin.from,
      to: coin.to,
      amount: amount,
      address: recipientSolAddress,
      refundAddress: refundAddress,
    });
    if (!exchange.payinAddress) {
      throw new Error('Failed to create exchange — no deposit address');
    }
    return exchange;
  }

  /**
   * Split amount into N random parts that sum to total
   * Variation: each part is 70-130% of the "fair share"
   */
  function splitAmount(total, parts) {
    const fair = total / parts;
    const min = fair * 0.7;
    const max = fair * 1.3;
    const raw = [];
    let sum = 0;
    for (let i = 0; i < parts - 1; i++) {
      const v = min + Math.random() * (max - min);
      raw.push(v);
      sum += v;
    }
    // Last chunk takes the remainder (ensures exact total)
    raw.push(total - sum);
    // Shuffle so the remainder isn't always last
    for (let i = raw.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [raw[i], raw[j]] = [raw[j], raw[i]];
    }
    return raw;
  }

  /**
   * Decide split count based on amount vs minimum AND fee efficiency
   * The bridge has a fixed fee per exchange (~0.536 USDC, ~0.0013 SOL)
   * Splitting only makes sense if each split is large enough that fees stay < 10%
   */
  function decideSplitCount(amount, minAmount, coinSymbol) {
    const ratio = amount / minAmount;
    
    // Smart thresholds: don't split if fee per split would be > 10%
    const SPLIT_MIN = {
      'SOL':  { two: 0.10, three: 0.15 },   // SOL fees are tiny
      'USDC': { two: 20,   three: 30 },      // ~0.54 USDC fixed fee/exchange
      'USDT': { two: 20,   three: 30 },      // ~0.54 USDT fixed fee/exchange 
      'USD1': { two: 10,   three: 15 },      // ~0.30 USD1 fixed fee/exchange
    };
    const thresholds = SPLIT_MIN[coinSymbol] || SPLIT_MIN['SOL'];
    
    // Must meet BOTH ratio requirement AND fee-efficiency threshold
    if (ratio >= 6 && amount >= thresholds.three) return 3;
    if (ratio >= 3 && amount >= thresholds.two) return 2;
    return 1;
  }

  /**
   * Create bridge — single or split mode
   * @param {number} amount - Amount in the coin's native units
   * @param {string} recipientSolAddress - Where SOL arrives
   * @param {function} onProgress - Progress callback
   * @param {string} coinSymbol - 'SOL', 'USDC', 'USDT', 'USD1'
   * @param {string} senderAddress - Refund address
   * @returns {object|object[]} Single result or array of split results
   */
  async function createBridge(amount, recipientSolAddress, onProgress, coinSymbol, senderAddress) {
    onProgress = onProgress || (() => {});
    coinSymbol = (coinSymbol || 'SOL').toUpperCase();
    const coinInfo = COIN_MAP[coinSymbol] || COIN_MAP.SOL;

    // Step 1: Check minimum
    onProgress('check', `Checking ${coinInfo.label} bridge minimum...`, '1/4');
    const minAmount = await getMinAmount(coinSymbol);
    if (amount < minAmount) {
      const solPrice = window.__solPrice || 83;
      throw new Error(`Minimum: ${minAmount} ${coinInfo.label} (~$${(minAmount * solPrice).toFixed(2)}). You have: ${amount.toFixed(4)} ${coinInfo.label}`);
    }

    // Step 2: Decide split count
    const splitCount = decideSplitCount(amount, minAmount, coinSymbol);
    
    if (splitCount === 1) {
      // Single exchange (same as before)
      onProgress('estimate', `${coinInfo.icon} Calculating route...`, '2/4');
      const estimate = await getEstimate(amount, coinSymbol);
      if (!estimate || estimate <= 0) throw new Error('Could not get estimate');

      onProgress('bridge1', `🔄 Creating ${coinInfo.label} bridge...`, '3/4');
      const exchange = await createSingleExchange(amount, coinSymbol, recipientSolAddress, senderAddress);

      onProgress('ready', `${coinInfo.icon} Bridge ready!`, `~${estimate.toFixed(4)} ${coinInfo.label} → recipient in 2-5 min`);

      return {
        depositAddress: exchange.payinAddress,
        depositAmount: amount,
        exchangeId: exchange.id,
        entryExchangeId: exchange.id,
        exitExchangeId: exchange.id,
        estimatedReceive: estimate,
        coin: coinSymbol.toLowerCase(),
        splitMode: false,
        splits: null,
      };
    }

    // === SPLIT MODE ===
    onProgress('estimate', `${coinInfo.icon} Split mode: ${splitCount} parallel bridges`, `Breaking ${amount.toFixed(4)} ${coinInfo.label} into ${splitCount} chunks`);

    const amounts = splitAmount(amount, splitCount);
    const splits = [];
    let totalEstimate = 0;

    for (let i = 0; i < splitCount; i++) {
      const chunkAmt = Math.round(amounts[i] * 1e6) / 1e6; // 6 decimal precision
      onProgress('bridge1', `🔄 Creating split ${i + 1}/${splitCount}...`, `${chunkAmt.toFixed(4)} ${coinInfo.label}`);

      const estimate = await getEstimate(chunkAmt, coinSymbol);
      totalEstimate += estimate || 0;

      const exchange = await createSingleExchange(chunkAmt, coinSymbol, recipientSolAddress, senderAddress);

      splits.push({
        depositAddress: exchange.payinAddress,
        depositAmount: chunkAmt,
        exchangeId: exchange.id,
        estimatedReceive: estimate,
        index: i,
      });

      // Small delay between API calls to avoid rate limits
      if (i < splitCount - 1) await new Promise(r => setTimeout(r, 1000));
    }

    onProgress('ready', `${coinInfo.icon} ${splitCount} bridges ready!`,
      `~${totalEstimate.toFixed(4)} ${coinInfo.label} → recipient in 2-5 min (${splitCount} parallel routes)`);

    return {
      depositAddress: splits[0].depositAddress, // primary for compatibility
      depositAmount: amount,
      exchangeId: splits[0].exchangeId, // primary
      entryExchangeId: splits[0].exchangeId,
      exitExchangeId: splits[splits.length - 1].exchangeId,
      estimatedReceive: totalEstimate,
      coin: coinSymbol.toLowerCase(),
      splitMode: true,
      splitCount: splitCount,
      splits: splits,
    };
  }

  /**
   * Poll a single exchange until it reaches 'finished' or 'failed' status.
   * Returns the final status object.
   * @param {string} exchangeId
   * @param {function} onProgress - optional progress callback (status, detail)
   * @param {number} timeoutMs - max wait time (default 15 min)
   * @param {number} intervalMs - poll interval (default 15s)
   */
  async function pollUntilDone(exchangeId, onProgress, timeoutMs = 15 * 60 * 1000, intervalMs = 15000) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      try {
        const st = await getStatus(exchangeId);
        const status = st.status || 'unknown';
        if (onProgress) onProgress(status, `Exchange ${exchangeId.slice(0,8)}: ${status}`);
        if (status === 'finished') return st;
        if (status === 'failed' || status === 'refunded' || status === 'expired') {
          throw new Error(`Exchange ${exchangeId.slice(0,8)} ${status}: ${st.message || ''}`);
        }
      } catch(e) {
        if (e.message.includes('failed') || e.message.includes('refunded') || e.message.includes('expired')) throw e;
        console.warn(`[pollUntilDone] ${exchangeId.slice(0,8)}: ${e.message}`);
      }
      await new Promise(r => setTimeout(r, intervalMs));
    }
    throw new Error(`Exchange ${exchangeId.slice(0,8)} timed out after ${Math.round(timeoutMs/60000)}min`);
  }

  /**
   * Poll ALL split exchange IDs until all finish. Returns array of final statuses.
   */
  async function pollAllUntilDone(exchangeIds, onProgress, timeoutMs = 15 * 60 * 1000, intervalMs = 15000) {
    const start = Date.now();
    const done = new Set();
    const failed = new Set();
    const results = {};

    while (Date.now() - start < timeoutMs) {
      for (const eid of exchangeIds) {
        if (done.has(eid) || failed.has(eid)) continue;
        try {
          const st = await getStatus(eid);
          const status = st.status || 'unknown';
          results[eid] = st;
          if (status === 'finished') {
            done.add(eid);
            if (onProgress) onProgress('split-done', `✅ ${eid.slice(0,8)}: delivered (${done.size}/${exchangeIds.length})`);
          } else if (status === 'failed' || status === 'refunded' || status === 'expired') {
            failed.add(eid);
            if (onProgress) onProgress('split-fail', `❌ ${eid.slice(0,8)}: ${status}`);
          } else {
            if (onProgress) onProgress('split-wait', `⏳ ${eid.slice(0,8)}: ${status} (${done.size}/${exchangeIds.length} done)`);
          }
        } catch(e) { console.warn(`[pollAll] ${eid.slice(0,8)}: ${e.message}`); }
      }
      if (done.size + failed.size === exchangeIds.length) break;
      await new Promise(r => setTimeout(r, intervalMs));
    }

    if (done.size < exchangeIds.length && failed.size === 0) {
      throw new Error(`Timeout: only ${done.size}/${exchangeIds.length} exchanges finished`);
    }
    return { done: done.size, failed: failed.size, results };
  }

  // Expose
  if (!window.ShadowPrivacy) window.ShadowPrivacy = {};
  window.ShadowPrivacy.bridge = {
    getMinAmount,
    getEstimate,
    getStatus,
    createBridge,
    splitAmount,
    decideSplitCount,
    pollUntilDone,
    pollAllUntilDone,
    COIN_MAP,
    BRIDGE_COINS: {
      sol:  { name: 'SOL Bridge',  symbol: 'SOL',  confirmTime: '2-5 min', icon: '⚡' },
      usdc: { name: 'USDC Bridge', symbol: 'USDC', confirmTime: '2-5 min', icon: '💵' },
      usdt: { name: 'USDT Bridge', symbol: 'USDT', confirmTime: '2-5 min', icon: '💵' },
      usd1: { name: 'USD1 Bridge', symbol: 'USD1', confirmTime: '2-5 min', icon: '💵' },
    },
  };
})();
