/**
 * Client-side charge credential creator for the Abstract MPP payment method.
 *
 * The client signs an ERC-3009 `TransferWithAuthorization` typed-data message.
 * No transaction is sent from the client side — the server broadcasts the
 * `transferWithAuthorization` call on behalf of the payer.
 */

import { Credential, Method } from 'mppx';
import {
  type Account,
  type Address,
  createWalletClient,
  type Hex,
  http,
  type Transport,
  type WalletClient,
} from 'viem';
import { abstract, abstractTestnet } from 'viem/chains';
import type { ChainEIP712 } from 'viem/zksync';
import { TRANSFER_WITH_AUTHORIZATION_TYPES } from '../constants.js';
import { abstractChargeMethods } from './methods.js';

export interface AbstractChargeClientOptions {
  /** Viem account to sign ERC-3009 authorizations. */
  account: Account;
  /** Optional custom RPC URL override. */
  rpcUrl?: string;
  /** Override the viem wallet client factory (advanced). */
  getClient?: (chainId: number) => WalletClient | Promise<WalletClient>;
}

/**
 * Creates a client-side Abstract charge method that signs ERC-3009
 * `TransferWithAuthorization` typed data without broadcasting a transaction.
 *
 * @example
 * ```ts
 * import { abstractCharge } from 'mppx-abstract/client'
 * import { privateKeyToAccount } from 'viem/accounts'
 *
 * const charge = abstractCharge({ account: privateKeyToAccount('0x...') })
 * ```
 */
export function abstractCharge(options: AbstractChargeClientOptions) {
  const { account, getClient: customGetClient, rpcUrl } = options;

  function buildClient(
    chainId: number,
  ): WalletClient<Transport, ChainEIP712, Account> {
    const chain: ChainEIP712 | undefined =
      chainId === abstract.id
        ? abstract
        : chainId === abstractTestnet.id
          ? abstractTestnet
          : undefined;

    if (!chain) {
      throw new Error(
        `Unsupported chainId ${chainId} for Abstract charge method`,
      );
    }

    return createWalletClient({ account, chain, transport: http(rpcUrl) });
  }

  async function resolveClient(chainId: number): Promise<WalletClient> {
    if (customGetClient) return customGetClient(chainId);
    return buildClient(chainId);
  }

  return Method.toClient(abstractChargeMethods, {
    async createCredential({
      challenge,
    }: {
      challenge: Record<string, unknown>;
    }) {
      const methodDetails = (challenge.request as Record<string, unknown>)
        .methodDetails as Record<string, unknown> | undefined;
      const chainId =
        (methodDetails?.chainId as number | undefined) ??
        ((challenge.request as Record<string, unknown>).chainId as
          | number
          | undefined) ??
        abstract.id;

      const client = await resolveClient(chainId);

      const req = challenge.request as Record<string, unknown>;
      const currency = req.currency as Address;
      const recipient = req.recipient as Address;
      const amountRaw = req.amount as string;

      // Random bytes32 nonce for the ERC-3009 authorization
      const nonceBytes = new Uint8Array(32);
      globalThis.crypto.getRandomValues(nonceBytes);
      const nonce = `0x${Array.from(nonceBytes)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')}` as Hex;

      const validAfter = 0n;
      const expiresStr = challenge.expires as string | undefined;
      const validBefore = expiresStr
        ? BigInt(Math.floor(new Date(expiresStr).getTime() / 1000))
        : BigInt(Math.floor(Date.now() / 1000) + 1800);

      const domain = {
        name: 'USD Coin',
        version: '2',
        chainId,
        verifyingContract: currency,
      };

      const signature = await client.signTypedData({
        account,
        domain,
        types: TRANSFER_WITH_AUTHORIZATION_TYPES,
        primaryType: 'TransferWithAuthorization',
        message: {
          from: account.address as Address,
          to: recipient,
          value: BigInt(amountRaw),
          validAfter,
          validBefore,
          nonce,
        },
      });

      const source = `did:pkh:eip155:${chainId}:${account.address}`;

      return Credential.serialize({
        challenge: challenge as Parameters<
          typeof Credential.serialize
        >[0]['challenge'],
        source,
        payload: {
          type: 'authorization' as const,
          signature,
          nonce,
          validAfter: validAfter.toString(),
          validBefore: validBefore.toString(),
          from: account.address as Address,
        },
      });
    },
  });
}
