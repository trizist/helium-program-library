import * as anchor from "@coral-xyz/anchor";
import { GetProgramAccountsFilter, PublicKey } from "@solana/web3.js";
import retry from "async-retry";
import { Op, Sequelize, Transaction } from "sequelize";
import { SOLANA_URL } from "../env";
import { initPlugins } from "../plugins";
import { IAccountConfig } from "../types";
import cachedIdlFetch from "./cachedIdlFetch";
import { chunks } from "./chunks";
import database from "./database";
import { defineIdlModels } from "./defineIdlModels";
import { sanitizeAccount } from "./sanitizeAccount";
import { truthy } from "./truthy";
import { lowerFirstChar } from "@helium/spl-utils";

interface UpsertProgramAccountsArgs {
  programId: PublicKey;
  accounts: IAccountConfig[];
  sequelize?: Sequelize;
}

export const upsertProgramAccounts = async ({
  programId,
  accounts,
  sequelize = database,
}: UpsertProgramAccountsArgs) => {
  anchor.setProvider(
    anchor.AnchorProvider.local(process.env.ANCHOR_PROVIDER_URL || SOLANA_URL)
  );
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const connection = provider.connection;
  const idl = await cachedIdlFetch.fetchIdl({
    skipCache: true,
    programId: programId.toBase58(),
    provider,
  });

  if (!idl) {
    throw new Error(`unable to fetch idl for ${programId}`);
  }

  if (
    !accounts.every(({ type }) =>
      idl.accounts!.some(({ name }) => name === type)
    )
  ) {
    throw new Error("idl does not have every account type");
  }

  const program = new anchor.Program(idl, provider);

  try {
    await sequelize.authenticate();
    await defineIdlModels({
      idl,
      accounts,
      sequelize,
    });
  } catch (e) {
    console.log(e);
    throw e;
  }

  const processProgramAccounts = async (
    connection: anchor.web3.Connection,
    programId: anchor.web3.PublicKey,
    accountType: string,
    filters: anchor.web3.GetProgramAccountsFilter[],
    batchSize: number,
    processChunk: (
      chunk: anchor.web3.GetProgramAccountsResponse,
      transaction: Transaction
    ) => Promise<void>
  ) => {
    const startTime = Date.now();
    let processedCount = 0;

    const accounts = await retry(
      async () => {
        return await connection.getProgramAccounts(programId, {
          filters,
          commitment: "confirmed",
        });
      },
      {
        retries: 5,
        factor: 2,
        minTimeout: 1000,
        maxTimeout: 60000,
        onRetry: (err, attempt) => {
          console.warn(
            `Retrying getProgramAccounts for ${accountType}, attempt #${attempt}: Retrying due to ${err.message}`
          );
        },
      }
    );

    for (const chunk of chunks(accounts, batchSize)) {
      try {
        const t = await sequelize.transaction({
          isolationLevel: Transaction.ISOLATION_LEVELS.READ_COMMITTED,
        });
        await processChunk(chunk, t);
        await t.commit();
        processedCount += chunk.length;
        console.log(`Processed ${processedCount} ${accountType} accounts`);
      } catch (err) {
        console.error(`Error processing chunk:`, err);
        throw err;
      }
    }

    const duration = (Date.now() - startTime) / 1000;
    console.log(
      `Finished processing ${accountType} accounts in ${duration} seconds`
    );
  };

  for (const { type, batchSize = 50000, ...rest } of accounts) {
    try {
      const model = sequelize.models[type];
      const plugins = await initPlugins(rest.plugins);
      const filter = program.coder.accounts.memcmp(
        lowerFirstChar(type),
        undefined
      );
      const coderFilters: GetProgramAccountsFilter[] = [];

      if (filter?.offset != undefined && filter?.bytes != undefined) {
        coderFilters.push({
          memcmp: { offset: filter.offset, bytes: filter.bytes },
        });
      }

      if (filter?.dataSize != undefined) {
        coderFilters.push({ dataSize: filter.dataSize });
      }

      const now = new Date().toISOString();
      await processProgramAccounts(
        connection,
        programId,
        type,
        coderFilters,
        batchSize,
        async (chunk, transaction) => {
          const accs = chunk
            .map(({ pubkey, account }) => {
              try {
                const decodedAcc = program.coder.accounts.decode(
                  lowerFirstChar(type),
                  account.data
                );
                return {
                  publicKey: pubkey,
                  account: decodedAcc,
                };
              } catch (_e) {
                console.error(`Decode error ${pubkey.toBase58()}`, _e);
                return null;
              }
            })
            .filter(truthy);

          const updateOnDuplicateFields: string[] = [
            ...Object.keys(accs[0].account),
            ...new Set(
              plugins
                .map((plugin) => plugin?.updateOnDuplicateFields || [])
                .flat()
            ),
          ];

          const values = await Promise.all(
            accs.map(async ({ publicKey, account }) => {
              let sanitizedAccount = sanitizeAccount(account);

              for (const plugin of plugins) {
                if (plugin?.processAccount) {
                  sanitizedAccount = await plugin.processAccount(
                    sanitizedAccount
                  );
                }
              }

              return {
                address: publicKey.toBase58(),
                refreshed_at: now,
                ...sanitizedAccount,
              };
            })
          );

          await model.bulkCreate(values, {
            transaction,
            updateOnDuplicate: [
              "address",
              "refreshed_at",
              ...updateOnDuplicateFields,
            ],
          });
        }
      );

      if (!rest.ignore_deletes) {
        await model.destroy({
          where: {
            refreshed_at: {
              [Op.lt]: now,
            },
          },
        });
      }
    } catch (err) {
      console.error(`Error processing account type ${type}:`, err);
    }
  }
};
