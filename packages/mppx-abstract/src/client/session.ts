/**
 * Client-side session credential creator for the Abstract MPP payment method.
 *
 * Session payments use AbstractStreamChannel.sol — an ERC-20/EIP-712 payment
 * channel where:
 *   - `open`: client approves + calls escrow.open(), then signs a voucher
 *   - `voucher`: client signs a new cumulative voucher for each request
 *   - `topUp`: client deposits more tokens into the channel
 *   - `close`: client sends a final voucher to close the channel
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseUnits,
  type Account,
  type Address,
  type Hex,
  type PublicClient,
  type WalletClient,
} from 'viem'
import { readContract, signTypedData, writeContract, waitForTransactionReceipt } from 'viem/actions'
import { Method, Credential } from 'mppx'
import {
  ABSTRACT_MAINNET_CHAIN_ID,
  ABSTRACT_MAINNET_RPC,
  ABSTRACT_TESTNET_CHAIN_ID,
  ABSTRACT_TESTNET_RPC,
  ABSTRACT_STREAM_CHANNEL_ABI,
  VOUCHER_DOMAIN_NAME,
  VOUCHER_DOMAIN_VERSION,
  VOUCHER_TYPES,
} from '../constants.js'
import { abstractSessionMethods } from './methods.js'

const ERC20_ABI = [
  {
    name: 'approve',
    type: 'function',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    name: 'allowance',
    type: 'function',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ name: '', type: 'uint256' }],
  },
] as const

export interface AbstractSessionClientOptions {
  account: Account
  /**
   * Default deposit amount as human-readable string (e.g. "10" for 10 USDC.e).
   * Required unless the server challenge includes `suggestedDeposit`.
   */
  deposit?: string
  /** Override escrow contract (falls back to challenge.request.methodDetails.escrowContract). */
  escrowContract?: Address
  getClient?: (chainId: number) => WalletClient | Promise<WalletClient>
  getPublicClient?: (chainId: number) => PublicClient | Promise<PublicClient>
}

interface ChannelEntry {
  channelId: Hex
  escrowContract: Address
  chainId: number
  cumulativeAmount: bigint
  opened: boolean
}

/**
 * Creates a client-side Abstract session payment method.
 *
 * Manages channel state in-memory across requests.
 *
 * @example
 * ```ts
 * import { abstractSession } from 'mppx-abstract/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const session = abstractSession({
 *   account: privateKeyToAccount('0x...'),
 *   deposit: '10',
 * })
 * ```
 */
export function abstractSession(options: AbstractSessionClientOptions) {
  const { account } = options
  const channels = new Map<string, ChannelEntry>()

  function channelKey(payee: string, currency: string, escrow: string): string {
    return `${payee.toLowerCase()}:${currency.toLowerCase()}:${escrow.toLowerCase()}`
  }

  function buildChain(chainId: number) {
    const isTestnet = chainId === ABSTRACT_TESTNET_CHAIN_ID
    const rpc = isTestnet ? ABSTRACT_TESTNET_RPC : ABSTRACT_MAINNET_RPC
    return {
      id: chainId,
      name: isTestnet ? 'Abstract Testnet' : 'Abstract',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [rpc] } },
    } as const
  }

  async function resolveWalletClient(chainId: number): Promise<WalletClient> {
    if (options.getClient) return options.getClient(chainId)
    const chain = buildChain(chainId)
    const isTestnet = chainId === ABSTRACT_TESTNET_CHAIN_ID
    const rpc = isTestnet ? ABSTRACT_TESTNET_RPC : ABSTRACT_MAINNET_RPC
    return createWalletClient({ account, chain, transport: http(rpc) })
  }

  async function resolvePublicClient(chainId: number): Promise<PublicClient> {
    if (options.getPublicClient) return options.getPublicClient(chainId)
    const chain = buildChain(chainId)
    const isTestnet = chainId === ABSTRACT_TESTNET_CHAIN_ID
    const rpc = isTestnet ? ABSTRACT_TESTNET_RPC : ABSTRACT_MAINNET_RPC
    return createPublicClient({ chain, transport: http(rpc) })
  }

  async function signVoucherSig(
    chainId: number,
    escrowContract: Address,
    channelId: Hex,
    cumulativeAmount: bigint,
    walletClient: WalletClient,
  ): Promise<Hex> {
    return signTypedData(walletClient, {
      account,
      domain: {
        name: VOUCHER_DOMAIN_NAME,
        version: VOUCHER_DOMAIN_VERSION,
        chainId,
        verifyingContract: escrowContract,
      },
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: { channelId, cumulativeAmount },
    })
  }

  return Method.toClient(abstractSessionMethods, {
    async createCredential({ challenge, context }: { challenge: Record<string, unknown>; context?: unknown }) {
      const req = challenge.request as Record<string, unknown>
      const md = (req.methodDetails ?? {}) as Record<string, unknown>

      const chainId = (md.chainId as number | undefined) ?? ABSTRACT_MAINNET_CHAIN_ID
      const currency = req.currency as Address
      const recipient = req.recipient as Address
      const amountRaw = req.amount as string
      const amount = BigInt(amountRaw)

      const escrowContract = (
        options.escrowContract ??
        (md.escrowContract as Address | undefined)
      )
      if (!escrowContract) {
        throw new Error('escrowContract required: set options.escrowContract or ensure the server challenge includes methodDetails.escrowContract')
      }

      const walletClient = await resolveWalletClient(chainId)
      const publicClient = await resolvePublicClient(chainId)

      const key = channelKey(recipient, currency, escrowContract)
      let entry = channels.get(key)

      // ── Open a new channel ────────────────────────────────────────────────
      if (!entry) {
        const suggestedDepositRaw = req.suggestedDeposit as string | undefined
        const depositStr = options.deposit
        const deposit = suggestedDepositRaw
          ? BigInt(suggestedDepositRaw)
          : depositStr
          ? parseUnits(depositStr, 6)
          : (() => { throw new Error('deposit required: set options.deposit or ensure server sends suggestedDeposit') })()

        const nonceBytes = new Uint8Array(32)
        globalThis.crypto.getRandomValues(nonceBytes)
        const salt = `0x${Array.from(nonceBytes).map(b => b.toString(16).padStart(2, '0')).join('')}` as Hex

        // Ensure allowance
        const currentAllowance = await readContract(publicClient, {
          address: currency,
          abi: ERC20_ABI,
          functionName: 'allowance',
          args: [account.address as Address, escrowContract],
        })

        if ((currentAllowance as bigint) < deposit) {
          const approveTx = await writeContract(walletClient, {
            account,
            address: currency,
            abi: ERC20_ABI,
            functionName: 'approve',
            args: [escrowContract, deposit],
            chain: null,
          })
          await waitForTransactionReceipt(publicClient, { hash: approveTx })
        }

        // Open channel
        const openTx = await writeContract(walletClient, {
          account,
          address: escrowContract,
          abi: ABSTRACT_STREAM_CHANNEL_ABI,
          functionName: 'open',
          args: [
            recipient,
            currency,
            deposit as unknown as bigint,
            salt,
            '0x0000000000000000000000000000000000000000' as Address,
          ],
          chain: null,
        })
        await waitForTransactionReceipt(publicClient, { hash: openTx })

        // Compute channelId
        const channelId = await readContract(publicClient, {
          address: escrowContract,
          abi: ABSTRACT_STREAM_CHANNEL_ABI,
          functionName: 'computeChannelId',
          args: [
            account.address as Address,
            recipient,
            currency,
            salt,
            '0x0000000000000000000000000000000000000000' as Address,
          ],
        }) as Hex

        entry = {
          channelId,
          escrowContract,
          chainId,
          cumulativeAmount: 0n,
          opened: true,
        }
        channels.set(key, entry)

        // Sign opening voucher
        entry.cumulativeAmount += amount
        const voucherSig = await signVoucherSig(chainId, escrowContract, channelId, entry.cumulativeAmount, walletClient)

        return Credential.serialize({
          challenge: challenge as Parameters<typeof Credential.serialize>[0]['challenge'],
          source: `did:pkh:eip155:${chainId}:${account.address}`,
          payload: {
            action: 'open' as const,
            channelId,
            cumulativeAmount: entry.cumulativeAmount.toString(),
            signature: voucherSig,
            txHash: openTx,
          },
        })
      }

      // ── Voucher for existing channel ──────────────────────────────────────
      entry.cumulativeAmount += amount
      const sig = await signVoucherSig(
        chainId,
        entry.escrowContract,
        entry.channelId,
        entry.cumulativeAmount,
        walletClient,
      )

      return Credential.serialize({
        challenge: challenge as Parameters<typeof Credential.serialize>[0]['challenge'],
        source: `did:pkh:eip155:${chainId}:${account.address}`,
        payload: {
          action: 'voucher' as const,
          channelId: entry.channelId,
          cumulativeAmount: entry.cumulativeAmount.toString(),
          signature: sig,
        },
      })
    },
  })
}
