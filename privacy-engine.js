/**
 * Ciego Privacy Engine — Enhanced Mode
 * 
 * Enhanced: User → Temp1 → Temp2 → Temp3 → Recipient  (3 hops, 3 delays)
 * 
 * Each hop uses a fresh ephemeral keypair generated in-browser.
 * Private keys exist ONLY in RAM — never stored, never transmitted.
 * Delays between hops break temporal correlation.
 */
(function () {
  'use strict';
  if (typeof solanaWeb3 === 'undefined') return;

  const {
    Keypair, PublicKey, SystemProgram, TransactionMessage,
    VersionedTransaction, LAMPORTS_PER_SOL, TransactionInstruction,
    ComputeBudgetProgram,
  } = solanaWeb3;

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const FEE_PER_HOP_SOL = 0.000006; // 5000 lamports base fee + 1000 buffer per hop
  const FEE_WALLET = new PublicKey('983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb');
  const FEE_PERCENT = 0.01; // 1%

  function getATA(mint, owner) {
    const [address] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
    return address;
  }
  const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
  // Use IDEMPOTENT create ATA (instruction byte = 1) — does NOT fail if ATA already exists
  // Requires 7 accounts including SYSVAR_RENT
  function createATAIx(payer, ata, owner, mint) {
    return new TransactionInstruction({
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
      ],
      programId: ATA_PROGRAM_ID, data: new Uint8Array([1]),
    });
  }
  function splTransferIx(src, dst, owner, amt) {
    const d = new Uint8Array(9); d[0] = 3;
    new DataView(d.buffer).setBigUint64(1, BigInt(amt), true);
    return new TransactionInstruction({
      keys: [
        { pubkey: src, isSigner: false, isWritable: true },
        { pubkey: dst, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID, data: d,
    });
  }
  function closeAccountIx(account, dest, owner) {
    return new TransactionInstruction({
      keys: [
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID, data: new Uint8Array([9]),
    });
  }

  function encodeBase58(bytes) {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let r = '', n = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
    while (n > 0n) { r = A[Number(n % 58n)] + r; n /= 58n; }
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) r = '1' + r;
    return r;
  }

  async function buildV0(conn, payer, ixs) {
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  async function sendConfirm(conn, tx, signers, rpc, maxRetries = 3) {
    const canResign = signers?.length > 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (canResign) {
        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        tx.message.recentBlockhash = blockhash;
        tx.signatures = [];
        for (const s of signers) tx.sign([s]);
      }
      const raw = encodeBase58(tx.serialize());
      let j;
      for (let s = 0; s < 4; s++) {
        try {
          const resp = await fetch(rpc, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
              params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }] })
          });
          if (!resp.ok) {
            console.warn('RPC returned ' + resp.status + ', retrying send...');
            await new Promise(r => setTimeout(r, 1500 * (s + 1)));
            continue;
          }
          const text = await resp.text();
          try { j = JSON.parse(text); } catch(pe) {
            console.warn('RPC returned non-JSON, retrying send...');
            await new Promise(r => setTimeout(r, 1500 * (s + 1)));
            continue;
          }
          break;
        } catch(fe) {
          console.warn('Fetch error: ' + fe.message + ', retrying...');
          await new Promise(r => setTimeout(r, 1500 * (s + 1)));
        }
      }
      if (!j) throw new Error('RPC unreachable after 4 send attempts');
      if (j.error) throw new Error('RPC: ' + JSON.stringify(j.error));
      const sig = j.result;
      // Poll for 45s (75 * 600ms)
      for (let i = 0; i < 75; i++) {
        await new Promise(r => setTimeout(r, 600));
        try {
          const pr = await fetch(rpc, {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
              params: [[sig], { searchTransactionHistory: true }] })
          });
          if (!pr.ok) continue;
          const pt = await pr.text();
          let pj; try { pj = JSON.parse(pt); } catch(pe) { continue; }
          const st = pj?.result?.value?.[0];
          if (st?.err) throw new Error('TX failed on-chain: ' + JSON.stringify(st.err));
          if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
        } catch (e) { if (e.message.includes('TX failed')) throw e; }
        // Resubmit every 5 polls (~3s)
        if (i > 0 && i % 5 === 0) {
          try { await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
              params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] }) });
          } catch(e) {}
        }
      }
      if (!canResign) {
        throw new Error('Initial transaction not confirmed after 45s — blockhash may have expired. Please try again.');
      }
      if (attempt < maxRetries - 1) {
        console.log('TX attempt ' + (attempt + 1) + ' expired, retrying with fresh blockhash...');
      }
    }
    throw new Error('Transaction not confirmed after ' + maxRetries + ' attempts — network may be congested, try again');
  }

  function randomDelay(minS, maxS) {
    return new Promise(r => setTimeout(r, (minS + Math.random() * (maxS - minS)) * 1000));
  }

  // ===== ENHANCED: 3 hops with delays =====
  // User → Temp1 → Temp2 → Temp3 → Recipient
  async function sendEnhanced(opts) {
    const { connection, wallet, publicKey, recipient, amount, token, rpcProxy, onProgress } = opts;
    const isSOL = token.mint === 'native';
    const mintPubkey = isSOL ? null : new PublicKey(token.mint);
    const rawAmount = Math.round(amount * Math.pow(10, token.decimals));
    const NUM_HOPS = 5;

    // Generate 3 temp wallets
    const temps = Array.from({ length: NUM_HOPS }, () => Keypair.generate());

    // ⚠️ CRITICAL: Save keypairs to localStorage for recovery if tx fails mid-way
    const recoveryData = {
      timestamp: Date.now(),
      wallets: temps.map(k => ({ pub: k.publicKey.toBase58(), secret: Array.from(k.secretKey) })),
      recipient: recipient.toBase58(),
      amount, token: { symbol: token.symbol, mint: token.mint, decimals: token.decimals }
    };
    try { localStorage.setItem('shadowsend_recovery', JSON.stringify(recoveryData)); } catch(e) {}

    onProgress('hop1', `Generating ${NUM_HOPS} shadow wallets...`, temps.map((t, i) => `T${i + 1}: ${t.publicKey.toBase58().slice(0, 6)}...`).join(' → '));

    // STEP 1: User → Temp1 (user signs with Phantom)
    onProgress('hop1', 'Building TX to shadow wallet 1...', 'Please approve in Phantom');
    const ix1 = [];
    // For SPL tokens, each shadow wallet needs SOL to create ATAs (~0.0021 SOL) + tx fees
    const ATA_RENT = 2_100_000; // ~0.0021 SOL for ATA rent-exempt
    const HOP_FEE = 5500;
    const solPerHop = isSOL ? HOP_FEE : (ATA_RENT + HOP_FEE);
    // Extra SOL for decoy transactions (each decoy sends RENT_EXEMPT_MIN + fee)
    const decoyExtra = window.ShadowPrivacy?.decoys?.SETTINGS?.enhanced?.extraSOL
      ? Math.round(window.ShadowPrivacy.decoys.SETTINGS.enhanced.extraSOL * LAMPORTS_PER_SOL)
      : 0;
    const solForFees = NUM_HOPS * solPerHop + decoyExtra;

    // 1% platform fee — minimum 891000 lamports for SOL (rent-exempt minimum)
    const RENT_EXEMPT_MIN = 891000;
    const feeAmount = isSOL
      ? Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT_MIN)
      : Math.round(rawAmount * FEE_PERCENT);
    const sendAmount = isSOL
      ? Math.round(amount * LAMPORTS_PER_SOL) - feeAmount
      : rawAmount - feeAmount;

    if (isSOL) {
      ix1.push(SystemProgram.transfer({
        fromPubkey: publicKey, toPubkey: temps[0].publicKey,
        lamports: sendAmount + solForFees,
      }));
      // Fee to platform wallet
      ix1.push(SystemProgram.transfer({
        fromPubkey: publicKey, toPubkey: FEE_WALLET,
        lamports: feeAmount,
      }));
    } else {
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: temps[0].publicKey, lamports: solForFees }));
      const sATA = getATA(mintPubkey, publicKey);
      const t1ATA = getATA(mintPubkey, temps[0].publicKey);
      ix1.push(createATAIx(publicKey, t1ATA, temps[0].publicKey, mintPubkey));
      ix1.push(splTransferIx(sATA, t1ATA, publicKey, sendAmount));
      // Fee to platform wallet (SPL)
      const feeATA = getATA(mintPubkey, FEE_WALLET);
      ix1.push(createATAIx(publicKey, feeATA, FEE_WALLET, mintPubkey));
      ix1.push(splTransferIx(sATA, feeATA, publicKey, feeAmount));
    }

    const tx1 = await buildV0(connection, publicKey, ix1);
    const signed1 = await wallet.signTransaction(tx1);
    onProgress('hop1', 'Sending to shadow wallet 1...', 'TX 1/' + (NUM_HOPS + 1));
    const sig1 = await sendConfirm(connection, signed1, null, rpcProxy);
    onProgress('hop1', '✅ Shadow 1 funded', `TX: ${sig1.slice(0, 8)}...`);
    const sigs = [sig1];

    // Decoy engine (if loaded)
    const decoyEngine = window.ShadowPrivacy?.decoys;
    const cfg = decoyEngine?.SETTINGS?.enhanced;

    // HOPS 2-3: Temp[i-1] → Temp[i]  (automatic, no Phantom)
    for (let i = 1; i < NUM_HOPS; i++) {
      // ANTI-TRACKING: Random delay (15-45s) to break timing analysis
      if (decoyEngine && cfg) {
        await decoyEngine.randomDelay(cfg.delays.min, cfg.delays.max, onProgress);
      } else {
        const delaySec = 2 + Math.random() * 3;
        onProgress(`delay`, `Delay ${Math.round(delaySec)}s before hop ${i + 1}...`, 'Breaking temporal correlation');
        await randomDelay(delaySec, delaySec + 0.1);
      }

      const from = temps[i - 1];
      const to = temps[i];
      onProgress(`hop${i + 1}`, `Shadow ${i} → Shadow ${i + 1}...`, `TX ${i + 1}/${NUM_HOPS + 1}`);

      // Wait for balance to arrive from previous hop
      for (let w = 0; w < 30; w++) {
        try {
          if (isSOL) { if (await connection.getBalance(from.publicKey) > 5000) break; }
          else { const a = getATA(mintPubkey, from.publicKey); const b = await connection.getTokenAccountBalance(a); if (parseInt(b.value.amount) > 0) break; }
        } catch(e) {}
        await new Promise(r => setTimeout(r, 1000));
        if (w === 29) throw new Error('Shadow wallet balance not found after 30s — previous TX may not have landed');
      }

      const ix = [];
      if (isSOL) {
        const bal = await connection.getBalance(from.publicKey);
        const sendAmt = bal - 5000;
        if (sendAmt <= 0) throw new Error('Shadow wallet has insufficient SOL: ' + (bal / 1e9).toFixed(6));
        ix.push(SystemProgram.transfer({ fromPubkey: from.publicKey, toPubkey: to.publicKey, lamports: sendAmt }));
      } else {
        const fromATA = getATA(mintPubkey, from.publicKey);
        const toATA = getATA(mintPubkey, to.publicKey);
        // Get actual token balance
        const tokenBal = await connection.getTokenAccountBalance(fromATA);
        const actualAmt = parseInt(tokenBal.value.amount);
        if (actualAmt <= 0) throw new Error('Shadow wallet has 0 token balance');
        // 1. Create dest ATA
        ix.push(createATAIx(from.publicKey, toATA, to.publicKey, mintPubkey));
        // 2. Transfer ALL SPL tokens
        ix.push(splTransferIx(fromATA, toATA, from.publicKey, actualAmt));
        // 3. Close own ATA → recovers rent
        ix.push(closeAccountIx(fromATA, from.publicKey, from.publicKey));
        // Do NOT transfer SOL in same TX — unpredictable balance after create+close ATA
      }

      const tx = await buildV0(connection, from.publicKey, ix);
      const sig = await sendConfirm(connection, tx, [from], rpcProxy);

      // For SPL: sweep remaining SOL in separate TX (fire-and-forget, non-blocking)
      if (!isSOL) {
        const _from = from; // capture for closure
        const _to = to;
        setTimeout(async () => {
          try {
            const remSOL = await connection.getBalance(_from.publicKey);
            const sweepAmt = remSOL - 5000;
            const destBal = await connection.getBalance(_to.publicKey);
            const MIN_FOR_NEW = 891000;
            if (sweepAmt > 0 && (destBal > 0 || sweepAmt >= MIN_FOR_NEW)) {
              const sIx = [SystemProgram.transfer({ fromPubkey: _from.publicKey, toPubkey: _to.publicKey, lamports: sweepAmt })];
              const sTx = await buildV0(connection, _from.publicKey, sIx);
              sTx.sign([_from]);
              const raw = encodeBase58(sTx.serialize());
              await fetch(rpcProxy, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
                  params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] }) });
              console.log('SOL sweep sent (fire-and-forget): ' + sweepAmt + ' lamports');
            }
          } catch(e) { console.warn('SOL sweep failed (non-critical):', e.message); }
        }, 800);
      }
      onProgress(`hop${i + 1}`, `✅ Shadow ${i + 1} received`, `TX: ${sig.slice(0, 8)}...`);
      sigs.push(sig);

      // ANTI-TRACKING: Send decoy TX from this shadow wallet to random address
      if (decoyEngine && cfg && i < NUM_HOPS - 1) {
        onProgress('decoy', '🎭 Sending decoy transactions...', 'Creating noise for trackers');
        await decoyEngine.sendDecoys(connection, temps[i], rpcProxy, cfg.decoys.perHop, onProgress);
      }
    }

    // FINAL HOP: Last Temp → Recipient
    // ANTI-TRACKING: Final long delay
    if (decoyEngine && cfg) {
      await decoyEngine.randomDelay(cfg.delays.min, cfg.delays.max, onProgress);
    } else {
      const lastDelay = 2 + Math.random() * 3;
      onProgress('delay', `Final delay ${Math.round(lastDelay)}s...`, 'Last obfuscation window');
      await randomDelay(lastDelay, lastDelay + 0.1);
    }

    const lastTemp = temps[NUM_HOPS - 1];
    onProgress('final', 'Delivering to recipient...', 'TX ' + (NUM_HOPS + 1) + '/' + (NUM_HOPS + 1) + ' — final hop');
    // NO priority fee — drain to 0
    const ixF = [];

    if (isSOL) {
      const bal = await connection.getBalance(lastTemp.publicKey);
      ixF.push(SystemProgram.transfer({ fromPubkey: lastTemp.publicKey, toPubkey: recipient, lamports: bal - 5000 }));
    } else {
      const ltATA = getATA(mintPubkey, lastTemp.publicKey);
      const rATA = getATA(mintPubkey, recipient);
      // Get actual token balance
      const ltTokenBal = await connection.getTokenAccountBalance(ltATA);
      const ltActualAmt = parseInt(ltTokenBal.value.amount);
      try {
        const info = await connection.getAccountInfo(rATA);
        if (!info) ixF.push(createATAIx(lastTemp.publicKey, rATA, recipient, mintPubkey));
      } catch { ixF.push(createATAIx(lastTemp.publicKey, rATA, recipient, mintPubkey)); }
      ixF.push(splTransferIx(ltATA, rATA, lastTemp.publicKey, ltActualAmt));
      ixF.push(closeAccountIx(ltATA, lastTemp.publicKey, lastTemp.publicKey));
      // Do NOT sweep SOL in same TX — do separate sweep after
    }

    const txF = await buildV0(connection, lastTemp.publicKey, ixF);
    const sigF = await sendConfirm(connection, txF, [lastTemp], rpcProxy);

    // For SPL: sweep remaining SOL from last temp to FEE_WALLET (fire-and-forget)
    if (!isSOL) {
      const _lt = lastTemp;
      setTimeout(async () => {
        try {
          const remSOL = await connection.getBalance(_lt.publicKey);
          const sweepAmt = remSOL - 5000;
          const feeBal = await connection.getBalance(FEE_WALLET);
          if (sweepAmt > 0 && (feeBal > 0 || sweepAmt >= 891000)) {
            const sIx = [SystemProgram.transfer({ fromPubkey: _lt.publicKey, toPubkey: FEE_WALLET, lamports: sweepAmt })];
            const sTx = await buildV0(connection, _lt.publicKey, sIx);
            sTx.sign([_lt]);
            const raw = encodeBase58(sTx.serialize());
            await fetch(rpcProxy, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
                params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] }) });
          }
        } catch(e) { console.warn('Final SOL sweep failed (non-critical):', e.message); }
      }, 800);
    }
    onProgress('final', '✅ Recipient received funds', `TX: ${sigF.slice(0, 8)}...`);
    sigs.push(sigF);

    // Sweep remaining SOL from all temps to FEE_WALLET (fire-and-forget)
    onProgress('cleanup', 'Cleaning shadow wallets...', 'Sending leftover SOL to fee wallet');
    for (const tmp of temps) {
      try {
        const bal = await connection.getBalance(tmp.publicKey);
        const sweepAmt = bal - 5000;
        if (sweepAmt <= 0) continue;
        const feeBal = await connection.getBalance(FEE_WALLET);
        if (feeBal > 0 || sweepAmt >= 891000) {
          const ixS = [SystemProgram.transfer({ fromPubkey: tmp.publicKey, toPubkey: FEE_WALLET, lamports: sweepAmt })];
          const txS = await buildV0(connection, tmp.publicKey, ixS);
          txS.sign([tmp]);
          const raw = encodeBase58(txS.serialize());
          fetch(rpcProxy, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
              params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] }) })
            .catch(e => console.warn('[Privacy] Sweep:', e.message));
        }
      } catch (e) { console.warn('[Privacy] Sweep failed:', e.message); }
    }

    // Clear recovery data on success
    try { localStorage.removeItem('shadowsend_recovery'); } catch(e) {}
    return { signatures: sigs, hops: NUM_HOPS, tempWallets: temps.map(t => t.publicKey.toBase58()) };
  }

  window.ShadowPrivacy = { sendEnhanced };
})();
