/**
 * Ciego Maximum Privacy v2
 *
 * NEW: Chain funding (only T1 visible from main wallet) + token swaps
 *
 * Flow:
 *   User → T1 (ONLY link from main wallet)
 *   T1 → Swap(SOL→USDC) — break token trail
 *   T1 → T2, T1 → T3 (chain-funded from T1, NOT from user)
 *   T2 → T4, T3 → T5 (parallel paths)
 *   T4,T5 → T6 (collector)
 *   T6 → Swap(USDC→SOL) — swap back
 *   T6 → Recipient
 *
 * On Solscan: your wallet → T1 (single link). That's it.
 * Token changes: SOL→USDC→SOL. Following SOL won't find USDC hops.
 */
(function() {
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
  function closeAccIx(account, dest, owner) {
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
    const _r = window.ShadowPrivacy?.rpc;
    const { blockhash } = _r ? await _r.getLatestBlockhash() : await conn.getLatestBlockhash('confirmed');
    return new VersionedTransaction(
      new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions: ixs }).compileToV0Message()
    );
  }
  async function sendC(conn, tx, signers, rpcUrl) {
    const _r = window.ShadowPrivacy?.rpc;
    const canResign = signers?.length > 0;
    // Pre-signed TXs (Phantom) get longer timeout + more aggressive resends
    const maxAttempts = canResign ? 3 : 1;
    const maxPollMs = canResign ? 90_000 : 120_000;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      if (canResign) {
        const { blockhash } = _r ? await _r.getLatestBlockhash() : await conn.getLatestBlockhash('confirmed');
        tx.message.recentBlockhash = blockhash;
        tx.signatures = [];
        for (const s of signers) tx.sign([s]);
      }
      const raw = encodeBase58(tx.serialize());
      // Send TX multiple times upfront to increase landing chance
      let sig;
      for (let s = 0; s < (canResign ? 1 : 3); s++) {
        try {
          const r = await _r.rpcCall('sendTransaction', [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }], 6);
          if (r) sig = r;
        } catch(e) { if (s === 0) throw e; }
        if (s < 2) await new Promise(r => setTimeout(r, 500));
      }
      if (!sig) throw new Error('sendTransaction returned null');

      // Poll for confirmation
      const pollStart = Date.now();
      let pollCount = 0;
      while (Date.now() - pollStart < maxPollMs) {
        await new Promise(r => setTimeout(r, 800));
        pollCount++;
        try {
          const stResult = await _r.rpcCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
          const st = stResult?.value?.[0];
          if (st?.err) throw new Error('TX failed: ' + JSON.stringify(st.err));
          if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') return sig;
        } catch(e) {
          if (e.message.includes('TX failed')) throw e;
          if (e.message.includes('502') || e.message.includes('503') || e.message.includes('HTML')) {
            await new Promise(r => setTimeout(r, 2000));
          }
        }
        // Re-send more aggressively for pre-signed TXs
        const resendEvery = canResign ? 8 : 5;
        if (pollCount % resendEvery === 0) {
          try { await _r.rpcCall('sendTransaction', [raw, { encoding: 'base58', skipPreflight: true }]); } catch(e) {}
        }
      }
      // Pre-signed TX: return sig anyway — TX was sent, confirmation just timed out
      // The calling code has balance verification as fallback
      if (!canResign) {
        console.warn('[sendC] Pre-signed TX confirmation timed out, returning sig for balance check:', sig);
        return sig;
      }
    }
    throw new Error('TX not confirmed after ' + maxAttempts + ' attempts');
  }

  function rDelay(min, max) { return new Promise(r => setTimeout(r, (min + Math.random()*(max-min))*1000)); }

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
    const variation = 1 - (Math.random() * fuzzPct); // e.g. 0.95 - 1.00
    return Math.round(lamports * variation);
  }

  // ===== MAXIMUM PRIVACY v2 =====
  async function sendMaximum(opts) {
    const { connection, wallet, publicKey, recipient, amount, token, rpcProxy, onProgress, doubleBridge } = opts;
    const rpc = window.ShadowPrivacy?.rpc || { getBalance: (pk) => connection.getBalance(pk), getTokenAccountBalance: (a) => connection.getTokenAccountBalance(a).then(r => parseInt(r.value.amount)) };
    const isSOL = token.mint === 'native';
    const mintPubkey = isSOL ? null : new PublicKey(token.mint);
    const rawTotal = Math.round(amount * Math.pow(10, token.decimals));
    const swapEngine = window.ShadowPrivacy?.swapEngine;
    const bridge = window.ShadowPrivacy?.bridge;

    // ==== BRIDGE MODE: via private pool (2-5 min) ====
    // Supports: SOL→SOL, USDC→SOL, USDT→SOL, USD1→SOL (+ splits for ⭐⭐⭐⭐⭐)
    // Shadow wallet sends to private pool, which sends SOL from DIFFERENT address to recipient.
    let bridgeShadow = null; // track for recovery if bridge fails
    let bridgeShadow2 = null; // track shadow2 for double bridge recovery
    let bridgeCoinSymbol = (token.symbol || 'SOL').toUpperCase(); // outer scope for recovery
    if (bridge) {
      try {
        // Determine which coin to bridge with
        const coinMap = bridge.COIN_MAP || {};
        const tokenSymbol = (token.symbol || 'SOL').toUpperCase();
        const directSupported = !isSOL && coinMap[tokenSymbol]; // USDC, USDT, USD1
        const bridgeCoinCheck = directSupported ? tokenSymbol : 'SOL';
        
        const minAmount = await bridge.getMinAmount(bridgeCoinCheck);
        let qualifies = false;
        let qualifyAmount = 0;
        
        if (isSOL) {
          qualifyAmount = amount;
          qualifies = amount >= minAmount;
        } else if (directSupported) {
          // Direct stablecoin bridge (no swap needed!)
          qualifyAmount = rawTotal / Math.pow(10, token.decimals);
          qualifies = qualifyAmount >= minAmount;
        } else {
          // Fallback: estimate SOL equivalent via swap
          let solEquiv = 0;
          if (swapEngine) {
            try {
              const q = await swapEngine.getQuote(token.mint, 'So11111111111111111111111111111111111111112', rawTotal, 100);
              solEquiv = (q?.outAmount || 0) / LAMPORTS_PER_SOL;
            } catch(e) { solEquiv = 0; }
          }
          qualifyAmount = solEquiv;
          qualifies = solEquiv >= minAmount;
        }

        // Double bridge needs higher minimum (2x fees)
        if (doubleBridge && qualifies) {
          // Double bridge min = enough so bridge1 output >= private pool min for bridge2
          // Formula: amount * 0.93 (worst-case 7% fee) >= singleMin
          const doubleMins = { 'SOL': 0.01, 'USDC': 2.5, 'USDT': 2.5, 'USD1': 0.6 };
          const doubleMin = doubleMins[bridgeCoinCheck] || minAmount * 2;
          if (qualifyAmount < doubleMin) {
            onProgress('bridge', `⚠️ Double bridge needs ≥${doubleMin} ${bridgeCoinCheck} (you have ${qualifyAmount.toFixed(4)})`, 'Falling back to single bridge...');
            // Continue with single bridge instead
            opts.doubleBridge = false;
          }
        }

        if (!qualifies) {
          // Maximum/Maximum+ REQUIRES private pool — no silent fallback to swap engine
          const minStr = minAmount.toFixed(isSOL ? 4 : 2);
          throw new Error(`Amount too low. Minimum: ${minStr} ${bridgeCoinCheck}. Use Enhanced mode for smaller amounts.`);
        }

        if (qualifies) {
          const coinIcon = isSOL ? '⚡' : '💵';
          const isDouble = opts.doubleBridge !== false && doubleBridge;
          // Signal bridge mode to UI so it can switch step labels
          onProgress('mode', 'bridge', bridgeCoinCheck);
          onProgress('bridge', `${coinIcon} ${bridgeCoinCheck} ${isDouble ? 'Double ' : ''}Bridge — trace breaks at private pool`, `Amount qualifies (min: ${minAmount.toFixed(4)} ${bridgeCoinCheck}). ETA: ${isDouble ? '5-15' : '2-5'} min`);

          // Collect ALL user-signed instructions into one TX (single Phantom popup)
          const allUserIx = [];
          
          // 1% fee instructions
          if (isSOL) {
            allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: FEE_WALLET, lamports: Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT) }));
          } else {
            const sATA = getATA(mintPubkey, publicKey);
            const feeATA = getATA(mintPubkey, FEE_WALLET);
            allUserIx.push(createATAIx(publicKey, feeATA, FEE_WALLET, mintPubkey));
            allUserIx.push(splTx(sATA, feeATA, publicKey, Math.round(rawTotal * FEE_PERCENT)));
          }

          // Use shadow wallet as intermediary (accept pre-generated from batch, or create new)
          const shadow = opts.batchShadow || Keypair.generate();
          bridgeShadow = shadow; // save ref for recovery
          // APPEND to existing recovery data (don't overwrite previous shadow wallets)
          try {
            const existing = JSON.parse(localStorage.getItem('shadowsend_recovery') || '{"wallets":[]}');
            const newWallet = { pub: shadow.publicKey.toBase58(), secret: Array.from(shadow.secretKey) };
            // Only add if not already saved
            const alreadySaved = existing.wallets.some(w => w.pub === newWallet.pub);
            if (!alreadySaved) existing.wallets.push(newWallet);
            existing.timestamp = Date.now();
            existing.recipient = recipient.toBase58();
            existing.amount = amount;
            existing.token = { symbol: token.symbol, mint: token.mint, decimals: token.decimals };
            existing.mode = `${bridgeCoin}-bridge`;
            localStorage.setItem('shadowsend_recovery', JSON.stringify(existing));
          } catch(e) {}

          // STEP 1: Calculate bridge amount (use batch values if provided)
          let bridgeAmount = opts.batchBridgeAmount || (isSOL ? (amount - amount * FEE_PERCENT) : 0);
          bridgeCoinSymbol = opts.batchBridgeCoin || (isSOL ? 'SOL' : token.symbol.toUpperCase());
          let bridgeTokenAmount = 0; // for SPL: amount in token units
          
          // For SPL tokens: check if private pool supports direct token bridge (skip if batch pre-calculated)
          if (!isSOL && !opts.batchBridgeAmount) {
            const coinMap = bridge.COIN_MAP || {};
            const directSupported = coinMap[bridgeCoinSymbol];
            if (directSupported) {
              // Direct stablecoin bridge (USDC→USDC, USDT→USDT, USD1→USD1 same-token)
              bridgeTokenAmount = (rawTotal - Math.round(rawTotal * FEE_PERCENT)) / Math.pow(10, token.decimals);
              bridgeAmount = bridgeTokenAmount;
            } else if (swapEngine) {
              // Fallback: swap to SOL first, then SOL→SOL bridge
              bridgeCoinSymbol = 'SOL';
              const netTokens = rawTotal - Math.round(rawTotal * FEE_PERCENT);
              try {
                const q = await swapEngine.getQuote(token.mint, 'So11111111111111111111111111111111111111112', netTokens, 100);
                bridgeAmount = (q?.outAmount || 0) / LAMPORTS_PER_SOL;
              } catch(e) { bridgeAmount = 0; }
            }
          }

          // STEP 2: For double bridge, create shadow2 as intermediate recipient
          const effectiveDoubleBridge = opts.doubleBridge !== false && doubleBridge;
          let shadow2 = null;
          let bridge1Recipient = recipient.toBase58();
          if (effectiveDoubleBridge) {
            shadow2 = opts.batchShadow2 || Keypair.generate();
            bridgeShadow2 = shadow2;
            bridge1Recipient = shadow2.publicKey.toBase58();
            onProgress('bridge', '🔒 Double Bridge mode', 'Bridge 1 → intermediate wallet → Bridge 2 → recipient');
            // Save shadow2 to recovery
            try {
              const existing = JSON.parse(localStorage.getItem('shadowsend_recovery') || '{"wallets":[]}');
              existing.wallets.push({ pub: shadow2.publicKey.toBase58(), secret: Array.from(shadow2.secretKey) });
              existing.timestamp = Date.now();
              existing.doubleBridge = true;
              localStorage.setItem('shadowsend_recovery', JSON.stringify(existing));
            } catch(e) {}
          }

          // VALIDATE bridge BEFORE funding (creates exchanges, checks minimums)
          // Use pre-created bridge from batch, or create new one
          let bridgeResult;
          if (opts.batchBridgeResult) {
            bridgeResult = opts.batchBridgeResult;
            onProgress('bridge', '✅ Bridge ready (pre-validated)', `Batch mode`);
          } else {
            onProgress('bridge', '⚡ Validating bridge...', `Checking private pool for ${bridgeCoinSymbol}`);
            bridgeResult = await bridge.createBridge(
              bridgeAmount * 0.98,
              bridge1Recipient,
              (s, t, d) => onProgress('bridge', t, d),
              bridgeCoinSymbol,
              shadow.publicKey.toBase58()
            );
            if (!bridgeResult || !bridgeResult.depositAddress) {
              throw new Error('Bridge validation failed — no deposit address');
            }
          }
          const isSplit = bridgeResult.splitMode && bridgeResult.splits;
          const splitCount = isSplit ? bridgeResult.splitCount : 1;
          onProgress('bridge', `✅ Bridge ready (${isSplit ? splitCount + ' splits' : 'single'})`,
            `~${bridgeResult.estimatedReceive.toFixed(4)} ${bridgeCoinSymbol} → recipient in 2-5 min`);

          // STEP 3: Save recovery data BEFORE funding
          try {
            const recoveryData = JSON.parse(localStorage.getItem('shadowsend_recovery') || '{"wallets":[]}');
            recoveryData.bridge = {
              exchangeId: bridgeResult.exchangeId,
              depositAddress: bridgeResult.depositAddress,
              splits: isSplit ? bridgeResult.splits.map(s => ({ exchangeId: s.exchangeId, depositAddress: s.depositAddress, amount: s.depositAmount })) : null,
              amount: bridgeAmount * 0.98,
              coin: bridgeCoinSymbol,
              recipient: recipient.toBase58(),
              timestamp: Date.now()
            };
            localStorage.setItem('shadowsend_recovery', JSON.stringify(recoveryData));
          } catch(e) { console.warn('Failed to save bridge recovery:', e); }

          // STEP 4: Pre-funding delay
          await antiCorrelationDelay(onProgress, 2, 5, 'Pre-funding delay');

          // STEP 5: Fund shadow wallet + fee + shadow2 gas
          let fundSig = opts.batchFundSig || 'batch';
          if (opts.skipFunding) {
            // BATCH MODE: shadow was funded by the combined batch TX already
            onProgress('bridge', '✅ Shadow already funded (batch TX)', 'Proceeding to bridge...');
          } else {
            // SINGLE MODE: Build, sign (1 Phantom popup), and send
            onProgress('bridge', 'Preparing transaction...', 'Approve in Phantom (1 popup for everything)');
            if (isSOL) {
              const netLamports = Math.round(amount * LAMPORTS_PER_SOL) - Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT);
              allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: shadow.publicKey, lamports: netLamports }));
            } else {
              const netTokens = rawTotal - Math.round(rawTotal * FEE_PERCENT);
              const perSplitCost = 2_100_000;
              const solForFees = Math.max(3_000_000, splitCount * perSplitCost + 500_000);
              allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: shadow.publicKey, lamports: solForFees }));
              const sATA = getATA(mintPubkey, publicKey);
              const shATA = getATA(mintPubkey, shadow.publicKey);
              allUserIx.push(createATAIx(publicKey, shATA, shadow.publicKey, mintPubkey));
              allUserIx.push(splTx(sATA, shATA, publicKey, netTokens));
            }
            // Pre-fund shadow2 gas for Maximum+ SPL
            const effectiveDoubleBridgeForGas = opts.doubleBridge !== false && doubleBridge;
            if (effectiveDoubleBridgeForGas && shadow2 && !isSOL) {
              const SHADOW2_GAS = 5_500_000;
              allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: shadow2.publicKey, lamports: SHADOW2_GAS }));
              onProgress('bridge', '⛽ Shadow2 gas included in TX', '');
            }
            const combinedTx = await buildV0(connection, publicKey, allUserIx);
            const combinedSigned = await wallet.signTransaction(combinedTx);
            fundSig = await sendC(connection, combinedSigned, null, rpcProxy);
            onProgress('bridge', '✅ Fee + Shadow funded (1 TX)', `TX: ${fundSig.slice(0,8)}...`);
          }

          // STEP 6: For SPL with no direct private pool support, swap to SOL first
          if (!isSOL && bridgeCoinSymbol === 'SOL' && swapEngine) {
            await rDelay(2, 4);
            onProgress('bridge', `Swapping ${token.symbol} → SOL...`, 'swap engine swap');
            const netTokens = rawTotal - Math.round(rawTotal * FEE_PERCENT);
            const r = await swapEngine.executeSwap(connection, shadow, token.mint, 'So11111111111111111111111111111111111111112', netTokens, rpcProxy, onProgress);
            bridgeAmount = r.outAmount / LAMPORTS_PER_SOL;
            onProgress('bridge', `✅ Swapped to ${bridgeAmount.toFixed(4)} SOL`, 'Ready for bridge');
          }

          // STEP 7: Post-funding delay
          await antiCorrelationDelay(onProgress, 2, 5, 'Post-funding delay');

          // STEP 8: Send to private pool deposit(s) — single or split
          const sendSigs = [];

          if (isSplit) {
            // === SPLIT MODE: send to each deposit address with random delays ===
            onProgress('bridge', `⚡ Sending ${splitCount} split deposits...`, 'Shadow → multiple private pools');
            
            for (let i = 0; i < bridgeResult.splits.length; i++) {
              const split = bridgeResult.splits[i];
              
              if (isSOL || bridgeCoinSymbol === 'SOL') {
                // SOL split: use REAL balance, reserve fees for remaining TXs
                // CRITICAL: Solana requires post-TX balance to be >= 890,880 (rent-exempt) OR exactly 0
                const RENT_EXEMPT = 890_880;
                const TX_FEE = 25_000;
                const shadowBal = await rpc.getBalance(shadow.publicKey.toBase58());
                const remainingSplits = bridgeResult.splits.length - i;
                const isLast = (remainingSplits === 1);
                let sendLamports;
                if (isLast) {
                  // Last split: drain to EXACTLY 0
                  // Solana actual fee = 5000 per sig (BASE_FEE), NOT TX_FEE
                  // send = balance - 5000, so after fee: balance = 0
                  sendLamports = shadowBal - BASE_FEE;
                } else {
                  // Non-last: must leave enough for remaining splits + rent-exempt buffer
                  // Each future split needs: RENT_EXEMPT + TX_FEE (to stay above rent or drain)
                  const reserveForRemaining = (remainingSplits - 1) * (RENT_EXEMPT + TX_FEE) + RENT_EXEMPT;
                  const availableNow = shadowBal - reserveForRemaining - TX_FEE;
                  sendLamports = Math.floor(availableNow / remainingSplits);
                  // Add slight randomness (±10% of the proportional amount)
                  const fuzzRange = Math.floor(sendLamports * 0.10);
                  sendLamports += Math.floor(Math.random() * fuzzRange * 2) - fuzzRange;
                  // Safety: never send so much that remaining balance < RENT_EXEMPT + fees for rest
                  const maxSafe = shadowBal - reserveForRemaining - TX_FEE;
                  sendLamports = Math.min(sendLamports, maxSafe);
                }
                // Ensure minimum viable send
                if (sendLamports < 10_000) {
                  console.warn(`[Split ${i+1}] Only ${sendLamports} lamports available, skipping`);
                  continue;
                }
                
                const ix = [SystemProgram.transfer({
                  fromPubkey: shadow.publicKey,
                  toPubkey: new PublicKey(split.depositAddress),
                  lamports: sendLamports,
                })];
                const tx = await buildV0(connection, shadow.publicKey, ix);
                const sig = await sendC(connection, tx, [shadow], rpcProxy);
                sendSigs.push(sig);
                onProgress('bridge', `✅ Split ${i+1}/${splitCount} sent`, `${(sendLamports/LAMPORTS_PER_SOL).toFixed(4)} SOL → ${split.depositAddress.slice(0,8)}...`);
              } else {
                // SPL token split (USDC/USDT/USD1 direct)
                const shATA = getATA(mintPubkey, shadow.publicKey);
                const depositPub = new PublicKey(split.depositAddress);
                const depositATA = getATA(mintPubkey, depositPub);
                const tokenAmount = Math.round(split.depositAmount * Math.pow(10, token.decimals));
                
                const ix = [
                  createATAIx(shadow.publicKey, depositATA, depositPub, mintPubkey),
                  splTx(shATA, depositATA, shadow.publicKey, tokenAmount),
                ];
                const tx = await buildV0(connection, shadow.publicKey, ix);
                const sig = await sendC(connection, tx, [shadow], rpcProxy);
                sendSigs.push(sig);
                onProgress('bridge', `✅ Split ${i+1}/${splitCount} sent`, `${split.depositAmount.toFixed(4)} ${bridgeCoinSymbol}`);
              }
              
              // Random delay between splits (2-8s)
              if (i < bridgeResult.splits.length - 1) {
                const splitDelay = 2 + Math.random() * 6;
                onProgress('bridge', `⏱️ Split delay...`, `${splitDelay.toFixed(0)}s between deposits`);
                await new Promise(r => setTimeout(r, splitDelay * 1000));
              }
            }
          } else {
            // === SINGLE MODE: one deposit ===
            onProgress('bridge', '⚡ Sending to private pool...', 'Shadow → private pool');
            
            if (isSOL || bridgeCoinSymbol === 'SOL') {
              // Single mode: drain shadow to exactly 0
              const shadowBal = await rpc.getBalance(shadow.publicKey.toBase58());
              const sendLamports = shadowBal - BASE_FEE; // drain to exactly 0 (fee=5000)
              const ix = [SystemProgram.transfer({
                fromPubkey: shadow.publicKey,
                toPubkey: new PublicKey(bridgeResult.depositAddress),
                lamports: sendLamports,
              })];
              const tx = await buildV0(connection, shadow.publicKey, ix);
              const sig = await sendC(connection, tx, [shadow], rpcProxy);
              sendSigs.push(sig);
            } else {
              // Direct SPL token send to private pool (USDC/USDT/USD1)
              const shATA = getATA(mintPubkey, shadow.publicKey);
              const depositPub = new PublicKey(bridgeResult.depositAddress);
              const depositATA = getATA(mintPubkey, depositPub);
              const netTokens = rawTotal - Math.round(rawTotal * FEE_PERCENT);
              const tokenSend = fuzzAmount(netTokens, 0.03);
              const ix = [
                createATAIx(shadow.publicKey, depositATA, depositPub, mintPubkey),
                splTx(shATA, depositATA, shadow.publicKey, tokenSend),
              ];
              const tx = await buildV0(connection, shadow.publicKey, ix);
              const sig = await sendC(connection, tx, [shadow], rpcProxy);
              sendSigs.push(sig);
            }
          }

          // Sweep leftover SOL from shadow → FEE_WALLET
          // Close ATA first (reclaims ~0.002 SOL rent), then drain SOL to 0
          if (!isSOL) {
            try {
              // Try to close the shadow's ATA first (reclaims rent)
              const shadowATA = getATA(mintPubkey, shadow.publicKey);
              try {
                const closeIx = [closeAccIx(shadowATA, shadow.publicKey, shadow.publicKey)];
                const closeTx = await buildV0(connection, shadow.publicKey, closeIx);
                await sendC(connection, closeTx, [shadow], rpcProxy);
              } catch(closeErr) { /* ATA might not exist or already closed */ }
              
              // Now sweep all SOL (rent + leftover) to fee wallet
              const leftoverSOL = await rpc.getBalance(shadow.publicKey.toBase58());
              if (leftoverSOL > BASE_FEE + 1000) {
                const sweepIx = [SystemProgram.transfer({
                  fromPubkey: shadow.publicKey,
                  toPubkey: FEE_WALLET,
                  lamports: leftoverSOL - BASE_FEE,
                })];
                const sweepTx = await buildV0(connection, shadow.publicKey, sweepIx);
                await sendC(connection, sweepTx, [shadow], rpcProxy);
                onProgress('bridge', '💰 Shadow SOL swept to fee wallet', `${((leftoverSOL - BASE_FEE) / LAMPORTS_PER_SOL).toFixed(4)} SOL`);
              }
            } catch(sweepErr) { console.warn('SOL sweep failed:', sweepErr.message); }
          }

          const totalSent = isSplit
            ? bridgeResult.splits.map(s => s.depositAmount).reduce((a,b) => a+b, 0)
            : bridgeAmount * 0.98;

          // ==== DOUBLE BRIDGE: second hop through private pool ====
          if (effectiveDoubleBridge && shadow2) {
            onProgress('bridge2', '🔄 Double Bridge — waiting for Bridge 1 delivery...', 'Private pool → intermediate wallet. Polling every 15s...');

            // Poll bridge 1 until ALL exchanges finish
            const exchangeIds = isSplit
              ? bridgeResult.splits.map(s => s.exchangeId)
              : [bridgeResult.exchangeId];
            
            await bridge.pollAllUntilDone(
              exchangeIds,
              (status, detail) => onProgress('bridge2', `🔄 Bridge 1: ${detail}`, 'Waiting for delivery to intermediate wallet...'),
              15 * 60 * 1000,
              15000
            );
            
            onProgress('bridge2', '✅ Bridge 1 delivered!', 'Preparing Bridge 2...');

            // Shadow2 gas was pre-funded in the combined TX (no extra popup needed)
            if (!isSOL && bridgeCoinSymbol !== 'SOL') {
              onProgress('bridge2', '⛽ Shadow2 gas already funded', 'Pre-funded in initial TX');
            }

            await antiCorrelationDelay(onProgress, 2, 5, 'Delay between bridges');

            // Check what shadow2 received
            let shadow2Balance;
            if (isSOL || bridgeCoinSymbol === 'SOL') {
              shadow2Balance = await rpc.getBalance(shadow2.publicKey.toBase58());
              onProgress('bridge2', `💰 Intermediate received ${(shadow2Balance / LAMPORTS_PER_SOL).toFixed(4)} SOL`, 'Creating Bridge 2...');
            } else {
              // SPL token — check token balance
              const s2ATA = getATA(mintPubkey, shadow2.publicKey);
              try {
                const balResult = await rpc.getTokenAccountBalance(s2ATA);
                // rpc returns { value: { amount: '1234' } } — extract raw lamports
                shadow2Balance = parseInt(balResult?.value?.amount || '0', 10);
              } catch(e) { shadow2Balance = 0; }
              const s2Human = shadow2Balance / Math.pow(10, token.decimals);
              onProgress('bridge2', `💰 Intermediate received ${s2Human.toFixed(4)} ${bridgeCoinSymbol}`, 'Creating Bridge 2...');
            }

            // Calculate bridge 2 amount (what arrived minus fees for sending)
            let bridge2Amount;
            if (isSOL || bridgeCoinSymbol === 'SOL') {
              bridge2Amount = (shadow2Balance - BASE_FEE) / LAMPORTS_PER_SOL;
            } else {
              bridge2Amount = shadow2Balance / Math.pow(10, token.decimals);
            }

            // Check minimums for bridge 2 (use min2 / 0.98 to account for the 2% buffer in createBridge call)
            const min2 = await bridge.getMinAmount(bridgeCoinSymbol);
            if (bridge2Amount * 0.98 < min2) {
              // Not enough for bridge 2 — send directly to recipient instead
              onProgress('bridge2', `⚠️ Bridge 2 amount (${bridge2Amount.toFixed(4)}) below min (${min2.toFixed(4)})`, 'Sending directly to recipient...');
              
              if (isSOL || bridgeCoinSymbol === 'SOL') {
                const s2Bal = await rpc.getBalance(shadow2.publicKey.toBase58());
                const ix = [SystemProgram.transfer({ fromPubkey: shadow2.publicKey, toPubkey: recipient, lamports: s2Bal - BASE_FEE })];
                const tx = await buildV0(connection, shadow2.publicKey, ix);
                await sendC(connection, tx, [shadow2], rpcProxy);
              } else {
                const s2ATA = getATA(mintPubkey, shadow2.publicKey);
                const rATA = getATA(mintPubkey, recipient);
                const ix = [
                  createATAIx(shadow2.publicKey, rATA, recipient, mintPubkey),
                  splTx(s2ATA, rATA, shadow2.publicKey, shadow2Balance),
                ];
                const tx = await buildV0(connection, shadow2.publicKey, ix);
                await sendC(connection, tx, [shadow2], rpcProxy);
              }
              onProgress('bridge2', '✅ Funds sent directly to recipient (below bridge minimum)', '');
            } else {
              // Create bridge 2: shadow2 → private pool → real recipient (NO splits, single hop)
              onProgress('bridge2', '⚡ Creating Bridge 2...', `${bridge2Amount.toFixed(4)} ${bridgeCoinSymbol} → Private pool → recipient`);
              
              const bridge2Result = await bridge.createBridge(
                bridge2Amount * 0.98,
                recipient.toBase58(),
                (s, t, d) => onProgress('bridge2', `[Bridge 2] ${t}`, d),
                bridgeCoinSymbol,
                shadow2.publicKey.toBase58()
              );

              if (!bridge2Result || !bridge2Result.depositAddress) {
                throw new Error('Bridge 2 validation failed — no deposit address');
              }

              const is2Split = bridge2Result.splitMode && bridge2Result.splits;
              onProgress('bridge2', '✅ Bridge 2 ready', `~${bridge2Result.estimatedReceive.toFixed(4)} ${bridgeCoinSymbol} → recipient`);

              // Send from shadow2 → private pool (bridge 2 deposit)
              await antiCorrelationDelay(onProgress, 1, 3, 'Pre-send delay');
              
              if (isSOL || bridgeCoinSymbol === 'SOL') {
                const s2Bal = await rpc.getBalance(shadow2.publicKey.toBase58());
                const sendLam = s2Bal - BASE_FEE;
                const depositAddr = is2Split ? bridge2Result.splits[0].depositAddress : bridge2Result.depositAddress;
                
                if (is2Split) {
                  // Split mode for bridge 2
                  for (let i = 0; i < bridge2Result.splits.length; i++) {
                    const sp = bridge2Result.splits[i];
                    const s2Bal2 = await rpc.getBalance(shadow2.publicKey.toBase58());
                    const remaining = bridge2Result.splits.length - i;
                    const isLast2 = remaining === 1;
                    let sendAmt;
                    if (isLast2) {
                      sendAmt = s2Bal2 - BASE_FEE;
                    } else {
                      const reserve2 = (remaining - 1) * (890_880 + 25_000) + 890_880;
                      sendAmt = Math.floor((s2Bal2 - reserve2 - 25_000) / remaining);
                    }
                    if (sendAmt < 10_000) continue;
                    const ix = [SystemProgram.transfer({ fromPubkey: shadow2.publicKey, toPubkey: new PublicKey(sp.depositAddress), lamports: sendAmt })];
                    const tx = await buildV0(connection, shadow2.publicKey, ix);
                    await sendC(connection, tx, [shadow2], rpcProxy);
                    onProgress('bridge2', `✅ Bridge 2 split ${i+1}/${bridge2Result.splits.length} sent`, `${(sendAmt/LAMPORTS_PER_SOL).toFixed(4)} SOL`);
                    if (i < bridge2Result.splits.length - 1) await new Promise(r => setTimeout(r, (2 + Math.random() * 4) * 1000));
                  }
                } else {
                  const ix = [SystemProgram.transfer({ fromPubkey: shadow2.publicKey, toPubkey: new PublicKey(bridge2Result.depositAddress), lamports: sendLam })];
                  const tx = await buildV0(connection, shadow2.publicKey, ix);
                  await sendC(connection, tx, [shadow2], rpcProxy);
                }
              } else {
                // SPL send for bridge 2
                const s2ATA = getATA(mintPubkey, shadow2.publicKey);
                const dep2Pub = new PublicKey(is2Split ? bridge2Result.splits[0].depositAddress : bridge2Result.depositAddress);
                const dep2ATA = getATA(mintPubkey, dep2Pub);
                const ix = [
                  createATAIx(shadow2.publicKey, dep2ATA, dep2Pub, mintPubkey),
                  splTx(s2ATA, dep2ATA, shadow2.publicKey, shadow2Balance),
                ];
                const tx = await buildV0(connection, shadow2.publicKey, ix);
                await sendC(connection, tx, [shadow2], rpcProxy);
              }

              // Sweep leftover SOL from shadow2 → FEE_WALLET (close ATA first)
              try {
                if (!isSOL && bridgeCoinSymbol !== 'SOL') {
                  const s2ATAClose = getATA(mintPubkey, shadow2.publicKey);
                  const closeIx2 = [closeAccIx(s2ATAClose, shadow2.publicKey, shadow2.publicKey)];
                  const closeTx2 = await buildV0(connection, shadow2.publicKey, closeIx2);
                  await sendC(connection, closeTx2, [shadow2], rpcProxy);
                }
                const leftover2 = await rpc.getBalance(shadow2.publicKey.toBase58());
                if (leftover2 > BASE_FEE + 1000) {
                  const sweepIx = [SystemProgram.transfer({ fromPubkey: shadow2.publicKey, toPubkey: FEE_WALLET, lamports: leftover2 - BASE_FEE })];
                  const sweepTx = await buildV0(connection, shadow2.publicKey, sweepIx);
                  await sendC(connection, sweepTx, [shadow2], rpcProxy);
                }
              } catch(e) {}

              onProgress('bridge2', '✅ Bridge 2 sent!', `${bridgeCoinSymbol} → Private pool → recipient. ETA: 2-5 min`);

              // Update bridgeResult with bridge 2 info for the UI polling
              bridgeResult.doubleBridge = true;
              bridgeResult.bridge2 = bridge2Result;
              bridgeResult.bridge2ExchangeIds = is2Split
                ? bridge2Result.splits.map(s => s.exchangeId)
                : [bridge2Result.exchangeId];
            }
          }

          onProgress('done', `⚡ Bridge Active! ${isSplit ? '(' + splitCount + ' splits)' : ''}`,
            `Funds sent to private pool. ${bridgeCoinSymbol} arrives at recipient in 2-5 min.\n` +
            `${isSplit ? 'Exchange IDs: ' + bridgeResult.splits.map(s => s.exchangeId).join(', ') : 'Exchange ID: ' + bridgeResult.exchangeId}\n` +
            `Total sent: ${totalSent.toFixed(4)} ${bridgeCoinSymbol}`
          );

          return {
            signatures: [fundSig, ...sendSigs],
            bridge: bridgeResult,
            mode: `${bridgeCoinSymbol.toLowerCase()}-bridge${isSplit ? '-split' : ''}${effectiveDoubleBridge ? '-double' : ''}`,
          };
        }
      } catch(bridgeErr) {
        console.error('[Ciego] Bridge FAILED:', bridgeErr.message, bridgeErr.stack);
        onProgress('mode', 'shadow-fallback', bridgeErr.message);
        onProgress('bridge', '⚠️ Bridge error: ' + bridgeErr.message, 'Falling back to shadow chain...');
        
        // Try to recover ALL shadow funds (SOL + SPL tokens)
        const shadowsToRecover = [bridgeShadow, bridgeShadow2].filter(Boolean);
        for (const shadow of shadowsToRecover) {
          const label = shadow === bridgeShadow2 ? 'shadow2' : 'shadow1';
          // 1. Recover SPL tokens first
          if (!isSOL && mintPubkey) {
            try {
              const sATA = getATA(mintPubkey, shadow.publicKey);
              const balResult = await rpc.rpcCall('getTokenAccountBalance', [sATA.toBase58()]);
              const tokenAmt = parseInt(balResult?.value?.amount || '0', 10);
              if (tokenAmt > 0) {
                const dec = token.decimals || 6;
                onProgress('bridge', `🔄 Recovering ${label} ${bridgeCoinSymbol}...`, `${(tokenAmt / Math.pow(10, dec)).toFixed(4)} ${bridgeCoinSymbol}`);
                const destATA = getATA(mintPubkey, publicKey);
                const tData = new Uint8Array(9); tData[0] = 3;
                new DataView(tData.buffer).setBigUint64(1, BigInt(tokenAmt), true);
                const recoverIx = [
                  createATAIx(shadow.publicKey, destATA, publicKey, mintPubkey),
                  new TransactionInstruction({
                    keys: [
                      { pubkey: sATA, isSigner: false, isWritable: true },
                      { pubkey: destATA, isSigner: false, isWritable: true },
                      { pubkey: shadow.publicKey, isSigner: true, isWritable: false },
                    ],
                    programId: TOKEN_PROGRAM_ID, data: tData,
                  }),
                  closeAccIx(sATA, shadow.publicKey, shadow.publicKey),
                ];
                const recoverTx = await buildV0(connection, shadow.publicKey, recoverIx);
                await sendC(connection, recoverTx, [shadow], rpcProxy);
                onProgress('bridge', `✅ ${label} ${bridgeCoinSymbol} recovered`, `${(tokenAmt / Math.pow(10, dec)).toFixed(4)} ${bridgeCoinSymbol} returned`);
              }
            } catch(e) {
              console.warn(`${label} SPL recovery failed:`, e.message);
            }
          }
          // 2. Recover SOL
          try {
            const shadowBal = await rpc.getBalance(shadow.publicKey.toBase58());
            if (shadowBal > BASE_FEE + 1000) {
              onProgress('bridge', `🔄 Recovering ${label} SOL...`, 'Sweeping back to your wallet');
              const sweepIx = [SystemProgram.transfer({
                fromPubkey: shadow.publicKey,
                toPubkey: publicKey,
                lamports: shadowBal - BASE_FEE,
              })];
              const sweepTx = await buildV0(connection, shadow.publicKey, sweepIx);
              await sendC(connection, sweepTx, [shadow], rpcProxy);
              onProgress('bridge', `✅ ${label} SOL recovered`, `${((shadowBal - BASE_FEE) / LAMPORTS_PER_SOL).toFixed(4)} SOL returned`);
            }
          } catch(recoverErr) {
            console.warn(`${label} SOL recovery failed, manual recovery available:`, recoverErr.message);
          }
        }
        // Return error result so app.js doesn't crash on result.bridge
        throw bridgeErr;
      }
    }
  }

  if (!window.ShadowPrivacy) window.ShadowPrivacy = {};
  window.ShadowPrivacy.sendMaximum = sendMaximum;
  window.ShadowPrivacy.sendC = sendC;
})();

// === BATCH SUPPORT: Prepare TX without signing ===
(function() {
  'use strict';
  if (typeof solanaWeb3 === 'undefined') return;

  const {
    Keypair, PublicKey, SystemProgram, TransactionMessage,
    VersionedTransaction, LAMPORTS_PER_SOL, ComputeBudgetProgram,
  } = solanaWeb3;

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROGRAM_ID  = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const FEE_WALLET = new PublicKey('983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb');
  const FEE_PERCENT = 0.01;
  const RENT_EXEMPT = 5000;

  function getATA(mint, owner) {
    const [addr] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ATA_PROGRAM_ID
    );
    return addr;
  }

  function createATAIx(payer, ata, owner, mint) {
    return new solanaWeb3.TransactionInstruction({
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
      ],
      programId: ATA_PROGRAM_ID, data: Buffer.alloc(0),
    });
  }

  function splTx(src, dst, auth, amt) {
    const data = Buffer.alloc(9); data[0] = 3;
    const bn = BigInt(amt);
    for (let i = 0; i < 8; i++) data[1+i] = Number((bn >> BigInt(8*i)) & 0xFFn);
    return new solanaWeb3.TransactionInstruction({
      keys: [
        { pubkey: src, isSigner: false, isWritable: true },
        { pubkey: dst, isSigner: false, isWritable: true },
        { pubkey: auth, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID, data,
    });
  }

  async function buildV0(connection, payer, instructions) {
    const bh = await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({ payerKey: payer, recentBlockhash: bh.blockhash, instructions }).compileToV0Message();
    return new VersionedTransaction(msg);
  }

  /**
   * prepareBatchMaximum - Builds the user-signed TX for Maximum/Maximum+
   * Returns { transaction, shadow, shadow2, bridgeResult, bridgeCoinSymbol, isSOL }
   * The transaction is UNSIGNED - caller uses signAllTransactions to batch-sign
   */
  async function prepareBatchMaximum(opts) {
    const { connection, publicKey, recipient, amount, token, onProgress, doubleBridge } = opts;
    const isSOL = token.mint === 'native';
    const mintPubkey = isSOL ? null : new PublicKey(token.mint);
    const rawTotal = Math.round(amount * Math.pow(10, token.decimals));
    const bridge = window.ShadowPrivacy?.bridge;
    const swapEngine = window.ShadowPrivacy?.swapEngine;

    const shadow = Keypair.generate();
    const allUserIx = [];

    // 1% fee
    if (isSOL) {
      allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: FEE_WALLET, lamports: Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT) }));
    } else {
      const feeTokens = Math.round(rawTotal * FEE_PERCENT);
      const sATA = getATA(mintPubkey, publicKey);
      const feeATA = getATA(mintPubkey, FEE_WALLET);
      allUserIx.push(createATAIx(publicKey, feeATA, FEE_WALLET, mintPubkey));
      allUserIx.push(splTx(sATA, feeATA, publicKey, feeTokens));
    }

    // Determine bridge coin
    const coinMap = bridge?.COIN_MAP || {};
    const tokenSymbol = (token.symbol || 'SOL').toUpperCase();
    const directSupported = !isSOL && coinMap[tokenSymbol];
    const bridgeCoinSymbol = directSupported ? tokenSymbol : 'SOL';

    let bridgeAmount = 0;
    if (isSOL) {
      bridgeAmount = amount - amount * FEE_PERCENT;
    } else if (directSupported) {
      bridgeAmount = (rawTotal - Math.round(rawTotal * FEE_PERCENT)) / Math.pow(10, token.decimals);
    } else if (swapEngine) {
      const netTokens = rawTotal - Math.round(rawTotal * FEE_PERCENT);
      try {
        const q = await swapEngine.getQuote(token.mint, 'So11111111111111111111111111111111111111112', netTokens, 100);
        bridgeAmount = (q?.outAmount || 0) / LAMPORTS_PER_SOL;
      } catch(e) { bridgeAmount = 0; }
    }

    // Shadow2 for double bridge
    let shadow2 = null;
    let bridge1Recipient = recipient.toBase58();
    if (doubleBridge) {
      shadow2 = Keypair.generate();
      bridge1Recipient = shadow2.publicKey.toBase58();
    }

    // Validate bridge
    onProgress('prepare', '⚡ Validating bridge...', `Checking private pool`);
    const bridgeResult = await bridge.createBridge(
      bridgeAmount * 0.98,
      bridge1Recipient,
      (s, t, d) => onProgress('prepare', t, d),
      bridgeCoinSymbol,
      shadow.publicKey.toBase58()
    );
    if (!bridgeResult || !bridgeResult.depositAddress) {
      throw new Error('Bridge validation failed');
    }
    const splitCount = bridgeResult.splitMode ? bridgeResult.splitCount : 1;

    // Fund shadow wallet
    if (isSOL) {
      const netLamports = Math.round(amount * LAMPORTS_PER_SOL) - Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT);
      allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: shadow.publicKey, lamports: netLamports }));
    } else {
      const netTokens = rawTotal - Math.round(rawTotal * FEE_PERCENT);
      const perSplitCost = 2_100_000;
      const solForFees = Math.max(3_000_000, splitCount * perSplitCost + 500_000);
      allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: shadow.publicKey, lamports: solForFees }));
      const sATA = getATA(mintPubkey, publicKey);
      const shATA = getATA(mintPubkey, shadow.publicKey);
      allUserIx.push(createATAIx(publicKey, shATA, shadow.publicKey, mintPubkey));
      allUserIx.push(splTx(sATA, shATA, publicKey, netTokens));
    }

    // Shadow2 gas for Maximum+ SPL
    if (doubleBridge && shadow2 && !isSOL) {
      allUserIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: shadow2.publicKey, lamports: 5_500_000 }));
    }

    const transaction = await buildV0(connection, publicKey, allUserIx);

    return { transaction, shadow, shadow2, bridgeResult, bridgeCoinSymbol, bridgeAmount, isSOL, splitCount };
  }

  /**
   * prepareBatchEnhanced - Builds the user-signed TX for Enhanced mode
   * Returns { transaction, shadows }
   */
  async function prepareBatchEnhanced(opts) {
    const { connection, publicKey, recipient, amount, token, onProgress } = opts;
    const isSOL = token.mint === 'native';
    const mintPubkey = isSOL ? null : new PublicKey(token.mint);
    const rawAmount = Math.round(amount * Math.pow(10, token.decimals));
    const swapEngine = window.ShadowPrivacy?.swapEngine;

    const temps = [Keypair.generate(), Keypair.generate(), Keypair.generate()];

    const feeAmount = isSOL
      ? Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT)
      : Math.round(rawAmount * FEE_PERCENT);
    const sendAmount = isSOL
      ? Math.round(amount * LAMPORTS_PER_SOL) - feeAmount
      : rawAmount - feeAmount;

    const swapBuffer = swapEngine ? 15_000_000 : 0;
    const hopFees = isSOL ? 3 * 5000 : 3 * (2_100_000 + 5000);

    const ix1 = [];
    if (isSOL) {
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: temps[0].publicKey, lamports: sendAmount + hopFees + swapBuffer }));
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: FEE_WALLET, lamports: feeAmount }));
    } else {
      ix1.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: temps[0].publicKey, lamports: hopFees + swapBuffer }));
      const sATA = getATA(mintPubkey, publicKey);
      const t1ATA = getATA(mintPubkey, temps[0].publicKey);
      ix1.push(createATAIx(publicKey, t1ATA, temps[0].publicKey, mintPubkey));
      ix1.push(splTx(sATA, t1ATA, publicKey, sendAmount));
      const feeATA = getATA(mintPubkey, FEE_WALLET);
      ix1.push(createATAIx(publicKey, feeATA, FEE_WALLET, mintPubkey));
      ix1.push(splTx(sATA, feeATA, publicKey, feeAmount));
    }

    const transaction = await buildV0(connection, publicKey, ix1);
    return { transaction, shadows: temps };
  }

  if (!window.ShadowPrivacy) window.ShadowPrivacy = {};
  window.ShadowPrivacy.prepareBatchMaximum = prepareBatchMaximum;
  window.ShadowPrivacy.prepareBatchEnhanced = prepareBatchEnhanced;
})();
