/**
 * Shared utility helpers for the Abstract server-side plugin.
 */

import { type Chain } from 'viem'
import {
  ABSTRACT_MAINNET_CHAIN_ID,
  ABSTRACT_MAINNET_RPC,
  ABSTRACT_TESTNET_CHAIN_ID,
  ABSTRACT_TESTNET_RPC,
} from '../constants.js'

/** Build a minimal viem Chain object for Abstract. */
export function buildAbstractChain(chainId: number, rpcUrl?: string): Chain {
  const isTestnet = chainId === ABSTRACT_TESTNET_CHAIN_ID
  const defaultRpc = isTestnet ? ABSTRACT_TESTNET_RPC : ABSTRACT_MAINNET_RPC
  const rpc = rpcUrl ?? defaultRpc
  return {
    id: chainId,
    name: isTestnet ? 'Abstract Testnet' : 'Abstract',
    nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
    rpcUrls: { default: { http: [rpc] } },
  }
}

/** Resolve chainId from request, falling back to testnet/mainnet default. */
export function resolveChainId(
  requestChainId: number | undefined,
  testnet: boolean,
): number {
  if (requestChainId) return requestChainId
  return testnet ? ABSTRACT_TESTNET_CHAIN_ID : ABSTRACT_MAINNET_CHAIN_ID
}
