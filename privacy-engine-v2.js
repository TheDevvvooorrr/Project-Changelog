/**
 * Ciego Privacy Engine v2 — Enhanced Mode
 * 
 * NEW: Chain funding + token swap mid-route
 * 
 * Enhanced flow (SOL):
 *   User → T1 (only 1 visible link from main wallet)
 *   T1 → Swap(SOL→USDC) — breaks token trail
 *   T1 → T2 (USDC) → T3 (USDC)  — chain hops as USDC
 *   T3 → Swap(USDC→SOL) — swap back
 *   T3 → Recipient (SOL)
 *
 * Enhanced flow (USDC/USDT):
 *   User → T1 (only 1 visible link)
 *   T1 → Swap(USDC→SOL) — breaks token trail
 *   T1 → T2 (SOL) → T3 (SOL)  — chain hops as SOL
 *   T3 → Swap(SOL→USDC) — swap back
 *   T3 → Recipient (USDC)
 * 
 * Result: On Solscan, main wallet only links to T1.
 * Token changes mid-route = impossible to trace by following one token.
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
  const ATA_PROGRAM_ID  = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const FEE_WALLET = new PublicKey('983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb');
  const FEE_PERCENT = 0.01;
  const BASE_FEE = 5000;
  const RENT_EXEMPT = 891000;
  const USDC_MINT = new PublicKey('EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v');
  const SOL_MINT_STR = 'So11111111111111111111111111111111111111112';

  function getATA(mint, owner) {
    const [a] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
    return a;
  }
  const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
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
    const rpc = window.ShadowPrivacy?.rpc;
    const { blockhash } = rpc ? await rpc.getLatestBlockhash() : await conn.getLatestBlockhash('confirmed');
    return new VersionedTransaction(
      new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
    );
  }

  async function sendConfirm(conn, tx, signers, rpcUrl, maxRetries = 3) {
    const rpc = window.ShadowPrivacy?.rpc;
    const canResign = signers?.length > 0;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (canResign) {
        const { blockhash } = rpc ? await rpc.getLatestBlockhash() : await conn.getLatestBlockhash('confirmed');
        tx.message.recentBlockhash = blockhash;
        tx.signatures = [];
        for (const s of signers) tx.sign([s]);
      }
      const raw = encodeBase58(tx.serialize());
      const _rpc = window.ShadowPrivacy?.rpc;
      const sig = await _rpc.rpcCall('sendTransaction', [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }], 4);
      if (!sig) throw new Error('sendTransaction returned null');
      for (let i = 0; i < 75; i++) {
        await new Promise(r => setTimeout(r, 600));
        try {
          const stResult = await _rpc.rpcCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
          const st = stResult?.value?.[0];
          if (st?.err) throw new Error('TX failed on-chain: ' + JSON.stringify(st.err));
          if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
        } catch (e) { if (e.message.includes('TX failed')) throw e; }
        if (i > 0 && i % 5 === 0) {
          try { await _rpc.rpcCall('sendTransaction', [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }]);
          } catch(e) {}
        }
      }
      if (!canResign) throw new Error('TX not confirmed after 45s — try again');
      if (attempt < maxRetries - 1) console.log('TX attempt ' + (attempt + 1) + ' expired, retrying...');
    }
    throw new Error('TX not confirmed after ' + maxRetries + ' attempts');
  }

  // Wait for a balance to appear on a shadow wallet
  async function waitForBalance(connection, pubkey, isSOL, mintPubkey, minAmount = 0, timeoutS = 45) {
    for (let w = 0; w < timeoutS; w++) {
      try {
        if (isSOL) {
          const b = await rpc.getBalance(pubkey);
          if (b > (minAmount || BASE_FEE)) return b;
        } else {
          const ata = getATA(mintPubkey, pubkey);
          const b = await rpc.getTokenAccountBalance(ata);
          if (parseInt(b.value.amount) > 0) return parseInt(b.value.amount);
        }
      } catch(e) {}
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Shadow wallet balance not found after ' + timeoutS + 's');
  }

  // Anti-correlation delay with visual countdown
  async function antiCorrelationDelay(onProgress, minSec, maxSec, label) {
    const delaySec = minSec + Math.random() * (maxSec - minSec);
    const totalMs = Math.round(delaySec * 1000);
    const startTime = Date.now();
    onProgress('delay', `⏱️ ${label || 'Anti-correlation delay'}`, `Waiting ${Math.round(delaySec)}s to break timing pattern...`);
    while (Date.now() - startTime < totalMs) {
      const remaining = Math.ceil((totalMs - (Date.now() - startTime)) / 1000);
      onProgress('delay', `⏱️ ${remaining}s remaining...`, label || 'Breaking timing pattern');
      await new Promise(r => setTimeout(r, 1000));
    }
  }

  // Amount fuzzing: vary amount by ±fuzzPct to break amount correlation
  function fuzzAmount(lamports, fuzzPct = 0.05) {
    // ONLY fuzz DOWN (never above balance!) — range: (1-fuzzPct) to 1.0
    const variation = 1 - (Math.random() * fuzzPct);
    return Math.round(lamports * variation);
  }

  // ===== ENHANCED v2: Chain funding + token swap =====
  async function sendEnhanced(opts) {
    const { connection, wallet, publicKey, recipient, amount, token, rpcProxy, onProgress } = opts;
    const rpc = window.ShadowPrivacy?.rpc || { getBalance: (pk) => connection.getBalance(pk), getTokenAccountBalance: (a) => connection.getTokenAccountBalance(a).then(r => parseInt(r.value.amount)) };
    const isSOL = token.mint === 'native';
    const mintPubkey = isSOL ? null : new PublicKey(token.mint);
    const rawAmount = Math.round(amount * Math.pow(10, token.decimals));
    const swapEngine = window.ShadowPrivacy?.swapEngine;

    // 3 shadow wallets for chain hops
    const temps = opts.batchShadows || [Keypair.generate(), Keypair.generate(), Keypair.generate()];

    // Recovery data
    const recoveryData = {
      timestamp: Date.now(),
      wallets: temps.map(k => ({ pub: k.publicKey.toBase58(), secret: Array.from(k.secretKey) })),
      recipient: recipient.toBase58(),
      amount, token: { symbol: token.symbol, mint: token.mint, decimals: token.decimals }
    };
    try { localStorage.setItem('shadowsend_recovery', JSON.stringify(recoveryData)); } catch(e) {}

    onProgress('hop1', 'Generating 3 shadow wallets...', temps.map((t, i) => `T${i+1}: ${t.publicKey.toBase58().slice(0,6)}...`).join(' → '));

    // 1% fee
    const feeAmount = isSOL
      ? Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT)
      : Math.round(rawAmount * FEE_PERCENT);
    const sendAmount = isSOL
      ? Math.round(amount * LAMPORTS_PER_SOL) - feeAmount
      : rawAmount - feeAmount;

    // SOL needed for T1: swap fees (~0.01 SOL) + hop fees + rent
    const swapBuffer = swapEngine ? 15_000_000 : 0; // 0.015 SOL for swap fees/ATA
    const hopFees = isSOL ? 3 * BASE_FEE : 3 * (2_100_000 + BASE_FEE);

    // ==== STEP 1: User → T1 only (single link from main wallet) ====
    onProgress('hop1', 'Funding shadow wallet 1...', 'Please approve in Phantom — only 1 TX from your wallet');
    const ix1 = [];
    if (isSOL) {
      ix1.push(SystemProgram.transfer({
        fromPubkey: publicKey, toPubkey: temps[0].publicKey,
        lamports: sendAmount + hopFees + swapBuffer,
      }));
      ix1.push(SystemProgram.transfer({
        fromPubkey: publicKey, toPubkey: FEE_WALLET, lamports: feeAmount,
      }));
    } else {
      ix1.push(SystemProgram.transfer({
        fromPubkey: publicKey, toPubkey: temps[0].publicKey,
        lamports: hopFees + swapBuffer,
      }));
      const sATA = getATA(mintPubkey, publicKey);
      const t1ATA = getATA(mintPubkey, temps[0].publicKey);
      ix1.push(createATAIx(publicKey, t1ATA, temps[0].publicKey, mintPubkey));
      ix1.push(splTransferIx(sATA, t1ATA, publicKey, sendAmount));
      const feeATA = getATA(mintPubkey, FEE_WALLET);
      ix1.push(createATAIx(publicKey, feeATA, FEE_WALLET, mintPubkey));
      ix1.push(splTransferIx(sATA, feeATA, publicKey, feeAmount));
    }
    const sigs = [];
    if (opts.skipFunding) {
      // BATCH MODE: shadow was funded by the combined batch TX already
      onProgress('hop1', '✅ Shadow 1 already funded (batch TX)', 'Proceeding...');
    } else {
      // SINGLE MODE: Build and sign (1 Phantom popup)
      const tx1 = await buildV0(connection, publicKey, ix1);
      const signed1 = await wallet.signTransaction(tx1);
      onProgress('hop1', 'Broadcasting to shadow 1...', 'TX 1/5');
      const sig1 = await sendConfirm(connection, signed1, null, rpcProxy);
      onProgress('hop1', '✅ Shadow 1 funded', `TX: ${sig1.slice(0,8)}... — Only link to your wallet`);
      sigs.push(sig1);
    }

    // Anti-correlation delay before swap (15-40s)
    await antiCorrelationDelay(onProgress, 3, 8, 'Pre-swap delay — breaking timing link');

    // ==== STEP 2: Token swap on T1 (break token trail) ====
    let swappedAmount = sendAmount;
    let midIsSOL = isSOL; // track what token we're hopping with
    let midMint = mintPubkey;
    let didSwap = false; // true if swapped to intermediate token

    if (swapEngine) {
      try {
        const inputMint = isSOL ? SOL_MINT_STR : token.mint;
        const outputMint = swapEngine.getSwapMint(token.mint);
        // For SOL: swap most of it to USDC, keep some for fees
        const swapAmt = isSOL ? (sendAmount - 3 * BASE_FEE) : sendAmount;

        const result = await swapEngine.executeSwap(
          connection, temps[0], inputMint, outputMint, swapAmt, rpcProxy, onProgress
        );
        sigs.push(result.signature);
        swappedAmount = result.outAmount;
        // Determine what we're now hopping with based on actual output mint
        if (outputMint === SOL_MINT_STR) {
          midIsSOL = true;
          midMint = null;
        } else {
          midIsSOL = false;
          midMint = new PublicKey(outputMint);
        }
        didSwap = true;
        const midLabel = midIsSOL ? 'SOL' : (outputMint === swapEngine.USDC_MINT ? 'USDC' : 'intermediate token');
        onProgress('swap', '✅ Token trail broken', `Now moving as ${midLabel}`);
      } catch(e) {
        console.warn('Swap failed, continuing with original token:', e.message);
        onProgress('swap', '⚠️ Swap skipped (continuing direct)', e.message);
      }
    }

    // ==== STEP 3: T1 → T2 (chain hop — T2 was NOT funded by main wallet) ====
    await antiCorrelationDelay(onProgress, 4, 10, 'Inter-hop delay');

    onProgress('hop2', 'Shadow 1 → Shadow 2...', 'TX 3/5 — Chain funded, no link to your wallet (fuzzed amount)');
    const ix2 = [];
    if (midIsSOL) {
      const bal = await rpc.getBalance(temps[0].publicKey);
      const send2 = fuzzAmount(bal - BASE_FEE, 0.05); // ±5% fuzzing
      if (send2 <= 0) throw new Error('T1 has insufficient SOL: ' + (bal/1e9).toFixed(6));
      ix2.push(SystemProgram.transfer({ fromPubkey: temps[0].publicKey, toPubkey: temps[1].publicKey, lamports: send2 }));
    } else {
      // Transfer SPL + SOL for next hop fees
      const t1Bal = await rpc.getBalance(temps[0].publicKey);
      const solForward = Math.min(t1Bal - BASE_FEE, 5_000_000); // forward up to 0.005 SOL for fees
      if (solForward > 0) ix2.push(SystemProgram.transfer({ fromPubkey: temps[0].publicKey, toPubkey: temps[1].publicKey, lamports: solForward }));
      const t1ATA = getATA(midMint, temps[0].publicKey);
      const t2ATA = getATA(midMint, temps[1].publicKey);
      ix2.push(createATAIx(temps[0].publicKey, t2ATA, temps[1].publicKey, midMint));
      ix2.push(splTransferIx(t1ATA, t2ATA, temps[0].publicKey, swappedAmount));
      ix2.push(closeAccountIx(t1ATA, temps[0].publicKey, temps[0].publicKey));
    }
    const tx2 = await buildV0(connection, temps[0].publicKey, ix2);
    const sig2 = await sendConfirm(connection, tx2, [temps[0]], rpcProxy);
    sigs.push(sig2);
    onProgress('hop2', '✅ Shadow 2 received', `TX: ${sig2.slice(0,8)}...`);

    // ==== STEP 4: T2 → T3 (another chain hop) ====
    await antiCorrelationDelay(onProgress, 4, 10, 'Inter-hop delay');

    onProgress('hop3', 'Shadow 2 → Shadow 3...', 'TX 4/5 (fuzzed amount)');
    const ix3 = [];
    if (midIsSOL) {
      const bal = await rpc.getBalance(temps[1].publicKey);
      const send3 = fuzzAmount(bal - BASE_FEE, 0.05); // ±5% fuzzing
      ix3.push(SystemProgram.transfer({ fromPubkey: temps[1].publicKey, toPubkey: temps[2].publicKey, lamports: send3 }));
    } else {
      const t2Bal = await rpc.getBalance(temps[1].publicKey);
      const solForward = Math.min(t2Bal - BASE_FEE, 5_000_000);
      if (solForward > 0) ix3.push(SystemProgram.transfer({ fromPubkey: temps[1].publicKey, toPubkey: temps[2].publicKey, lamports: solForward }));
      const t2ATA = getATA(midMint, temps[1].publicKey);
      const t3ATA = getATA(midMint, temps[2].publicKey);
      ix3.push(createATAIx(temps[1].publicKey, t3ATA, temps[2].publicKey, midMint));
      ix3.push(splTransferIx(t2ATA, t3ATA, temps[1].publicKey, swappedAmount));
      ix3.push(closeAccountIx(t2ATA, temps[1].publicKey, temps[1].publicKey));
    }
    const tx3 = await buildV0(connection, temps[1].publicKey, ix3);
    const sig3 = await sendConfirm(connection, tx3, [temps[1]], rpcProxy);
    sigs.push(sig3);
    onProgress('hop3', '✅ Shadow 3 received', `TX: ${sig3.slice(0,8)}...`);

    // ==== STEP 5: Swap back on T3 + deliver to recipient ====
    let finalAmount = swappedAmount;
    if (swapEngine && didSwap) {
      // We need to swap back to original token
      try {
        await antiCorrelationDelay(onProgress, 3, 8, 'Pre-swap-back delay');

        const inputMint2 = midIsSOL ? SOL_MINT_STR : midMint.toBase58();
        const outputMint2 = isSOL ? SOL_MINT_STR : token.mint;
        // Amount to swap back
        let swapBackAmt;
        if (midIsSOL) {
          const bal = await rpc.getBalance(temps[2].publicKey);
          swapBackAmt = bal - 2 * BASE_FEE - 5_000_000; // keep some for final TX fee
        } else {
          swapBackAmt = swappedAmount;
        }
        const result2 = await swapEngine.executeSwap(
          connection, temps[2], inputMint2, outputMint2, swapBackAmt, rpcProxy, onProgress
        );
        sigs.push(result2.signature);
        finalAmount = result2.outAmount;
        onProgress('swap', '✅ Swapped back to ' + token.symbol, 'Ready for final delivery');
      } catch(e) {
        console.warn('Swap-back failed:', e.message);
        onProgress('swap', '⚠️ Swap-back skipped', 'Delivering in ' + (midIsSOL ? 'SOL' : 'intermediate token'));
        // Deliver whatever we have
      }
    }

    // ==== STEP 6: T3 → Recipient (final delivery) ====
    await antiCorrelationDelay(onProgress, 4, 12, 'Final delivery delay — maximum decorrelation');

    onProgress('final', 'Delivering to recipient...', 'Final TX');
    const ixF = [];
    if (isSOL) {
      const bal = await rpc.getBalance(temps[2].publicKey);
      const deliverAmt = bal - BASE_FEE;
      if (deliverAmt <= 0) throw new Error('T3 has no SOL to deliver');
      ixF.push(SystemProgram.transfer({ fromPubkey: temps[2].publicKey, toPubkey: recipient, lamports: deliverAmt }));
    } else {
      // Deliver SPL token
      const t3ATA = getATA(mintPubkey, temps[2].publicKey);
      const recipATA = getATA(mintPubkey, recipient);
      ixF.push(createATAIx(temps[2].publicKey, recipATA, recipient, mintPubkey));
      // Check actual token balance on T3 — MUST read real balance (slippage from swap)
      let tokenBal;
      for (let attempt = 0; attempt < 5; attempt++) {
        try {
          const b = await rpc.getTokenAccountBalance(t3ATA);
          tokenBal = parseInt(b.value.amount);
          break;
        } catch(e) {
          if (attempt < 4) { await new Promise(r => setTimeout(r, 2000)); }
          else { throw new Error('Cannot read T3 token balance — funds safe in shadow wallet, try recovery'); }
        }
      }
      if (tokenBal <= 0) throw new Error('T3 has 0 tokens — check swap result');
      ixF.push(splTransferIx(t3ATA, recipATA, temps[2].publicKey, tokenBal));
      ixF.push(closeAccountIx(t3ATA, temps[2].publicKey, temps[2].publicKey));
    }
    const txF = await buildV0(connection, temps[2].publicKey, ixF);
    const sigF = await sendConfirm(connection, txF, [temps[2]], rpcProxy);
    sigs.push(sigF);
    onProgress('final', '✅ Delivered to recipient', `TX: ${sigF.slice(0,8)}...`);

    // Cleanup: sweep dust from all temps
    for (const tmp of temps) {
      try {
        const bal = await rpc.getBalance(tmp.publicKey);
        if (bal > BASE_FEE + 1000) {
          const ixC = [SystemProgram.transfer({ fromPubkey: tmp.publicKey, toPubkey: FEE_WALLET, lamports: bal - BASE_FEE })];
          const txC = await buildV0(connection, tmp.publicKey, ixC);
          txC.sign([tmp]);
          const raw = encodeBase58(txC.serialize());
          fetch(rpcProxy, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
              params: [raw, { encoding: 'base58', skipPreflight: true }] }) }).catch(() => {});
        }
      } catch(e) {}
    }

    try { localStorage.removeItem('shadowsend_recovery'); } catch(e) {}

    return {
      success: true,
      signatures: sigs,
      hops: 3,
      swapCount: swapEngine ? 2 : 0,
      tokenTrailBroken: !!swapEngine,
    };
  }

  if (!window.ShadowPrivacy) window.ShadowPrivacy = {};
  window.ShadowPrivacy.sendEnhanced = sendEnhanced;
})();
