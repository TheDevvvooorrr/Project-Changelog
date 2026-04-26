# Ciego Changelog

## v2.6 — Wallet Parity + Fast Route Stabilization (Apr 26, 2026)

- Completed **wallet parity** for private send flows, with MetaMask behavior aligned to Phantom for production use.
- Promoted stablecoin transfers to **Fast Route** for quicker execution and fewer waiting states.
- Validated stablecoin coverage across the active send flow, including **USDC, USDT, and USD1**.
- Removed temporary beta/testing UI elements to keep the wallet connection experience clean and consistent.
- Added the latest wallet logos in **Connect Wallet** for clearer visual identification.

## v2.5 — Bridge Routing + Privacy+ Streamline (Apr 26, 2026)

- Integrated **Fast Route** as the primary bridge route inside **Send Privately**.
- Added **automatic Backup Route** when **Fast Route** is unavailable.
- Enabled **A+B privacy strategy** in the main flow:
  - **A:** additional intermediate shadow hop.
  - **B:** dynamic amount splitting.
- Added support for **up to 5 splits** (max cap).
- Consolidated bridge execution into **Send Privately** (no separate flow).
- Prioritized **fast execution mode** (reduced unnecessary delays).
- Simplified Privacy+ behavior by removing user-facing toggles and keeping a cleaner execution path.
- Updated footer/public references:
  - **Docs:** 
  - **X (Twitter):** 
  - **GitHub:**
- Fixed bridge order parsing reliability for provider response address mapping.
- Improved bridge preparation/validation before funding execution.
- Aligned bridge option propagation across modules for consistent flow behavior.

## v2.4 — Public Repository Sanitization (Apr 22, 2026)

- Public repository content reduced to product documentation only.
- Removed implementation files from the public repo.
- README and changelog standardized for public-safe communication.

## v2.3 — Ciego Branding + Public Docs Hardening (Apr 22, 2026)

- Project naming unified as **Ciego** in user-facing documentation.
- README rewritten to product-level language.
- Changelog standardized to avoid implementation leakage.
- Privacy posture kept explicit while avoiding internal architecture exposure.

## v2.2 — Security Hardening (Apr 7, 2026)

- Strengthened server-side access controls for sensitive files.
- Improved request filtering and path-safety protections.
- Added stricter response/security headers.
- Reduced exposure of provider-specific details in user-facing output.
- Privacy level selector hidden (single mode UX).
- Primary action wording updated to “Send Privately”.

## v2.1 — Docs & UI Cleanup (Apr 7, 2026)

- Documentation expanded and reorganized.
- UI simplified for a more focused transfer flow.
- Branding and wording cleanup for consistency.
- Hidden non-production tabs from main UI while preserving internal work.

## v2.0 — Exchange-Style UI Redesign (Apr 4, 2026)

- Full visual redesign to a cleaner exchange-like experience.
- Improved consistency across key screens and flow sections.
- Better summaries for amount/fee/total clarity.
- Refined batch table layout and validation feedback.

## v1.9 — Batch Single-Popup & Stability Fixes (Apr 4, 2026)

- Consolidated batch approvals into a simpler signing flow.
- Reduced wallet friction for multi-recipient sends.
- Fixed high-impact reliability issues in batch execution.
- Improved fallback confirmation handling.

## v1.8 — Single Popup Flow Improvements (Apr 3, 2026)

- Send flow optimized to reduce approval popups.
- Better user continuity between prepare/sign/execute steps.

## v1.7 — Privacy Mode Simplification (Apr 3, 2026)

- Removed standard mode from user-facing selector.
- Kept only privacy-focused modes to reduce confusion.

## v1.6 — Maximum+ Double-Hop Privacy Flow (Apr 3, 2026)

- Added double-hop privacy path for stronger unlinkability.
- Expanded high-privacy flow coverage for supported assets.
- Added recovery controls for interrupted sessions.

## v1.5 — Fees & Transaction Cost Reliability (Apr 3, 2026)

- Unified fee handling across transfer paths.
- Fixed edge cases related to transaction cost/rent handling.
- Improved batch progress/log stability.

## v1.4 — Performance & Reliability (Mar 28, 2026)

- Faster transaction lifecycle and smoother processing.
- Better resilience under intermittent network conditions.
- More robust confirmation/retry behavior.
- Improved pre-execution checks and non-blocking cleanup behavior.

## v1.3 — Token Expansion & Stablecoin Fixes (Mar 28, 2026)

- Added USD1 support.
- Corrected stablecoin display/balance edge cases.
- Improved token selector behavior.

## v1.1 — Bug Fixes & UX Stability (Mar 28, 2026)

- Fixed transfer edge cases and post-error recovery UX.
- Improved selector ordering and max-amount behavior.
- Fixed stuck states after failed attempts.

## v1.0 — Initial Release (Mar 27, 2026)

- Initial web release with Phantom integration.
- Private transfer architecture established.
- Multi-asset support and cross-network destination support.
- Client-side-first privacy execution model with recovery baseline.

*Last updated: April 26, 2026*
