/**
 * Ciego — Untraceable Mode (Private Bridge)
 *
 * Multi-network support: SOL → XMR → [SOL/ETH/BTC/LTC/USDT/USDC on any chain]
 * The Monero hop makes it cryptographically untraceable.
 */
(function () {
  const API = window.location.href.replace(/\/[^/]*$/, '/') + 'bridge-ext';

  window.ShadowBridge = {
    /**
     * Estimate: SOL → XMR → destCoin on destNetwork
     * @param {number} solAmount
     * @param {string} destCoin - e.g. 'SOL', 'ETH', 'BTC', 'USDT', 'USDC', 'LTC'
     * @param {string} destNetwork - e.g. 'SOL', 'ETH', 'ARBITRUM', 'BASE', 'BSC', 'BTC', 'LTC'
     */
    async estimate(solAmount, destCoin = 'SOL', destNetwork = 'SOL') {
      try {
        // Leg 1: SOL → XMR
        const r1 = await fetch(`${API}/rate?coinFrom=SOL&coinTo=XMR&amount=${solAmount}&rateType=float`);
        const d1 = await r1.json();
        if (d1.error) throw new Error(d1.error);
        const xmrAmount = d1.toAmount;

        // Leg 2: XMR → destCoin on destNetwork
        const r2 = await fetch(`${API}/rate?coinFrom=XMR&coinTo=${destCoin}&networkTo=${destNetwork}&amount=${xmrAmount}&rateType=float`);
        const d2 = await r2.json();
        if (d2.error) throw new Error(d2.error);

        return {
          solIn: solAmount,
          xmrMiddle: xmrAmount,
          finalAmount: d2.toAmount,
          destCoin,
          destNetwork,
          minAmount: d1.minAmount || 0.6,
          estimatedTime: '15-40 min',
        };
      } catch (err) {
        console.error('[ShadowBridge] Estimate error:', err);
        throw err;
      }
    },

    /**
     * Full execute: create both exchange legs, sign & send SOL, poll status
     */
    async execute(connection, wallet, publicKey, recipientAddress, solAmount, destCoin, destNetwork, onLog, onRefresh) {
      const log = (msg, color) => { console.log('[ShadowBridge]', msg); if (onLog) onLog(msg, color); };

      log('🌑 Starting untraceable transfer...', '#a78bfa');
      log(`Route: SOL → XMR → ${destCoin} (${destNetwork})`, '#888');

      // Step 1: Estimate to get XMR amount
      log('📊 Getting exchange rates...', '#888');
      const est = await this.estimate(solAmount, destCoin, destNetwork);
      log(`Will convert ${solAmount} SOL → ~${est.xmrMiddle.toFixed(6)} XMR → ~${est.finalAmount.toFixed(6)} ${destCoin}`, '#fff');

      // Step 2: Create Leg 2 first (XMR → dest) to get the XMR deposit address
      log('🔗 Creating Leg 2: XMR → ' + destCoin + ' (' + destNetwork + ')...', '#888');
      const leg2 = await this._createExchange('XMR', 'XMR', destCoin, destNetwork, est.xmrMiddle, recipientAddress);
      const xmrDepositAddr = leg2.depositAddress;
      log('✅ Leg 2 created — XMR deposit: ' + xmrDepositAddr.slice(0, 12) + '...', '#22c55e');

      // Step 3: Create Leg 1 (SOL → XMR) pointing to leg2's XMR deposit
      log('🔗 Creating Leg 1: SOL → XMR...', '#888');
      const leg1 = await this._createExchange('SOL', 'SOL', 'XMR', 'XMR', solAmount, xmrDepositAddr);
      const solDepositAddr = leg1.depositAddress;
      log('✅ Leg 1 created — SOL deposit: ' + solDepositAddr.slice(0, 8) + '...', '#22c55e');

      // Step 4: Sign and send SOL to leg1 deposit address
      log('✍️ Sign transaction in Phantom...', '#f59e0b');
      const { SystemProgram, Transaction, PublicKey, LAMPORTS_PER_SOL } = solanaWeb3;
      const tx = new Transaction().add(
        SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(solDepositAddr),
          lamports: Math.floor(solAmount * LAMPORTS_PER_SOL),
        })
      );
      tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
      tx.feePayer = publicKey;
      const signed = await wallet.signTransaction(tx);
      const sig = await connection.sendRawTransaction(signed.serialize());
      log('📤 SOL sent! TX: ' + sig.slice(0, 16) + '...', '#22c55e');
      if (onRefresh) onRefresh();

      // Step 5: Poll Leg 1 (SOL → XMR)
      log('⏳ Waiting for SOL → XMR conversion...', '#888');
      await this._pollStatus(leg1.id, ['success'], (s) => {
        log('  Leg 1 status: ' + s.status, '#888');
      });
      log('✅ SOL → XMR complete!', '#22c55e');

      // Step 6: Poll Leg 2 (XMR → dest)
      log('⏳ Waiting for XMR → ' + destCoin + ' conversion...', '#888');
      await this._pollStatus(leg2.id, ['success'], (s) => {
        log('  Leg 2 status: ' + s.status, '#888');
      });
      log('✅ XMR → ' + destCoin + ' complete!', '#22c55e');
      log('🌑 Transfer complete! Recipient received ~' + est.finalAmount.toFixed(6) + ' ' + destCoin + ' on ' + destNetwork, '#a78bfa');
    },

    /** Create a bridge exchange */
    async _createExchange(coinFrom, networkFrom, coinTo, networkTo, amount, withdrawalAddress) {
      const r = await fetch(`${API}/transactions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ coinFrom, networkFrom, coinTo, networkTo, amount, withdrawalAddress, rateType: 'float' }),
      });
      const data = await r.json();
      if (data.errors || data.statusCode >= 400) throw new Error(JSON.stringify(data.errors || data));
      return data;
    },

    /** Poll exchange status until target */
    async _pollStatus(txId, targets, onUpdate, maxWait = 600000) {
      const start = Date.now();
      while (Date.now() - start < maxWait) {
        const r = await fetch(`${API}/transactions/${txId}`);
        const status = await r.json();
        if (onUpdate) onUpdate(status);
        if (targets.includes(status.status)) return status;
        if (['overdue', 'refunded'].includes(status.status)) {
          throw new Error(`Exchange ${status.status}: ${txId}`);
        }
        await new Promise(r => setTimeout(r, 12000));
      }
      throw new Error('Timeout — check bridge status manually: ' + txId);
    },
  };

  console.log('[ShadowBridge] Multi-network bridge loaded ✓');
})();
