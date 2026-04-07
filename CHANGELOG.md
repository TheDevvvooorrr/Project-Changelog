# Project Changelog

> Private transaction platform for Solana.

**Chain:** Solana (Mainnet)

---

## v2.1 — Docs & UI Cleanup (Apr 7, 2026)

### Documentation
- Created full documentation site (GitBook) with 7 pages
- Covers: How It Works, Privacy Levels, Fees & Minimums, Recovery, Security, FAQ
- Flow diagrams for each privacy level
- No provider names or internal details exposed
- Docs link added to footer

### UI Simplification
- Hidden Batch and Bridge tabs from main UI (code preserved, not production-ready yet)
- Hidden Enhanced and Maximum privacy selectors — only Maximum+ available
- Default privacy level set to Maximum+
- Removed mode tab bar (single-mode view)

### Branding
- Console logs now use `[Ciego]` instead of previous branding
- Third-party provider names hidden from user-facing console messages (replaced with "private pool")
- Logo removed from header

---

## v2.0 — Exchange UI Redesign (Apr 4, 2026)

### Visual Overhaul
- Full exchange-style UI with glassmorphism cards and backdrop blur
- Particle background canvas with 60 floating particles + connection lines
- 3 ambient glow orbs with smooth floating animations
- 3D tilt effect on cards (mouse-reactive)
- Glow pulsing borders on all cards (neon purple)
- Shimmer effect on buttons on hover
- Ripple click animations on all interactive elements
- Logo ghost icon with animated drop-shadow glow
- Status bar at bottom (Solana Mainnet • RPC Ready)

### Tab Consistency
- Send Privately, Bridge, and Batch tabs all share the same clean table-based layout
- Section labels and descriptive text on every tab
- Summary boxes with Amount / Fee / Total Cost breakdown
- Token selector with dropdown, logos, and balance display

### Batch Mode Redesign
- Clean HTML table layout with numbered rows (#, Address, Amount, ×)
- Auto-numbering on add/remove
- Green border on valid rows, red on invalid
- Clear All + Add Recipient buttons
- Summary row with total cost in bold

---

## v1.9 — Batch Single-Popup & Bug Fixes (Apr 4, 2026)

### Batch Consolidation
- All batch recipients funded in ONE combined transaction
- Single Phantom popup for entire batch (was 1 per recipient)
- Phase flow: Prepare → Build combined TX → Sign once → Send → Execute bridges

### Critical Bug Fixes
- Fixed `sendC` scope bug — was defined in IIFE #1 but exported from IIFE #2 (different scopes)
- Fixed `FEE_PERCENT` Temporal Dead Zone error in batch mode — renamed to `BATCH_FEE`
- Fixed WebSocket confirmation fallback — now uses RPC polling when WS unavailable
- Fixed transactions appearing successful but funds lost due to unconfirmed sends

---

## v1.8 — Single Phantom Popup (Apr 3, 2026)

### Send Privately
- Consolidated all transactions (fee + shadow funding) into one `signAllTransactions` call
- Single Phantom approval popup instead of multiple

### Batch Mode
- Reduced to 2 popups (one per recipient) — down from N popups

---

## v1.7 — Standard Mode Removed (Apr 3, 2026)

### Privacy Modes
- Removed Standard option from privacy selector
- Only Enhanced, Maximum, and Maximum+ available
- Cleaner UI with fewer confusing options

---

## v1.6 — Double Bridge / Maximum+ (Apr 3, 2026)

### Maximum+ Mode (⭐⭐⭐⭐⭐+)
- Double bridge: Wallet → ChangeNOW → Shadow → ChangeNOW → Recipient
- Two separate bridge hops break any possible on-chain link
- Works with SOL, USDC, USDT, USD1

### Batch + Double Bridge
- Batch mode supports all 3 privacy modes (Enhanced, Maximum, Maximum+)
- Confirmed working with USDC and SOL double bridge in batch

### Recovery
- Recovery button added to UI for stuck/interrupted transactions

---

## v1.5 — Fee System & Rent Fix (Apr 3, 2026)

### Fee Wallet
- 1% fee on all transactions including shadow wallet funding
- Fee wallet: `983VntrxFbU1F5yTUszni8CrMi2kMoW3idbshV7kTfhb`

### Bug Fixes
- Fixed `InsufficientFundsForRent` on split transactions (fee reduced 25k → 5k lamports)
- Batch progress and log UI elements fixed

---

## v1.4 — Performance & Reliability (Mar 28, 2026)

### Speed Optimization
- Significantly reduced transaction processing times

### Network Resilience
- All network calls retry automatically with exponential backoff
- Graceful handling of proxy/RPC intermittent failures (502, timeouts)
- Recovery system hardened against network instability

### Transaction Reliability
- Improved confirmation logic — fresh parameters on each retry attempt
- Pre-hop balance verification ensures funds are available before proceeding
- Non-critical cleanup operations no longer block the main transaction flow
- Eliminated edge cases where transactions could hang indefinitely

### SPL Token Reliability
- Fixed funding issue for intermediate wallets
- All intermediate wallets now properly funded upfront

---

## v1.3 — Token Expansion & Stablecoin Fixes (Mar 28, 2026)

### New Token: USD1 (WLFI)
- Added World Liberty Financial USD1 stablecoin support

### USDT Fix
- Corrected USDT token address — balances now display correctly

### Stablecoin Visibility
- USDC, USDT, and USD1 always appear in token selector regardless of balance
- Other tokens require balance > 0 to show

---

## v1.1 — Bug Fixes & Stability (Mar 28, 2026)

### Token Transfer Fixes
- Fixed several edge cases with SPL token transfers
- Resolved rent-exemption errors in intermediate transactions
- Improved account cleanup after transaction completion

### UX Fixes
- Send button no longer gets stuck disabled after errors
- Privacy report display crash fixed
- Token selector sorted by wallet balance (highest first)
- "MAX" button uses actual wallet balance

---

## v1.0 — Initial Release (Mar 27, 2026)

### Platform
- Web-based interface with Phantom wallet integration
- Backend proxy for RPC load balancing and reliability

### Privacy
- All transactions are private by default
- Enhanced mode: shadow wallets + Jupiter swaps
- Maximum mode: ChangeNOW bridge (SOL/LTC route, ~2.5 min)
- Cross-chain bridge via Monero for untraceable transfers

### Supported Tokens
- SOL, USDC, USDT, USD1

### Cross-Chain Support
- Multi-chain destination: SOL, ETH, BSC, BTC, BASE, ARB, MATIC, LTC
- Real-time exchange rate display
- Recipient address validation per network

### Security
- All privacy logic runs client-side
- No backend state or transaction logging
- Built-in fund recovery for interrupted transactions

---

*Last updated: April 7, 2026*
