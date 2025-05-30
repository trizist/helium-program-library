import { Program } from "@coral-xyz/anchor";
import { PROGRAM_ID, daoKey, init } from "@helium/helium-sub-daos-sdk";
import { sendInstructions, toBN } from "@helium/spl-utils";
import { init as initVsr } from "@helium/voter-stake-registry-sdk";
import { getMint } from "@solana/spl-token";
import { PublicKey, TransactionInstruction } from "@solana/web3.js";
import { useAsyncCallback } from "react-async-hook";
import { useHeliumVsrState } from "../contexts/heliumVsrContext";
import { PositionWithMeta } from "../sdk/types";
import { fetchBackwardsCompatibleIdl } from "@helium/spl-utils";

export const useTransferPosition = () => {
  const { provider } = useHeliumVsrState();
  const { error, loading, execute } = useAsyncCallback(
    async ({
      sourcePosition,
      amount,
      targetPosition,
      programId = PROGRAM_ID,
      onInstructions,
    }: {
      sourcePosition: PositionWithMeta;
      amount: number;
      targetPosition: PositionWithMeta;
      programId?: PublicKey;
      // Instead of sending the transaction, let the caller decide
      onInstructions?: (
        instructions: TransactionInstruction[]
      ) => Promise<void>;
    }) => {
      const isInvalid =
        !provider ||
        sourcePosition.numActiveVotes > 0 ||
        targetPosition.numActiveVotes > 0;

      const idl = await fetchBackwardsCompatibleIdl(programId, provider as any);
      const hsdProgram = await init(provider as any, programId, idl);
      const vsrProgram = await initVsr(provider as any);
      const mint = sourcePosition.votingMint.mint;

      if (loading) return;

      if (isInvalid || !hsdProgram) {
        throw new Error(
          "Unable to Transfer Position, position has active votes"
        );
      } else {
        const instructions: TransactionInstruction[] = [];
        const [dao] = daoKey(mint);
        const isDao = Boolean(await provider.connection.getAccountInfo(dao));
        const mintAcc = await getMint(provider.connection, mint);
        const amountToTransfer = toBN(amount, mintAcc!.decimals);

        if (isDao) {
          instructions.push(
            await hsdProgram.methods
              .transferV0({
                amount: amountToTransfer,
              })
              .accountsPartial({
                sourcePosition: sourcePosition.pubkey,
                targetPosition: targetPosition.pubkey,
                depositMint: mint,
                dao: dao,
              })
              .instruction()
          );
        } else {
          instructions.push(
            await vsrProgram.methods
              .transferV0({
                amount: amountToTransfer,
              })
              .accountsPartial({
                sourcePosition: sourcePosition.pubkey,
                targetPosition: targetPosition.pubkey,
                depositMint: mint,
              })
              .instruction()
          );
        }

        if (amountToTransfer.eq(sourcePosition.amountDepositedNative)) {
          instructions.push(
            await vsrProgram.methods
              .closePositionV0()
              .accountsPartial({
                position: sourcePosition.pubkey,
              })
              .instruction()
          );
        }

        if (onInstructions) {
          await onInstructions(instructions)
        } else {
          await sendInstructions(provider, instructions);
        }
      }
    }
  );

  return {
    error,
    loading,
    transferPosition: execute,
  };
};
