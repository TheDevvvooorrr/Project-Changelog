// Ciego — Real Private Solana Transactions
(function () {
  'use strict';

  // === SECURITY: HTML sanitizer ===
  function sanitize(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ===== GUARD: solanaWeb3 must be loaded =====
  if (typeof solanaWeb3 === 'undefined') {
    console.error('solanaWeb3 not loaded');
    return;
  }

  const {
    Connection, PublicKey, Transaction, SystemProgram,
    TransactionInstruction, LAMPORTS_PER_SOL,
    VersionedTransaction, TransactionMessage, ComputeBudgetProgram
  } = solanaWeb3;

  // ===== CONFIG =====
  const TOKENS = {
    SOL:    { mint: 'native', decimals: 9, symbol: 'SOL', icon: '◎', logo: 'sol-logo.png' },
    USDC:   { mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v', decimals: 6, symbol: 'USDC', icon: '$', logo: 'usdc-logo.webp' },
    USDT:   { mint: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB', decimals: 6, symbol: 'USDT', icon: '₮', logo: 'usdt-logo.jpg' },
    USD1:   { mint: 'USD1ttGY1N17NEEHLmELoaybftRBUSErhqYiQzvEmuB', decimals: 6, symbol: 'USD1', icon: '💵', logo: 'usd1-logo.png', alwaysShow: true },

  };

  const TOKEN_PROGRAM_ID = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
  const ASSOCIATED_TOKEN_PROGRAM_ID = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
  // Official Jito Tip Payment Accounts (from https://jito-foundation.gitbook.io/mev)
  // Platform fee: 1% to this wallet on every private transaction
  const FEE_WALLET = new PublicKey('983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb');
  const FEE_PERCENT = 0.01; // 1%

  const JITO_TIP_ACCOUNTS = [
    '96gYZGLnJYVFmbjzopPSU6QiEV5fGqZNyN9nmNhvrZU5',
    'HFqU5x63VTqvQss8hp11i4wVV8bD44PvwucfZ2bU7gRe',
    'Cw8CFyM9FkoMi7K7Crf6HNQqf4uEMzpKw6QNghXLvLkY',
    'ADaUMid9yfUytqMBgopwjb2DTLSokTSzL1zt6iGPaS49',
    'DfXygSm4jCyNCybVYYK6DwvWqjKee8pbDmJGcLWNDXjh',
    'ADuUkR4vqLUMWXxW9gh6D6L8pMSawimctcNZ5pGwDcEt',
    'DttWaMuVvTiduZRnguLF7jNxTgiMBZ1hyAumKUiL2KRL',
    '3AVi9Tg9Uo68tJfuvoKvqKNWKkC5wPdSSdeBnizKZ6jT',
  ];

  // Backend proxy endpoints — resolve to absolute URLs based on current page
  function baseUrl() {
    const loc = window.location;
    const path = loc.pathname;
    // Preview URL: /preview/xxx/ → keep prefix
    if (path.match(/^\/preview\/[^/]+/)) {
      return loc.protocol + '//' + loc.host + path.replace(/\/[^/]*$/, '/');
    }
    // Community URL: /2287-shadowsend/ → keep slug prefix (proxy needs it)
    const slugMatch = path.match(/^\/(\d+-[^/]+)/);
    if (slugMatch) {
      return loc.protocol + '//' + loc.host + '/' + slugMatch[1] + '/';
    }
    // Standalone: /
    return loc.protocol + '//' + loc.host + '/';
  }
  const RPC_PROXY = baseUrl() + 'rpc';
  const JITO_BUNDLE_URL = baseUrl() + 'jito/bundles';
  const JITO_TX_URL = baseUrl() + 'jito/transactions';
  // Expose baseUrl for swap proxy
  window.__shadowBaseUrl = baseUrl();

  // ===== STATE =====
  let wallet = null;
  let publicKey = null;
  let selectedToken = 'SOL';
  let privacyLevel = 'maximum-plus';
  let balances = {};
  let tokenPrices = { SOL: 0, USDC: 1, USDT: 1, USD1: 1 };

  // Fetch live token prices
  async function fetchPrices() {
    try {
      const r = await fetch(baseUrl() + 'api/prices');
      if (r.ok) tokenPrices = await r.json();
    } catch(e) { console.log('Price fetch failed, using defaults'); }
  }
  fetchPrices();
  setInterval(fetchPrices, 60000); // refresh every 60s

  function updateUsdEstimate() {
    const el = $('usdEstimate');
    const feeEl = $('sendFeeEstimate');
    const totalEl = $('sendTotalEstimate');
    const amt = parseFloat(amountInput?.value) || 0;
    const price = tokenPrices[selectedToken] || 0;
    const usd = amt * price;
    const fee = amt * 0.01;
    const feeUsd = fee * price;
    const totalAmt = amt + fee;
    const totalUsd = totalAmt * price;
    const fmt = (v) => v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    if (!amt || amt <= 0) {
      if (el) el.textContent = '—';
      if (feeEl) feeEl.textContent = '—';
      if (totalEl) totalEl.textContent = '—';
      return;
    }
    if (el) el.textContent = amt + ' ' + selectedToken + ' ($' + fmt(usd) + ')';
    if (feeEl) feeEl.textContent = fee.toFixed(4) + ' ' + selectedToken + ' ($' + fmt(feeUsd) + ')';
    if (totalEl) totalEl.textContent = totalAmt.toFixed(4) + ' ' + selectedToken + ' ($' + fmt(totalUsd) + ')';
  }

  // Custom Connection that routes through our backend proxy
  // Disable WebSocket by pointing wsEndpoint to a dummy — our proxy is HTTP-only
  let connection = new Connection(RPC_PROXY, {
    commitment: 'confirmed',
    wsEndpoint: 'wss://localhost:1/ws-disabled',
    disableRetryOnRateLimit: false,
  });

  // ===== DOM =====
  const $ = id => document.getElementById(id);
  const connectBtn = $('connectBtn');
  const disconnectBtn = $('disconnectBtn');
  const walletInfo = $('walletInfo');
  const walletAddress = $('walletAddress');
  const walletBalances = $('walletBalances');
  const txForm = $('txForm');
  const recipientInput = $('recipientInput');
  const amountInput = $('amountInput');
  const addressHint = $('addressHint');
  const sendBtn = $('sendBtn');
  const maxBtn = $('maxBtn');
  // txStatus removed — using txStepBar + txResult separately
  const availableBalance = $('availableBalance');
  const availableToken = $('availableToken');

  console.log('[Ciego] App loaded, DOM ready');


  // ===== WALLET CONNECTION (Multi-Wallet) =====
  let connectedWalletType = null; // 'phantom', 'solflare', 'backpack'
  const walletModal = $('walletModal');
  const walletModalClose = $('walletModalClose');

  const WALLETS = {
    phantom: {
      name: 'Phantom',
      icon: '👻',
      logo: 'phantom-logo.png',
      getProvider: () => window.phantom?.solana || (window.solana?.isPhantom ? window.solana : null),
      downloadUrl: 'https://phantom.app/',
      deepLink: (url) => 'https://phantom.app/ul/browse/' + encodeURIComponent(url)
    },
    solflare: {
      name: 'Solflare',
      icon: '🔆',
      logo: 'solflare-logo.png',
      getProvider: () => window.solflare?.isSolflare ? window.solflare : null,
      downloadUrl: 'https://solflare.com/',
      deepLink: (url) => 'https://solflare.com/ul/v1/browse/' + encodeURIComponent(url)
    },
    backpack: {
      name: 'Backpack',
      icon: '🎒',
      logo: 'backpack-logo.png',
      getProvider: () => window.backpack?.isBackpack ? window.backpack : null,
      downloadUrl: 'https://backpack.app/',
      deepLink: null
    }
  };

  function detectInstalledWallets() {
    const results = {};
    for (const [key, w] of Object.entries(WALLETS)) {
      results[key] = !!w.getProvider();
    }
    return results;
  }

  function updateWalletModalStatus() {
    const installed = detectInstalledWallets();
    for (const [key, isInstalled] of Object.entries(installed)) {
      const statusEl = $(key + 'Status');
      const optionEl = document.querySelector(`.wallet-option[data-wallet="${key}"]`);
      if (statusEl && optionEl) {
        if (isInstalled) {
          statusEl.textContent = 'Detected';
          statusEl.style.color = 'var(--accent2)';
          optionEl.classList.remove('not-installed');
        } else {
          statusEl.textContent = 'Not installed';
          statusEl.style.color = 'var(--text2)';
          optionEl.classList.add('not-installed');
        }
      }
    }
  }

  function showWalletModal() {
    updateWalletModalStatus();
    walletModal.classList.remove('hidden');
  }

  function hideWalletModal() {
    walletModal.classList.add('hidden');
  }

  function getProvider() {
    // If already connected to a specific wallet, return that
    if (connectedWalletType && WALLETS[connectedWalletType]) {
      return WALLETS[connectedWalletType].getProvider();
    }
    // Fallback: detect any
    for (const w of Object.values(WALLETS)) {
      const p = w.getProvider();
      if (p) return p;
    }
    return null;
  }

  function waitForProvider(timeout = 4000) {
    return new Promise((resolve) => {
      const p = getProvider();
      if (p) return resolve(p);
      const start = Date.now();
      const interval = setInterval(() => {
        const p = getProvider();
        if (p || Date.now() - start > timeout) {
          clearInterval(interval);
          resolve(p || null);
        }
      }, 200);
    });
  }

  async function connectToWallet(walletKey) {
    const walletDef = WALLETS[walletKey];
    if (!walletDef) return;

    const provider = walletDef.getProvider();
    if (!provider) {
      const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
      if (isMobile && walletDef.deepLink) {
        window.location.href = walletDef.deepLink(window.location.href);
      } else {
        showNotification(`${walletDef.name} not found. Install it first.`, 'error');
        window.open(walletDef.downloadUrl, '_blank');
      }
      return;
    }

    hideWalletModal();
    connectBtn.textContent = `Connecting to ${walletDef.name}...`;
    connectBtn.disabled = true;

    try {
      const resp = await provider.connect();
      wallet = provider;
      publicKey = resp.publicKey;
      connectedWalletType = walletKey;
      onWalletConnected();
      showNotification(`${walletDef.name} connected!`, 'success', walletDef.logo);
    } catch (err) {
      console.error('Connect error:', err);
      connectBtn.textContent = 'Connect Wallet';
      connectBtn.disabled = false;
      if (err.code === 4001) {
        showNotification('Connection rejected by user.', 'error');
      } else {
        showNotification('Connection failed: ' + err.message, 'error');
      }
    }
  }

  async function connectWallet() {
    console.log('[Ciego] Connect button clicked');
    // On mobile, check if inside a wallet browser
    const isMobile = /Android|iPhone|iPad/i.test(navigator.userAgent);
    const singleProvider = getProvider();
    if (isMobile && singleProvider) {
      // Inside wallet browser — connect directly
      for (const [key, w] of Object.entries(WALLETS)) {
        if (w.getProvider() === singleProvider) {
          connectToWallet(key);
          return;
        }
      }
    }
    showWalletModal();
  }

  async function disconnectWallet() {
    const walletName = connectedWalletType ? WALLETS[connectedWalletType]?.name : 'Wallet';
    const walletLogo = connectedWalletType ? WALLETS[connectedWalletType]?.logo : null;
    if (wallet) { try { await wallet.disconnect(); } catch(e) {} }
    wallet = null;
    publicKey = null;
    balances = {};
    connectedWalletType = null;
    connectBtn.style.display = '';
    walletInfo.classList.add('hidden');
    if ($('txStepBar')) $('txStepBar').classList.add('hidden');
    if ($('txResult')) $('txResult').classList.add('hidden');
    txForm.classList.remove('hidden');
    if ($('batchMode')) $('batchMode').classList.add('hidden');
    if ($('bridgeMode')) $('bridgeMode').classList.add('hidden');
    // Reset send button
    const btnText = sendBtn.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Connect Wallet';
    sendBtn.classList.add("btn-not-ready");
    // Reset tabs to send mode
    document.querySelectorAll('.mode-tab').forEach(t => t.classList.remove('active'));
    const sendTab = document.querySelector('.mode-tab[data-mode="send"]');
    if (sendTab) sendTab.classList.add('active');
    connectBtn.textContent = 'Connect Wallet';
    connectBtn.disabled = false;
    showNotification(walletName + ' disconnected', 'info', walletLogo);
  }

  function onWalletConnected() {
    connectBtn.style.display = 'none';
    walletInfo.classList.remove('hidden');
    txForm.classList.remove('hidden');
    // Update send button text
    const btnText = sendBtn.querySelector('.btn-text');
    if (btnText) btnText.textContent = 'Send Privately';
    // Smooth entrance
    walletInfo.style.opacity = '0';
    requestAnimationFrame(() => {
      walletInfo.style.transition = 'opacity 0.4s ease';
      walletInfo.style.opacity = '1';
    });
    const addr = publicKey.toBase58();
    // Show wallet name + address
    const wName = connectedWalletType ? WALLETS[connectedWalletType]?.name : 'Wallet';
    const wIcon = connectedWalletType ? WALLETS[connectedWalletType]?.icon : '💳';
    walletAddress.innerHTML = `<span class="wallet-badge"><span class="wallet-badge-fallback">${wIcon}</span> ${sanitize(addr.slice(0, 6))}...${sanitize(addr.slice(-4))}</span>`;
    // Update wallet label
    const walletLabel = document.querySelector('.wallet-label');
    if (walletLabel) walletLabel.textContent = 'Connected via ' + wName;
    fetchBalances();
    updateAvailableBalance();
    // Show manual recovery button when wallet connected
    const manualRecoveryDiv = $('manualRecoveryCheck');
    if (manualRecoveryDiv) manualRecoveryDiv.classList.remove('hidden');
    // Check recovery after a moment (balances need to load first)
    setTimeout(() => checkRecovery(), 4000);
    validateForm();
  }

  // ===== BALANCE FETCHING =====
  async function fetchBalances() {
    if (!publicKey) return;
    try {
      // SOL balance via resilient rpcCall
      const solResult = await rpcCall('getBalance', [publicKey.toBase58(), { commitment: 'confirmed' }]);
      balances.SOL = (solResult?.value || 0) / LAMPORTS_PER_SOL;

      // SPL token balances via resilient rpcCall
      try {
        const splResult = await rpcCall('getTokenAccountsByOwner', [
          publicKey.toBase58(),
          { programId: TOKEN_PROGRAM_ID.toBase58() },
          { encoding: 'jsonParsed', commitment: 'confirmed' }
        ]);
        for (const item of (splResult?.value || [])) {
          const info = item.account.data.parsed.info;
          const mint = info.mint;
          const amount = info.tokenAmount.uiAmount || 0;
          for (const [sym, tok] of Object.entries(TOKENS)) {
            if (tok.mint === mint) {
              balances[sym] = amount;
            }
          }
        }
      } catch (splErr) {
        console.warn('SPL balance fetch failed, showing SOL only:', splErr);
      }

      renderBalances();
    } catch (err) {
      console.error('Balance fetch error:', err);
      renderBalances();
      setTimeout(fetchBalances, 5000);
    }
  }

  function renderBalances() {
    walletBalances.innerHTML = '';
    for (const [sym, tok] of Object.entries(TOKENS)) {
      const bal = balances[sym] || 0;
      if (bal > 0 || sym === 'SOL' || sym === 'USDC' || sym === 'USDT' || sym === 'USD1' || sym === selectedToken) {
        const div = document.createElement('div');
        div.className = 'balance-item';
        div.innerHTML = '<span class="balance-icon">' + tok.icon + '</span><span class="balance-symbol">' + sym + '</span><span class="balance-amount">' + bal.toFixed(tok.decimals > 6 ? 4 : 2) + '</span>';
        walletBalances.appendChild(div);
      }
    }
    updateAvailableBalance();
    renderTokenSelector();
    // Also update bridge available balance
    const bridgeAvail = $('bridgeAvailableBalance');
    if (bridgeAvail) bridgeAvail.textContent = (balances.SOL || 0).toFixed(4);
  }

  function renderTokenSelector() {
    const tokenSelect = $('tokenSelect');
    if (!tokenSelect) return;

    // Build list: only tokens with balance > 0, plus stablecoins always
    const tokenEntries = Object.entries(TOKENS)
      .map(([sym, tok]) => ({ sym, tok, bal: balances[sym] || 0 }))
      .sort((a, b) => b.bal - a.bal); // Show ALL tokens, sorted by balance

    if (!tokenEntries.find(e => e.sym === selectedToken)) {
      selectedToken = tokenEntries[0]?.sym || 'SOL';
    }

    const NAMES = { SOL: 'Solana', USDC: 'USD Coin', USDT: 'Tether', USD1: 'USD1 (WLFI)' };
    const sel = TOKENS[selectedToken];

    // Build: trigger button + floating cloud dropdown
    tokenSelect.innerHTML =
      '<div class="tk-trigger" id="tkTrigger">'
      + '<img class="tk-logo" src="' + sel.logo + '" alt="' + selectedToken + '" onerror="this.style.display=\'none\'">'
      + '<span class="tk-name">' + selectedToken + '</span>'
      + '<svg class="tk-chevron" width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
      + '</div>'
      + '<div class="tk-cloud" id="tkCloud">'
      + tokenEntries.map(e => {
          const active = e.sym === selectedToken ? ' active' : '';
          const balStr = e.bal > 0 ? e.bal.toFixed(e.tok.decimals > 6 ? 4 : 2) : '0';
          return '<div class="tk-item' + active + '" data-token="' + e.sym + '">'
            + '<img class="tk-item-logo" src="' + e.tok.logo + '" alt="' + e.sym + '" onerror="this.textContent=\'' + e.tok.icon + '\'">'
            + '<div class="tk-item-info">'
            + '<span class="tk-item-name">' + e.sym + '</span>'
            + '<span class="tk-item-full">' + (NAMES[e.sym] || e.sym) + '</span>'
            + '</div>'
            + '<span class="tk-item-bal">' + balStr + '</span>'
            + '</div>';
        }).join('')
      + '</div>';

    // Toggle cloud on trigger click
    const trigger = tokenSelect.querySelector('#tkTrigger');
    const cloud = tokenSelect.querySelector('#tkCloud');
    trigger.addEventListener('click', (e) => {
      e.stopPropagation();
      cloud.classList.toggle('show');
    });

    // Select token from cloud
    tokenSelect.querySelectorAll('.tk-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        selectedToken = el.dataset.token;
        cloud.classList.remove('show');
        renderTokenSelector(); // re-render with new selection
        updateAvailableBalance();
        validateForm();
        updateUsdEstimate();
      });
    });

    // Close cloud on outside click
    document.addEventListener('click', () => cloud.classList.remove('show'), { once: false });
  }

  function updateAvailableBalance() {
    const bal = balances[selectedToken] || 0;
    if (availableBalance) availableBalance.textContent = bal.toFixed(4);
    if (availableToken) availableToken.textContent = selectedToken;
  }


  // ===== ATA HELPERS =====
  function getAssociatedTokenAddress(mint, owner) {
    const [address] = PublicKey.findProgramAddressSync(
      [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()],
      ASSOCIATED_TOKEN_PROGRAM_ID
    );
    return address;
  }

  function createAssociatedTokenAccountInstruction(payer, ata, owner, mint) {
    return new TransactionInstruction({
      keys: [
        { pubkey: payer, isSigner: true, isWritable: true },
        { pubkey: ata, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: false, isWritable: false },
        { pubkey: mint, isSigner: false, isWritable: false },
        { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
        { pubkey: new PublicKey('SysvarRent111111111111111111111111111111111'), isSigner: false, isWritable: false },
      ],
      programId: ASSOCIATED_TOKEN_PROGRAM_ID,
      data: new Uint8Array(0),
    });
  }

  // SPL Transfer instruction (manual, no dependency)
  function createSplTransferInstruction(source, destination, owner, amount) {
    const data = new Uint8Array(9);
    data[0] = 3; // Transfer instruction index
    const view = new DataView(data.buffer);
    view.setBigUint64(1, BigInt(amount), true); // little-endian
    return new TransactionInstruction({
      keys: [
        { pubkey: source, isSigner: false, isWritable: true },
        { pubkey: destination, isSigner: false, isWritable: true },
        { pubkey: owner, isSigner: true, isWritable: false },
      ],
      programId: TOKEN_PROGRAM_ID,
      data,
    });
  }

  // ===== BUILD TRANSACTION =====
  async function buildTransaction(recipient, amount) {
    const instructions = [];

    // Priority fee
    const priorityFee = parseInt($('priorityFee')?.value || '5000');
    if (priorityFee > 0) {
      instructions.push(ComputeBudgetProgram.setComputeUnitPrice({ microLamports: priorityFee }));
    }

    const tok = TOKENS[selectedToken];

    // 1% platform fee — minimum 891000 lamports for SOL (rent-exempt minimum)
    const RENT_EXEMPT_MIN = 891000;
    const feeLamports = Math.max(Math.round(amount * FEE_PERCENT * LAMPORTS_PER_SOL), RENT_EXEMPT_MIN);
    const sendLamports = Math.round(amount * LAMPORTS_PER_SOL) - feeLamports;
    const feeAmount = feeLamports / LAMPORTS_PER_SOL;
    const sendAmount = sendLamports / LAMPORTS_PER_SOL;

    if (selectedToken === 'SOL') {
      instructions.push(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: recipient,
        lamports: sendLamports,
      }));
      // Fee transfer
      instructions.push(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: FEE_WALLET,
        lamports: feeLamports,
      }));
    } else {
      const mint = new PublicKey(tok.mint);
      const senderATA = getAssociatedTokenAddress(mint, publicKey);
      const recipientATA = getAssociatedTokenAddress(mint, recipient);

      // Check if recipient ATA exists
      try {
        const recipientATAResult = await rpcCall('getAccountInfo', [recipientATA.toBase58(), { encoding: 'base64' }]);
        if (!recipientATAResult?.value) {
          instructions.push(createAssociatedTokenAccountInstruction(publicKey, recipientATA, recipient, mint));
        }
      } catch (e) {
        // If check fails, include create instruction (idempotent)
        instructions.push(createAssociatedTokenAccountInstruction(publicKey, recipientATA, recipient, mint));
      }

      const rawSendAmount = Math.round(sendAmount * Math.pow(10, tok.decimals));
      const rawFeeAmount = Math.round(feeAmount * Math.pow(10, tok.decimals));
      instructions.push(createSplTransferInstruction(senderATA, recipientATA, publicKey, rawSendAmount));
      // Fee transfer (SPL token)
      if (rawFeeAmount > 0) {
        const feeATA = getAssociatedTokenAddress(mint, FEE_WALLET);
        try {
          const feeATAResult = await rpcCall('getAccountInfo', [feeATA.toBase58(), { encoding: 'base64' }]);
          if (!feeATAResult?.value) {
            instructions.push(createAssociatedTokenAccountInstruction(publicKey, feeATA, FEE_WALLET, mint));
          }
        } catch(e) {
          instructions.push(createAssociatedTokenAccountInstruction(publicKey, feeATA, FEE_WALLET, mint));
        }
        instructions.push(createSplTransferInstruction(senderATA, feeATA, publicKey, rawFeeAmount));
      }
    }

    // Jito tip for enhanced/maximum
    if (privacyLevel !== 'standard') {
      // Input is in SOL (e.g. 0.001), convert to lamports. Minimum 1000 lamports for Jito.
      const tipInputVal = parseFloat($('jitoTip')?.value || '0.001');
      const tipLamports = Math.max(1000, Math.round(tipInputVal * LAMPORTS_PER_SOL));
      console.log('[Ciego] Jito tip:', tipLamports, 'lamports', '(' + tipInputVal + ' SOL)');
      const tipAccount = JITO_TIP_ACCOUNTS[Math.floor(Math.random() * JITO_TIP_ACCOUNTS.length)];
      instructions.push(SystemProgram.transfer({
        fromPubkey: publicKey,
        toPubkey: new PublicKey(tipAccount),
        lamports: tipLamports,
      }));
    }

    // Use resilient rpcCall instead of connection.getLatestBlockhash (handles 502s)
    const bhResult = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }], 5);
    const blockhash = bhResult.value.blockhash;
    const lastValidBlockHeight = bhResult.value.lastValidBlockHeight;

    const messageV0 = new TransactionMessage({
      payerKey: publicKey,
      recentBlockhash: blockhash,
      instructions,
    }).compileToV0Message();

    return { tx: new VersionedTransaction(messageV0), blockhash, lastValidBlockHeight };
  }


  // ===== SEND METHODS =====
  async function sendDirect(signedTx) {
    console.log('[Ciego] Sending via RPC proxy...');
    const raw = encodeBase58(signedTx.serialize());
    // Use resilient fetch instead of connection.sendRawTransaction
    for (let i = 0; i < 4; i++) {
      try {
        const resp = await fetch(RPC_PROXY, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction',
            params: [raw, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }] })
        });
        if (!resp.ok) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
        const text = await resp.text();
        if (text.startsWith('<!') || text.startsWith('<html')) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
        const j = JSON.parse(text);
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        return j.result;
      } catch(e) {
        if (i >= 3 || e.message.includes('insufficient')) throw e;
        console.warn('[sendDirect] attempt', i+1, 'failed:', e.message);
        await new Promise(r => setTimeout(r, 1500 * (i + 1)));
      }
    }
    throw new Error('Failed to send transaction after 4 attempts');
  }

  async function sendViaJitoTx(signedTx) {
    const raw = signedTx.serialize();
    const bs58Encoded = encodeBase58(raw);
    try {
      console.log('[Ciego] Trying Jito single-tx...', JITO_TX_URL);
      const resp = await fetch(JITO_TX_URL + '?bundleOnly=true', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [bs58Encoded] }),
      });
      const json = await resp.json();
      console.log('[Ciego] Jito TX response:', json);
      if (json.result) return json.result;
      if (json.error) console.warn('[Ciego] Jito TX error:', json.error);
    } catch (e) {
      console.warn('[Ciego] Jito single-tx failed, fallback to direct:', e);
    }
    // Fallback: direct send via proxy
    return sendDirect(signedTx);
  }

  async function sendViaJitoBundle(signedTx) {
    const raw = signedTx.serialize();
    const bs58Encoded = encodeBase58(raw);
    try {
      console.log('[Ciego] Trying Jito bundle...', JITO_BUNDLE_URL);
      const resp = await fetch(JITO_BUNDLE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendBundle', params: [[bs58Encoded]] }),
      });
      const json = await resp.json();
      console.log('[Ciego] Jito bundle response:', json);
      if (json.result) return json.result;
      if (json.error) console.warn('[Ciego] Jito bundle error:', json.error);
    } catch(e) {
      console.warn('[Ciego] Jito bundle failed, using single-tx:', e);
    }
    return sendViaJitoTx(signedTx);
  }

  // ===== STEP COUNTER UI =====
  // Privacy report removed — compact result inline
  let stepList = [];
  let currentStepIdx = 0;

  function initStepsUI(steps) {
    stepList = steps;
    currentStepIdx = 0;
    const stepText = $('stepText');
    const stepLabel = $('stepLabel');
    const stepBarFill = $('stepBarFill');
    const stepBar = $('txStepBar');
    const resultCard = $('txResult');
    if (stepBar) stepBar.classList.remove('hidden');
    if (resultCard) resultCard.classList.add('hidden');
    if (stepText) stepText.textContent = '1/' + steps.length;
    if (stepLabel) stepLabel.textContent = steps[0]?.label || 'Starting...';
    if (stepBarFill) stepBarFill.style.width = '0%';
  }

  function advanceStep(hopId, label, detail) {
    const idx = stepList.findIndex(s => s.id === hopId);
    if (idx >= 0) currentStepIdx = idx;
    const stepText = $('stepText');
    const stepLabel = $('stepLabel');
    const stepBarFill = $('stepBarFill');
    const pct = Math.round(((currentStepIdx + 1) / stepList.length) * 100);
    if (stepText) stepText.textContent = (currentStepIdx + 1) + '/' + stepList.length;
    if (stepLabel) stepLabel.textContent = label || stepList[currentStepIdx]?.label || '';
    if (stepBarFill) stepBarFill.style.width = pct + '%';
  }

  function completeAllSteps() {
    const stepBarFill = $('stepBarFill');
    const stepText = $('stepText');
    const stepLabel = $('stepLabel');
    if (stepBarFill) stepBarFill.style.width = '100%';
    if (stepText) stepText.textContent = stepList.length + '/' + stepList.length;
    if (stepLabel) stepLabel.textContent = 'Complete ✓';
  }

  // Privacy report removed — completion is now compact inline

  // ===== MAIN SEND HANDLER =====
  async function handleSend() {
    if (!wallet || !publicKey) return showNotification('Connect wallet first', 'error');

    const recipientStr = recipientInput.value.trim();
    const amount = parseFloat(amountInput.value);

    if (!recipientStr || isNaN(amount) || amount <= 0) {
      return showNotification('Please enter valid recipient and amount', 'error');
    }

    let recipient;
    try { recipient = new PublicKey(recipientStr); } catch (e) {
      return showNotification('Invalid Solana address', 'error');
    }

    sendBtn.disabled = true;
    sendBtn.querySelector('.btn-text').textContent = 'Sending...';
    sendBtn.querySelector('.btn-loader')?.classList.remove('hidden');

    // Hide previous report
    // Reset result UI
    // Reset step counter

    const tok = TOKENS[selectedToken];

    try {
      // ===== ENHANCED / MAXIMUM: Use Privacy Engine =====
      if ((privacyLevel === 'enhanced' || privacyLevel === 'maximum' || privacyLevel === 'maximum-plus') && window.ShadowPrivacy) {

        // Check SOL balance for fees + token swap buffer
        const solBal = balances.SOL || 0;
        const isSPL = selectedToken !== 'SOL';
        const hasSwap = !!window.ShadowPrivacy?.swapEngine;
        const swapBuffer = hasSwap ? 0.025 : 0; // SOL for swap fees/ATAs
        if (privacyLevel === 'maximum' || privacyLevel === 'maximum-plus') {
          // Private pool bridge (+ double bridge for maximum-plus)
          const perWallet = isSPL ? 0.0022 : 0.000891;
          const walletCost = 6 * perWallet;
          const feeCost = isSPL ? 0 : Math.max(amount * 0.01, 0.000891);
          const totalNeeded = isSPL ? walletCost + swapBuffer + 0.003 : amount + walletCost + feeCost + swapBuffer + 0.002;
          if (solBal < totalNeeded) {
            throw new Error('Need ≈' + totalNeeded.toFixed(4) + ' SOL total (includes ' + swapBuffer.toFixed(3) + ' SOL for token swaps). You have ' + solBal.toFixed(4) + ' SOL.');
          }
        } else {
          // Enhanced: 3 hops + token swap
          const perHop = isSPL ? 0.0022 : 0.000006;
          const feesNeeded = 3 * perHop + swapBuffer + (isSPL ? 0.003 : 0);
          if (solBal < (isSPL ? feesNeeded : amount + feesNeeded + 0.002)) {
            throw new Error('Need ≈' + (isSPL ? feesNeeded : amount + feesNeeded + 0.002).toFixed(4) + ' SOL. You have ' + solBal.toFixed(4) + ' SOL.');
          }
        }

        // Setup step counter UI
        if (privacyLevel === 'enhanced') {
          initStepsUI([
            { id: 'hop1', label: 'User → Shadow 1 (only visible link)' },
            { id: 'swap', label: '💱 token swap (break trail)' },
            { id: 'delay', label: '⏱️ Delay' },
            { id: 'hop2', label: 'Shadow 1 → Shadow 2' },
            { id: 'hop3', label: 'Shadow 2 → Shadow 3' },
            { id: 'swap2', label: '💱 Swap back to original' },
            { id: 'final', label: 'Shadow → Recipient' },
          ]);
        } else if (privacyLevel === 'maximum-plus') {
          initStepsUI([
            { id: 'bridge', label: '🔒 Bridge 1 via private pool' },
            { id: 'delay', label: '⏱️ Timing delay' },
            { id: 'bridge2', label: '🔒 Bridge 2 via private pool' },
            { id: 'done', label: '✅ Double bridge complete' },
          ]);
        } else {
          initStepsUI([
            { id: 'hop1', label: 'User → T1 (only visible link)' },
            { id: 'swap', label: '💱 token swap (break trail)' },
            { id: 'hop2', label: 'T1 → T2 + T3 split' },
            { id: 'hop3', label: 'Path A: T2 → T4' },
            { id: 'hop4', label: 'Path B: T3 → T5' },
            { id: 'hop5', label: 'T4 → Collector' },
            { id: 'hop6', label: 'T5 → Collector' },
            { id: 'swap2', label: '💱 Swap back' },
            { id: 'final', label: 'Collector → Recipient' },
            { id: 'cleanup', label: 'Sweep wallets' },
          ]);
        }
        updateStatus('processing', 'Privacy routing...', 'Using ' + privacyLevel + ' mode');

        const onProgress = (hopId, title, detail) => {
          console.log('[Ciego]', hopId, title, detail);
          // Dynamic mode switch: replace step UI when bridge is detected
          if (hopId === 'mode' && title === 'bridge') {
            const isDoubleBridge = privacyLevel === 'maximum-plus';
            const steps = [
              { id: 'bridge', label: `🔒 ${detail || 'Token'} Bridge 1 via private pool` },
              { id: 'check', label: '🔍 Validating bridge' },
              { id: 'estimate', label: '💱 Getting exchange rate' },
              { id: 'bridge1', label: '🔄 Creating exchange(s)' },
              { id: 'ready', label: '✅ Bridge ready' },
              { id: 'delay', label: '⏱️ Timing delay' },
              { id: 'done', label: '🚀 Sent to private pool' },
            ];
            if (isDoubleBridge) {
              steps.push(
                { id: 'bridge2', label: '🔄 Bridge 2 — second private pool hop' },
              );
            }
            initStepsUI(steps);
            return;
          }
          if (hopId === 'mode') return; // ignore other mode signals
          advanceStep(hopId, title, detail);
        };

        const privacyOpts = {
          connection, wallet, publicKey, recipient, amount,
          token: tok, rpcProxy: RPC_PROXY, onProgress,
          doubleBridge: privacyLevel === 'maximum-plus',
        };

        let result;
        if (privacyLevel === 'enhanced') {
          result = await window.ShadowPrivacy.sendEnhanced(privacyOpts);
        } else {
          result = await window.ShadowPrivacy.sendMaximum(privacyOpts);
        }

        completeAllSteps();

        // Bridge mode: show live tracking instead of receipt
        if (result.bridge && result.bridge.exchangeId) {
          const br = result.bridge;
          const bridgeModule = window.ShadowPrivacy?.bridge;
          const bridgeCoin = br.coin?.toUpperCase() || selectedToken;
          const isDoubleBridge = !!(br.doubleBridge && br.bridge2ExchangeIds);
          // For double bridge, show bridge2's estimate if available
          const finalEstimate = isDoubleBridge && br.bridge2?.estimatedReceive
            ? br.bridge2.estimatedReceive
            : br.estimatedReceive;
          const estReceive = finalEstimate ? finalEstimate.toFixed(4) : '?';
          const bridgeFee = finalEstimate ? (amount - finalEstimate).toFixed(4) : '?';
          const bridgeFeePercent = finalEstimate ? ((1 - finalEstimate / amount) * 100).toFixed(1) : '?';
          showReceipt({
            amount: amount,
            token: selectedToken,
            privacy: `Maximum${isDoubleBridge ? '+' : ''} (${bridgeCoin} ${isDoubleBridge ? 'Double ' : ''}Bridge${br.splitMode ? ` × ${br.splitCount}` : ''})`,
            hops: result.signatures?.length || 2,
            signature: result.signatures?.[result.signatures.length - 1] || '',
            bridgeInfo: br.splitMode
              ? `⚡ ${bridgeCoin} Bridge Active — ${br.splitCount} splits in transit...\nExchange IDs: ${br.splits.map(s => s.exchangeId.slice(0,8)).join(', ')}\nEstimated receive: ~${estReceive} ${bridgeCoin} (fee: ${bridgeFee} ${bridgeCoin}, ${bridgeFeePercent}%)\nDelivery: 2-10 min`
              : `⚡ ${bridgeCoin} Bridge Active — tracking delivery...\nExchange ID: ${br.exchangeId}\nEstimated receive: ~${estReceive} ${bridgeCoin} (fee: ${bridgeFee} ${bridgeCoin}, ${bridgeFeePercent}%)\nDelivery: 2-10 min`
          });
          showNotification(isDoubleBridge
            ? `🔒 Double Bridge active — Bridge 2 in transit ⏳`
            : `⚡ ${bridgeCoin} Bridge active — funds in transit ⏳`, 'success');

          // For double bridge, track bridge 2 IDs (bridge 1 already completed inside sendMaximum)
          const allExchangeIds = isDoubleBridge
            ? br.bridge2ExchangeIds
            : (br.splits ? br.splits.map(s => s.exchangeId) : [br.exchangeId]);
          const splitsDone = new Set();
          const splitsFailed = new Set();

          const pollBridge = async () => {
            try {
              if (!bridgeModule) return;
              for (const eid of allExchangeIds) {
                if (splitsDone.has(eid) || splitsFailed.has(eid)) continue;
                try {
                  const st = await bridgeModule.getStatus(eid);
                  if (st.status === 'finished') {
                    splitsDone.add(eid);
                    console.log(`[Bridge] Split ${eid.slice(0,8)} finished ✅ (${splitsDone.size}/${allExchangeIds.length})`);
                  } else if (st.status === 'failed' || st.status === 'refunded') {
                    splitsFailed.add(eid);
                    console.log(`[Bridge] Split ${eid.slice(0,8)} ${st.status} ❌`);
                  } else {
                    console.log(`[Bridge] Split ${eid.slice(0,8)}: ${st.status}`);
                  }
                } catch(e) { console.warn(`[Bridge poll] ${eid.slice(0,8)}:`, e.message); }
              }

              // All done?
              if (splitsDone.size + splitsFailed.size === allExchangeIds.length) {
                if (splitsFailed.size === 0) {
                  showNotification(`✅ Bridge complete! All ${allExchangeIds.length} transfers delivered.`, 'success');
                } else {
                  showNotification(`⚠️ Bridge: ${splitsDone.size} delivered, ${splitsFailed.size} failed`, 'warning');
                }
                // Update receipt to show completion
                const badge = $('receiptBadge');
                if (badge) { badge.textContent = '✅ Complete'; badge.className = 'receipt-badge'; badge.style.background = '#10b981'; }
                const bt = $('bridgeTracker');
                if (bt) { bt.textContent = splitsFailed.size === 0
                  ? `✅ All ${allExchangeIds.length} bridge transfers delivered!\nFunds should now be in the recipient wallet.`
                  : `⚠️ ${splitsDone.size}/${allExchangeIds.length} delivered. ${splitsFailed.size} failed/refunded.`;
                  bt.style.borderColor = splitsFailed.size === 0 ? '#10b981' : '#f59e0b';
                  bt.style.background = splitsFailed.size === 0 ? 'rgba(16,185,129,0.15)' : 'rgba(245,158,11,0.15)';
                }
                try { const rd = JSON.parse(localStorage.getItem('shadowsend_recovery') || '{}'); delete rd.bridge; localStorage.setItem('shadowsend_recovery', JSON.stringify(rd)); } catch(e) {}
                setTimeout(fetchBalances, 3000);
                return;
              }

              // Show progress
              if (splitsDone.size > 0) {
                showNotification(`⏳ Bridge: ${splitsDone.size}/${allExchangeIds.length} splits delivered...`, 'info');
              }
              setTimeout(pollBridge, 20000);
            } catch(e) {
              console.warn('[Bridge poll]', e.message);
              setTimeout(pollBridge, 20000);
            }
          };
          setTimeout(pollBridge, 15000);
        } else {
          const lastSig = result.signatures[result.signatures.length - 1];
          showReceipt({
            amount: amount,
            token: selectedToken,
            privacy: privacyLevel.charAt(0).toUpperCase() + privacyLevel.slice(1),
            hops: result.hops,
            signature: lastSig
          });
          showNotification('Private transfer complete! ✅', 'success');
        }
        setTimeout(fetchBalances, 3000);
        return;
      }

      // ===== STANDARD: Direct send with Jito MEV protection =====
      initStepsUI([
        { id: 's1', label: 'Building transaction...' },
        { id: 's2', label: 'Sign in wallet' },
        { id: 's3', label: 'Broadcasting via Jito' },
        { id: 's4', label: 'Confirming on-chain...' },
      ]);
      updateStatus('processing', 'Building transaction...', 'Standard mode — Jito MEV protection');
      const { tx, blockhash, lastValidBlockHeight } = await buildTransaction(recipient, amount);

      advanceStep('s2', 'Sign in wallet');
      updateStatus('processing', 'Sign in wallet', 'Please approve in your wallet');
      const signedTx = await wallet.signTransaction(tx);

      advanceStep('s3', 'Broadcasting via Jito');
      updateStatus('processing', 'Sending...', 'Broadcasting via Jito');
      let signature = await sendViaJitoTx(signedTx);

      advanceStep('s4', 'Confirming on-chain...');
      updateStatus('processing', 'Confirming...', 'Waiting for on-chain confirmation...');
      if (typeof signature === 'string') {
        for (let attempt = 0; attempt < 45; attempt++) {
          await new Promise(r => setTimeout(r, 1500));
          try {
            const pollResp = await fetch(RPC_PROXY, {
              method: 'POST', headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getSignatureStatuses',
                params: [[signature], { searchTransactionHistory: true }] })
            });
            const pj = await pollResp.json();
            const st = pj?.result?.value?.[0];
            if (st?.err) throw new Error('TX failed: ' + JSON.stringify(st.err));
            if (st?.confirmationStatus === 'confirmed' || st?.confirmationStatus === 'finalized') break;
          } catch (e) { if (e.message.includes('TX failed')) throw e; }
        }
      }

      completeAllSteps();
      showReceipt({
        amount: amount,
        token: selectedToken,
        privacy: 'Standard',
        hops: '1 (direct)',
        signature: typeof signature === 'string' ? signature : null
      });
      showNotification('Transaction confirmed! ✅', 'success');
      setTimeout(fetchBalances, 3000);

    } catch (err) {
      console.error('Send error:', err);
      // Step counter shows error via updateStatus below
      if (err.code === 4001 || err.message?.includes('User rejected')) {
        updateStatus('error', 'Transaction Cancelled', 'You rejected the transaction in your wallet');
      } else if (err.message?.includes('Funds have been recovered')) {
        updateStatus('error', '🔄 Bridge Failed — Funds Recovered', err.message);
        showNotification('Bridge failed but funds were recovered to your wallet ✅', 'info');
      } else if (err.message?.includes('private pool') || err.message?.includes('Check amount') || err.message?.includes('Bridge')) {
        updateStatus('error', '⚠️ Bridge Error', err.message + '\n\nFunds have been recovered to your wallet if they were sent.');
        showNotification('Bridge error: ' + err.message, 'error');
      } else if (err.message?.includes('Amount too low')) {
        updateStatus('error', '⚠️ Amount Too Low', err.message);
        showNotification(err.message, 'error');
      } else {
        updateStatus('error', 'Transaction Failed', err.message || 'Unknown error');
      }
    } finally {
      sendBtn.disabled = false; sendBtn.classList.remove("btn-not-ready");
      const btnText = sendBtn.querySelector('.btn-text');
      const btnLoader = sendBtn.querySelector('.btn-loader');
      if (btnText) btnText.textContent = 'Send Privately';
      if (btnLoader) btnLoader.classList.add('hidden');
      validateForm();
      // Check for recoverable funds after any error
      setTimeout(() => checkRecovery(), 2000);
    }
  }


  // ===== HELPERS =====
  function encodeBase58(bytes) {
    const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
    const result = [];
    for (const byte of bytes) {
      let carry = byte;
      for (let j = 0; j < result.length; j++) {
        carry += result[j] << 8;
        result[j] = carry % 58;
        carry = (carry / 58) | 0;
      }
      while (carry > 0) {
        result.push(carry % 58);
        carry = (carry / 58) | 0;
      }
    }
    for (const byte of bytes) {
      if (byte === 0) result.push(0);
      else break;
    }
    return result.reverse().map(i => ALPHABET[i]).join('');
  }

  function showNotification(message, type = 'info', icon = null) {
    const el = document.createElement('div');
    el.className = 'notification notification-' + type;
    if (icon) {
      const img = document.createElement('img');
      img.src = icon;
      img.className = 'notification-icon';
      el.appendChild(img);
    }
    const txt = document.createElement('span');
    txt.textContent = message;
    el.appendChild(txt);
    document.body.appendChild(el);
    setTimeout(() => el.classList.add('show'), 10);
    setTimeout(() => { el.classList.remove('show'); setTimeout(() => el.remove(), 300); }, 4000);
  }

  function updateStatus(state, title, desc) {
    const stepBar = $('txStepBar');
    const resultCard = $('txResult');

    if (state === 'processing') {
      if (stepBar) stepBar.classList.remove('hidden');
      if (resultCard) resultCard.classList.add('hidden');
      return;
    }

    // Hide step bar
    if (stepBar) stepBar.classList.add('hidden');

    if (state === 'error') {
      showNotification(desc || title, 'error');
      if (resultCard) resultCard.classList.add('hidden');
      return;
    }
    // Success — don't show receipt here, showReceipt() handles it
  }

  function showReceipt(opts) {
    // opts: { amount, token, privacy, hops, signature }
    const wrap = $('txResult');
    if (!wrap) return;

    const tok = TOKENS[opts.token];
    const badge = $('receiptBadge');
    const now = new Date();
    const dateStr = now.toLocaleDateString('en-GB', { day:'2-digit', month:'short', year:'numeric' })
      + ' ' + now.toLocaleTimeString('en-GB', { hour:'2-digit', minute:'2-digit' });

    $('receiptAmount').textContent = opts.amount;
    $('receiptTokenLogo').src = tok?.logo || '';
    $('receiptTokenName').textContent = opts.token;
    $('receiptPrivacy').textContent = opts.privacy;
    $('receiptHops').textContent = opts.hops || '—';
    $('receiptDate').textContent = dateStr;
    if (opts.bridgeInfo) {
      if (badge) { badge.textContent = '⏳ Bridge Active'; badge.className = 'receipt-badge bridge-active'; badge.style.background = '#f59e0b'; }
      // Add bridge info below receipt
      let bridgeEl = $('bridgeTracker');
      if (!bridgeEl) {
        bridgeEl = document.createElement('div');
        bridgeEl.id = 'bridgeTracker';
        bridgeEl.style.cssText = 'margin-top:12px;padding:12px;background:rgba(245,158,11,0.15);border:1px solid #f59e0b;border-radius:8px;font-size:13px;white-space:pre-line;color:#fbbf24;';
      }
      bridgeEl.textContent = opts.bridgeInfo;
      wrap.appendChild(bridgeEl);
    } else {
      if (badge) { badge.textContent = '✅ Complete'; badge.className = 'receipt-badge'; }
      const bt = $('bridgeTracker');
      if (bt) bt.remove();
    }

    const txLink = $('txLink');
    const receiptTxLink = $('receiptTxLink');
    if (opts.signature) {
      const short = opts.signature.slice(0,8) + '...' + opts.signature.slice(-6);
      if (receiptTxLink) {
        receiptTxLink.textContent = short;
        receiptTxLink.href = 'https://solscan.io/tx/' + opts.signature;
      }
      if (txLink) {
        txLink.href = 'https://solscan.io/tx/' + opts.signature;
        txLink.classList.remove('hidden');
      }
    } else {
      if (receiptTxLink) receiptTxLink.textContent = '—';
      if (txLink) txLink.classList.add('hidden');
    }

    wrap.classList.remove('hidden');
  }

  // Receipt: Copy as image to clipboard
  $('receiptCopyBtn')?.addEventListener('click', async () => {
    const card = $('receiptCard');
    if (!card || typeof html2canvas === 'undefined') return showNotification('html2canvas not loaded', 'error');
    try {
      const canvas = await html2canvas(card, { backgroundColor: '#141625', scale: 2 });
      canvas.toBlob(async (blob) => {
        try {
          await navigator.clipboard.write([ new ClipboardItem({ 'image/png': blob }) ]);
          showNotification('Receipt copied to clipboard! 📋', 'success');
        } catch (e) {
          // Fallback: download
          const a = document.createElement('a');
          a.href = canvas.toDataURL('image/png');
          a.download = 'shadowsend-receipt.png';
          a.click();
          showNotification('Downloaded (clipboard blocked in iframe)', 'info');
        }
      }, 'image/png');
    } catch (e) { showNotification('Failed to capture: ' + e.message, 'error'); }
  });

  // Receipt: Download as PNG
  $('receiptDownloadBtn')?.addEventListener('click', async () => {
    const card = $('receiptCard');
    if (!card || typeof html2canvas === 'undefined') return showNotification('html2canvas not loaded', 'error');
    try {
      const canvas = await html2canvas(card, { backgroundColor: '#141625', scale: 2 });
      const a = document.createElement('a');
      a.href = canvas.toDataURL('image/png');
      a.download = 'shadowsend-receipt.png';
      a.click();
      showNotification('Receipt downloaded! 📥', 'success');
    } catch (e) { showNotification('Failed: ' + e.message, 'error'); }
  });

  function isValidSolanaAddress(addr) {
    try { new PublicKey(addr); return addr.length >= 32 && addr.length <= 44; }
    catch { return false; }
  }

  function validateForm() {
    const addr = recipientInput.value.trim();
    const amount = parseFloat(amountInput.value);
    const addrValid = isValidSolanaAddress(addr);
    const amtValid = !isNaN(amount) && amount > 0;
    const valid = addrValid && amtValid;
    const walletOk = !!publicKey;
    const ready = valid && walletOk;
    // Never disable the button — handle states in click handler instead
    sendBtn.disabled = false;
    if (ready) {
      sendBtn.classList.remove('btn-not-ready');
      sendBtn.title = '';
    } else {
      sendBtn.classList.add('btn-not-ready');
      if (!walletOk) sendBtn.title = 'Connect your wallet first';
      else if (!addrValid) sendBtn.title = 'Enter a valid Solana address';
      else sendBtn.title = 'Enter an amount > 0';
    }

    if (addr.length > 0) {
      if (isValidSolanaAddress(addr)) {
        addressHint.textContent = '✓ Valid address';
        addressHint.style.color = 'var(--success)';
      } else {
        addressHint.textContent = '✗ Invalid address';
        addressHint.style.color = 'var(--error)';
      }
    } else {
      addressHint.textContent = '';
    }
  }

  // ===== EVENT LISTENERS =====
  console.log('[Ciego] Registering event listeners...');

  connectBtn.addEventListener('click', () => {
    console.log('[Ciego] Connect btn click event fired');
    connectWallet();
  });
  disconnectBtn.addEventListener('click', disconnectWallet);

  // Wallet modal events
  walletModalClose.addEventListener('click', hideWalletModal);
  document.querySelector('.wallet-modal-backdrop')?.addEventListener('click', hideWalletModal);
  document.querySelectorAll('.wallet-option').forEach(opt => {
    opt.addEventListener('click', () => {
      const wKey = opt.dataset.wallet;
      if (opt.classList.contains('not-installed')) {
        const w = WALLETS[wKey];
        if (w) window.open(w.downloadUrl, '_blank');
        return;
      }
      connectToWallet(wKey);
    });
  });
  sendBtn.addEventListener('click', async () => {
    // If no wallet connected, open wallet modal
    if (!publicKey && !wallet) {
      connectWallet();
      return;
    }
    // If button appears enabled but wallet disconnected, try reconnect
    if (!publicKey && wallet) {
      try {
        const resp = await wallet.connect();
        publicKey = resp.publicKey;
        onWalletConnected();
      } catch(e) { return showNotification('Reconnect wallet first', 'error'); }
    }
    // Validate before sending — show helpful error if not ready
    const addr = recipientInput.value.trim();
    const amount = parseFloat(amountInput.value);
    if (!isValidSolanaAddress(addr)) {
      return showNotification('Enter a valid Solana recipient address', 'error');
    }
    if (isNaN(amount) || amount <= 0) {
      return showNotification('Enter an amount greater than 0', 'error');
    }
    handleSend();
  });

  maxBtn.addEventListener('click', () => {
    const bal = balances[selectedToken] || 0;
    const max = selectedToken === 'SOL' ? Math.max(0, bal - 0.01) : bal;
    amountInput.value = max.toFixed(6);
    validateForm();
  });

  recipientInput.addEventListener('input', validateForm);
  recipientInput.addEventListener('change', validateForm);
  recipientInput.addEventListener('paste', () => setTimeout(validateForm, 50));
  amountInput.addEventListener('input', () => { validateForm(); updateUsdEstimate(); });
  amountInput.addEventListener('change', () => { validateForm(); updateUsdEstimate(); });
  amountInput.addEventListener('paste', () => setTimeout(() => { validateForm(); updateUsdEstimate(); }, 50));
  // Re-validate periodically in case wallet state changed
  setInterval(validateForm, 2000);

  // Token selector — listeners are now attached dynamically in renderTokenSelector()

  // Privacy level selector
  document.querySelectorAll('.privacy-opt').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('.privacy-opt').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      privacyLevel = el.dataset.level;
      console.log('[Ciego] Privacy level:', privacyLevel);
      // Update explainer
      document.querySelectorAll('.explainer-content').forEach(ec => {
        ec.classList.toggle('hidden', ec.dataset.for !== privacyLevel);
      });
    });
  });

  // New transaction button — hide result, reset form
  $('newTxBtn')?.addEventListener('click', () => {
    const resultCard = $('txResult');
    const stepBar = $('txStepBar');
    if (resultCard) resultCard.classList.add('hidden');
    if (stepBar) stepBar.classList.add('hidden');
    recipientInput.value = '';
    amountInput.value = '';
    sendBtn.disabled = false;
    sendBtn.classList.remove('btn-not-ready');
    const btnText = sendBtn.querySelector('.btn-text');
    const btnLoader = sendBtn.querySelector('.btn-loader');
    if (btnText) btnText.textContent = 'Send Privately';
    if (btnLoader) btnLoader.classList.add('hidden');
    if ($('txLink')) $('txLink').classList.add('hidden');
    if ($('usdEstimate')) $('usdEstimate').textContent = '—';
    if ($('sendFeeEstimate')) $('sendFeeEstimate').textContent = '—';
    if ($('sendTotalEstimate')) $('sendTotalEstimate').textContent = '—';
    fetchBalances();
    setTimeout(validateForm, 100);
  });

  // Auto-connect on load — detect which wallet
  window.addEventListener('load', async () => {
    console.log('[Ciego] Window loaded, checking for wallets...');
    // Wait briefly for wallet extensions to inject
    await new Promise(r => setTimeout(r, 500));
    for (const [key, w] of Object.entries(WALLETS)) {
      const provider = w.getProvider();
      if (provider && provider.isConnected && provider.publicKey) {
        wallet = provider;
        publicKey = provider.publicKey;
        connectedWalletType = key;
        onWalletConnected();
        console.log('[Ciego] Auto-connected to', w.name);
        break;
      }
    }

    // Listen for wallet events on all installed providers
    for (const [key, w] of Object.entries(WALLETS)) {
      const provider = w.getProvider();
      if (provider) {
        provider.on?.('disconnect', () => {
          if (connectedWalletType === key) disconnectWallet();
        });
        provider.on?.('accountChanged', (pk) => {
          if (connectedWalletType === key) {
            if (pk) { publicKey = pk; onWalletConnected(); }
            else { disconnectWallet(); }
          }
        });
      }
    }
  });

  // ===== BRIDGE MODE =====

  // Listen for amount changes to update bridge estimate
  amountInput.addEventListener('input', () => {
    if (privacyLevel === 'bridge') updateBridgeEstimate();
  });

  // Bridge start button — full in-app flow via private pool
  const bridgeStartBtn = $('bridgeStartBtn');
  if (bridgeStartBtn) {
    bridgeStartBtn.addEventListener('click', async () => {
      const recipientStr = recipientInput.value.trim();
      const amount = parseFloat(amountInput.value);
      const statusDiv = $('bridgeStatus');

      if (!recipientStr || !amount || amount <= 0) {
        return showNotification('Enter recipient address and amount first', 'error');
      }
      try { new PublicKey(recipientStr); } catch {
        return showNotification('Invalid Solana address', 'error');
      }
      if (!wallet || !publicKey) return showNotification('Connect wallet first', 'error');

      bridgeStartBtn.disabled = true;
      const btnText = bridgeStartBtn.querySelector('.btn-text');
      btnText.textContent = 'Starting...';
      if (statusDiv) { statusDiv.classList.remove('hidden'); statusDiv.innerHTML = ''; }

      const log = (msg, color) => {
        if (!statusDiv) return;
        const p = document.createElement('div');
        p.style.cssText = `padding:6px 0; color:${color || 'rgba(255,255,255,0.8)'}; font-size:0.82rem; border-bottom:1px solid rgba(255,255,255,0.05);`;
        p.innerHTML = msg;
        statusDiv.appendChild(p);
        statusDiv.scrollTop = statusDiv.scrollHeight;
      };

      try {
        // 1. Get estimate & check minimums
        log('🔍 Getting exchange rates...', '#a855f7');
        const est = await ShadowBridge.getEstimate(amount);
        if (amount < (est.minAmount || 0.6)) {
          return showNotification(`Minimum is ${est.minAmount} SOL for bridge mode`, 'error');
        }
        log(`📊 You send <strong>${amount} SOL</strong> → Recipient gets ~<strong>${est.solOut} SOL</strong> (fee ~${est.feePercent}%)`, '#fff');

        // 2. Create Leg 2 first (XMR → SOL to recipient) to get the XMR deposit address
        log('🔗 Creating XMR → SOL exchange (Leg 2)...', '#a855f7');
        btnText.textContent = 'Creating exchanges...';
        const leg2 = await ShadowBridge.createLeg2(est.xmrMiddle, recipientStr);
        const xmrDepositAddr = leg2.depositAddress;
        log(`✅ Leg 2 created — XMR deposit: <code style="color:#22c55e">${xmrDepositAddr.slice(0,12)}...${xmrDepositAddr.slice(-8)}</code>`, '#22c55e');

        // 3. Create Leg 1 (SOL → XMR) pointing XMR output to Leg 2's deposit address
        log('🔗 Creating SOL → XMR exchange (Leg 1)...', '#a855f7');
        const leg1 = await ShadowBridge.createLeg1(amount, xmrDepositAddr);
        const solDepositAddr = leg1.depositAddress;
        log(`✅ Leg 1 created — Send SOL to: <code style="color:#22c55e">${solDepositAddr}</code>`, '#22c55e');

        // 4. Build & sign SOL transfer via Phantom
        log('✍️ <strong>Sign in Phantom: send SOL to private pool deposit address</strong>', '#fbbf24');
        btnText.textContent = 'Sign in Phantom...';

        const bhResult2 = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }], 5);
        const blockhash2 = bhResult2.value.blockhash;
        const tx = new Transaction();
        tx.add(SystemProgram.transfer({
          fromPubkey: publicKey,
          toPubkey: new PublicKey(solDepositAddr),
          lamports: Math.round(amount * LAMPORTS_PER_SOL),
        }));
        tx.recentBlockhash = blockhash2;
        tx.feePayer = publicKey;

        const signed = await wallet.signTransaction(tx);
        const rawTx = signed.serialize();

        log('📤 Broadcasting SOL transaction...', '#a855f7');
        btnText.textContent = 'Broadcasting...';

        // Use resilient rpcCall for bridge TX send
        const rawB58 = encodeBase58(rawTx);
        const sigResult = await rpcCall('sendTransaction', [rawB58, { encoding: 'base58', skipPreflight: true, maxRetries: 5 }], 4);
        const sig = sigResult;
        log(`✅ SOL sent! Tx: <a href="https://solscan.io/tx/${sig}" target="_blank" style="color:#22c55e">${sig.slice(0,12)}...</a>`, '#22c55e');

        // 5. Wait for Leg 1 to process
        log('⏳ Waiting for private pool to process SOL & convert to XMR... (this takes 5-20 min)', '#fbbf24');
        btnText.textContent = 'Converting SOL → XMR...';

        await ShadowBridge.waitForStatus(leg1.id, ['success', 'sending'], (s) => {
          const statusMap = { wait: '⏳ Waiting for deposit...', confirmation: '🔄 Confirming SOL deposit...', confirmed: '🔄 SOL confirmed, exchanging...', exchanging: '🔄 Converting to XMR...', sending: '📤 Sending XMR to Leg 2...', success: '✅ Leg 1 complete!' };
          btnText.textContent = statusMap[s.status] || s.status;
        });
        log('✅ <strong>Leg 1 complete</strong> — SOL converted to XMR', '#22c55e');

        // 6. Wait for Leg 2 to process
        log('⏳ Waiting for XMR → SOL conversion... (this takes 5-20 min)', '#fbbf24');
        btnText.textContent = 'Converting XMR → SOL...';

        const finalStatus = await ShadowBridge.waitForStatus(leg2.id, ['success'], (s) => {
          const statusMap = { wait: '⏳ Waiting for XMR deposit...', confirmation: '🔄 Confirming XMR...', confirmed: '🔄 XMR confirmed, exchanging...', exchanging: '🔄 Converting to SOL...', sending: '📤 Sending SOL to recipient...', success: '✅ Done!' };
          btnText.textContent = statusMap[s.status] || s.status;
        });

        // 7. Final success
        const outHash = finalStatus.hashOut?.link || finalStatus.hashOut?.hash || '';
        log(`<div style="padding:12px;background:rgba(34,197,94,0.15);border:1px solid rgba(34,197,94,0.3);border-radius:8px;margin-top:8px;">
          <strong style="color:#22c55e;font-size:1rem;">🌑 Untraceable Transfer Complete!</strong><br>
          <span style="color:rgba(255,255,255,0.7);font-size:0.8rem;">
            Sent: ${amount} SOL → Monero → ${est.solOut} SOL<br>
            Recipient: ${recipientStr.slice(0,6)}...${recipientStr.slice(-4)}<br>
            ${outHash ? 'Output tx: <a href="' + outHash + '" target="_blank" style="color:#22c55e">' + outHash.split('/').pop()?.slice(0,16) + '...</a><br>' : ''}
            Leg 1 ID: ${leg1.id} | Leg 2 ID: ${leg2.id}<br>
            <strong>Zero on-chain link between your wallet and the recipient.</strong>
          </span>
        </div>`, '#22c55e');

        showNotification('🌑 Untraceable transfer complete!', 'success');
        btnText.textContent = '✅ Complete!';
        refreshBalances();

      } catch (err) {
        console.error('[ShadowBridge] Error:', err);
        if (err.code === 4001 || err.message?.includes('User rejected')) {
          log('❌ Transaction cancelled by user', '#ef4444');
          showNotification('Transaction cancelled', 'error');
        } else {
          log('❌ Error: ' + err.message, '#ef4444');
          showNotification('Bridge error: ' + err.message, 'error');
        }
      } finally {
        bridgeStartBtn.disabled = false;
        btnText.textContent = 'Start Bridge';
      }
    });
  }

  // ===== MODE TABS (Private Send vs Bridge vs Batch) =====
  const modeTabs = document.querySelectorAll('.mode-tab');
  const sendPage = $('txForm');
  const bridgePage = $('bridgeMode');
  const batchPage = $('batchMode');

  modeTabs.forEach(tab => {
    tab.addEventListener('click', () => {
      modeTabs.forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      const mode = tab.dataset.mode;
      // Hide all pages
      if (sendPage) sendPage.classList.add('hidden');
      if (bridgePage) bridgePage.classList.add('hidden');
      if (batchPage) batchPage.classList.add('hidden');
      // Show selected
      if (mode === 'bridge') {
        if (bridgePage) bridgePage.classList.remove('hidden');
        const bridgeAvail = $('bridgeAvailableBalance');
        if (bridgeAvail) bridgeAvail.textContent = (balances.SOL || 0).toFixed(4);
      } else if (mode === 'batch') {
        if (batchPage) batchPage.classList.remove('hidden');
        renderBatchTokenSelector();
        updateBatchSummary();
      } else {
        if (sendPage) sendPage.classList.remove('hidden');
      }
      // Hide result/step when switching tabs
      if ($('txStepBar')) $('txStepBar').classList.add('hidden');
      if ($('txResult')) $('txResult').classList.add('hidden');
    });
  });

  // Bridge-specific inputs
  const bridgeAmountInput = $('bridgeAmountInput');
  const bridgeRecipientInput = $('bridgeRecipientInput');
  const bridgeMaxBtn = $('bridgeMaxBtn');
  const bridgeDestSelect = $('bridgeDestNetwork');

  // ===== BRIDGE CHAIN TABS + TOKEN GRID =====
  const CHAIN_TOKENS = {
    eth: [
      { value: 'eth', label: 'ETH', sub: 'Ethereum', logo: 'eth-logo.png' },
      { value: 'usdc', label: 'USDC', sub: 'ERC-20', logo: 'usdc-logo.webp' },
      { value: 'usdt', label: 'USDT', sub: 'ERC-20', logo: 'usdt-logo.jpg' }
    ],
    bnb: [
      { value: 'bsc', label: 'BNB', sub: 'BSC', logo: 'bnb-logo.png' }
    ],
    base: [
      { value: 'base', label: 'ETH', sub: 'Base', logo: 'base-logo.png' }
    ],
    poly: [
      { value: 'matic', label: 'MATIC', sub: 'Polygon', logo: 'matic-logo.png' }
    ],
    arb: [
      { value: 'arb', label: 'ETH', sub: 'Arbitrum', logo: 'arb-logo.png' }
    ],
    btc: [
      { value: 'btc', label: 'BTC', sub: 'Bitcoin', logo: 'btc-logo.png' }
    ],
    sol: [
      { value: 'sol', label: 'SOL', sub: 'Solana', logo: 'sol-logo.png' }
    ],
    ltc: [
      { value: 'ltc', label: 'LTC', sub: 'Litecoin', logo: 'ltc-logo.png' }
    ]
  };

  let activeChainTab = 'eth';

  function renderChainTokens(chain) {
    const container = $('chainTokens');
    if (!container) return;
    const tokens = CHAIN_TOKENS[chain] || [];
    container.innerHTML = tokens.map((t, i) => `
      <button class="chain-token-btn${i === 0 ? ' active' : ''}" data-value="${t.value}">
        <img src="${t.logo}" class="chain-token-logo" alt="${t.label}">
        <div>
          <div class="chain-token-name">${t.label}</div>
          <div class="chain-token-sub">${t.sub}</div>
        </div>
      </button>
    `).join('');

    // Select first token by default
    if (tokens.length && bridgeDestSelect) {
      bridgeDestSelect.value = tokens[0].value;
      bridgeDestSelect.dispatchEvent(new Event('change'));
    }

    // Token button clicks
    container.querySelectorAll('.chain-token-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        container.querySelectorAll('.chain-token-btn').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        if (bridgeDestSelect) {
          bridgeDestSelect.value = btn.dataset.value;
          bridgeDestSelect.dispatchEvent(new Event('change'));
        }
      });
    });
  }

  // Chain tab clicks
  document.querySelectorAll('.chain-tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.chain-tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      activeChainTab = tab.dataset.chain;
      renderChainTokens(activeChainTab);
    });
  });

  // Init first chain
  renderChainTokens('eth');

  if (bridgeMaxBtn) {
    bridgeMaxBtn.addEventListener('click', () => {
      const max = Math.max(0, (balances.SOL || 0) - 0.05);
      if (bridgeAmountInput) bridgeAmountInput.value = max.toFixed(6);
      updateBridgeEstimate();
    });
  }
  if (bridgeAmountInput) {
    bridgeAmountInput.addEventListener('input', updateBridgeEstimate);
  }
  function getSelectedDest() {
    const val = bridgeDestSelect?.value || 'SOL|SOL';
    const [coin, network] = val.split('|');
    const opt = bridgeDestSelect?.selectedOptions?.[0];
    return { coin, network, chain: opt?.dataset?.chain || network, placeholder: opt?.dataset?.placeholder || '', regex: opt?.dataset?.regex || '' };
  }

  function updateBridgeUI() {
    const dest = getSelectedDest();
    // Update recipient placeholder + hint + clear validation
    if (bridgeRecipientInput) {
      bridgeRecipientInput.placeholder = dest.placeholder;
      bridgeRecipientInput.classList.remove('addr-valid', 'addr-invalid');
      bridgeRecipientInput.value = '';
    }
    const addrHint = $('bridgeAddrHint');
    if (addrHint) {
      addrHint.textContent = 'Paste your ' + dest.chain + ' wallet address to receive ' + dest.coin;
    }
    // Update flow visual — badges + labels
    const destBadge = $('flowDestBadge');
    const destFlowLabel = $('flowDestLabel');
    const destLabel = $('bridgeDestLabel');
    if (destBadge) {
      destBadge.textContent = dest.coin;
      destBadge.className = 'flow-badge flow-dest';
      const badgeClass = { SOL: 'chain-sol', ETH: 'chain-eth', BTC: 'chain-btc', LTC: 'chain-ltc', USDT: 'chain-usdt', USDC: 'chain-usdc' };
      const coinKey = dest.coin;
      if (badgeClass[coinKey]) destBadge.classList.add(badgeClass[coinKey]);
      else destBadge.classList.add('chain-eth'); // default for unknown
    }
    if (destFlowLabel) {
      // Show chain name (e.g. "Ethereum", "Arbitrum", "Bitcoin")
      destFlowLabel.textContent = dest.chain;
    }
    if (destLabel) destLabel.textContent = dest.coin + ' on ' + dest.chain;
    // Update estimate
    updateBridgeEstimate();
  }

  if (bridgeDestSelect) {
    bridgeDestSelect.addEventListener('change', updateBridgeUI);
    // Run once on init to set correct state
    updateBridgeUI();
  }

  // Validate bridge recipient address based on selected network
  if (bridgeRecipientInput) {
    bridgeRecipientInput.addEventListener('input', () => {
      const dest = getSelectedDest();
      const addr = bridgeRecipientInput.value.trim();
      if (!addr) {
        bridgeRecipientInput.classList.remove('addr-valid', 'addr-invalid');
        return;
      }
      try {
        const valid = new RegExp(dest.regex).test(addr);
        bridgeRecipientInput.classList.toggle('addr-valid', valid);
        bridgeRecipientInput.classList.toggle('addr-invalid', !valid);
      } catch(e) {
        bridgeRecipientInput.classList.remove('addr-valid', 'addr-invalid');
      }
    });
  }

  // Bridge estimate using bridge-specific inputs + destination
  async function updateBridgeEstimate() {
    const amount = parseFloat(bridgeAmountInput?.value || amountInput?.value);
    const bridgeSend = $('bridgeSendAmount');
    const bridgeRecv = $('bridgeReceiveAmount');
    const bridgeFee = $('bridgeFee');
    const dest = getSelectedDest();
    if (!amount || amount <= 0) {
      if (bridgeSend) bridgeSend.textContent = '— SOL';
      if (bridgeRecv) bridgeRecv.textContent = '—';
      return;
    }
    if (bridgeSend) bridgeSend.textContent = amount + ' SOL';
    try {
      const est = await ShadowBridge.estimate(amount, dest.coin, dest.network);
      if (bridgeRecv) bridgeRecv.textContent = '~' + est.finalAmount.toFixed(6) + ' ' + dest.coin;
      // Fee calculation makes sense only for same-denom (SOL→SOL)
      if (dest.coin === 'SOL') {
        if (bridgeFee) bridgeFee.textContent = '~' + ((1 - est.finalAmount / amount) * 100).toFixed(1) + '%';
      } else {
        if (bridgeFee) bridgeFee.textContent = 'Included in rate';
      }
    } catch (e) { if (bridgeRecv) bridgeRecv.textContent = 'Error estimating'; }
  }

  // Override bridge start button to use bridge-specific inputs
  if (bridgeStartBtn) {
    // Remove old listener by replacing node
    const newBtn = bridgeStartBtn.cloneNode(true);
    bridgeStartBtn.parentNode.replaceChild(newBtn, bridgeStartBtn);

    newBtn.addEventListener('click', async () => {
      const recipient = (bridgeRecipientInput?.value || recipientInput?.value || '').trim();
      const amount = parseFloat(bridgeAmountInput?.value || amountInput?.value);

      const dest = getSelectedDest();
      if (!wallet || !publicKey) return showNotification('Connect wallet first', 'error');
      // Validate address format for selected network
      if (!recipient) return showNotification('Enter recipient address', 'error');
      try {
        if (!new RegExp(dest.regex).test(recipient)) return showNotification('Invalid address for ' + dest.network + ' network', 'error');
      } catch(e) {}
      if (!amount || amount < 0.5) return showNotification('Minimum 0.6 SOL for bridge', 'error');

      newBtn.disabled = true;
      const btnText = newBtn.querySelector('.btn-text');
      if (btnText) btnText.textContent = '⏳ Processing...';

      try {
        await ShadowBridge.execute(connection, wallet, publicKey, recipient, amount, dest.coin, dest.network, (msg, color) => {
          const statusDiv = $('bridgeStatus');
          if (statusDiv) {
            statusDiv.classList.remove('hidden');
            const line = document.createElement('div');
            line.style.color = color || '#fff';
            line.textContent = msg;
            statusDiv.appendChild(line);
            statusDiv.scrollTop = statusDiv.scrollHeight;
          }
        }, () => fetchBalances());
      } catch (err) {
        console.error('[ShadowBridge] Error:', err);
        showNotification('Bridge error: ' + err.message, 'error');
      } finally {
        newBtn.disabled = false;
        if (btnText) btnText.textContent = '🌉 Start Bridge Transfer';
      }
    });
  }

  // ===== RECOVERY SYSTEM =====
  const recoveryBanner = $('recoveryBanner');
  const recoverBtn = $('recoverBtn');
  const recoveryInfo = $('recoveryInfo');
  const recoveryLog = $('recoveryLog');

  // Resilient RPC call — retries on 502/network errors/HTML responses
  async function rpcCall(method, params, retries = 5) {
    for (let i = 0; i < retries; i++) {
      try {
        const resp = await fetch(RPC_PROXY, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params })
        });
        if (!resp.ok) {
          console.warn(`[rpcCall] ${method} attempt ${i+1}/${retries}: HTTP ${resp.status}`);
          if (i < retries - 1) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
          throw new Error('RPC ' + resp.status);
        }
        const text = await resp.text();
        // Detect HTML responses (proxy error pages)
        if (text.startsWith('<!') || text.startsWith('<html')) {
          console.warn(`[rpcCall] ${method} attempt ${i+1}/${retries}: got HTML instead of JSON`);
          if (i < retries - 1) { await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue; }
          throw new Error('RPC returned HTML (proxy error)');
        }
        const j = JSON.parse(text);
        if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
        return j.result;
      } catch(e) {
        if (i < retries - 1 && !e.message.includes('TX failed') && !e.message.includes('insufficient')) {
          console.warn(`[rpcCall] ${method} attempt ${i+1}/${retries}: ${e.message}`);
          await new Promise(r => setTimeout(r, 1500 * (i + 1))); continue;
        }
        throw e;
      }
    }
  }

  async function safeGetBalance(pubkeyStr) {
    const result = await rpcCall('getBalance', [pubkeyStr, { commitment: 'confirmed' }]);
    return result?.value || 0;
  }

  async function safeGetTokenBalance(ataStr) {
    try {
      const result = await rpcCall('getTokenAccountBalance', [ataStr, { commitment: 'confirmed' }]);
      return parseInt(result?.value?.amount || '0');
    } catch(e) {
      // ATA doesn't exist = 0 tokens (not an error worth logging)
      return 0;
    }
  }

  async function checkRecovery() {
    if (!recoveryBanner || !publicKey) return;
    try {
      const raw = localStorage.getItem('shadowsend_recovery');
      if (!raw) { recoveryBanner.classList.add('hidden'); return; }
      const data = JSON.parse(raw);
      // Validate recovery data structure
      if (!data || !Array.isArray(data.wallets) || data.wallets.length === 0) {
        console.warn('[Recovery] Invalid recovery data, clearing');
        localStorage.removeItem('shadowsend_recovery');
        recoveryBanner.classList.add('hidden');
        return;
      }
      // Check SOL balances (using resilient RPC)
      let totalLamports = 0;
      for (const w of data.wallets) {
        try {
          const bal = await safeGetBalance(w.pub);
          totalLamports += bal;
        } catch(e) { console.warn('[Recovery] balance check failed for ' + w.pub.slice(0,8) + ':', e.message); }
      }
      // Check SPL token balances if token info is saved
      let totalTokens = 0;
      const tokenInfo = data.token;
      if (tokenInfo && tokenInfo.mint && tokenInfo.mint !== 'native') {
        const mintPub = new solanaWeb3.PublicKey(tokenInfo.mint);
        const ATA_PROG = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        for (const w of data.wallets) {
          try {
            const ownerPub = new solanaWeb3.PublicKey(w.pub);
            const [ata] = solanaWeb3.PublicKey.findProgramAddressSync(
              [ownerPub.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mintPub.toBuffer()], ATA_PROG);
            const tokAmt = await safeGetTokenBalance(ata.toBase58());
            totalTokens += tokAmt;
          } catch(e) {} // ATA doesn't exist = no tokens
        }
      }
      // Check for active bridge exchanges
      let bridgeActive = false;
      let bridgeMsg = '';
      const bridgeId = data.bridge?.exchangeId || data.bridge?.entryId;
      if (data.bridge && bridgeId) {
        try {
          const bridge = window.ShadowPrivacy?.bridge;
          if (bridge) {
            const status = await bridge.getStatus(bridgeId);
            const st = status.status || 'unknown';
            
            if (['waiting', 'confirming', 'exchanging', 'sending'].includes(st)) {
              bridgeActive = true;
              bridgeMsg = `⏳ SOL Bridge active! Status: ${st}. ` +
                `Estimated: 2-5 min. ID: ${bridgeId.slice(0,10)}...`;
            } else if (st === 'finished') {
              delete data.bridge;
              localStorage.setItem('shadowsend_recovery', JSON.stringify(data));
            } else if (st === 'failed' || st === 'refunded') {
              bridgeMsg = `⚠️ Bridge ${st}. Check bridge ID: ${bridgeId}. ` +
                `If refunded, funds return to shadow wallet → use Recover button.`;
            }
          }
        } catch(e) { console.warn('[Recovery] Bridge status check failed:', e); }
      }

      const hasSOL = totalLamports > 5000;
      const hasTokens = totalTokens > 0;
      if (hasSOL || hasTokens || bridgeActive) {
        recoveryBanner.classList.remove('hidden');
        const mrc = $('manualRecoveryCheck');
        if (mrc) mrc.classList.add('hidden');
        const age = Math.round((Date.now() - data.timestamp) / 60000);
        let msg = '';
        if (bridgeActive) {
          msg = bridgeMsg;
        } else if (bridgeMsg) {
          msg = bridgeMsg + ' ';
        }
        if (hasTokens && tokenInfo) {
          const dec = tokenInfo.decimals || 6;
          msg += `${(totalTokens / Math.pow(10, dec)).toFixed(4)} ${tokenInfo.symbol}`;
        }
        if (hasSOL) {
          msg += (msg ? ' + ' : '') + `${(totalLamports / 1e9).toFixed(6)} SOL`;
        }
        if (!bridgeActive && (hasSOL || hasTokens)) {
          msg += ` in ${data.wallets.length} shadow wallet${data.wallets.length > 1 ? 's' : ''} (${age} min ago). Click to recover.`;
        }
        recoveryInfo.textContent = msg;
        // If bridge is active, disable recover button (funds are in transit)
        if (recoverBtn) recoverBtn.disabled = bridgeActive;
      } else {
        recoveryBanner.classList.add('hidden');
        localStorage.removeItem('shadowsend_recovery');
      }
    } catch(e) { console.warn('[Recovery]', e); }
  }

  if (recoverBtn) {
    recoverBtn.addEventListener('click', async () => {
      if (!publicKey) return showNotification('Connect wallet first', 'error');
      recoverBtn.disabled = true;
      recoverBtn.querySelector('.btn-text').textContent = '🔄 Recovering...';
      recoveryLog.style.display = 'block';
      recoveryLog.innerHTML = '';
      const log = (msg) => { recoveryLog.innerHTML += msg + '<br>'; };
      try {
        const data = JSON.parse(localStorage.getItem('shadowsend_recovery'));
        const tokenInfo = data.token;
        const hasSPL = tokenInfo && tokenInfo.mint && tokenInfo.mint !== 'native';
        const mintPub = hasSPL ? new solanaWeb3.PublicKey(tokenInfo.mint) : null;
        const ATA_PROG = new solanaWeb3.PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        let recovered = 0;
        let recoveredTokens = 0;

        // Helper: get ATA address
        const getATA = (mint, owner) => solanaWeb3.PublicKey.findProgramAddressSync(
          [owner.toBuffer(), TOKEN_PROGRAM_ID.toBuffer(), mint.toBuffer()], ATA_PROG)[0];

        // Helper: build + send + confirm TX via RPC proxy (resilient to 502s)
        const sendSweepTx = async (kp, ixs) => {
          for (let attempt = 0; attempt < 3; attempt++) {
            const bhResult = await rpcCall('getLatestBlockhash', [{ commitment: 'confirmed' }]);
            const bh = { blockhash: bhResult.value.blockhash };
            const msg = new solanaWeb3.TransactionMessage({
              payerKey: kp.publicKey, recentBlockhash: bh.blockhash, instructions: ixs
            }).compileToV0Message();
            const tx = new solanaWeb3.VersionedTransaction(msg);
            tx.sign([kp]);
            const raw = encodeBase58(tx.serialize());

            // Send via proxy RPC with fetch retry
            let sig;
            for (let s = 0; s < 4; s++) {
              try {
                const resp = await fetch(RPC_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sendTransaction', params: [raw, { skipPreflight: true, maxRetries: 5 }] })
                });
                if (!resp.ok) { await new Promise(r => setTimeout(r, 1500 * (s + 1))); continue; }
                const j = await resp.json();
                if (j.error) throw new Error('RPC error: ' + (j.error.message || JSON.stringify(j.error)));
                sig = j.result;
                break;
              } catch(fe) {
                if (s >= 3) throw fe;
                await new Promise(r => setTimeout(r, 1500 * (s + 1)));
              }
            }
            if (!sig) throw new Error('Failed to send TX after 4 attempts');

            // Poll for confirmation
            const start = Date.now();
            while (Date.now() - start < 45000) {
              await new Promise(r => setTimeout(r, 1500));
              try {
                const stResult = await rpcCall('getSignatureStatuses', [[sig]]);
                const sv = stResult?.value?.[0];
                if (sv?.confirmationStatus === 'confirmed' || sv?.confirmationStatus === 'finalized') return sig;
                if (sv?.err) throw new Error('TX failed: ' + JSON.stringify(sv.err));
              } catch(e) { if (e.message.includes('TX failed')) throw e; }
            }
            // Blockhash may have expired — retry with fresh one
            if (attempt < 2) { log(`⚠️ TX timeout, retrying with fresh blockhash...`); continue; }
            throw new Error('TX not confirmed after 45s. Sig: ' + sig);
          }
        };

        for (let i = 0; i < data.wallets.length; i++) {
          const w = data.wallets[i];
          const kp = solanaWeb3.Keypair.fromSecretKey(new Uint8Array(w.secret));

          // 1. Recover SPL tokens first (if any)
          if (hasSPL) {
            try {
              const srcATA = getATA(mintPub, kp.publicKey);
              const tokenAmt = await safeGetTokenBalance(srcATA.toBase58());
              if (tokenAmt > 0) {
                const dec = tokenInfo.decimals || 6;
                log(`Shadow ${i + 1}: ${(tokenAmt / Math.pow(10, dec)).toFixed(4)} ${tokenInfo.symbol} — recovering tokens...`);
                // Ensure user has ATA (idempotent create)
                const destATA = getATA(mintPub, publicKey);
                const tIx = [];
                // Idempotent create dest ATA (byte 1)
                const SYSVAR_RENT = new solanaWeb3.PublicKey('SysvarRent111111111111111111111111111111111');
                tIx.push(new solanaWeb3.TransactionInstruction({
                  keys: [
                    { pubkey: kp.publicKey, isSigner: true, isWritable: true },
                    { pubkey: destATA, isSigner: false, isWritable: true },
                    { pubkey: publicKey, isSigner: false, isWritable: false },
                    { pubkey: mintPub, isSigner: false, isWritable: false },
                    { pubkey: solanaWeb3.SystemProgram.programId, isSigner: false, isWritable: false },
                    { pubkey: TOKEN_PROGRAM_ID, isSigner: false, isWritable: false },
                    { pubkey: SYSVAR_RENT, isSigner: false, isWritable: false },
                  ],
                  programId: ATA_PROG, data: new Uint8Array([1]),
                }));
                // Transfer all tokens
                const tData = new Uint8Array(9); tData[0] = 3;
                new DataView(tData.buffer).setBigUint64(1, BigInt(tokenAmt), true);
                tIx.push(new solanaWeb3.TransactionInstruction({
                  keys: [
                    { pubkey: srcATA, isSigner: false, isWritable: true },
                    { pubkey: destATA, isSigner: false, isWritable: true },
                    { pubkey: kp.publicKey, isSigner: true, isWritable: false },
                  ],
                  programId: TOKEN_PROGRAM_ID, data: tData,
                }));
                // Close source ATA → recover rent to shadow wallet
                tIx.push(new solanaWeb3.TransactionInstruction({
                  keys: [
                    { pubkey: srcATA, isSigner: false, isWritable: true },
                    { pubkey: kp.publicKey, isSigner: false, isWritable: true },
                    { pubkey: kp.publicKey, isSigner: true, isWritable: false },
                  ],
                  programId: TOKEN_PROGRAM_ID, data: new Uint8Array([9]),
                }));
                const sig = await sendSweepTx(kp, tIx);
                recoveredTokens += tokenAmt;
                log(`✅ Shadow ${i + 1}: recovered ${(tokenAmt / Math.pow(10, dec)).toFixed(4)} ${tokenInfo.symbol} (tx: ${sig.slice(0, 12)}...)`);
                await new Promise(r => setTimeout(r, 1500)); // wait for balance update
              }
            } catch(e) {
              log(`⚠️ Shadow ${i + 1}: token recovery: ${e.message}`);
            }
          }

          // 2. Recover SOL
          const bal = await safeGetBalance(kp.publicKey.toBase58());
          if (bal > 5000) {
            log(`Shadow ${i + 1}: ${(bal / 1e9).toFixed(6)} SOL — sweeping...`);
            try {
              const sweepAmt = bal - 5000;
              const ix = [
                solanaWeb3.SystemProgram.transfer({
                  fromPubkey: kp.publicKey,
                  toPubkey: publicKey,
                  lamports: sweepAmt,
                })
              ];
              const sig = await sendSweepTx(kp, ix);

              recovered += sweepAmt;
              log(`✅ Shadow ${i + 1}: recovered ${(sweepAmt / 1e9).toFixed(6)} SOL (tx: ${sig.slice(0, 12)}...)`);
            } catch(e) {
              log(`❌ Shadow ${i + 1}: ${e.message}`);
            }
          } else {
            log(`Shadow ${i + 1}: empty (${bal} lamports)`);
          }
        }
        const hasAnything = recovered > 0 || recoveredTokens > 0;
        if (hasAnything) {
          let msg = '';
          if (recoveredTokens > 0 && tokenInfo) {
            const dec = tokenInfo.decimals || 6;
            msg += `${(recoveredTokens / Math.pow(10, dec)).toFixed(4)} ${tokenInfo.symbol}`;
          }
          if (recovered > 0) {
            msg += (msg ? ' + ' : '') + `${(recovered / 1e9).toFixed(6)} SOL`;
          }
          log(`<br><strong>✅ Total recovered: ${msg}</strong>`);
          showNotification(`Recovered ${msg}!`, 'success');
          localStorage.removeItem('shadowsend_recovery');
          setTimeout(() => { recoveryBanner.classList.add('hidden'); fetchBalances(); }, 3000);
        } else {
          log('<br>No funds found to recover.');
          localStorage.removeItem('shadowsend_recovery');
        }
      } catch(e) {
        log(`❌ Error: ${e.message}`);
        showNotification('Recovery failed: ' + e.message, 'error');
      } finally {
        recoverBtn.disabled = false;
        recoverBtn.querySelector('.btn-text').textContent = '🔄 Recover Funds';
      }
    });
  }

  // Dismiss button — clears recovery data
  const recoverDismissBtn = $('recoverDismissBtn');
  if (recoverDismissBtn) {
    recoverDismissBtn.addEventListener('click', () => {
      localStorage.removeItem('shadowsend_recovery');
      if (recoveryBanner) recoveryBanner.classList.add('hidden');
      showNotification('Recovery data cleared', 'info');
    });
  }

  // Manual recovery check button
  const manualRecoverBtn = $('manualRecoverBtn');
  if (manualRecoverBtn) {
    manualRecoverBtn.addEventListener('click', async () => {
      if (!publicKey) return showNotification('Conecta wallet primero', 'error');
      manualRecoverBtn.disabled = true;
      manualRecoverBtn.textContent = '🔍 Buscando...';
      try {
        // First check localStorage
        const raw = localStorage.getItem('shadowsend_recovery');
        if (raw) {
          await checkRecovery();
          const banner = $('recoveryBanner');
          if (banner && !banner.classList.contains('hidden')) {
            showNotification('✅ Recoverable funds found!', 'success');
          } else {
            showNotification('No stuck funds found', 'info');
          }
        } else {
          showNotification('No recovery data found in this browser', 'info');
        }
      } catch(e) {
        showNotification('Error checking: ' + e.message, 'error');
      } finally {
        manualRecoverBtn.disabled = false;
        manualRecoverBtn.textContent = '🔍 Check for stuck funds';
      }
    });
  }

  // Run recovery check after balances load
  setTimeout(() => { if (publicKey) checkRecovery(); }, 3000);

  // ===== BATCH SEND =====
  let batchToken = 'SOL';
  let batchPrivacy = 'enhanced';
  let batchRows = [];

  function renderBatchTokenSelector() {
    const container = $('batchTokenSelect');
    if (!container) return;
    const NAMES = { SOL: 'Solana', USDC: 'USD Coin', USDT: 'Tether', USD1: 'USD1 (WLFI)' };
    const entries = Object.entries(TOKENS)
      .map(([sym, tok]) => ({ sym, tok, bal: balances[sym] || 0 }))
      .sort((a, b) => b.bal - a.bal); // Show ALL tokens

    const selTok = TOKENS[batchToken];
    container.innerHTML =
      '<div class="tk-trigger" id="batchTkTrigger">'
      + '<img class="tk-logo" src="' + selTok.logo + '" alt="' + batchToken + '" onerror="this.style.display=\'none\'">'
      + '<span class="tk-name">' + batchToken + '</span>'
      + '<svg class="tk-chevron" width="12" height="12" viewBox="0 0 12 12"><path d="M3 4.5L6 7.5L9 4.5" stroke="currentColor" stroke-width="1.5" fill="none"/></svg>'
      + '</div>'
      + '<div class="tk-cloud" id="batchTkCloud">'
      + entries.map(e => {
          const active = e.sym === batchToken ? ' active' : '';
          const balStr = e.bal > 0 ? e.bal.toFixed(e.tok.decimals > 6 ? 4 : 2) : '0';
          return '<div class="tk-item' + active + '" data-token="' + e.sym + '">'
            + '<img class="tk-item-logo" src="' + e.tok.logo + '" alt="' + e.sym + '">'
            + '<div class="tk-item-info"><span class="tk-item-name">' + e.sym + '</span><span class="tk-item-full">' + (NAMES[e.sym] || e.sym) + '</span></div>'
            + '<span class="tk-item-bal">' + balStr + '</span></div>';
        }).join('')
      + '</div>';

    const trigger = container.querySelector('#batchTkTrigger');
    const cloud = container.querySelector('#batchTkCloud');
    trigger.addEventListener('click', (e) => { e.stopPropagation(); cloud.classList.toggle('show'); });
    container.querySelectorAll('.tk-item').forEach(el => {
      el.addEventListener('click', (e) => {
        e.stopPropagation();
        batchToken = el.dataset.token;
        cloud.classList.remove('show');
        renderBatchTokenSelector();
        updateBatchSummary();
      });
    });
    document.addEventListener('click', () => cloud.classList.remove('show'));
  }

  // Batch privacy selector
  document.querySelectorAll('#batchPrivacyOptions .privacy-opt').forEach(el => {
    el.addEventListener('click', () => {
      document.querySelectorAll('#batchPrivacyOptions .privacy-opt').forEach(e => e.classList.remove('active'));
      el.classList.add('active');
      batchPrivacy = el.dataset.level;
    });
  });

  function renumberBatchRows() {
    document.querySelectorAll('.batch-row').forEach((row, i) => {
      const num = row.querySelector('.batch-num');
      if (num) num.textContent = i + 1;
    });
  }

  function addBatchRow(addr, amt) {
    const container = $('batchRecipients');
    if (!container) return;
    const row = document.createElement('tr');
    row.className = 'batch-row';
    const n = container.querySelectorAll('.batch-row').length + 1;
    row.innerHTML = `<td class="batch-num">${n}</td>`
      + `<td><input type="text" class="batch-addr" placeholder="Solana address..." value="${addr || ''}" spellcheck="false"></td>`
      + `<td><input type="number" class="batch-amt" placeholder="0.00" step="any" min="0" value="${amt || ''}"></td>`
      + `<td><button class="batch-rm" title="Remove">×</button></td>`;
    container.appendChild(row);
    row.querySelector('.batch-rm').addEventListener('click', () => {
      row.remove();
      renumberBatchRows();
      updateBatchSummary();
    });
    row.querySelector('.batch-addr').addEventListener('input', updateBatchSummary);
    row.querySelector('.batch-amt').addEventListener('input', updateBatchSummary);
    updateBatchSummary();
    row.querySelector('.batch-addr').focus();
  }

  function updateBatchSummary() {
    const rows = document.querySelectorAll('.batch-row');
    const countEl = $('batchCount');
    const summaryEl = $('batchSummary');
    const sendBtn = $('batchSendBtn');
    if (countEl) countEl.textContent = `(${rows.length})`;

    let totalAmt = 0;
    let validCount = 0;
    rows.forEach(row => {
      const addr = row.querySelector('.batch-addr')?.value.trim() || '';
      const amt = parseFloat(row.querySelector('.batch-amt')?.value);
      row.classList.remove('row-valid', 'row-error');
      if (addr && !isNaN(amt) && amt > 0 && isValidSolanaAddress(addr)) {
        totalAmt += amt;
        validCount++;
        row.classList.add('row-valid');
      } else if (addr && !isValidSolanaAddress(addr)) {
        row.classList.add('row-error');
      }
    });

    const fee = totalAmt * FEE_PERCENT;
    const total = totalAmt + fee;
    const tok = batchToken;

    if (summaryEl) {
      if (validCount > 0) {
        summaryEl.classList.remove('hidden');
        $('batchTotalRecipients').textContent = validCount;
        $('batchTotalAmount').textContent = totalAmt.toFixed(4) + ' ' + tok;
        $('batchTotalFee').textContent = fee.toFixed(4) + ' ' + tok;
        $('batchTotalCost').textContent = total.toFixed(4) + ' ' + tok;
      } else {
        summaryEl.classList.add('hidden');
      }
    }

    if (sendBtn) sendBtn.disabled = validCount === 0 || !publicKey;
  }

  // Wire up the existing HTML row's events
  document.querySelectorAll('.batch-row').forEach(row => {
    row.querySelector('.batch-rm')?.addEventListener('click', () => {
      row.remove(); renumberBatchRows(); updateBatchSummary();
    });
    row.querySelector('.batch-addr')?.addEventListener('input', updateBatchSummary);
    row.querySelector('.batch-amt')?.addEventListener('input', updateBatchSummary);
  });
  $('batchAddBtn')?.addEventListener('click', () => addBatchRow('', ''));
  $('batchClearBtn')?.addEventListener('click', () => {
    const container = $('batchRecipients');
    if (container) { container.innerHTML = ''; addBatchRow('', ''); }
  });
  // Add a second empty row
  addBatchRow('', '');

  // Batch send handler
  $('batchSendBtn')?.addEventListener('click', async () => {
    if (!wallet || !publicKey) return showNotification('Connect wallet first', 'error');

    const rows = document.querySelectorAll('.batch-row');
    const recipients = [];
    rows.forEach(row => {
      const addr = row.querySelector('.batch-addr').value.trim();
      const amt = parseFloat(row.querySelector('.batch-amt').value);
      if (addr && !isNaN(amt) && amt > 0 && isValidSolanaAddress(addr)) {
        recipients.push({ address: addr, amount: amt, row });
      }
    });

    if (recipients.length === 0) return showNotification('Add at least one valid recipient', 'error');

    // Check total balance
    const totalNeeded = recipients.reduce((s, r) => s + r.amount, 0) * (1 + FEE_PERCENT);
    const bal = balances[batchToken] || 0;
    if (totalNeeded > bal) {
      return showNotification(`Insufficient ${batchToken}. Need ${totalNeeded.toFixed(4)}, have ${bal.toFixed(4)}`, 'error');
    }

    const batchSendBtn = $('batchSendBtn');
    const btnText = batchSendBtn.querySelector('.btn-text');
    const btnLoader = batchSendBtn.querySelector('.btn-loader');
    batchSendBtn.disabled = true;
    btnText.classList.add('hidden');
    btnLoader.classList.remove('hidden');

    try {

    const progress = $('batchProgress');
    const progressFill = $('batchProgressFill');
    const progressText = $('batchProgressText');
    const logDiv = $('batchLog');
    progress.classList.remove('hidden');
    logDiv.classList.remove('hidden');
    logDiv.innerHTML = '';

    function batchLog(msg, cls) {
      const el = document.createElement('div');
      el.className = 'batch-log-entry' + (cls ? ' ' + cls : '');
      el.innerHTML = msg;
      logDiv.appendChild(el);
      logDiv.scrollTop = logDiv.scrollHeight;
    }

    let completed = 0;
    let failed = 0;
    const total = recipients.length;

    // Save original privacy level and token, restore after
    const origPrivacy = privacyLevel;
    const origToken = selectedToken;
    privacyLevel = batchPrivacy;
    selectedToken = batchToken;

    const tok = TOKENS[batchToken];
    const isMaxOrPlus = batchPrivacy === 'maximum' || batchPrivacy === 'maximum-plus';
    const isEnhanced = batchPrivacy === 'enhanced';
    const isDoubleBridge = batchPrivacy === 'maximum-plus';

    // ====== PHASE 1: Prepare all recipients (validate bridges, generate shadows) ======
    batchLog(`🔧 Preparing ${total} recipients...`);
    const prepared = [];
    let prepFailed = false;

    for (let i = 0; i < total; i++) {
      const r = recipients[i];
      const shortAddr = r.address.slice(0, 6) + '...' + r.address.slice(-4);
      r.row.querySelector('.batch-status').textContent = '🔧';
      batchLog(`&nbsp;&nbsp;↳ [${i + 1}/${total}] Preparing ${shortAddr}...`);

      try {
        const recipient = new PublicKey(r.address);
        const onProgress = (hopId, title) => {
          batchLog(`&nbsp;&nbsp;&nbsp;&nbsp;↳ ${title}`, '');
        };

        if (isMaxOrPlus && window.ShadowPrivacy.prepareBatchMaximum) {
          const prep = await window.ShadowPrivacy.prepareBatchMaximum({
            connection, publicKey, recipient, amount: r.amount,
            token: tok, onProgress, doubleBridge: isDoubleBridge,
          });
          prepared.push({ index: i, recipient, domRow: r.row, amount: r.amount, shortAddr, type: 'maximum', ...prep });
        } else if (isEnhanced && window.ShadowPrivacy.prepareBatchEnhanced) {
          const prep = await window.ShadowPrivacy.prepareBatchEnhanced({
            connection, publicKey, recipient, amount: r.amount,
            token: tok, onProgress,
          });
          prepared.push({ index: i, recipient, domRow: r.row, amount: r.amount, shortAddr, type: 'enhanced', ...prep });
        }
      } catch (err) {
        failed++;
        r.row.querySelector('.batch-status').textContent = '❌';
        batchLog(`❌ [${i + 1}] Prepare failed: ${shortAddr} — ${err.message}`, 'error');
      }
    }

    if (prepared.length === 0) {
      batchLog(`⛔ All preparations failed`, 'error');
      privacyLevel = origPrivacy;
      selectedToken = origToken;
      batchSendBtn.disabled = false;
      btnText.classList.remove('hidden');
      btnLoader.classList.add('hidden');
      return;
    }

    // ====== PHASE 2: Build ONE combined TX (all fees + fundings) ======
    batchLog(`<br>📦 <strong>Building combined funding TX for ${prepared.length} recipients...</strong>`);
    const allIx = [];
    const { Keypair, SystemProgram, PublicKey: PK2, LAMPORTS_PER_SOL: LSOL } = solanaWeb3;
    const FEE_WALLET_PK = new PK2('983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb');
    const TOKEN_PROGRAM_ID = new PK2('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');
    const ATA_PROGRAM_ID = new PK2('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
    const SYSVAR_RENT = new PK2('SysvarRent111111111111111111111111111111111');
    const RENT_EXEMPT = 890_880;

    function batchGetATA(mint, owner) {
      const seeds = [owner.toBytes(), TOKEN_PROGRAM_ID.toBytes(), mint.toBytes()];
      return PK2.findProgramAddressSync(seeds, ATA_PROGRAM_ID)[0];
    }
    function batchCreateATAIx(payer, ata, owner, mint) {
      return new solanaWeb3.TransactionInstruction({
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
    function batchSplTx(src, dst, auth, amt) {
      const data = new Uint8Array(9);
      data[0] = 3;
      const view = new DataView(data.buffer);
      view.setBigUint64(1, BigInt(amt), true);
      return new solanaWeb3.TransactionInstruction({
        keys: [
          { pubkey: src, isSigner: false, isWritable: true },
          { pubkey: dst, isSigner: false, isWritable: true },
          { pubkey: auth, isSigner: true, isWritable: false },
        ],
        programId: TOKEN_PROGRAM_ID, data,
      });
    }

    const isSOL = tok.mint === 'native';
    const mintPubkey = isSOL ? null : new PK2(tok.mint);
    const BATCH_FEE = 0.01;
    let feeATACreated = false;

    for (const p of prepared) {
      const rawTotal = Math.round(p.amount * Math.pow(10, tok.decimals));

      // Fee instructions
      if (isSOL) {
        allIx.push(SystemProgram.transfer({
          fromPubkey: publicKey, toPubkey: FEE_WALLET_PK,
          lamports: Math.max(Math.round(p.amount * BATCH_FEE * LSOL), RENT_EXEMPT),
        }));
      } else {
        const feeTokens = Math.round(rawTotal * BATCH_FEE);
        const sATA = batchGetATA(mintPubkey, publicKey);
        const feeATA = batchGetATA(mintPubkey, FEE_WALLET_PK);
        if (!feeATACreated) {
          allIx.push(batchCreateATAIx(publicKey, feeATA, FEE_WALLET_PK, mintPubkey));
          feeATACreated = true;
        }
        allIx.push(batchSplTx(sATA, feeATA, publicKey, feeTokens));
      }

      // Fund shadow wallet
      if (isSOL) {
        const netLamports = Math.round(p.amount * LSOL) - Math.max(Math.round(p.amount * BATCH_FEE * LSOL), RENT_EXEMPT);
        allIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: p.shadow.publicKey, lamports: netLamports }));
      } else {
        const netTokens = rawTotal - Math.round(rawTotal * BATCH_FEE);
        const splitCount = p.splitCount || 1;
        const perSplitCost = 2_100_000;
        const solForFees = Math.max(3_000_000, splitCount * perSplitCost + 500_000);
        allIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: p.shadow.publicKey, lamports: solForFees }));
        const sATA = batchGetATA(mintPubkey, publicKey);
        const shATA = batchGetATA(mintPubkey, p.shadow.publicKey);
        allIx.push(batchCreateATAIx(publicKey, shATA, p.shadow.publicKey, mintPubkey));
        allIx.push(batchSplTx(sATA, shATA, publicKey, netTokens));
      }

      // Shadow2 gas for Maximum+ SPL
      if (isDoubleBridge && p.shadow2 && !isSOL) {
        allIx.push(SystemProgram.transfer({ fromPubkey: publicKey, toPubkey: p.shadow2.publicKey, lamports: 5_500_000 }));
      }
    }

    // Build ONE versioned TX with all instructions
    const _rpc = window.ShadowPrivacy?.rpc;
    const { blockhash } = _rpc ? await _rpc.getLatestBlockhash() : await connection.getLatestBlockhash('confirmed');
    const lut = []; // no lookup tables needed
    const msg = new solanaWeb3.TransactionMessage({
      payerKey: publicKey, recentBlockhash: blockhash, instructions: allIx,
    }).compileToV0Message(lut);
    const combinedTx = new solanaWeb3.VersionedTransaction(msg);

    // ====== PHASE 3: Sign ONE TX = 1 Phantom popup ======
    batchLog(`<br>✍️ <strong>Approve 1 transaction in Phantom...</strong>`);
    let signedTx;
    try {
      signedTx = await wallet.signTransaction(combinedTx);
      batchLog(`✅ Transaction signed!`);
    } catch (err) {
      if (err.code === 4001 || err.message?.includes('User rejected')) {
        batchLog(`⛔ Batch stopped — wallet signing rejected`, 'error');
      } else {
        batchLog(`❌ Signing failed: ${err.message}`, 'error');
      }
      privacyLevel = origPrivacy;
      selectedToken = origToken;
      batchSendBtn.disabled = false;
      btnText.classList.remove('hidden');
      btnLoader.classList.add('hidden');
      return;
    }

    // ====== PHASE 4: Send the combined funding TX ======
    batchLog(`📤 Sending combined funding TX...`);
    try {
      const sendC = window.ShadowPrivacy?.sendC;
      if (!sendC) throw new Error('sendC not available');
      await sendC(connection, signedTx, null, RPC_PROXY);
      batchLog(`✅ All shadows funded!`);
    } catch (err) {
      // TX may have been sent but confirmation timed out — verify shadow balances
      batchLog(`⚠️ Confirmation issue: ${err.message}`, 'error');
      batchLog(`🔍 Verifying shadow wallet balances...`);
      await new Promise(r => setTimeout(r, 3000));
      let allFunded = true;
      for (const p of prepared) {
        try {
          const shadow = p.shadow || (p.shadows ? p.shadows[0] : null);
          if (!shadow) { allFunded = false; break; }
          const bal = await connection.getBalance(shadow.publicKey);
          if (bal < 5000) { allFunded = false; break; }
        } catch(e) { allFunded = false; break; }
      }
      if (!allFunded) {
        batchLog(`❌ Shadows not funded — TX likely failed. Check wallet.`, 'error');
        privacyLevel = origPrivacy;
        selectedToken = origToken;
        batchSendBtn.disabled = false;
        btnText.classList.remove('hidden');
        btnLoader.classList.add('hidden');
        return;
      }
      batchLog(`✅ Shadows verified funded — continuing!`);
    }

    // ====== PHASE 5: Execute all bridges (shadows already funded) ======
    batchLog(`<br>🚀 <strong>Executing ${prepared.length} bridges...</strong>`);
    for (let i = 0; i < prepared.length; i++) {
      const p = prepared[i];
      progressFill.style.width = ((i / prepared.length) * 100) + '%';
      progressText.textContent = `${i + 1} / ${prepared.length}`;
      p.domRow.querySelector('.batch-status').textContent = '⏳';
      batchLog(`<br>📤 [${i + 1}/${prepared.length}] ${p.amount} ${batchToken} to ${p.shortAddr}...`);

      try {
        const onProgress = (hopId, title) => {
          batchLog(`&nbsp;&nbsp;↳ ${title}`, '');
        };

        let result;
        if (p.type === 'maximum') {
          result = await window.ShadowPrivacy.sendMaximum({
            connection, wallet, publicKey, recipient: p.recipient, amount: p.amount,
            token: tok, rpcProxy: RPC_PROXY, onProgress,
            doubleBridge: isDoubleBridge,
            batchShadow: p.shadow,
            batchShadow2: p.shadow2,
            batchBridgeResult: p.bridgeResult,
            batchBridgeCoin: p.bridgeCoinSymbol,
            batchBridgeAmount: p.bridgeAmount,
            skipFunding: true,
          });
        } else {
          result = await window.ShadowPrivacy.sendEnhanced({
            connection, wallet, publicKey, recipient: p.recipient, amount: p.amount,
            token: tok, rpcProxy: RPC_PROXY, onProgress,
            batchShadows: p.shadows,
            skipFunding: true,
          });
        }
        const lastSig = result.signatures?.[result.signatures.length - 1] || 'pending';
        const hops = result.hops || result.mode || '?';
        batchLog(`✅ [${i + 1}] Sent to ${p.shortAddr} — <a href="https://solscan.io/tx/${lastSig}" target="_blank" style="color:var(--success)">view</a>`, 'success');
        p.domRow.querySelector('.batch-status').textContent = '✅';
        completed++;
      } catch (err) {
        failed++;
        p.domRow.querySelector('.batch-status').textContent = '❌';
        batchLog(`❌ [${i + 1}] Failed: ${p.shortAddr} — ${err.message}`, 'error');
      }

      if (i < prepared.length - 1) await new Promise(r => setTimeout(r, 500));
    }

    progressFill.style.width = '100%';
    progressText.textContent = `Done! ${completed} ✅ ${failed > 0 ? failed + ' ❌' : ''}`;
    batchLog(`<br><strong>Batch complete: ${completed} sent, ${failed} failed</strong>`, completed === total ? 'success' : '');
    showNotification(`Batch: ${completed}/${total} sent${failed > 0 ? ', ' + failed + ' failed' : ''}`, failed > 0 ? 'error' : 'success');

    } catch (err) {
      console.error('Batch error:', err);
      batchLog(`❌ Batch error: ${err.message}`, 'error');
      showNotification(`Batch error: ${err.message}`, 'error');
    } finally {
      // ALWAYS restore state — even on error
      privacyLevel = origPrivacy;
      selectedToken = origToken;
      batchSendBtn.disabled = false;
      btnText.classList.remove('hidden');
      btnLoader.classList.add('hidden');
      setTimeout(fetchBalances, 3000);
    }
  });

  console.log('[Ciego] Init complete ✓');
})();
