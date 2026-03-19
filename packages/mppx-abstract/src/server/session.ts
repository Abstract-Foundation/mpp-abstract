/**
 * Server-side session method for the Abstract MPP payment method.
 *
 * Handles the full channel lifecycle against AbstractStreamChannel.sol.
 */

import { Method } from 'mppx';
import {
  type Account,
  type Address,
  createPublicClient,
  createWalletClient,
  type Hex,
  http,
  isAddressEqual,
  type PublicClient,
  parseUnits,
  recoverTypedDataAddress,
  type Transport,
  type WalletClient,
} from 'viem';
import { abstract, abstractTestnet } from 'viem/chains';
import { type ChainEIP712, getGeneralPaymasterInput } from 'viem/zksync';
import { abstractSessionMethods } from '../client/methods.js';
import {
  ABSTRACT_STREAM_CHANNEL_ABI,
  DEFAULT_CURRENCY,
  USDC_E_DECIMALS,
  VOUCHER_DOMAIN_NAME,
  VOUCHER_DOMAIN_VERSION,
  VOUCHER_TYPES,
} from '../constants.js';

// ── Types ─────────────────────────────────────────────────────────────────

interface ChannelState {
  channelId: Hex;
  chainId: number;
  escrowContract: Address;
  payer: Address;
  payee: Address;
  token: Address;
  authorizedSigner: Address;
  deposit: bigint;
  settledOnChain: bigint;
  highestVoucherAmount: bigint;
  highestVoucher: VoucherRecord | null;
  spent: bigint;
  units: number;
  finalized: boolean;
  createdAt: string;
}

interface VoucherRecord {
  channelId: Hex;
  cumulativeAmount: bigint;
  signature: Hex;
}

// ── Errors ─────────────────────────────────────────────────────────────────

class SessionError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'SessionError';
  }
}

// ── Options ────────────────────────────────────────────────────────────────

export interface AbstractSessionServerOptions {
  /** Server account (broadcasts close/settle transactions). */
  account: Account;
  /** Payment recipient. */
  recipient: Address;
  /** Token address (defaults to USDC.e for the chain). */
  currency?: Address;
  /** AbstractStreamChannel escrow contract address. */
  escrowContract: Address;
  /** Per-request payment amount (human-readable, e.g. "0.001"). */
  amount?: string;
  /** Suggested deposit for clients (human-readable). */
  suggestedDeposit?: string;
  /** Minimum voucher increment. Default "0". */
  minVoucherDelta?: string;
  /** Unit type label (e.g. "request", "token"). */
  unitType?: string;
  /** Decimals for amount conversion. Default 6. */
  decimals?: number;
  /** Use testnet (chainId 11124). */
  testnet?: boolean;
  /** Custom RPC URL. */
  rpcUrl?: string;
  /** Optional paymaster address. */
  paymasterAddress?: Address;
  /** Optional custom input for the paymaster's logic. */
  paymasterInput?: Hex;
}

// ── Helpers ────────────────────────────────────────────────────────────────

async function verifyVoucherSig(
  escrowContract: Address,
  chainId: number,
  voucher: VoucherRecord,
  expectedSigner: Address,
): Promise<boolean> {
  try {
    const recovered = await recoverTypedDataAddress({
      domain: {
        name: VOUCHER_DOMAIN_NAME,
        version: VOUCHER_DOMAIN_VERSION,
        chainId,
        verifyingContract: escrowContract,
      },
      types: VOUCHER_TYPES,
      primaryType: 'Voucher',
      message: {
        channelId: voucher.channelId,
        cumulativeAmount: voucher.cumulativeAmount,
      },
      signature: voucher.signature,
    });
    return isAddressEqual(recovered, expectedSigner);
  } catch {
    return false;
  }
}

function makeSessionReceipt(params: {
  challengeId: string;
  channelId: Hex;
  acceptedCumulative: bigint;
  spent: bigint;
  units: number;
  txHash?: Hex;
}) {
  return {
    method: 'abstract' as const,
    status: 'success' as const,
    timestamp: new Date().toISOString(),
    reference: params.txHash ?? params.channelId,
    channelId: params.channelId,
    acceptedCumulative: params.acceptedCumulative.toString(),
    spent: params.spent.toString(),
    units: params.units,
    challengeId: params.challengeId,
  };
}

// ── Main export ────────────────────────────────────────────────────────────

/**
 * Creates a server-side Abstract session handler.
 *
 * @example
 * ```ts
 * import { Mppx } from 'mppx/server'
 * import { abstract } from 'mppx-abstract/server'
 *
 * const mppx = Mppx.create({
 *   methods: [abstract.session({
 *     account: serverAccount,
 *     recipient: '0x...',
 *     escrowContract: '0x...',
 *     amount: '0.001',
 *     suggestedDeposit: '1',
 *     unitType: 'request',
 *     testnet: true,
 *   })],
 *   secretKey: process.env.MPP_SECRET_KEY!,
 * })
 * ```
 */
export function session(params: AbstractSessionServerOptions) {
  const {
    account,
    recipient,
    escrowContract,
    amount,
    suggestedDeposit,
    minVoucherDelta = '0',
    unitType = 'request',
    decimals = USDC_E_DECIMALS,
    testnet = false,
    rpcUrl,
    paymasterAddress,
    paymasterInput,
  } = params;

  const defaultChain = testnet ? abstractTestnet : abstract;
  const currency = params.currency ?? DEFAULT_CURRENCY[defaultChain.id];
  const minDelta = parseUnits(minVoucherDelta, decimals);

  // In-memory channel store
  const channels = new Map<Hex, ChannelState>();

  function buildClients(chainId: number): {
    publicClient: PublicClient<Transport, ChainEIP712>;
    walletClient: WalletClient<Transport, ChainEIP712, Account>;
  } {
    const chain: ChainEIP712 | undefined =
      chainId === abstract.id
        ? abstract
        : chainId === abstractTestnet.id
          ? abstractTestnet
          : undefined;
    if (!chain) {
      throw new SessionError(
        `Unsupported chainId: ${chainId}`,
        'UNSUPPORTED_CHAIN',
      );
    }
    const transport = http(rpcUrl);

    return {
      publicClient: createPublicClient({ chain, transport }),
      walletClient: createWalletClient({ account, chain, transport }),
    };
  }

  async function getOnChainChannel(
    publicClient: PublicClient<Transport, ChainEIP712>,
    channelId: Hex,
  ) {
    return publicClient.readContract({
      address: escrowContract,
      abi: ABSTRACT_STREAM_CHANNEL_ABI,
      functionName: 'getChannel',
      args: [channelId],
    });
  }

  return Method.toServer(abstractSessionMethods, {
    defaults: {
      amount: amount ?? '0',
      currency,
      decimals,
      recipient,
      suggestedDeposit,
      unitType,
      escrowContract,
    } as Record<string, unknown>,

    async request({
      credential,
      request,
    }: {
      credential?: unknown;
      request: Record<string, unknown>;
    }) {
      const md = (request.methodDetails ?? {}) as Record<string, unknown>;
      const chainId = (md.chainId as number | undefined) ?? defaultChain.id;
      return {
        ...request,
        chainId,
        escrowContract:
          (md.escrowContract as Address | undefined) ?? escrowContract,
      };
    },

    async verify({
      credential,
      request,
    }: {
      credential: Record<string, unknown>;
      request: Record<string, unknown>;
    }) {
      const chainId =
        (request.chainId as number | undefined) ?? defaultChain.id;
      const { publicClient, walletClient } = buildClients(chainId);

      const payload = credential.payload as Record<string, unknown>;
      const challenge = credential.challenge as Record<string, unknown>;
      const challengeReq = challenge.request as Record<string, unknown>;
      const challengeAmount = BigInt(challengeReq.amount as string);

      const action = payload.action as string;

      switch (action) {
        // ── OPEN ────────────────────────────────────────────────────────────
        case 'open': {
          const channelId = payload.channelId as Hex;
          const cumulativeAmount = BigInt(payload.cumulativeAmount as string);
          const signature = payload.signature as Hex;
          const txHash = payload.txHash as Hex;

          const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
          });
          if (receipt.status !== 'success') {
            throw new SessionError(
              `Open tx reverted: ${txHash}`,
              'OPEN_REVERTED',
            );
          }

          const onChain = await getOnChainChannel(publicClient, channelId);
          if (onChain.deposit === 0n)
            throw new SessionError(
              'Channel not funded on-chain',
              'CHANNEL_NOT_FOUND',
            );
          if (onChain.finalized)
            throw new SessionError('Channel is finalized', 'CHANNEL_FINALIZED');
          if (!isAddressEqual(onChain.payee, recipient)) {
            throw new SessionError('On-chain payee mismatch', 'PAYEE_MISMATCH');
          }
          if (!isAddressEqual(onChain.token, currency)) {
            throw new SessionError('On-chain token mismatch', 'TOKEN_MISMATCH');
          }

          const ZERO_ADDR =
            '0x0000000000000000000000000000000000000000' as Address;
          const authorizedSigner = isAddressEqual(
            onChain.authorizedSigner,
            ZERO_ADDR,
          )
            ? onChain.payer
            : onChain.authorizedSigner;

          if (cumulativeAmount > onChain.deposit) {
            throw new SessionError(
              'Voucher exceeds deposit',
              'AMOUNT_EXCEEDS_DEPOSIT',
            );
          }

          const voucher: VoucherRecord = {
            channelId,
            cumulativeAmount,
            signature,
          };
          const valid = await verifyVoucherSig(
            escrowContract,
            chainId,
            voucher,
            authorizedSigner,
          );
          if (!valid)
            throw new SessionError(
              'Invalid voucher signature',
              'INVALID_SIGNATURE',
            );

          const state: ChannelState = {
            channelId,
            chainId,
            escrowContract,
            payer: onChain.payer,
            payee: onChain.payee,
            token: onChain.token,
            authorizedSigner,
            deposit: onChain.deposit,
            settledOnChain: onChain.settled,
            highestVoucherAmount: cumulativeAmount,
            highestVoucher: voucher,
            spent: challengeAmount,
            units: 1,
            finalized: false,
            createdAt: new Date().toISOString(),
          };
          channels.set(channelId, state);

          return makeSessionReceipt({
            challengeId: challenge.id as string,
            channelId,
            acceptedCumulative: cumulativeAmount,
            spent: state.spent,
            units: state.units,
            txHash,
          });
        }

        // ── TOPUP ───────────────────────────────────────────────────────────
        case 'topUp': {
          const channelId = payload.channelId as Hex;
          const txHash = payload.txHash as Hex;

          const state = channels.get(channelId);
          if (!state)
            throw new SessionError('Channel not found', 'CHANNEL_NOT_FOUND');

          const receipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
          });
          if (receipt.status !== 'success') {
            throw new SessionError(
              `TopUp tx reverted: ${txHash}`,
              'TOPUP_REVERTED',
            );
          }

          const onChain = await getOnChainChannel(publicClient, channelId);
          if (onChain.deposit <= state.deposit) {
            throw new SessionError(
              'Deposit did not increase',
              'DEPOSIT_NOT_INCREASED',
            );
          }
          state.deposit = onChain.deposit;
          channels.set(channelId, state);

          return makeSessionReceipt({
            challengeId: challenge.id as string,
            channelId,
            acceptedCumulative: state.highestVoucherAmount,
            spent: state.spent,
            units: state.units,
            txHash,
          });
        }

        // ── VOUCHER ─────────────────────────────────────────────────────────
        case 'voucher': {
          const channelId = payload.channelId as Hex;
          const cumulativeAmount = BigInt(payload.cumulativeAmount as string);
          const signature = payload.signature as Hex;

          const state = channels.get(channelId);
          if (!state)
            throw new SessionError('Channel not found', 'CHANNEL_NOT_FOUND');
          if (state.finalized)
            throw new SessionError('Channel is finalized', 'CHANNEL_FINALIZED');

          // Idempotent
          if (cumulativeAmount <= state.highestVoucherAmount) {
            return makeSessionReceipt({
              challengeId: challenge.id as string,
              channelId,
              acceptedCumulative: state.highestVoucherAmount,
              spent: state.spent,
              units: state.units,
            });
          }

          const delta = cumulativeAmount - state.highestVoucherAmount;
          if (delta < minDelta) {
            throw new SessionError(
              `Delta ${delta} < min ${minDelta}`,
              'DELTA_TOO_SMALL',
            );
          }
          if (cumulativeAmount > state.deposit) {
            throw new SessionError(
              'Voucher exceeds deposit',
              'AMOUNT_EXCEEDS_DEPOSIT',
            );
          }

          const voucher: VoucherRecord = {
            channelId,
            cumulativeAmount,
            signature,
          };
          const valid = await verifyVoucherSig(
            escrowContract,
            chainId,
            voucher,
            state.authorizedSigner,
          );
          if (!valid)
            throw new SessionError(
              'Invalid voucher signature',
              'INVALID_SIGNATURE',
            );

          state.highestVoucherAmount = cumulativeAmount;
          state.highestVoucher = voucher;
          state.spent += challengeAmount;
          state.units += 1;
          channels.set(channelId, state);

          return makeSessionReceipt({
            challengeId: challenge.id as string,
            channelId,
            acceptedCumulative: cumulativeAmount,
            spent: state.spent,
            units: state.units,
          });
        }

        // ── CLOSE ───────────────────────────────────────────────────────────
        case 'close': {
          const channelId = payload.channelId as Hex;
          const cumulativeAmount = BigInt(payload.cumulativeAmount as string);
          const signature = payload.signature as Hex;

          const state = channels.get(channelId);
          if (!state)
            throw new SessionError('Channel not found', 'CHANNEL_NOT_FOUND');
          if (state.finalized)
            throw new SessionError(
              'Channel already finalized',
              'CHANNEL_FINALIZED',
            );

          const minClose =
            state.spent > state.settledOnChain
              ? state.spent
              : state.settledOnChain;
          if (cumulativeAmount < minClose) {
            throw new SessionError(
              `Close amount ${cumulativeAmount} < min ${minClose}`,
              'CLOSE_AMOUNT_TOO_LOW',
            );
          }
          if (cumulativeAmount > state.deposit) {
            throw new SessionError(
              'Close amount exceeds deposit',
              'AMOUNT_EXCEEDS_DEPOSIT',
            );
          }

          const voucher: VoucherRecord = {
            channelId,
            cumulativeAmount,
            signature,
          };
          const valid = await verifyVoucherSig(
            escrowContract,
            chainId,
            voucher,
            state.authorizedSigner,
          );
          if (!valid)
            throw new SessionError(
              'Invalid close voucher signature',
              'INVALID_SIGNATURE',
            );

          const closeArgs = [channelId, cumulativeAmount, signature] as const;

          let txHash: Hex;
          if (paymasterAddress) {
            txHash = await walletClient.writeContract({
              account,
              address: escrowContract,
              abi: ABSTRACT_STREAM_CHANNEL_ABI,
              functionName: 'close',
              args: closeArgs,
              chain: null,
              ...{
                paymaster: paymasterAddress,
                paymasterInput: getGeneralPaymasterInput({
                  innerInput: paymasterInput ?? '0x',
                }),
              },
            });
          } else {
            txHash = await walletClient.writeContract({
              account,
              address: escrowContract,
              abi: ABSTRACT_STREAM_CHANNEL_ABI,
              functionName: 'close',
              args: closeArgs,
              chain: null,
            });
          }

          const closeReceipt = await publicClient.waitForTransactionReceipt({
            hash: txHash,
          });
          if (closeReceipt.status !== 'success') {
            throw new SessionError(
              `Close tx reverted: ${txHash}`,
              'CLOSE_REVERTED',
            );
          }

          state.highestVoucherAmount = cumulativeAmount;
          state.highestVoucher = voucher;
          state.finalized = true;
          channels.set(channelId, state);

          return makeSessionReceipt({
            challengeId: challenge.id as string,
            channelId,
            acceptedCumulative: cumulativeAmount,
            spent: state.spent,
            units: state.units,
            txHash,
          });
        }

        default:
          throw new SessionError(
            `Unknown session action: ${action}`,
            'BAD_REQUEST',
          );
      }
    },

    respond({ credential }: { credential: Record<string, unknown> }) {
      const action = (credential.payload as Record<string, unknown>)
        .action as string;
      if (action === 'close' || action === 'topUp') {
        return new Response(null, { status: 204 });
      }
      return undefined;
    },
  });
}
