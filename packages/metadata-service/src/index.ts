import { BN, Program } from "@coral-xyz/anchor";
import cors from "@fastify/cors";
import fastifyStatic from "@fastify/static";
import Address from "@helium/address/build/Address";
import {
  decodeEntityKey,
  entityCreatorKey,
  init,
} from "@helium/helium-entity-manager-sdk";
import { HeliumEntityManager } from "@helium/idls/lib/types/helium_entity_manager";
// @ts-ignore
import {
  Asset,
  DC_MINT,
  HNT_MINT,
  IOT_MINT,
  MOBILE_MINT,
  searchAssets,
  truthy,
} from "@helium/spl-utils";
import animalHash from "angry-purple-tiger";
import axios from "axios";
import bs58 from "bs58";
import Fastify, { FastifyInstance, FastifyRequest } from "fastify";
import { IotHotspotInfo, KeyToAsset, MobileHotspotInfo } from "./model";
import { provider } from "./solana";
import { daoKey } from "@helium/helium-sub-daos-sdk";
import { delegatedDataCreditsKey, escrowAccountKey } from '@helium/data-credits-sdk'
import { subDaoKey } from '@helium/helium-sub-daos-sdk'
import {
  AccountLayout,
  getAssociatedTokenAddressSync,
} from "@solana/spl-token";
import { PublicKey } from "@solana/web3.js";
import { Op } from "sequelize";
import { credentials } from "@grpc/grpc-js";
import { orgClient } from "./proto/generated/iot_config_grpc_pb";
import { org_get_req_v1, org_list_req_v1, org_v1 } from "./proto/generated/iot_config_pb";

const RPC_HOST = process.env.RPC_HOST as string;
const PAGE_SIZE = Number(process.env.PAGE_SIZE) || 10000;
const MODEL_MAP: any = {
  "iot": [IotHotspotInfo, "iot_hotspot_info"],
  "mobile": [MobileHotspotInfo, "mobile_hotspot_info"],
}

export function getOrigin(request: FastifyRequest): string {
  const host = request.headers['x-forwarded-host'] || request.hostname;
  const protocol = request.headers['x-forwarded-proto'] || request.protocol || 'https';
  return `${protocol}://${host}`;
}

export function getAssetUrl(request: FastifyRequest, assetName: string): string {
  return `${getOrigin(request)}/v2/assets/${assetName}`;
}

function generateAssetJson(record: KeyToAsset, keyStr: string, request: FastifyRequest) {
  const digest = animalHash(keyStr);
  // HACK: If it has a long key, it's an RSA key, and this is a mobile hotspot.
  // In the future, we need to put different symbols on different types of hotspots
  const hotspotType = keyStr.length > 100 ? "MOBILE" : "IOT";
  const image = getAssetUrl(request, `hotspot-${hotspotType.toLowerCase()}.png`);

  return {
    name: keyStr === "iot_operations_fund" ? "IOT Operations Fund" : digest,
    description:
      keyStr === "iot_operations_fund"
        ? "IOT Operations Fund"
        : "A Rewardable NFT on Helium",
    image,
    asset_id: record.asset,
    key_to_asset_key: record.address,
    entity_key_b64: record?.entity_key.toString("base64"),
    key_serialization: record?.key_serialization,
    entity_key_str: keyStr,
    hotspot_infos: {
      iot: {
        ...record?.iot_hotspot_info?.dataValues,
        location: record?.iot_hotspot_info?.location
          ? new BN(record.iot_hotspot_info.location).toString("hex")
          : null,
        lat: record?.iot_hotspot_info?.lat,
        long: record?.iot_hotspot_info?.long,
      },
      mobile: {
        ...record?.mobile_hotspot_info?.dataValues,
        location: record?.mobile_hotspot_info?.location
          ? new BN(record.mobile_hotspot_info.location).toString("hex")
          : null,
        lat: record?.mobile_hotspot_info?.lat,
        long: record?.mobile_hotspot_info?.long,
      },
    },
    attributes: [
      keyStr && Address.isValid(keyStr)
        ? { trait_type: "ecc_compact", value: keyStr }
        : undefined,
      { trait_type: "entity_key_string", value: keyStr },
      {
        trait_type: "entity_key",
        value: record?.entity_key?.toString("base64"),
      },
      { trait_type: "rewardable", value: true },
      {
        trait_type: "networks",
        value: [
          record?.iot_hotspot_info && "iot",
          record?.mobile_hotspot_info && "mobile",
        ].filter(truthy),
      },
      ...locationAttributes("iot", record?.iot_hotspot_info),
      ...locationAttributes("mobile", record?.mobile_hotspot_info),
    ],
  };
}

async function getHotspotByKeyToAsset(request, reply) {
  program = program || (await init(provider));
  const { keyToAssetKey } = request.params;

  const record = await KeyToAsset.findOne({
    where: {
      address: keyToAssetKey,
    },
    include: [IotHotspotInfo, MobileHotspotInfo],
  });

  if (!record) {
    const error = {
      statusCode: 404,
      error: "Not Found",
      message: "Hotspot not found"
    }
    return reply.code(404).send(error);
  }

  const { entity_key: entityKey, key_serialization: keySerialization } = record;
  const keyStr = decodeEntityKey(entityKey, { [keySerialization]: {} });

  const assetJson = generateAssetJson(record, keyStr!, request);

  // Needed to make Cloudflare to cache for longer than 1 day
  reply.header("Cloudflare-CDN-Cache-Control", "max-age=31536000");  // 1 year in seconds

  return assetJson;
};

function locationAttributes(
  name: string,
  info: MobileHotspotInfo | IotHotspotInfo | undefined
) {
  if (!info) {
    return [];
  }

  return [
    { trait_type: `${name}_city`, value: info.city },
    { trait_type: `${name}_state`, value: info.state },
    { trait_type: `${name}_country`, value: info.country },
    { trait_type: `${name}_lat`, value: info.lat },
    { trait_type: `${name}_long`, value: info.long },
  ];
}

function encodeCursor(cursor: string | null) {
  if (!cursor) return cursor;

  const bufferObj = Buffer.from(cursor, "utf8");
  return bufferObj.toString("base64");
};

function decodeCursor(cursor?: string) {
  if (!cursor) return cursor;

  const bufferObj = Buffer.from(cursor, "base64")
  return bufferObj.toString("utf8");
};

function createHeliumAddress(buf: Uint8Array): Address {
  const payerKeyFirstByte = buf[0];
  const payerWithoutFirstByte = buf.slice(1);

  const solanaAddress = new PublicKey(payerWithoutFirstByte);
  const heliumAddress = new Address(0, 0, payerKeyFirstByte, solanaAddress.toBytes());

  return heliumAddress;
}

function processOrg(org: org_v1) {
  const oui = org?.getOui();
  const payerU8 = org?.getPayer_asU8() as Uint8Array;
  const ownerU8 = org?.getOwner_asU8() as Uint8Array;
  const delegateKeysU8Arr = org?.getDelegateKeysList_asU8() as Uint8Array[];
  const locked = org?.getLocked();

  const payerAddress = createHeliumAddress(payerU8);
  const ownerAddress = createHeliumAddress(ownerU8);
  const delegateKeysB58Arr = delegateKeysU8Arr.map((key) => {
    const delegateAddress = createHeliumAddress(key);
    return delegateAddress.b58;
  })

  const IOT_SUB_DAO_KEY = subDaoKey(IOT_MINT)[0];
  const delegatedDataCredits = delegatedDataCreditsKey(IOT_SUB_DAO_KEY, payerAddress.b58)[0];
  const escrowTokenAccount = escrowAccountKey(delegatedDataCredits)[0];

  return {
    oui,
    owner: ownerAddress.b58,
    payer: payerAddress.b58,
    escrow: escrowTokenAccount.toBase58(),
    delegate_keys: delegateKeysB58Arr,
    locked,
  }
}

const server: FastifyInstance = Fastify({
  logger: true,
});
server.register(cors, {
  origin: "*",
});
server.register(fastifyStatic, {
  root: __dirname + "/assets",
  prefix: "/v2/assets/",
});
server.get("/health", async () => {
  return { ok: true };
});

server.get("/v2/tokens/hnt", async (request) => {
  return {
    "name": "Helium Network Token",
    "symbol": "HNT",
    "description": "https://helium.com",
    "image": getAssetUrl(request, "hnt.png")
  }
})

server.get("/v2/tokens/mobile", async (request) => {
  return {
    "name": "Helium MOBILE",
    "symbol": "MOBILE",
    "description": "https://helium.com",
    "image": getAssetUrl(request, "mobile.png")
  }
})

server.get("/v2/tokens/iot", async (request) => {
  return {
    "name": "Helium IOT",
    "symbol": "IOT",
    "description": "https://helium.com",
    "image": getAssetUrl(request, "iot.png")
  }
})

server.get("/v2/tokens/dc", async (request) => {
  return {
    "name": "Helium Data Credits",
    "symbol": "DC",
    "description": "https://helium.com",
    "image": getAssetUrl(request, "dc.png")
  }
})

server.get("/v2/merkles", async () => {
  return {
    "2Jwd1qm2LMSrG8bxQ4ikXzvmgm74mZnrBVvq8DSMVUUU": 13,
    "EBxGnvhdHnL8U3fKh1JmKNADCiupgwaHHGRjZwExnope": 11,
    "GHYFhNyiqSPxu3q2a5ENs42iV1zRCfcjCiE7TmzNxni3": 14,
    "BUnvyMc6oi8iqmyYtyhwEDfyd1i28v77jDjJBfap1UV3": 13,
    "GtXtQrbFNinhizKuP3QByoAv4jRHWvgBRZVHHbHGgwN2": 12,
    "4XXCnN2d1kzmhnX7j5w9nAH68oJyA2XjEGVrLHd459tu": 0,
    "E7JbdYSZLvVmqvw6XfEwNQCEAybTF6E1mnrHUXw8hXDV": 15,
    "C9UKRDvtRhXnkqHK1Ba2fpzK2Cwu94JzSdhHLBy8Je1i": 11,
    "8wKvdzBu2kEG5T3maJBX8m2gLs4XFavXzCKiZcGVeS8T": 11,
    "EMoaRr4VozEnY6WKA14Jmhkp5bkPEDJhxYFY4ZCwgRWm": 15,
    "H1AsZuvhDZyqWu8PZtaWMcKnvMEuSiBXocKh8avXdmAj": 12,
    "8ESPyS65YfWXt79cSWUvCkwQaNALRKv7cKWXczC2oiB5": 11,
    "Buto1H4vq8bnxfq8Va5N1krr3wAXSfA4UZ3wk76R7muC": 16,
    "9FfEgLMXRH8aQn77bBZ4v9HbTKg1dcLVzHvhXVyE1jZ3": 11,
    "FMMeuTgrSLTpnscdp5Sh7wtsf84X6RQzrAyUwdyViWBG": 14,
    "AuJT6Vw2YHAYRWV7wwYuYwQWnhHjzv973cgZR1LC36cp": 14,
    "EQ92UMxgeCcbJ4VQ9uSmZ28FK9S4q1KxwwuKcXohrNtJ": 11,
    "C23NdwvbYs1Q4WCjPrjvTzzFSCeVENqkEj8BXJd6rZD1": 14,
    "5woUW7E5paakGqS5NfitiW3T8VdPuHxeiKrwKqv6wNDM": 13,
    "BqbVsb1wNpH9CtMM9xRsbKC11hMTWZBSyvdW5rK3Mq1L": 0,
    "4kYR34KvQsx7qTio4cTwFvbAo6WhuaCKnM4Bf9Dfaqo6": 11,
    "C9gqeeZZFMUFQBZ2X6MoFVn1sUhphkwQ4BKwGqktu9RR": 17,
    "73vVondUFfaGUYBTBXHYrqus65yBH7rdwVYCnek8zTCp": 11,
    "6LFMZiVPkUnc9EVta3sgL8XzE1qdzzavbnTytMCooLzX": 11,
    "9Yn32WbXK8JTVFpx5CGFrPKqbeQ7LE1UZi5bG7k9P4Rv": 14,
    "3vMhiyqFZsBEzTBCWgg1cHwysoVySG3GZ92E97U8RppG": 13,
    "8UhsYMot5TtpDdYjQdaNG7rTjVLZ3S4wM687mn3Vgj9W": 11,
    "F9JbUcxPbe7UzEPvsFCkgcvMXnD6JDt9kYLiXRzEwyJY": 12,
    "8VVgKpqJvNFZRMD3Jnv4QQUH8vVe8FLmNoP37hs45iBy": 2,
    "BPUkacznTsDJQVpGZxoU13SXmpfxA7jnHm7CjHRwc85d": 11,
    "89YtRsRDvzbFYho7XjRU88fpHbaXqzZQSXpcbbBQ8pJv": 11,
    "Di82cwgeGPAPoP8mLjnWSWB7XJpw9fmNir47McqXeVi6": 12,
    "9kcHNYioRNWC1SzSL5NuJHNQrVPcqhHDmrecy7Z1wbKV": 12,
    "8nyQLJWp3nyF73fqmKvonLaZSW4sqDnuqepjQp4vYYxi": 16,
    "FvQWyPz6LnxpvKSqj4dJuPfYRvtz1x8aWg6bCW7zmRWH": 11,
    "6MTM2BF6dGgq56xC3MChJwboP6SkXZdPi1BDkatTjL8D": 15,
    "FtCvpg3mgCfoBZtcoEswUAcHApFnHeoRspc7RPvTZBmL": 11,
    "2s1TWjRJLjDsJanC5KfRkSoh9gri9REcE5ZkdGxfcb7m": 11,
    "2EeAouaXGsbgKVj9ictoePhe2hd416wjM2AWFaXAAzzE": 11,
    "2QJyU5LHWfYxWm9cs28Nu4xB6Pc7jR9DNm3qQMKsJARa": 11,
    "AkWgEecGzLfc55vB9mHSNoeHbfJcmALEDbBR3mrr5yez": 11,
    "3ipgGZz1bWq9pY5eUpfyBVLJQwWjFBsWJxpykXJF3CyM": 11,
    "97puk7SuvRavuVNVn6p9d5kekQGf8qmPmNexuxiXY9Yx": 14,
    "6HHTCDfdgq7YguEf7cff4dGHzqgaq8Q3QhVppv1jy6Zz": 12,
    "3eF7v7My6zNSyU8ctcUXBbY15fsTEdPPgZ38ib6ijZBV": 14,
    "6LvYRfeLm5pZaYqC8jqvcvySg7nXUEdmUXxVXSg8YF3G": 12,
    "EziNojucYkoN5AXPAMXhmUUHiLsUp1nL3BM9gPqsFBRU": 11,
    "9YgvHbCTrRCvBd6ZEMsMAFBmk2SkWkySdYPK98y34F9S": 17,
    "J53f1jfy6QGU8U3qty2MwyNPk68AoybUkigeukDTj356": 11
  }
});

server.get<{ Params: { oui: string } }>(
  "/v2/oui/all",
  async (request, reply) => {
    try {
      const client = new orgClient(RPC_HOST, credentials.createSsl());
      const rpcReq = new org_list_req_v1();

      client.list(rpcReq, (err, resp) => {
        if (err) {
          const errMessage = {
            statusCode: 500,
            error: "Internal Server Error",
            message: err.message ? err.message : "Error making RPC request"
          }
          reply.code(500).send(errMessage);
        }
        if (resp) {
          try {
            const orgList = resp.getOrgsList();
            const orgListJson = orgList.map((org) => processOrg(org));

            reply.header("Cloudflare-CDN-Cache-Control", "max-age=3600"); // 1 hour
            reply.send({ orgs: orgListJson });
          } catch (error: any) {
            const errorMessage = {
              statusCode: 500,
              error: "Internal Server Error",
              message: error.message ? error.message : "Error processing RPC response"
            }
            reply.code(500).send(errorMessage);
          }
        }
      });
    } catch (error: any) {
      const errorMessage = {
        statusCode: 500,
        error: "Internal Server Error",
        message: error.message ? error.message : "Error creating RPC connection"
      }
      reply.code(500).send(errorMessage);
    }

    return reply;
  }
);

server.get<{ Params: { oui: string } }>(
  "/v2/oui/:oui",
  async (request, reply) => {
    try {
      const { oui } = request.params;
      const ouiNum = parseInt(oui);

      if (typeof ouiNum !== 'number' || isNaN(ouiNum)) {
        const error = {
          statusCode: 400,
          error: "Bad Request",
          message: "Invalid OUI ID"
        }
        return reply.code(400).send(error);
      }

      const client = new orgClient(RPC_HOST, credentials.createSsl());

      const rpcReq = new org_get_req_v1();
      rpcReq.setOui(ouiNum);

      client.get(rpcReq, (err, resp) => {
        if (err) {
          const errMessage = {
            statusCode: 500,
            error: "Internal Server Error",
            message: err.message ? err.message : "Error making RPC request"
          }
          reply.code(500).send(errMessage);
        };
        if (resp) {
          try {
            const org = resp.getOrg() as org_v1;
            const orgJson = processOrg(org);

            reply.header("Cloudflare-CDN-Cache-Control", "max-age=3600"); // 1 hour
            reply.send(orgJson);
          } catch (error: any) {
            const errorMessage = {
              statusCode: 500,
              error: "Internal Server Error",
              message: error.message ? error.message : "Error processing RPC response"
            }
            reply.code(500).send(errorMessage);
          }
        }
      });
    } catch (error: any) {
      const errorMessage = {
        statusCode: 500,
        error: "Internal Server Error",
        message: error.message ? error.message : "Error creating RPC connection"
      }
      reply.code(500).send(errorMessage);
    }

    return reply
  }
);

server.get<{ Params: { wallet: string } }>(
  "/v2/wallet/:wallet",
  async (request, reply) => {
    const { wallet } = request.params;
    let page = 1;
    const limit = 1000;
    let allAssets: Asset[] = [];

    while (true) {
      const assets =
        (await searchAssets(provider.connection.rpcEndpoint, {
          ownerAddress: wallet,
          creatorVerified: true,
          creatorAddress: entityCreatorKey(daoKey(HNT_MINT)[0])[0].toBase58(),
          page,
          limit,
        })) || [];

      allAssets = allAssets.concat(assets);

      if (assets.length < limit) {
        break;
      }

      page++;
    }

    const assetIds = allAssets.map((a) => a.id);
    const keyToAssets = await KeyToAsset.findAll({
      where: {
        asset: assetIds.map((a) => a.toBase58()),
      },
      include: [IotHotspotInfo, MobileHotspotInfo],
    });

    const assetJsons = keyToAssets.map((record) => {
      const keyStr = decodeEntityKey(record.entity_key, {
        [record.key_serialization]: {},
      });
      return generateAssetJson(record, keyStr!, request);
    });

    const tokens = [HNT_MINT, MOBILE_MINT, IOT_MINT, DC_MINT];
    const walletPk = new PublicKey(wallet);
    const balances = await Promise.all(
      tokens.map(async (mint) => {
        const account = await provider.connection.getAccountInfo(
          getAssociatedTokenAddressSync(mint, walletPk, true)
        );
        if (account) {
          return {
            mint,
            balance: AccountLayout.decode(account.data).amount.toString(),
          };
        } else {
          return { mint, balance: "0" };
        }
      })
    );

    reply.header("Cloudflare-CDN-Cache-Control", "no-cache");

    return {
      hotspots_count: assetJsons.length,
      hotspots: assetJsons,
      balances,
    };
  }
);

server.get<{ Querystring: { subnetwork: string } }>(
  "/v2/hotspots/pagination-metadata",
  async (request, reply) => {
    const { subnetwork } = request.query;

    if (!MODEL_MAP[subnetwork]) {
      const error = {
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid subnetwork"
      }
      return reply.code(400).send(error);
    }

    const count = await KeyToAsset.count({
      include: [
        {
          model: MODEL_MAP[subnetwork][0],
          required: true,
        },
      ],
    });

    let result = {
      pageSize: PAGE_SIZE,
      totalItems: count,
      totalPages: Math.ceil(count / PAGE_SIZE),
    };

    reply.header("Cloudflare-CDN-Cache-Control", "no-cache");

    return result;
  }
);

server.get<{ Querystring: { subnetwork: string; cursor?: string; } }>(
  "/v2/hotspots",
  async (request, reply) => {
    const { subnetwork, cursor } = request.query;

    if (!MODEL_MAP[subnetwork]) {
      const error = {
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid subnetwork"
      }
      return reply.code(400).send(error);
    }

    const decodedCursor = decodeCursor(cursor);

    if (decodedCursor && !decodedCursor.includes("|")) {
      const error = {
        statusCode: 400,
        error: "Bad Request",
        message: "Invalid cursor"
      }
      return reply.code(400).send(error);
    }

    let where: any = {}
    if (decodedCursor?.includes("|")) {
      const [lastAsset, lastCreatedAt] = decodedCursor.split("|");
      where = {
        [Op.or]: [
          {
            created_at: {
              [Op.gt]: lastCreatedAt
            }
          },
          {
            [Op.and]: [
              { created_at: lastCreatedAt },
              { asset: { [Op.gt]: lastAsset } }
            ]
          }
        ]
      }
    }

    const ktas = await KeyToAsset.findAll({
      limit: PAGE_SIZE,
      include: [
        {
          model: MODEL_MAP[subnetwork][0],
          required: true,
          where,
        },
      ],
      order: [
        [MODEL_MAP[subnetwork][0], "created_at", "ASC"],
        [MODEL_MAP[subnetwork][0], "asset", "ASC"],
      ],
    });

    const lastItemTable = MODEL_MAP[subnetwork][1];
    const lastItem = ktas[ktas.length - 1];
    const lastItemAsset = lastItem[lastItemTable]?.asset;
    const lastItemDate = lastItem[lastItemTable]?.created_at.toISOString();
    const isLastPage = ktas.length < PAGE_SIZE;
    const nextCursor = isLastPage
      ? null
      : `${lastItemAsset}|${lastItemDate}`;

    let result = {
      cursor: encodeCursor(nextCursor),
      items: [] as { key_to_asset_key: string }[],
    };

    result.items = ktas.map((kta) => {
      return {
        key_to_asset_key: kta.address,
        entity_key_str: decodeEntityKey(kta.entity_key, { [kta.key_serialization]: {} }),
        is_active: kta[lastItemTable]?.is_active,
        lat: kta[lastItemTable]?.lat,
        long: kta[lastItemTable]?.long,
      };
    });

    if (isLastPage) {
      reply.header("Cloudflare-CDN-Cache-Control", "no-cache");
    } else {
      reply.header("Cloudflare-CDN-Cache-Control", "max-age=86400");  // 1 day in seconds

    }

    return result;
  }
);

let program: Program<HeliumEntityManager>;
server.get<{ Params: { keyToAssetKey: string } }>(
  "/v1/:keyToAssetKey",
  getHotspotByKeyToAsset
);

server.get<{ Params: { keyToAssetKey: string } }>(
  "/v2/hotspot/:keyToAssetKey",
  getHotspotByKeyToAsset
);

server.get<{ Params: { eccCompact: string } }>(
  "/:eccCompact",
  async (request, reply) => {
    const { eccCompact } = request.params;

    // TODO: Remove this once we can update compressed nft metadata
    if (eccCompact?.length === 22) {
      try {
        const { data } = await axios(
          `https://sol.hellohelium.com/api/metadata/${eccCompact}`
        );
        return data;
      } catch (e: any) {
        console.error(e);
      }
    }

    const record = await KeyToAsset.findOne({
      where: {
        entity_key: bs58.decode(eccCompact),
      },
      include: [IotHotspotInfo, MobileHotspotInfo],
    });

    if (!record) {
      const error = {
        statusCode: 404,
        error: "Not Found",
        message: "Hotspot not found"
      }
      return reply.code(404).send(error);
    }

    const assetJson = generateAssetJson(record, eccCompact, request);

    // Needed to make Cloudflare to cache for longer than 1 day
    reply.header("Cloudflare-CDN-Cache-Control", "max-age=31536000");  // 1 year in seconds

    return assetJson;
  }
);

const start = async () => {
  try {
    await server.listen({ port: 8081, host: "0.0.0.0" });

    const address = server.server.address();
    const port = typeof address === "string" ? address : address?.port;
    console.log(`Running on 0.0.0.0:${port}`);
  } catch (err) {
    server.log.error(err);
    process.exit(1);
  }
};
start();
