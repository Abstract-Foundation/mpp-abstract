---
'@abstract-foundation/mpp': patch
---

Add smart-wallet compatibility for Abstract payments.

- Support ERC-3009 `bytes` signatures for charge flows, including ERC-1271 wallets.
- Verify session vouchers with contract-wallet-compatible typed-data checks.
- Update the Abstract testnet and mainnet `AbstractStreamChannel` defaults to `0x29635C384f451a72ED2e2a312BCeb8b0bDC0923c`.
