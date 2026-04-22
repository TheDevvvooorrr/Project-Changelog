/**
 * Ciego Decoy Engine — Anti-tracking layer
 * 
 * Three techniques to break on-chain analysis:
 * 
 * 1. DECOY TRANSACTIONS: Send tiny amounts to random wallets (noise)
 * 2. RANDOM DELAYS: 15-90s pauses between hops (break timing analysis)
 * 3. RANDOM AMOUNTS: Split into uneven fragments (break amount matching)
 * 
 * A tracker sees: dozens of transactions, random wallets, irregular timing,
 * unequal amounts — impossible to filter signal from noise.
 */
(function () {
  'use strict';
  if (!window.ShadowPrivacy) return;
  if (typeof solanaWeb3 === 'undefined') return;

  const { Keypair, PublicKey, SystemProgram, TransactionMessage,
    VersionedTransaction, LAMPORTS_PER_SOL, TransactionInstruction,
    ComputeBudgetProgram } = solanaWeb3;

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ATA_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  const SYSVAR_RENT = new PublicKey('SysvarRent111111111111111111111111111111111');
  const BASE_FEE = 5000;
  const RENT_EXEMPT_MIN = 891000;

  function getATA(mint, owner) {
    const [a] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROGRAM_ID);
    return a;
  }
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

  async function sendFast(conn, tx, signers, rpc) {
    if (signers?.length > 0) {
      const { blockhash } = await conn.getLatestBlockhash('confirmed');
      tx.message.recentBlockhash = blockhash;
      tx.signatures = [];
      for (const s of signers) tx.sign([s]);
    }
    const raw = encodeBase58(tx.serialize());
    // Fire and forget — decoys don't need confirmation
    const resp = await fetch(rpc, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
        params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 3 }] })
    });
    const j = await resp.json();
    return j.result || null;
  }

  // ============================================
  // 1. DECOY TRANSACTIONS — send dust to random wallets
  // ============================================
  // Creates noise: an analyst sees N outgoing TX from a shadow wallet
  // and can't tell which is the real hop vs decoys
  async function sendDecoys(conn, fromKeypair, rpc, count, onProgress) {
    const decoyAmount = RENT_EXEMPT_MIN; // minimum viable amount
    const sigs = [];
    for (let i = 0; i < count; i++) {
      try {
        const decoyTarget = Keypair.generate().publicKey;
        const ix = [SystemProgram.transfer({
          fromPubkey: fromKeypair.publicKey,
          toPubkey: decoyTarget,
          lamports: decoyAmount,
        })];
        const tx = await buildV0(conn, fromKeypair.publicKey, ix);
        const sig = await sendFast(conn, tx, [fromKeypair], rpc);
        if (sig) sigs.push(sig);
        if (onProgress) onProgress('decoy', `🎭 Decoy ${i + 1}/${count}`, decoyTarget.toBase58().slice(0, 8) + '...');
        // Small random gap between decoys (0.5-2s)
        await new Promise(r => setTimeout(r, 500 + Math.random() * 1500));
      } catch (e) {
        console.warn('[Decoy] Failed:', e.message);
      }
    }
    return sigs;
  }

  // ============================================
  // 2. RANDOM DELAYS — break timing correlation
  // ============================================
  // Instead of instant hops, wait 15-90s (configurable)
  // An analyst can't match "TX at 12:00:01" → "TX at 12:00:02"
  // if there's a random 45s gap
  function randomDelay(minSec, maxSec, onProgress) {
    const delay = minSec + Math.random() * (maxSec - minSec);
    const secs = Math.round(delay);
    return new Promise(resolve => {
      let elapsed = 0;
      const tick = () => {
        elapsed++;
        if (onProgress) {
          const remaining = secs - elapsed;
          onProgress('delay', `⏱️ Waiting ${remaining}s...`, `Anti-timing: ${elapsed}/${secs}s`);
        }
        if (elapsed >= secs) resolve();
        else setTimeout(tick, 1000);
      };
      setTimeout(tick, 1000);
    });
  }

  // ============================================
  // 3. RANDOM AMOUNT SPLITTING — break amount matching  
  // ============================================
  // Instead of 1.0 SOL → 0.5 + 0.5, split into
  // random unequal parts like 0.37 + 0.19 + 0.44
  // Makes it impossible to grep by amount on explorers
  function randomSplit(totalLamports, numParts) {
    if (numParts <= 1) return [totalLamports];
    // Generate random breakpoints
    const breaks = [];
    for (let i = 0; i < numParts - 1; i++) {
      // Each part gets between 10% and 55% — very unequal
      breaks.push(0.1 + Math.random() * 0.45);
    }
    // Normalize to sum to 1
    const sum = breaks.reduce((a, b) => a + b, 0);
    const normalized = breaks.map(b => b / sum);
    // Last piece is whatever's left
    const parts = [];
    let remaining = totalLamports;
    for (let i = 0; i < numParts - 1; i++) {
      const part = Math.floor(totalLamports * normalized[i]);
      parts.push(part);
      remaining -= part;
    }
    parts.push(remaining);
    return parts.sort(() => Math.random() - 0.5); // shuffle order
  }

  // ============================================
  // SETTINGS per privacy level
  // ============================================
  const SETTINGS = {
    enhanced: {
      delays: { min: 15, max: 45 },    // seconds between hops
      decoys: { perHop: 1, total: 3 },  // 1 decoy per hop, 3 total
      splitParts: 2,                     // split into 2 random parts
      extraSOL: 0.005,                   // extra SOL needed for decoys
    },
    maximum: {
      delays: { min: 30, max: 90 },     // longer delays
      decoys: { perHop: 2, total: 8 },  // 2 decoys per hop, up to 8
      splitParts: 3,                     // 3-way random split (already exists)
      extraSOL: 0.012,                   // extra SOL for all decoys
    }
  };

  // Expose to ShadowPrivacy
  window.ShadowPrivacy.decoys = {
    sendDecoys,
    randomDelay,
    randomSplit,
    SETTINGS,
  };

  console.log('[Ciego] Decoy engine loaded — delays + decoys + random splits');
})();
