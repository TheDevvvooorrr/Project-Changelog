/**
 * Ciego Token Swap Engine
 * Uses aggregator API for on-chain token swaps
 * No API key required — fully decentralized
 * 
 * Purpose: Break the token trail mid-route
 * SOL → Swap → USDC (different token = untraceable)
 * USDC → Swap → SOL (swap back at end)
 */
(function() {
  'use strict';

  // Use our server proxy to avoid CORS issues from browser
  function getSwapBase() {
    // Use baseUrl set by app.js, or compute it from location
    if (window.__shadowBaseUrl) return window.__shadowBaseUrl + 'swap';
    const loc = window.location;
    const path = loc.pathname;
    const previewMatch = path.match(/^\/preview\/[^/]+/);
    if (previewMatch) return loc.protocol + '//' + loc.host + path.replace(/\/[^/]*$/, '/') + 'swap';
    const slugMatch = path.match(/^\/(\d+-[^/]+)/);
    if (slugMatch) return loc.protocol + '//' + loc.host + '/' + slugMatch[1] + '/swap';
    return loc.protocol + '//' + loc.host + '/swap';
  }
  const SOL_MINT = 'So11111111111111111111111111111111111111112';
  const USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
  const USDT_MINT = 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB';
  const USD1_MINT = 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB';

  // Get the best swap route
  async function getQuote(inputMint, outputMint, amountRaw, slippageBps = 150) {
    const url = `${getSwapBase()}/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountRaw}&slippageBps=${slippageBps}`;
    const resp = await fetch(url);
    if (!resp.ok) throw new Error('Quote failed: ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error('Swap: ' + data.error);
    return data;
  }

  // Get swap instructions (we build the TX ourselves)
  async function getSwapInstructions(quote, userPublicKey) {
    const resp = await fetch(`${getSwapBase()}/swap-instructions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        quoteResponse: quote,
        userPublicKey: userPublicKey.toBase58(),
        dynamicComputeUnitLimit: true,
        wrapAndUnwrapSol: true,
      }),
    });
    if (!resp.ok) throw new Error('Swap instructions failed: ' + resp.status);
    const data = await resp.json();
    if (data.error) throw new Error('Swap: ' + data.error);
    return data;
  }

  // Build a swap transaction from aggregator instructions
  async function buildSwapTx(connection, swapData, signerPubkey) {
    const {
      PublicKey,
      TransactionInstruction,
      TransactionMessage,
      VersionedTransaction,
      AddressLookupTableAccount,
    } = solanaWeb3;

    function deserializeIx(ix) {
      return new TransactionInstruction({
        programId: new PublicKey(ix.programId),
        keys: ix.accounts.map(a => ({
          pubkey: new PublicKey(a.pubkey),
          isSigner: a.isSigner,
          isWritable: a.isWritable,
        })),
        data: Buffer.from(ix.data, 'base64'),
      });
    }

    const allIx = [];

    // Setup instructions (create token accounts, etc.)
    if (swapData.setupInstructions?.length) {
      for (const ix of swapData.setupInstructions) {
        allIx.push(deserializeIx(ix));
      }
    }

    // Main swap instruction
    allIx.push(deserializeIx(swapData.swapInstruction));

    // Cleanup (close wrapped SOL, etc.)
    if (swapData.cleanupInstruction) {
      allIx.push(deserializeIx(swapData.cleanupInstruction));
    }

    // Load address lookup tables
    const altAddresses = swapData.addressLookupTableAddresses || [];
    const altAccounts = [];
    for (const addr of altAddresses) {
      for (let retry = 0; retry < 3; retry++) {
        try {
          const result = await connection.getAddressLookupTable(new PublicKey(addr));
          if (result.value) altAccounts.push(result.value);
          break;
        } catch(e) {
          if (retry < 2) await new Promise(r => setTimeout(r, 1500 * (retry + 1)));
        }
      }
    }

    const _rpc = window.ShadowPrivacy?.rpc;
    const bh = _rpc ? await _rpc.getLatestBlockhash() : await connection.getLatestBlockhash('confirmed');
    const msg = new TransactionMessage({
      payerKey: signerPubkey,
      recentBlockhash: bh.blockhash,
      instructions: allIx,
    }).compileToV0Message(altAccounts);

    return new VersionedTransaction(msg);
  }

  // Execute a full swap: get quote → build TX → sign → send
  async function executeSwap(connection, signer, inputMint, outputMint, amountRaw, rpcProxy, onProgress) {
    const label = inputMint === SOL_MINT ? 'SOL→USDC' : 'USDC→SOL';
    onProgress('swap', `💱 Token swap: ${label}...`, 'Getting best route');

    // 1. Get quote
    const quote = await getQuote(inputMint, outputMint, amountRaw);
    const inAmt = inputMint === SOL_MINT
      ? (parseInt(quote.inAmount) / 1e9).toFixed(4) + ' SOL'
      : (parseInt(quote.inAmount) / 1e6).toFixed(2) + ' USDC';
    const outAmt = outputMint === SOL_MINT
      ? (parseInt(quote.outAmount) / 1e9).toFixed(4) + ' SOL'
      : (parseInt(quote.outAmount) / 1e6).toFixed(2) + ' USDC';
    onProgress('swap', `💱 Swapping ${inAmt} → ${outAmt}`, 'Building transaction');

    // 2. Get swap instructions
    const swapData = await getSwapInstructions(quote, signer.publicKey);

    // 3. Build and sign transaction
    const tx = await buildSwapTx(connection, swapData, signer.publicKey);
    tx.sign([signer]);

    // 4. Send
    onProgress('swap', `💱 Broadcasting swap...`, 'Confirming on-chain');
    const raw = Buffer.from(tx.serialize()).toString('base64');
    const _rpc = window.ShadowPrivacy?.rpc;
    const sig = await _rpc.rpcCall('sendTransaction', [raw, { encoding: 'base64', skipPreflight: true, maxRetries: 3 }], 4);
    if (!sig) throw new Error('Swap TX send failed');

    // 5. Confirm using resilient RPC
    for (let i = 0; i < 60; i++) {
      await new Promise(r => setTimeout(r, 2000));
      try {
        const stResult = await _rpc.rpcCall('getSignatureStatuses', [[sig], { searchTransactionHistory: true }]);
        const st = stResult?.value?.[0];
        if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') {
          onProgress('swap', `✅ Swap complete: ${inAmt} → ${outAmt}`, `TX: ${sig.slice(0,8)}...`);
          return { signature: sig, outAmount: parseInt(quote.outAmount) };
        }
        if (st?.err) throw new Error('Swap TX reverted');
      } catch(e) { if (e.message === 'Swap TX reverted') throw e; }
    }
    throw new Error('Swap TX not confirmed after 120s');
  }

  // Get intermediate mint for a given token (what to swap through)
  function getSwapMint(tokenMint) {
    // If sending SOL, swap to USDC mid-route
    if (tokenMint === 'native' || tokenMint === SOL_MINT) return USDC_MINT;
    // If sending USDC, swap to SOL mid-route
    if (tokenMint === USDC_MINT) return SOL_MINT;
    // If sending USDT, swap to SOL mid-route
    if (tokenMint === USDT_MINT) return SOL_MINT;
    // If sending USD1, swap to SOL mid-route (better liquidity than USD1→USDC)
    if (tokenMint === USD1_MINT) return SOL_MINT;
    // Default: swap to USDC
    return USDC_MINT;
  }

  if (!window.ShadowPrivacy) window.ShadowPrivacy = {};
  window.ShadowPrivacy.swapEngine = {
    getQuote,
    getSwapInstructions,
    buildSwapTx,
    executeSwap,
    getSwapMint,
    SOL_MINT,
    USDC_MINT,
    USDT_MINT,
  };
})();
