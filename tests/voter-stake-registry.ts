import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { VoterStakeRegistry } from "@helium/idls/lib/types/voter_stake_registry";
import { NftProxy } from "@helium/modular-governance-idls/lib/types/nft_proxy";
import { Proposal } from "@helium/modular-governance-idls/lib/types/proposal";
import {
  PROGRAM_ID as DEL_PID,
  init as initNftProxy,
  proxyAssignmentKey,
} from "@helium/nft-proxy-sdk";
import { init as initProposal, proposalKey } from "@helium/proposal-sdk";
import {
  createAtaAndMint,
  createMint,
  createMintInstructions,
  sendInstructions,
  toBN,
  truthy,
} from "@helium/spl-utils";
import {
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
  getAssociatedTokenAddress,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import {
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
} from "@solana/web3.js";
import chai, { expect } from "chai";
import chaiAsPromised from "chai-as-promised";
import {
  PROGRAM_ID,
  init,
  positionKey,
} from "../packages/voter-stake-registry-sdk/src";
import { expectBnAccuracy } from "./utils/expectBnAccuracy";
import { ensureVSRIdl } from "./utils/fixtures";
import { getUnixTimestamp, loadKeypair } from "./utils/solana";
import { random } from "./utils/string";
import { SPL_GOVERNANCE_PID } from "./utils/vsr";

chai.use(chaiAsPromised);

const SECS_PER_DAY = 86400;
const SECS_PER_YEAR = 365 * SECS_PER_DAY;
const MAX_LOCKUP = 4 * SECS_PER_YEAR;
const BASELINE = 0;
const SCALE = 100;
const GENESIS_MULTIPLIER = 3;
type VotingMintConfig =
  anchor.IdlTypes<VoterStakeRegistry>["votingMintConfigV0"];

describe("voter-stake-registry", () => {
  anchor.setProvider(anchor.AnchorProvider.local("http://127.0.0.1:8899"));

  let program: Program<VoterStakeRegistry>;
  let proxyProgram: Program<NftProxy>;
  let proposalProgram: Program<Proposal>;
  let registrar: PublicKey;
  let collection: PublicKey;
  let hntMint: PublicKey;
  let realm: PublicKey;
  let proxyConfig: PublicKey | undefined;
  let oneWeekFromNow: number;
  const provider = anchor.getProvider() as anchor.AnchorProvider;
  const me = provider.wallet.publicKey;

  before(async () => {
    await ensureVSRIdl();
  });

  beforeEach(async () => {
    program = await init(
      provider,
      PROGRAM_ID,
      anchor.workspace.VoterStakeRegistry.idl
    );
    // @ts-ignore
    proposalProgram = await initProposal(provider as any);
    proxyProgram = await initNftProxy(provider, DEL_PID);
    hntMint = await createMint(provider, 8, me, me);
    await createAtaAndMint(provider, hntMint, toBN(223_000_000, 8));

    // Create Realm
    const name = `Realm-${new Keypair().publicKey.toBase58().slice(0, 6)}`;
    let instructions: TransactionInstruction[] = [];
    realm = await PublicKey.findProgramAddressSync(
      [Buffer.from("governance", "utf-8"), Buffer.from(name, "utf-8")],
      new PublicKey("hgovkRU6Ghe1Qoyb54HdSLdqN7VtxaifBzRmh9jtd3S")
    )[0];
    ({
      pubkeys: { proxyConfig },
    } = await proxyProgram.methods
      .initializeProxyConfigV0({
        maxProxyTime: new anchor.BN(1000000000000),
        name: random(10),
        seasons: [
          {
            start: new anchor.BN(0),
            end: new anchor.BN(new Date().valueOf() / 1000 + 100000),
          },
        ],
      })
      .accountsPartial({
        authority: me,
      })
      .rpcAndKeys());

    const {
      instruction: createRegistrar,
      pubkeys: { registrar: rkey, collection: ckey },
    } = await program.methods
      .initializeRegistrarV0({
        positionUpdateAuthority: null,
      })
      .accountsPartial({
        realm: realm,
        realmGoverningTokenMint: hntMint,
        proxyConfig,
      })
      .prepare();
    registrar = rkey!;
    collection = ckey!;
    instructions.push(
      createRegistrar,
      SystemProgram.transfer({
        fromPubkey: me,
        toPubkey: rkey!,
        lamports: LAMPORTS_PER_SOL,
      })
    );

    // Configure voting mint
    oneWeekFromNow =
      Number(await getUnixTimestamp(provider)) + 60 * 60 * 24 * 7;
    instructions.push(
      await program.methods
        .configureVotingMintV0({
          idx: 0, // idx
          baselineVoteWeightScaledFactor: new anchor.BN(BASELINE * 1e9),
          maxExtraLockupVoteWeightScaledFactor: new anchor.BN(SCALE * 1e9),
          genesisVotePowerMultiplier: GENESIS_MULTIPLIER,
          genesisVotePowerMultiplierExpirationTs: new anchor.BN(oneWeekFromNow),
          lockupSaturationSecs: new anchor.BN(MAX_LOCKUP),
        })
        .accountsPartial({
          registrar,
          mint: hntMint,
        })
        .remainingAccounts([
          {
            pubkey: hntMint,
            isSigner: false,
            isWritable: false,
          },
        ])
        .instruction()
    );

    await sendInstructions(provider, instructions, []);
  });

  async function createAndDeposit(
    lockupAmount: number,
    periods: number,
    kind: any = { cliff: {} },
    owner?: Keypair
  ): Promise<{ mint: PublicKey; position: PublicKey }> {
    const mintKeypair = Keypair.generate();
    const position = positionKey(mintKeypair.publicKey)[0];
    const instructions: TransactionInstruction[] = [];
    instructions.push(
      ...(await createMintInstructions(
        provider,
        0,
        position,
        position,
        mintKeypair
      ))
    );
    instructions.push(
      await program.methods
        .initializePositionV0({
          kind,
          periods,
        })
        .accountsPartial({
          // lock for 6 months
          collection,
          registrar,
          mint: mintKeypair.publicKey,
          depositMint: hntMint,
          recipient: owner?.publicKey,
        })
        .instruction()
    );

    // deposit some hnt
    instructions.push(
      await program.methods
        .depositV0({ amount: toBN(lockupAmount, 8) })
        .accountsPartial({
          registrar,
          position,
          mint: hntMint,
        })
        .instruction()
    );
    await sendInstructions(
      provider,
      instructions,
      [mintKeypair].filter(truthy)
    );

    return { position, mint: mintKeypair.publicKey };
  }

  it("should configure a votingMint correctly", async () => {
    const registrarAcc = await program.account.registrar.fetch(registrar);
    console.log(registrarAcc.collection.toBase58());
    const votingMint0 = (
      registrarAcc.votingMints as VotingMintConfig[]
    )[0] as VotingMintConfig;

    expect(
      votingMint0.baselineVoteWeightScaledFactor.eq(
        new anchor.BN(BASELINE * 1e9)
      )
    ).to.eq(true);
    expect(
      votingMint0.maxExtraLockupVoteWeightScaledFactor.eq(
        new anchor.BN(SCALE * 1e9)
      )
    ).to.eq(true);
    expect(votingMint0.genesisVotePowerMultiplier).to.eq(GENESIS_MULTIPLIER);
    expect(
      votingMint0.genesisVotePowerMultiplierExpirationTs.eq(
        new anchor.BN(oneWeekFromNow)
      )
    ).to.eq(true);
    expect(
      votingMint0.lockupSaturationSecs.eq(new anchor.BN(MAX_LOCKUP))
    ).to.eq(true);
  });

  it("should allow me to create a position and deposit tokens", async () => {
    const { mint, position } = await createAndDeposit(10, 183);
    const positionAccount = await program.account.positionV0.fetch(position);

    expect(positionAccount.amountDepositedNative.toNumber()).to.eq(
      toBN(10, 8).toNumber()
    );
    expect(positionAccount.mint.toBase58()).to.eq(mint.toBase58());
    expect(positionAccount.registrar.toBase58()).to.eq(registrar.toBase58());
    expect(positionAccount.numActiveVotes).to.eq(0);

    const bal = await provider.connection.getTokenAccountBalance(
      await getAssociatedTokenAddress(mint, me)
    );
    expect(bal.value.uiAmount).to.eq(1);
  });

  describe("with proposal", async () => {
    let proposalConfig: PublicKey | undefined;
    let proposal: PublicKey | undefined;
    let name: string;
    beforeEach(async () => {
      name = random();
      const {
        pubkeys: { proposalConfig: proposalConfigK },
      } = await proposalProgram.methods
        .initializeProposalConfigV0({
          name,
          voteController: registrar,
          stateController: me,
          onVoteHook: PublicKey.default,
          authority: me,
        })
        .rpcAndKeys();
      proposalConfig = proposalConfigK as PublicKey;
      const proposalK = proposalKey(me, Buffer.from(name, "utf-8"))[0];
      await proposalProgram.methods
        .initializeProposalV0({
          seed: Buffer.from(name, "utf-8"),
          maxChoicesPerVoter: 1,
          name,
          uri: "https://example.com",
          choices: [
            {
              name: "Yes",
              uri: null,
            },
            {
              name: "No",
              uri: null,
            },
          ],
          tags: ["test", "tags"],
        })
        .accountsPartial({
          proposal: proposalK,
          proposalConfig,
        })
        .rpcAndKeys();
      proposal = proposalK as PublicKey;

      await proposalProgram.methods
        .updateStateV0({
          newState: {
            voting: {
              startTs: new anchor.BN(new Date().valueOf() / 1000),
            } as any,
          },
        })
        .accountsPartial({ proposal, proposalConfig })
        .rpc({ skipPreflight: true });
    });

    let voteTestCases = [
      {
        name: "genesis constant 1 position (within genesis)",
        delay: 0, // days
        fastForward: 60, // days
        positions: [
          {
            lockupAmount: 10000,
            periods: 200,
            kind: { constant: {} },
          },
        ],
        expectedVeHnt:
          10000 *
          (GENESIS_MULTIPLIER || 1) *
          (BASELINE + Math.min((SECS_PER_DAY * 200) / MAX_LOCKUP, 1) * SCALE),
      },
      {
        name: "genesis cliff 1 position (within genesis)",
        delay: 0, // days
        fastForward: 60, // days
        positions: [
          {
            lockupAmount: 10000,
            periods: 200,
            kind: { cliff: {} },
          },
        ],
        expectedVeHnt:
          10000 *
          (GENESIS_MULTIPLIER || 1) *
          (BASELINE +
            Math.min((SECS_PER_DAY * (200 - 60)) / MAX_LOCKUP, 1) * SCALE),
      },
      {
        name: "constant 1 positon (outside of genesis)",
        delay: 0, // days
        fastForward: 201, // days
        positions: [
          {
            lockupAmount: 10000,
            periods: 200,
            kind: { constant: {} },
          },
        ],
        expectedVeHnt:
          10000 *
          (BASELINE + Math.min((SECS_PER_DAY * 200) / MAX_LOCKUP, 1) * SCALE),
      },
      {
        name: "cliff 1 position (outside genesis)",
        delay: 7, // days
        fastForward: 60, // days
        positions: [
          {
            lockupAmount: 10000,
            periods: 200,
            kind: { cliff: {} },
          },
        ],
        expectedVeHnt:
          10000 *
          (BASELINE +
            Math.min((SECS_PER_DAY * (200 - 60)) / MAX_LOCKUP, 1) * SCALE),
      },
    ];
    voteTestCases.forEach((testCase) => {
      const depositor = Keypair.generate();
      it("should allow me to vote with " + testCase.name, async () => {
        await program.methods
          .setTimeOffsetV0(new anchor.BN(testCase.delay * SECS_PER_DAY))
          .accountsPartial({ registrar })
          .rpc();

        const instructions: TransactionInstruction[] = [];
        const positions: { position: PublicKey; mint: PublicKey }[] =
          await Promise.all(
            testCase.positions.map((position) =>
              createAndDeposit(
                position.lockupAmount,
                position.periods,
                position.kind,
                depositor
              )
            )
          );

        await program.methods
          .setTimeOffsetV0(
            new anchor.BN(
              (testCase.delay + testCase.fastForward) * SECS_PER_DAY
            )
          )
          .accountsPartial({ registrar })
          .rpc();

        const voteIxs = await Promise.all(
          positions.map(
            async (position) =>
              await program.methods
                .voteV0({
                  choice: 0,
                })
                .accountsPartial({
                  registrar,
                  proposal,
                  proposalConfig,
                  voter: depositor.publicKey,
                  position: position.position,
                  stateController: me,
                  onVoteHook: PublicKey.default,
                })
                .instruction()
          )
        );
        instructions.push(...voteIxs);

        await sendInstructions(provider, instructions, [depositor]);
        const acc = await proposalProgram.account.proposalV0.fetch(proposal!);
        expectBnAccuracy(
          toBN(testCase.expectedVeHnt, 8),
          acc.choices[0].weight,
          0.00001
        );
      });
    });

    describe("with proxy", async () => {
      let delegatee = Keypair.generate();
      let position: PublicKey;
      let mint: PublicKey;
      let proxyAssignment: PublicKey;

      beforeEach(async () => {
        ({ position, mint } = await createAndDeposit(10000, 200));
        const {
          pubkeys: { nextProxyAssignment: proxyAssignmentK },
        } = await proxyProgram.methods
          .assignProxyV0({
            expirationTime: new anchor.BN(new Date().valueOf() / 1000 + 10000),
          })
          .accountsPartial({
            proxyConfig,
            asset: mint,
            recipient: delegatee.publicKey,
          })
          .rpcAndKeys({ skipPreflight: true });

        proxyAssignment = proxyAssignmentK!;
      });

      it("(v0) allows voting on and relinquishing votes on the proposal", async () => {
        const {
          pubkeys: { marker },
        } = await program.methods
          .proxiedVoteV0({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .signers([delegatee])
          .rpcAndKeys({ skipPreflight: true });

        let acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.be.gt(0);
        let markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices).to.deep.eq([0]);

        await program.methods
          .proxiedRelinquishVoteV0({
            choice: 0,
          })
          .accountsPartial({
            mint,
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .signers([delegatee])
          .rpc({ skipPreflight: true });

        acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.eq(0);
        markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices).to.be.empty;
      });

      it("(v0) allows pays the rent for the marker from registrar if possible", async () => {
        await sendInstructions(provider, [
          SystemProgram.transfer({
            fromPubkey: me,
            toPubkey: registrar,
            lamports: LAMPORTS_PER_SOL,
          }),
        ]);
        const registrarBalance = await provider.connection.getBalance(
          registrar
        );
        const positionLamports =
          (await provider.connection.getAccountInfo(position))?.lamports || 0;
        const {
          pubkeys: { marker },
        } = await program.methods
          .proxiedVoteV0({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .signers([delegatee])
          .rpcAndKeys({ skipPreflight: true });

        let acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.be.gt(0);
        let markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.rentRefund?.toBase58()).to.eq(registrar.toBase58());
        const registrarBalance2 = await provider.connection.getBalance(
          registrar
        );
        const positionLamportsNew =
          (await provider.connection.getAccountInfo(position))?.lamports || 0;
        const spentLamports =
          ((await provider.connection.getAccountInfo(marker! as PublicKey))
            ?.lamports || 0) +
          (positionLamportsNew - positionLamports);
        expect(registrarBalance2).to.eq(registrarBalance - spentLamports);
      });

      it("(v1) allows voting on and relinquishing votes on the proposal", async () => {
        await program.methods
          .proxiedVoteV1({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            voter: delegatee.publicKey,
          })
          .signers([delegatee])
          .rpc({ skipPreflight: true });

        const {
          pubkeys: { marker },
        } = await program.methods
          .countProxyVoteV0()
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpcAndKeys({ skipPreflight: true });

        let acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.be.gt(0);
        let markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices).to.deep.eq([0]);

        await program.methods
          .proxiedRelinquishVoteV1({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            voter: delegatee.publicKey,
          })
          .signers([delegatee])
          .rpc({ skipPreflight: true });

        await program.methods
          .countProxyVoteV0()
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpcAndKeys({ skipPreflight: true });

        acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.eq(0);
        markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices).to.be.empty;
      });

      it("(v1) allows pays the rent for the marker from registrar if possible", async () => {
        await sendInstructions(provider, [
          SystemProgram.transfer({
            fromPubkey: me,
            toPubkey: registrar,
            lamports: LAMPORTS_PER_SOL,
          }),
        ]);
        const registrarBalance = await provider.connection.getBalance(
          registrar
        );
        const positionBalance = await provider.connection.getBalance(position);
        await program.methods
          .proxiedVoteV1({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            voter: delegatee.publicKey,
          })
          .signers([delegatee])
          .rpc({ skipPreflight: true });
        const {
          pubkeys: { marker },
        } = await program.methods
          .countProxyVoteV0()
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpcAndKeys({ skipPreflight: true });

        let acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.be.gt(0);
        let markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.rentRefund?.toBase58()).to.eq(registrar.toBase58());
        const registrarBalance2 = await provider.connection.getBalance(
          registrar
        );
        const positionBalance2 = await provider.connection.getBalance(position);
        const spentLamports =
          ((await provider.connection.getAccountInfo(marker! as PublicKey))
            ?.lamports || 0) + (positionBalance2 - positionBalance);
        expect(registrarBalance2).to.eq(registrarBalance - spentLamports);
      });

      it("allows earlier proxies to change the vote", async () => {
        await program.methods
          .proxiedVoteV1({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            voter: delegatee.publicKey,
          })
          .signers([delegatee])
          .rpc({ skipPreflight: true });
        const {
          pubkeys: { marker },
        } = await program.methods
          .countProxyVoteV0()
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpcAndKeys({ skipPreflight: true });

        let acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.be.gt(0);
        let markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices).to.deep.eq([0]);
        expect(markerA?.proxyIndex).to.eq(1);

        await program.methods
          .proxiedRelinquishVoteV1({
            choice: 0,
          })
          .accountsPartial({
            proposal,
            voter: delegatee.publicKey,
          })
          .signers([delegatee])
          .rpc({ skipPreflight: true });
        await program.methods
          .countProxyVoteV0()
          .accountsPartial({
            proposal,
            position,
            voter: delegatee.publicKey,
            proxyAssignment,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpc({ skipPreflight: true });

        acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[0].weight.toNumber()).to.eq(0);
        markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices || []).to.be.empty;

        await program.methods
          .voteV0({
            choice: 1,
          })
          .accountsPartial({
            mint,
            proposal,
            proposalConfig,
            position,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpcAndKeys({ skipPreflight: true });

        acct = await proposalProgram.account.proposalV0.fetch(proposal!);
        expect(acct.choices[1].weight.toNumber()).to.be.gt(0);
        markerA = await program.account.voteMarkerV0.fetchNullable(
          marker! as PublicKey
        );
        expect(markerA?.choices).to.deep.eq([1]);
        expect(markerA?.proxyIndex).to.eq(0);
      });

      it("allows the original owner to undelegate", async () => {
        const toUnProxy = proxyAssignmentKey(
          proxyConfig!,
          mint,
          delegatee.publicKey
        )[0];
        const myProxy = proxyAssignmentKey(
          proxyConfig!,
          mint,
          PublicKey.default
        )[0];
        await proxyProgram.methods
          .unassignProxyV0()
          .accountsPartial({
            proxyAssignment: toUnProxy,
            prevProxyAssignment: myProxy,
            currentProxyAssignment: myProxy,
          })
          .rpc({ skipPreflight: true });

        expect(
          (
            await proxyProgram.account.proxyAssignmentV0.fetch(myProxy)
          ).nextVoter.toBase58()
        ).to.eq(PublicKey.default.toBase58());
        expect(
          await proxyProgram.account.proxyAssignmentV0.fetchNullable(toUnProxy)
        ).to.be.null;
      });
    });

    describe("with an active vote", async () => {
      let position: PublicKey;
      let mint: PublicKey;
      let tokenOwnerRecord: PublicKey;
      let voteRecord: PublicKey;
      let voterWeightRecord: PublicKey;

      beforeEach(async () => {
        ({ position, mint } = await createAndDeposit(10000, 200));

        await program.methods
          .voteV0({
            choice: 0,
          })
          .accountsPartial({
            registrar,
            proposal,
            position,
            proposalConfig,
            stateController: me,
            onVoteHook: PublicKey.default,
          })
          .rpc({ skipPreflight: true });
      });

      it("should not allow me to vote twice", async () => {
        try {
          await program.methods
            .voteV0({
              choice: 0,
            })
            .accountsPartial({
              registrar,
              proposal,
              proposalConfig,
              position,
              stateController: me,
              onVoteHook: PublicKey.default,
            })
            .rpc({ skipPreflight: true });
        } catch (e: any) {
          expect(e.code).to.eq(6044);
        }
      });

      it("doesn't allow transferring", async () => {
        const voter = Keypair.generate();
        const instructions: TransactionInstruction[] = [];
        instructions.push(
          createAssociatedTokenAccountInstruction(
            me,
            await getAssociatedTokenAddress(mint, voter.publicKey),
            voter.publicKey,
            mint
          ),
          await createTransferInstruction(
            await getAssociatedTokenAddress(mint, me),
            await getAssociatedTokenAddress(mint, voter.publicKey),
            me,
            1
          )
        );

        try {
          await sendInstructions(provider, instructions);
        } catch (e: any) {
          console.log(e);
          expect(e.InstructionError[1].Custom).to.eq(17);
        }
      });

      it("should allow me to relinquish my vote", async () => {
        const instructions: TransactionInstruction[] = [];
        instructions.push(
          await program.methods
            .relinquishVoteV1({
              choice: 0,
            })
            .accountsPartial({
              proposal,
              position,
              stateController: me,
              onVoteHook: PublicKey.default,
              proposalConfig,
              registrar,
            })
            .instruction()
        );
        await sendInstructions(provider, instructions);
        const positionAcc = await program.account.positionV0.fetch(position);
        expect(positionAcc.numActiveVotes).to.equal(0);
      });

      it("should not allow me to move tokens to another position while vote is active", async () => {
        const { position: newPos } = await createAndDeposit(10, 185);
        await expect(
          program.methods
            .transferV0({ amount: toBN(10, 8) })
            .accountsPartial({
              sourcePosition: position,
              targetPosition: newPos,
              depositMint: hntMint,
            })
            .rpc()
        ).to.eventually.be.rejectedWith(
          "AnchorError caused by account: source_position. Error Code: ActiveVotesExist. Error Number: 6055. Error Message: Cannot change a position while active votes exist."
        );
      });
    });
  });

  describe("with position", async () => {
    let position: PublicKey;

    beforeEach(async () => {
      ({ position } = await createAndDeposit(100, 184));
    });

    it("should allow me to withdraw and close a position after lockup", async () => {
      await program.methods
        .setTimeOffsetV0(new anchor.BN(185 * SECS_PER_DAY))
        .accountsPartial({ registrar })
        .rpc({ skipPreflight: true });

      await program.methods
        .withdrawV0({ amount: toBN(100, 8) })
        .accountsPartial({ position, depositMint: hntMint })
        .rpc({ skipPreflight: true });

      const positionAccount = await program.account.positionV0.fetch(position);
      expect(positionAccount.amountDepositedNative.toNumber()).to.equal(0);

      await program.methods
        .closePositionV0()
        .accountsPartial({ position })
        .rpc();
      expect(await program.account.positionV0.fetchNullable(position)).to.be
        .null;
    });

    it("allows transfers for ledger users", async () => {
      const approver = loadKeypair(__dirname + "/keypairs/approver-test.json");
      const to = Keypair.generate();

      const positionAccount = await program.account.positionV0.fetch(position);
      const mint = positionAccount.mint;

      await program.methods
        .ledgerTransferPositionV0()
        .accountsPartial({
          to: to.publicKey,
          position,
          mint,
          approver: approver.publicKey,
        })
        .signers([approver, to])
        .rpc({ skipPreflight: true });

      const toBalance = await provider.connection.getTokenAccountBalance(
        getAssociatedTokenAddressSync(mint, to.publicKey)
      );
      expect(toBalance.value.uiAmount).to.equal(1);
    });

    it("should not allow me to withdraw a position before lockup", async () => {
      await expect(
        program.methods
          .withdrawV0({ amount: toBN(100, 8) })
          .accountsPartial({ position, depositMint: hntMint })
          .rpc()
      ).to.be.rejected;
    });

    it("should allow me to extend my lockup", async () => {
      await program.methods
        .resetLockupV0({
          kind: { constant: {} },
          periods: 185,
        })
        .accountsPartial({
          position,
        })
        .rpc({ skipPreflight: true });

      const positionAcc = await program.account.positionV0.fetch(position);
      expect(Boolean(positionAcc.lockup.kind.constant)).to.be.true;
      expect(
        positionAcc.lockup.endTs.sub(positionAcc.lockup.startTs).toNumber()
      ).to.equal(185 * SECS_PER_DAY);
    });

    it("should allow me to move tokens to a position with a greater or equal lockup", async () => {
      const { position: newPos } = await createAndDeposit(10, 185);
      await program.methods
        .transferV0({ amount: toBN(10, 8) })
        .accountsPartial({
          sourcePosition: position,
          targetPosition: newPos,
          depositMint: hntMint,
        })
        .rpc({ skipPreflight: true });

      const newPosAcc = await program.account.positionV0.fetch(newPos);
      const oldPosAcc = await program.account.positionV0.fetch(position);
      expect(newPosAcc.amountDepositedNative.toNumber()).to.equal(
        toBN(20, 8).toNumber()
      );
      expect(oldPosAcc.amountDepositedNative.toNumber()).to.equal(
        toBN(90, 8).toNumber()
      );
    });
  });
});
