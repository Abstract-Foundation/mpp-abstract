# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

MPP (Machine Payments Protocol) implementation for Abstract chain. A `mppx` payment method plugin that settles ERC-20 payments on Abstract (ZKsync-based) using two intents:

- **Charge**: One-time ERC-3009 `TransferWithAuthorization` — client signs typed data, server broadcasts tx
- **Session**: Payment channels via `AbstractStreamChannel` escrow — single on-chain open, off-chain cumulative vouchers, server-initiated close

## Build & Test Commands

```bash
# Install (from root)
pnpm install

# Build everything (turbo-cached, contracts → plugin → examples)
pnpm turbo run build

# TypeScript plugin only
cd packages/mppx-abstract && pnpm build        # tsc
cd packages/mppx-abstract && pnpm typecheck     # tsc --noEmit

# Solidity contracts
cd packages/contracts && forge build
cd packages/contracts && forge test -v                    # all 17 tests
cd packages/contracts && forge test -v --match test_Open  # single test

# Lint (Biome — excludes .sol files)
biome check .
biome format .
```

## Monorepo Structure

pnpm workspaces + Turbo. Shared dependency versions in `pnpm-workspace.yaml` catalog.

| Package | Purpose |
|---------|---------|
| `packages/contracts` | Solidity `AbstractStreamChannel` escrow (Foundry, Soldeer deps) |
| `packages/mppx-abstract` | TypeScript mppx plugin — exports `./client` and `./server` subpaths |
| `examples/hono-server` | Example paid API server (Hono + mppx) |
| `examples/agent-client` | Example autonomous client that handles 402 → sign → retry |

## Key Architecture

### Plugin structure (`packages/mppx-abstract/src/`)

- `constants.ts` — ABIs, token addresses, EIP-712 types, chain constants
- `client/charge.ts` — Signs ERC-3009 `TransferWithAuthorization` typed data
- `client/session.ts` — Manages channel lifecycle: open → voucher → close, tracks channels in-memory Map
- `server/charge.ts` — Verifies ERC-3009 sig, broadcasts `transferWithAuthorization` (optional ZKsync paymaster)
- `server/session.ts` — Verifies voucher sigs, calls `settle()`/`close()` on escrow contract
- `client/methods.ts` & `server/methods.ts` — Zod schemas and `Method.from()` definitions for both intents

### Contract (`packages/contracts/src/AbstractStreamChannel.sol`)

Direct port of Tempo's `TempoStreamChannel` with three changes: `ITIP20` → `IERC20`, Tempo utility check → `require(token != address(0))`, EIP-712 domain name → `"Abstract Stream Channel"`. All function signatures, events, errors, and business logic are otherwise identical.

Core flow: `open()` → `settle()` (repeatable) → `close()`. Payer escape hatch: `requestClose()` → 15 min grace → `withdraw()`.

### EIP-712 Domains

- **Charge (ERC-3009)**: domain `{name: 'USD Coin', version: '2', chainId, verifyingContract: tokenAddr}`
- **Session vouchers**: domain `{name: 'Abstract Stream Channel', version: '1', chainId, verifyingContract: escrowAddr}`

## Code Conventions

- **TypeScript**: ESM (`"type": "module"`), ES2023 target, NodeNext resolution, strict mode. Explicit `.js` extensions on imports.
- **Solidity**: Solc 0.8.26, 200 optimizer runs. Dependencies via Soldeer (forge-std, solady).
- **Formatting**: Biome with recommended rules, single quotes, space indentation. `.sol` files excluded from linting.
- **Foundry tests**: `setUp()` + `test_*` naming. Payer key `0xA11CE` with helper functions `_openChannel()`, `_signVoucher()`.

## Chain Constants

| | Testnet (11124) | Mainnet (2741) |
|---|---|---|
| USDC.e | `0xbd28Bd5A3Ef540d1582828CE2A1a657353008C61` | `0x84A71ccD554Cc1b02749b35d22F684CC8ec987e1` |
| RPC | `https://api.testnet.abs.xyz` | `https://api.mainnet.abs.xyz` |
