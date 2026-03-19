/**
 * Abstract MPP method definitions (client + server share the same schema objects).
 */

import { Method, z } from 'mppx';
import { parseUnits } from 'viem';

// ── Charge ────────────────────────────────────────────────────────────────

/**
 * Abstract charge intent — one-time ERC-3009 transfer authorization.
 *
 * The credential payload carries the ERC-3009 typed-data signature so the
 * server can call `transferWithAuthorization` on behalf of the payer.
 */
export const abstractChargeMethods = Method.from({
  name: 'abstract',
  intent: 'charge',
  schema: {
    credential: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: z.object({
        type: z.literal('authorization'),
        signature: z.string(),
        nonce: z.string(),
        validAfter: z.string(),
        validBefore: z.string(),
        from: z.string(),
      }) as any,
    },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    request: z.pipe(
      z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        recipient: z.string(),
        chainId: z.optional(z.number()),
        description: z.optional(z.string()),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      z.transform((v: any) => ({
        ...v,
        amount: parseUnits(v.amount as string, v.decimals as number).toString(),
      })),
    ) as any,
  },
});

// ── Session ───────────────────────────────────────────────────────────────

/**
 * Abstract session intent — payment channels backed by AbstractStreamChannel.
 */
export const abstractSessionMethods = Method.from({
  name: 'abstract',
  intent: 'session',
  schema: {
    credential: {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      payload: z.discriminatedUnion('action', [
        z.object({
          action: z.literal('open'),
          channelId: z.string(),
          cumulativeAmount: z.string(),
          signature: z.string(),
          txHash: z.string(),
          authorizedSigner: z.optional(z.string()),
        }),
        z.object({
          action: z.literal('topUp'),
          channelId: z.string(),
          additionalDeposit: z.string(),
          txHash: z.string(),
        }),
        z.object({
          action: z.literal('voucher'),
          channelId: z.string(),
          cumulativeAmount: z.string(),
          signature: z.string(),
        }),
        z.object({
          action: z.literal('close'),
          channelId: z.string(),
          cumulativeAmount: z.string(),
          signature: z.string(),
        }),
      ]) as any,
    },
    request: z.pipe(
      z.object({
        amount: z.string(),
        currency: z.string(),
        decimals: z.number(),
        unitType: z.string(),
        recipient: z.optional(z.string()),
        chainId: z.optional(z.number()),
        channelId: z.optional(z.string()),
        escrowContract: z.optional(z.string()),
        suggestedDeposit: z.optional(z.string()),
        minVoucherDelta: z.optional(z.string()),
      }),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      z.transform((v: any) => {
        const {
          amount,
          decimals,
          suggestedDeposit,
          minVoucherDelta,
          channelId,
          escrowContract,
          chainId,
          ...rest
        } = v;
        return {
          ...rest,
          amount: parseUnits(amount as string, decimals as number).toString(),
          ...(suggestedDeposit !== undefined && {
            suggestedDeposit: parseUnits(
              suggestedDeposit as string,
              decimals as number,
            ).toString(),
          }),
          methodDetails: {
            escrowContract,
            ...(channelId !== undefined && { channelId }),
            ...(minVoucherDelta !== undefined && {
              minVoucherDelta: parseUnits(
                minVoucherDelta as string,
                decimals as number,
              ).toString(),
            }),
            ...(chainId !== undefined && { chainId }),
          },
        };
      }),
    ) as any,
  },
});
