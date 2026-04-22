/**
 * Ciego Resilient RPC — shared by all privacy engines
 * Replaces direct connection.getBalance() calls with retry-aware fetch
 * Handles 502 errors, HTML proxy pages, and rate limits
 */
(function() {
  'use strict';

  function getRpcUrl() {
    const loc = window.location;
    const path = loc.pathname;
    // Preview URL: /preview/xxx/
    const m = path.match(/^\/preview\/[^/]+\//);
    if (m) return loc.origin + m[0] + 'rpc';
    // Community URL: /2287-shadowsend/
    const slug = path.match(/^\/(\d+-[^/]+)/);
    if (slug) return loc.origin + '/' + slug[1] + '/rpc';
    // Standalone
    return loc.origin + '/rpc';
  }

  async function rpcCall(method, params, retries = 5) {
    const url = getRpcUrl();
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        if (!resp.ok) {
          console.warn(`[RPC] ${method} attempt ${i+1}/${retries}: HTTP ${resp.status}`);
          if (i < retries - 1) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
          throw new Error('RPC HTTP ' + resp.status);
        }
        const text = await resp.text();
        if (text.startsWith('<!') || text.startsWith('<html') || text.includes('<!DOCTYPE')) {
          console.warn(`[RPC] ${method} attempt ${i+1}/${retries}: got HTML instead of JSON`);
          if (i < retries - 1) { await new Promise(r => setTimeout(r, 2000 * (i + 1))); continue; }
          throw new Error('RPC returned HTML (proxy error)');
        }
        const j = JSON.parse(text);
        if (j.error) {
          const errMsg = j.error.message || JSON.stringify(j.error);
          // "could not find account" is expected for non-existent ATAs — don't spam console
          if (errMsg.includes('could not find account') || errMsg.includes('Invalid param')) {
            throw new Error(errMsg);
          }
          throw new Error(errMsg);
        }
        return j.result;
      } catch(e) {
        if (i < retries - 1 && !e.message.includes('insufficient') && !e.message.includes('could not find account') && !e.message.includes('Invalid param')) {
          console.warn(`[RPC] ${method} attempt ${i+1}/${retries}: ${e.message}`);
          await new Promise(r => setTimeout(r, 1500 * (i + 1)));
          continue;
        }
        throw e;
      }
    }
  }

  // Drop-in replacements for connection.getBalance, etc.
  async function getBalance(pubkey) {
    const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    const result = await rpcCall('getBalance', [key, { commitment: 'confirmed' }]);
    return result?.value || 0;
  }

  async function getTokenAccountBalance(ata) {
    const key = typeof ata === 'string' ? ata : ata.toBase58();
    const result = await rpcCall('getTokenAccountBalance', [key, { commitment: 'confirmed' }]);
    // Return object with .value.amount to match Connection API used by privacy engines
    return { value: { amount: result?.value?.amount || '0' } };
  }

  async function getLatestBlockhash() {
    const result = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
    return { blockhash: result.value.blockhash, lastValidBlockHeight: result.value.lastValidBlockHeight };
  }

  async function sendTransaction(rawBase58) {
    const result = await rpcCall('sendTransaction', [
      rawBase58, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }
    ], 4);
    return result;
  }

  async function getAccountInfo(pubkey) {
    const key = typeof pubkey === 'string' ? pubkey : pubkey.toBase58();
    const result = await rpcCall('getAccountInfo', [key, { encoding: 'base64', commitment: 'confirmed' }]);
    return result?.value || null;
  }

  if (!window.ShadowPrivacy) window.ShadowPrivacy = {};
  window.ShadowPrivacy.rpc = {
    rpcCall,
    getBalance,
    getTokenAccountBalance,
    getLatestBlockhash,
    sendTransaction,
    getAccountInfo,
  };
})();
