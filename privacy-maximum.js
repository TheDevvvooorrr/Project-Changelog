/**
 * Ciego Maximum Privacy — 7 shadow wallets, 3 parallel paths, 10 transactions
 *
 * Flow:
 *   User → [T1, T2, T3]          3-way random split
 *     Path A: T1 → T4            hop
 *     Path B: T2 → T5            hop
 *     Path C: T3 → T6            hop
 *     T4 → T7 (collector)        converge
 *     T5 → T7                    converge
 *     T6 → T7                    converge
 *     T7 → Recipient             final delivery
 *
 * On Solscan: 10 transactions, 7 shadow wallets, 3 parallel paths, random amounts & timing.
 * An analyst sees a tree of unrelated wallets with no obvious link.
 */
(function () {
  'use strict';
  if (!window.ShadowPrivacy) return;
  if (typeof solanaWeb3 === 'undefined') return;

  const {
    Keypair, PublicKey, SystemProgram, TransactionMessage,
    VersionedTransaction, LAMPORTS_PER_SOL, TransactionInstruction,
    ComputeBudgetProgram,
  } = solanaWeb3;

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const FEE_PER_HOP = 0.000006; // 5000 lamports base + 1000 buffer per hop
  const FEE_WALLET = new PublicKey('983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb');
  const FEE_PERCENT = 0.01; // 1%

  function getATA(mint, owner) {
    const [a] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
    return a;
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
  function splTx(src, dst, owner, amt) {
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
  function closeIx(account, dest, owner) {
    return new TransactionInstruction({
      keys: [
        { pubkey: account, isSigner: false, isWritable: true },
        { pubkey: dest, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID, data: new Uint8Array([9]),
    });
  }

  const encodeBase58 = (bytes) => {
    const A = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    let r = '', n = BigInt('0x' + Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join(''));
    while (n > 0n) { r = A[Number(n % 58n)] + r; n /= 58n; }
    for (let i = 0; i < bytes.length && bytes[i] === 0; i++) r = '1' + r;
    return r;
  };

  async function buildV0(conn, payer, ixs) {
    const { blockhash } = await conn.getLatestBlockhash('confirmed');
    return new VersionedTransaction(
      new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message());
  }

  async function sendC(conn, tx, signers, rpc, maxRetries = 3) {
    const canResign = signers?.length > 0; // Only shadow wallet TXs can be re-signed
    for (let attempt = 0; attempt < maxRetries; attempt++) {
      if (canResign) {
        // Fresh blockhash + re-sign (shadow wallet TXs only)
        const { blockhash } = await conn.getLatestBlockhash('confirmed');
        tx.message.recentBlockhash = blockhash;
        tx.signatures = [];
        for (const s of signers) tx.sign([s]);
      }
      const raw = encodeBase58(tx.serialize());
      let j;
      for (let s = 0; s < 4; s++) {
        try {
          const resp = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
              params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }] }) });
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
          const pr = await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
              params: [[sig], { searchTransactionHistory: true }] }) });
          if (!pr.ok) continue; // 502/503 — just retry next poll
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
        // Phantom-signed TX can't be retried with new blockhash — fail immediately
        throw new Error('Initial transaction not confirmed after 45s — blockhash may have expired. Please try again.');
      }
      if (attempt < maxRetries - 1) {
        console.log('TX attempt ' + (attempt + 1) + ' expired, retrying with fresh blockhash...');
      }
    }
    throw new Error('Transaction not confirmed after ' + maxRetries + ' attempts — network may be congested, try again');
  }

  function rDelay(min, max) { return new Promise(r => setTimeout(r, (min + Math.random() * (max - min)) * 1000)); }

  // Helper: transfer SOL or SPL from one keypair to another
  // Drain account to EXACTLY 0 so Solana closes it (avoids InsufficientFundsForRent)
  const BASE_FEE = 5000; // lamports — base tx fee (1 signature)

  // Wait for a shadow wallet to have balance (previous TX may still be propagating)
  async function waitForBalance(conn, pubkey, isSOL, mintPubkey, maxWait = 30) {
    for (let i = 0; i < maxWait; i++) {
      try {
        if (isSOL) {
          const bal = await conn.getBalance(pubkey);
          if (bal > BASE_FEE) return bal;
        } else {
          const ata = getATA(mintPubkey, pubkey);
          const tokenBal = await conn.getTokenAccountBalance(ata);
          if (parseInt(tokenBal.value.amount) > 0) return parseInt(tokenBal.value.amount);
        }
      } catch(e) { /* ATA may not exist yet */ }
      await new Promise(r => setTimeout(r, 1000));
    }
    throw new Error('Shadow wallet balance not found after ' + maxWait + 's — previous TX may not have landed');
  }

  async function hopTransfer(conn, from, toPub, mintPubkey, isSOL, rawAmt, rpc, fromKp, solSweepDest) {
    // Wait for funds to arrive from previous hop
    await waitForBalance(conn, from, isSOL, mintPubkey);

    const ix = [];
    if (isSOL) {
      const bal = await conn.getBalance(from);
      const sendAmt = bal - BASE_FEE;
      if (sendAmt <= 0) throw new Error('Shadow wallet has insufficient SOL: ' + (bal / 1e9).toFixed(6));
      ix.push(SystemProgram.transfer({ fromPubkey: from, toPubkey: toPub, lamports: sendAmt }));
    } else {
      const fATA = getATA(mintPubkey, from);
      const tATA = getATA(mintPubkey, toPub);
      const tokenBal = await conn.getTokenAccountBalance(fATA);
      const actualTokenAmt = parseInt(tokenBal.value.amount);
      if (actualTokenAmt <= 0) throw new Error('Shadow wallet has 0 token balance');
      ix.push(createATAIx(from, tATA, toPub, mintPubkey));
      ix.push(splTx(fATA, tATA, from, actualTokenAmt));
      ix.push(closeIx(fATA, from, from));
    }
    const tx = await buildV0(conn, from, ix);
    const sig = await sendC(conn, tx, [fromKp], rpc);

    // For SPL: sweep remaining SOL in separate TX (fire-and-forget, non-blocking)
    if (!isSOL) {
      setTimeout(async () => {
        try {
          const remainingSOL = await conn.getBalance(from);
          const sweepDest = solSweepDest || toPub;
          const destBal = await conn.getBalance(sweepDest);
          const MIN_FOR_NEW = 891000;
          const sweepAmt = remainingSOL - BASE_FEE;
          if (sweepAmt > 0 && (destBal > 0 || sweepAmt >= MIN_FOR_NEW)) {
            const sweepIx = [SystemProgram.transfer({ fromPubkey: from, toPubkey: sweepDest, lamports: sweepAmt })];
            const sweepTx = await buildV0(conn, from, sweepIx);
            // Fire-and-forget: send but don't wait for confirmation
            sweepTx.sign([fromKp]);
            const raw = encodeBase58(sweepTx.serialize());
            await fetch(rpc, { method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
                params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] }) });
            console.log('SOL sweep sent (fire-and-forget): ' + sweepAmt + ' lamports');
          } else if (sweepAmt > 0) {
            console.log('SOL sweep skipped: ' + sweepAmt + ' lamports < rent-exempt for new account');
          }
        } catch(e) { console.warn('SOL sweep failed (non-critical):', e.message); }
      }, 800);
    }
    return sig;
  }

  // ===== MAXIMUM: 7 shadow wallets, 10 transactions, 3 parallel paths =====
  // Flow:
  //   User → [T1, T2, T3]  (3-way split)
  //     Path A: T1 → T4      hop
  //     Path B: T2 → T5      hop  
  //     Path C: T3 → T6      hop
  //     T4 → T7 (collector)  converge
  //     T5 → T7              converge
  //     T6 → T7              converge
  //     T7 → Recipient       final delivery
  async function sendMaximum(opts) {
    const { connection, wallet, publicKey, recipient, amount, token, rpcProxy, onProgress } = opts;
    const isSOL = token.mint === 'native';
    const mintPubkey = isSOL ? null : new PublicKey(token.mint);
    const rawTotal = Math.round(amount * Math.pow(10, token.decimals));

    // Random 3-way split (each 20-45%)
    const r1 = 0.2 + Math.random() * 0.25;
    const r2 = 0.2 + Math.random() * (0.8 - r1 - 0.2);
    const r3 = 1 - r1 - r2;
    const part1Raw = Math.floor(rawTotal * r1);
    const part2Raw = Math.floor(rawTotal * r2);
    const part3Raw = rawTotal - part1Raw - part2Raw;

    // Generate 7 shadow wallets
    const t = Array.from({ length: 7 }, () => Keypair.generate());
    const [t1, t2, t3, t4, t5, t6, t7] = t;

    // Save keypairs for recovery
    const recoveryData = {
      timestamp: Date.now(),
      wallets: t.map(k => ({ pub: k.publicKey.toBase58(), secret: Array.from(k.secretKey) })),
      recipient: recipient.toBase58(),
      amount, token: { symbol: token.symbol, mint: token.mint, decimals: token.decimals }
    };
    try { localStorage.setItem('shadowsend_recovery', JSON.stringify(recoveryData)); } catch(e) {}

    const label = (i) => t[i].publicKey.toBase58().slice(0, 6) + '...';
    onProgress('hop1', 'Generating 7 shadow wallets...', 
      `Path A: ${label(0)} → ${label(3)} → ${label(6)}\nPath B: ${label(1)} → ${label(4)} → ${label(6)}\nPath C: ${label(2)} → ${label(5)} → ${label(6)}`);

    const totalHops = 9;
    // For SPL tokens, each shadow wallet needs SOL to create ATAs (~0.002 SOL each) + tx fees
    // Each path: initial shadow (create ATA dest + tx fee) + forward shadow (create ATA dest + tx fee)
    // Each shadow wallet that does a SPL hop needs: ATA rent (create dest ATA) + tx fee
    // For SOL hops, only tx fee needed
    const RENT_EXEMPT_MIN = 891000; // minimum lamports for rent-exempt account
    const ATA_RENT = 2_100_000; // ~0.0021 SOL for ATA creation (rent-exempt)
    const HOP_FEE = 5500; // base tx fee per hop
    // SOL transfers: each shadow wallet must receive >= rent-exempt minimum (890880 lamports)
    // otherwise Solana rejects with InsufficientFundsForRent
    // Excess SOL is swept back to user at the end of each hop
    const solPerHop = isSOL ? RENT_EXEMPT_MIN : (ATA_RENT + HOP_FEE);
    // Extra SOL budget for decoy transactions
    const decoyExtra = window.ShadowPrivacy?.decoys?.SETTINGS?.maximum?.extraSOL
      ? Math.round(window.ShadowPrivacy.decoys.SETTINGS.maximum.extraSOL * LAMPORTS_PER_SOL)
      : 0;
    // Fund EACH shadow wallet directly from user (don't rely on SOL sweeps)
    // T1,T2,T3 each do 1 hop → solPerHop each
    // T4,T5,T6 each do 1 converge hop → solPerHop each
    // T7 does final delivery → solPerHop
    const sigs = [];

    // ==== TX 1: User → T1 + T2 + T3 (3-way split) + 1% fee ====
    onProgress('hop1', 'Building 3-way split...', 'Please approve in Phantom — splits to 3 shadow wallets');
    const ix1 = [];

    // 1% platform fee
    // 1% fee — minimum 891000 lamports for SOL (rent-exempt minimum for new account)
    const totalSolForWallets = 7 * solPerHop; // SOL needed to fund all 7 shadow wallets
    const feeAmountRaw = isSOL
      ? Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT_MIN)
      : Math.round(rawTotal * FEE_PERCENT);
    // For SOL: netTotal is what goes to recipient (minus fees and wallet funding)
    // For SPL: netTotal is tokens minus platform fee (SOL for wallets comes separately)
    const netTotal = isSOL 
      ? Math.round(amount * LAMPORTS_PER_SOL) - feeAmountRaw - totalSolForWallets - decoyExtra
      : rawTotal - feeAmountRaw;
    const p1net = Math.floor(netTotal * r1);
    const p2net = Math.floor(netTotal * r2);
    const p3net = netTotal - p1net - p2net;

    // Distribute decoy budget: T1,T2,T3 get extra SOL for sending decoys, T7 gets some too
    const decoyPerPath = Math.floor(decoyExtra / 4); // split among T1,T2,T3,T7

    if (isSOL) {
      // SOL mode: T1-T3 get tokens + fee + decoy budget, T4-T7 only need fee
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t1.publicKey, lamports: p1net + solPerHop + decoyPerPath }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t2.publicKey, lamports: p2net + solPerHop + decoyPerPath }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t3.publicKey, lamports: p3net + solPerHop + decoyPerPath }));
      // Fund intermediate + collector wallets directly
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t4.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t5.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t6.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t7.publicKey, lamports: solPerHop + decoyPerPath }));
      // Fee to platform wallet
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: FEE_WALLET, lamports: feeAmountRaw }));
    } else {
      // SPL mode: fund ALL 7 shadow wallets with SOL for ATA creation + fees
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t1.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t2.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t3.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t4.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t5.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t6.publicKey, lamports: solPerHop }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: t7.publicKey, lamports: solPerHop }));
      const sATA = getATA(mintPubkey, publicKey);
      const a1 = getATA(mintPubkey, t1.publicKey);
      const a2 = getATA(mintPubkey, t2.publicKey);
      const a3 = getATA(mintPubkey, t3.publicKey);
      ix1.push(createATAIx(publicKey, a1, t1.publicKey, mintPubkey));
      ix1.push(createATAIx(publicKey, a2, t2.publicKey, mintPubkey));
      ix1.push(createATAIx(publicKey, a3, t3.publicKey, mintPubkey));
      ix1.push(splTx(sATA, a1, publicKey, p1net));
      ix1.push(splTx(sATA, a2, publicKey, p2net));
      ix1.push(splTx(sATA, a3, publicKey, p3net));
      // Fee to platform wallet (SPL)
      const feeATA = getATA(mintPubkey, FEE_WALLET);
      ix1.push(createATAIx(publicKey, feeATA, FEE_WALLET, mintPubkey));
      ix1.push(splTx(sATA, feeATA, publicKey, feeAmountRaw));
    }

    const tx1 = await buildV0(connection, publicKey, ix1);
    const signed1 = await wallet.signTransaction(tx1);
    onProgress('hop1', 'Broadcasting 3-way split...', 'TX 1/10');
    const sig1 = await sendC(connection, signed1, null, rpcProxy);
    sigs.push(sig1);
    const fmt = (r) => (r / Math.pow(10, token.decimals)).toFixed(4);
    onProgress('hop1', '✅ Split sent', `${fmt(part1Raw)} + ${fmt(part2Raw)} + ${fmt(part3Raw)} ${token.symbol}`);

    // Decoy engine (if loaded)
    const decoyEngine = window.ShadowPrivacy?.decoys;
    const dcfg = decoyEngine?.SETTINGS?.maximum;

    // ==== PATH A: T1 → T4 ====
    if (decoyEngine && dcfg) {
      await decoyEngine.randomDelay(dcfg.delays.min, dcfg.delays.max, onProgress);
    } else { const d1 = 2 + Math.random() * 3; onProgress('delay', `Path A: delay ${Math.round(d1)}s...`, ''); await rDelay(d1, d1 + 0.1); }
    onProgress('hop2', 'Path A: Shadow 1 → Shadow 4...', 'TX 2/10');
    const sig2 = await hopTransfer(connection, t1.publicKey, t4.publicKey, mintPubkey, isSOL, part1Raw, rpcProxy, t1);
    sigs.push(sig2);
    onProgress('hop2', '✅ Path A hop complete', '');
    // Decoys from T1
    if (decoyEngine && dcfg) {
      onProgress('decoy', '🎭 Path A decoys...', 'Creating noise');
      await decoyEngine.sendDecoys(connection, t1, rpcProxy, dcfg.decoys.perHop, onProgress);
    }

    // ==== PATH B: T2 → T5 ====
    if (decoyEngine && dcfg) {
      await decoyEngine.randomDelay(dcfg.delays.min, dcfg.delays.max, onProgress);
    } else { const d2 = 2 + Math.random() * 2; onProgress('delay', `Path B: delay...`, ''); await rDelay(d2, d2 + 0.1); }
    onProgress('hop3', 'Path B: Shadow 2 → Shadow 5...', 'TX 3/10');
    const sig3 = await hopTransfer(connection, t2.publicKey, t5.publicKey, mintPubkey, isSOL, part2Raw, rpcProxy, t2);
    sigs.push(sig3);
    onProgress('hop3', '✅ Path B hop complete', '');
    if (decoyEngine && dcfg) {
      onProgress('decoy', '🎭 Path B decoys...', 'Creating noise');
      await decoyEngine.sendDecoys(connection, t2, rpcProxy, dcfg.decoys.perHop, onProgress);
    }

    // ==== PATH C: T3 → T6 ====
    if (decoyEngine && dcfg) {
      await decoyEngine.randomDelay(dcfg.delays.min, dcfg.delays.max, onProgress);
    } else { const d3 = 2 + Math.random() * 3; onProgress('delay', `Path C: delay...`, ''); await rDelay(d3, d3 + 0.1); }
    onProgress('hop4', 'Path C: Shadow 3 → Shadow 6...', 'TX 4/10');
    const sig4 = await hopTransfer(connection, t3.publicKey, t6.publicKey, mintPubkey, isSOL, part3Raw, rpcProxy, t3);
    sigs.push(sig4);
    onProgress('hop4', '✅ Path C hop complete', '');
    if (decoyEngine && dcfg) {
      onProgress('decoy', '🎭 Path C decoys...', 'Creating noise');
      await decoyEngine.sendDecoys(connection, t3, rpcProxy, dcfg.decoys.perHop, onProgress);
    }

    // ==== CONVERGE: T4 → T7 ====
    if (decoyEngine && dcfg) {
      await decoyEngine.randomDelay(dcfg.delays.min, dcfg.delays.max, onProgress);
    } else { const d4 = 2 + Math.random() * 2; await rDelay(d4, d4 + 0.1); }
    onProgress('hop5', 'Shadow 4 → Collector (Shadow 7)...', 'TX 5/10');
    const sig5 = await hopTransfer(connection, t4.publicKey, t7.publicKey, mintPubkey, isSOL, part1Raw, rpcProxy, t4);
    sigs.push(sig5);
    onProgress('hop5', '✅ Part 1 at collector', '');

    // ==== CONVERGE: T5 → T7 ====
    if (decoyEngine && dcfg) {
      await decoyEngine.randomDelay(Math.round(dcfg.delays.min / 2), Math.round(dcfg.delays.max / 2), onProgress);
    } else { const d5 = 2 + Math.random() * 2; await rDelay(d5, d5 + 0.1); }
    onProgress('hop6', 'Shadow 5 → Collector (Shadow 7)...', 'TX 6/10');
    const sig6 = await hopTransfer(connection, t5.publicKey, t7.publicKey, mintPubkey, isSOL, part2Raw, rpcProxy, t5);
    sigs.push(sig6);
    onProgress('hop6', '✅ Part 2 at collector', '');

    // ==== CONVERGE: T6 → T7 ====
    if (decoyEngine && dcfg) {
      await decoyEngine.randomDelay(Math.round(dcfg.delays.min / 2), Math.round(dcfg.delays.max / 2), onProgress);
    } else { const d6 = 2 + Math.random() * 2; await rDelay(d6, d6 + 0.1); }
    onProgress('hop7', 'Shadow 6 → Collector (Shadow 7)...', 'TX 7/10');
    const sig7 = await hopTransfer(connection, t6.publicKey, t7.publicKey, mintPubkey, isSOL, part3Raw, rpcProxy, t6);
    sigs.push(sig7);
    onProgress('hop7', '✅ All funds at collector', '');

    // ==== FINAL: T7 → Recipient ====
    if (decoyEngine && dcfg) {
      // Final decoys from collector before delivery
      onProgress('decoy', '🎭 Final decoys from collector...', 'Last noise burst');
      await decoyEngine.sendDecoys(connection, t7, rpcProxy, dcfg.decoys.perHop, onProgress);
      await decoyEngine.randomDelay(dcfg.delays.min, dcfg.delays.max, onProgress);
    } else { const dFinal = 2 + Math.random() * 3; await rDelay(dFinal, dFinal + 0.1); }
    onProgress('hop8', 'Collector → Recipient...', 'TX 8/10 — final delivery');
    const sigF = await hopTransfer(connection, t7.publicKey, recipient, mintPubkey, isSOL, rawTotal, rpcProxy, t7, FEE_WALLET);
    sigs.push(sigF);
    onProgress('hop8', '✅ Recipient received all funds', '');

    // CLEANUP: Sweep remaining SOL dust to FEE_WALLET (fire-and-forget, non-blocking)
    onProgress('cleanup', 'Sweeping 7 shadow wallets...', 'Sending leftover SOL to fee wallet');
    for (const tmp of t) {
      try {
        const bal = await connection.getBalance(tmp.publicKey);
        if (bal > BASE_FEE) {
          const ixS = [SystemProgram.transfer({ fromPubkey: tmp.publicKey, toPubkey: FEE_WALLET, lamports: bal - BASE_FEE })];
          const txS = await buildV0(connection, tmp.publicKey, ixS);
          txS.sign([tmp]);
          const raw = encodeBase58(txS.serialize());
          fetch(rpcProxy, { method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
              params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] }) })
            .catch(e => console.warn('[Privacy] Sweep:', e.message));
        }
      } catch (e) { console.warn('[Privacy] Sweep:', e.message); }
    }

    try { localStorage.removeItem('shadowsend_recovery'); } catch(e) {}
    return {
      signatures: sigs,
      hops: 8,
      tempWallets: t.map(x => x.publicKey.toBase58()),
      splits: [fmt(part1Raw), fmt(part2Raw), fmt(part3Raw)],
      paths: 3,
    };
  }

  window.ShadowPrivacy.sendMaximum = sendMaximum;
})();
