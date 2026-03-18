/**
 * Server-side charge method for the Abstract MPP payment method.
 *
 * Verifies an ERC-3009 TransferWithAuthorization signature and broadcasts
 * the `transferWithAuthorization` call to settle payment on-chain.
 *
 * When `paymasterAddress` is configured the transaction is submitted with
 * Abstract's ZKsync-native `customData.paymasterParams` — no external
 * fee-payer service required.
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  recoverTypedDataAddress,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { readContract, waitForTransactionReceipt, writeContract } from 'viem/actions'
import { Method } from 'mppx'
import {
  ABSTRACT_MAINNET_CHAIN_ID,
  ABSTRACT_MAINNET_RPC,
  ABSTRACT_TESTNET_CHAIN_ID,
  ABSTRACT_TESTNET_RPC,
  DEFAULT_CURRENCY,
  ERC3009_ABI,
  TRANSFER_WITH_AUTHORIZATION_TYPES,
  USDC_E_DECIMALS,
} from '../constants.js'
import { abstractChargeMethods } from '../client/methods.js'
import { buildAbstractChain } from './utils.js'

export interface AbstractChargeServerOptions {
  /** Token address (defaults to USDC.e for the resolved chain). */
  currency?: Address
  /** Decimals for amount conversion. Default 6. */
  decimals?: number
  /** Server wallet that broadcasts transferWithAuthorization. */
  account: Account
  /** Recipient address for collected payments. */
  recipient: Address
  /** Human-readable default amount per request, e.g. "0.01". */
  amount?: string
  /** If true, use Abstract testnet (chainId 11124). */
  testnet?: boolean
  /** Optional custom RPC URL override. */
  rpcUrl?: string
  /**
   * Optional Abstract paymaster contract address.
   *
   * When set, the `transferWithAuthorization` transaction is submitted with
   * ZKsync-native `customData.paymasterParams` — gas is sponsored by the
   * paymaster. No external fee-payer service is required.
   *
   * @example
   * ```ts
   * abstract.charge({
   *   paymasterAddress: '0x...', // your Abstract paymaster contract
   *   ...
   * })
   * ```
   */
  paymasterAddress?: Address
}

/** Per-currency ERC-3009 domain cache to avoid redundant RPC calls. */
const domainCache = new Map<string, { name: string; version: string }>()

async function getErc3009Domain(
  publicClient: PublicClient,
  currency: Address,
  chainId: number,
) {
  const cached = domainCache.get(currency)
  if (cached) return { ...cached, chainId, verifyingContract: currency }

  let name = 'USD Coin'
  let version = '2'

  try {
    name = await readContract(publicClient, {
      address: currency,
      abi: ERC3009_ABI,
      functionName: 'name',
    }) as string
  } catch { /* fallback */ }

  try {
    version = await readContract(publicClient, {
      address: currency,
      abi: ERC3009_ABI,
      functionName: 'version',
    }) as string
  } catch { /* fallback */ }

  domainCache.set(currency, { name, version })
  return { name, version, chainId, verifyingContract: currency }
}

/**
 * Creates a server-side Abstract charge handler using Method.toServer().
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { abstract } from 'mppx-abstract/server'
 *
 * const mppx = Mppx.create({
 *   methods: [abstract.charge({
 *     account: serverAccount,
 *     recipient: '0x...',
 *     amount: '0.01',
 *     testnet: true,
 *   })],
 *   secretKey: process.env.MPP_SECRET_KEY!,
 *   realm: 'api.example.com',
 * })
 * ```
 */
export function charge(params: AbstractChargeServerOptions) {
  const {
    account,
    recipient,
    amount,
    decimals = USDC_E_DECIMALS,
    testnet = false,
    rpcUrl,
    paymasterAddress,
  } = params

  const defaultChainId = testnet ? ABSTRACT_TESTNET_CHAIN_ID : ABSTRACT_MAINNET_CHAIN_ID
  const currency = params.currency ?? DEFAULT_CURRENCY[defaultChainId]!
  const rpc = rpcUrl ?? (testnet ? ABSTRACT_TESTNET_RPC : ABSTRACT_MAINNET_RPC)

  function buildClients(chainId: number): { publicClient: PublicClient; walletClient: WalletClient } {
    const chain = buildAbstractChain(chainId, rpc)
    const transport = http(rpc)
    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ account, chain, transport }),
    }
  }

  return Method.toServer(abstractChargeMethods, {
    defaults: {
      amount: amount ?? '0',
      currency,
      decimals,
      recipient,
    } as Record<string, unknown>,

    async request({ credential, request }: { credential?: unknown; request: Record<string, unknown> }) {
      const md = ((request.methodDetails ?? {}) as Record<string, unknown>)
      const chainId = (md.chainId as number | undefined) ?? defaultChainId
      return { ...request, chainId }
    },

    async verify({ credential, request }: { credential: Record<string, unknown>; request: Record<string, unknown> }) {
      const chainId = (request.chainId as number | undefined) ?? defaultChainId
      const { publicClient, walletClient } = buildClients(chainId)

      const payload = credential.payload as Record<string, unknown>
      const challenge = credential.challenge as Record<string, unknown>
      const challengeReq = challenge.request as Record<string, unknown>

      const amountRaw = challengeReq.amount as string
      const currencyAddr = (challengeReq.currency as Address | undefined) ?? currency
      const recipientAddr = (challengeReq.recipient as Address | undefined) ?? recipient

      if (payload.type !== 'authorization') {
        throw new Error(`Unsupported credential type "${payload.type}"`)
      }

      const signature = payload.signature as Hex
      const nonce = payload.nonce as Hex
      const validAfter = payload.validAfter as string
      const validBefore = payload.validBefore as string
      const from = payload.from as Address

      // Verify ERC-3009 signature
      const domain = await getErc3009Domain(publicClient, currencyAddr, chainId)

      const recoveredAddress = await recoverTypedDataAddress({
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from,
          to: recipientAddr,
          value: BigInt(amountRaw),
          validAfter: BigInt(validAfter),
          validBefore: BigInt(validBefore),
          nonce,
        },
        signature,
      })

      if (recoveredAddress.toLowerCase() !== from.toLowerCase()) {
        throw new Error(
          `ERC-3009 signature mismatch: recovered ${recoveredAddress}, expected ${from}`,
        )
      }

      // Check nonce not already used
      const used = await readContract(publicClient, {
        address: currencyAddr,
        abi: ERC3009_ABI,
        functionName: 'authorizationState',
        args: [from, nonce],
      }) as boolean

      if (used) throw new Error('ERC-3009 authorization nonce already used')

      // Split compact 65-byte signature into v/r/s
      const sigHex = signature.startsWith('0x') ? signature.slice(2) : signature
      const r = `0x${sigHex.slice(0, 64)}` as Hex
      const s = `0x${sigHex.slice(64, 128)}` as Hex
      const v = parseInt(sigHex.slice(128, 130), 16)

      const txArgs = [
        from,
        recipientAddr,
        BigInt(amountRaw),
        BigInt(validAfter),
        BigInt(validBefore),
        nonce,
        v,
        r,
        s,
      ] as const

      let txHash: Hex

      if (paymasterAddress) {
        txHash = await writeContract(walletClient, {
          account,
          address: currencyAddr,
          abi: ERC3009_ABI,
          functionName: 'transferWithAuthorization',
          args: txArgs,
          chain: null,
          // ZKsync-native gas sponsorship — no fee-payer service needed
          // @ts-expect-error viem base types don't include ZKsync customData
          customData: {
            paymasterParams: {
              paymaster: paymasterAddress,
              paymasterInput: '0x',
            },
          },
        })
      } else {
        txHash = await writeContract(walletClient, {
          account,
          address: currencyAddr,
          abi: ERC3009_ABI,
          functionName: 'transferWithAuthorization',
          args: txArgs,
          chain: null,
        })
      }

      const receipt = await waitForTransactionReceipt(publicClient, { hash: txHash })
      if (receipt.status !== 'success') {
        throw new Error(`transferWithAuthorization reverted: ${txHash}`)
      }

      return {
        method: 'abstract' as const,
        status: 'success' as const,
        timestamp: new Date().toISOString(),
        reference: txHash,
      }
    },
  })
}
