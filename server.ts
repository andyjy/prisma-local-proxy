import type { NextApiRequest, NextApiResponse } from "next";
import type { PrismaClient } from "@prisma/client/extension";

import { Sql } from "sql-template-tag";
import { serialize } from "@ungap/structured-clone";

import { debug as sharedDebug } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

export type ExtendedPrismaClient = Omit<
  PrismaClient,
  "$on" | "$use" | "$extends" | "$transaction"
> & { $transaction: (...args: any[]) => Promise<any> };

type TransactionOptions = {
  maxWait?: number;
  timeout?: number;
};

interface TransactionHandler {
  commit: () => Promise<void>;
  exec: (args: any) => Promise<any>;
  nestedTransaction: (txId: string) => Promise<TransactionHandler>;
}

type Context = {
  options: any;
  txId: string;
  parentTxId?: string;
};

globalThis.isPrismaLocalProxy = true;

const transactionQueue = new Map<string, TransactionHandler>();

function transactionHandler(
  prisma: ExtendedPrismaClient,
  txid: string,
  ctx: Context,
  options?: TransactionOptions,
  parentTxId?: string
) {
  const debug = debugFn(ctx);

  let commit: () => Promise<void>,
    exec: (args: any) => Promise<any>,
    nestedPrismaClient: Promise<ExtendedPrismaClient> = Promise.resolve(prisma);

  if (!parentTxId) {
    if (!("$transaction" in prisma)) {
      // not expected at runtime - just hint for type checking
      throw new Error(
        "prismaLocalProxy: shouldn't be here, prisma.$transaction() missing"
      );
    }
    let resolvePrismaTxClient: (value: ExtendedPrismaClient) => void,
      rejectPrismaTxClient: (reason?: any) => void;
    const prismaTxClient = new Promise<ExtendedPrismaClient>(
      (resolve, reject) => {
        resolvePrismaTxClient = resolve;
        rejectPrismaTxClient = reject;
      }
    );

    let resolveInteractiveTxn: (value: unknown) => void;
    const resolveInteractiveTxnFn = new Promise((resolve) => {
      resolveInteractiveTxn = resolve;
    });

    let txnException: unknown;
    debug(
      `transactionHandler: starting $transaction() with options ${JSON.stringify(
        options
      )}`
    );
    const tx = prisma
      .$transaction((prisma: ExtendedPrismaClient) => {
        debug(`$transaction start`);
        resolvePrismaTxClient(prisma);
        return new Promise((resolve, reject) => {
          debug(`$transaction Promise`);
          void resolveInteractiveTxnFn
            .then((value: unknown) => {
              debug(`$transaction Promise resolved`);
              resolve(value);
            })
            .catch((reason: any) => {
              debug(`$transaction Promise rejected`);
              reject(reason);
            });
        }) as any;
      }, options)
      .catch((e) => {
        debug(`transactionHandler: exception starting $transaction(): ${e}`);
        txnException = e;
        rejectPrismaTxClient(e);
      });

    const ensureNoException = (logInfo: string) => {
      if (txnException) {
        debug(
          `transactionHandler (${logInfo}): throwing exception from $transaction() start: ${txnException}`
        );
        throw txnException;
      }
    };

    commit = async () => {
      debug(`COMMIT!`);
      resolveInteractiveTxn(null);
      ensureNoException("commit");
      await tx;
      debug(`transaction closed`);
    };
    exec = async (body: any) => {
      debug(`exec!`);
      ensureNoException("exec");
      let prisma: Awaited<typeof prismaTxClient>;
      try {
        debug(`exec: awaiting prismaTxClient`);
        prisma = await prismaTxClient;
        debug(`exec: successfully awaited prismaTxClient`);
      } catch (e) {
        debug(`exec error awaiting prismaTxClient: ${e}`);
        throw e;
      }
      return await execQuery(prisma, body);
    };

    nestedPrismaClient = prismaTxClient;
  } else {
    commit = async () => {
      debug(`nested tx commit - no action taken`);
      return Promise.resolve();
    };
    exec = async (body: any) => {
      debug(`nested tx exec!`);
      return await execQuery(prisma, body);
    };
  }
  return {
    commit,
    exec,
    nestedTransaction: async (nestedTxId: string) => {
      return transactionHandler(
        await nestedPrismaClient,
        nestedTxId,
        ctx,
        undefined,
        txid
      );
    },
  };
}

async function execQuery(prisma: any, body: any) {
  const debug = debugFn({
    options: body.transactionOptions,
    txId: body.transactionUUID,
    parentTxId: body.parentTransactionUUID,
  });

  try {
    const modelKey = body.model
      ? `${String(body.model).substring(0, 1).toLowerCase()}${String(
          body.model
        ).substring(1)}`
      : undefined;

    let result: any;

    if (modelKey) {
      const model: any = prisma[modelKey as any];
      if (!model) {
        throw new Error(`prismaLocalProxy: model ${modelKey} not found`);
      }
      const fn = model[body.operation] as (
        ...args: any[]
      ) => Promise<any> | undefined;
      if (!fn) {
        throw new Error(
          `prismaLocalProxy: ${model}.${body.operation} not found`
        );
      }
      try {
        result = await fn.bind(model)(body.args);
      } catch (e) {
        debug(`prismaLocalProxy: ${modelKey}.${body.operation} failed: ${e}`);
        throw e;
      }
    } else {
      const topLevelFn = prisma[body.operation] as unknown as (
        ...args: any[]
      ) => Promise<any>;
      if (!topLevelFn) {
        throw new Error(
          `prismaLocalProxy: top level function ${body.operation} not found`
        );
      }
      const args = body.args;
      if (["$executeRaw", "$queryRaw"].includes(body.operation)) {
        const argsTemplate = new Sql(args.strings, args.values);
        try {
          result = await topLevelFn.bind(prisma)(argsTemplate, ...args.values);
        } catch (e) {
          debug(`prismaLocalProxy: ${body.operation} failed: ${e}`);
          throw e;
        }
      } else {
        try {
          result = await topLevelFn.bind(prisma)(...args);
        } catch (e) {
          debug(`prismaLocalProxy: ${body.operation} failed: ${e}`);
          throw e;
        }
      }
    }

    sharedDebug({
      model: body.model,
      operation: body.operation,
      txid: body.transactionUUID,
      result:
        result && Object.keys(result).length > 0
          ? "<object>"
          : typeof result !== "object"
          ? result
          : "<empty>",
    });

    return result;
  } catch (e) {
    debug(`prismaLocalProxy: execQuery failed: ${e}`);
    throw e;
  }
}

export async function proxy(
  req: NextApiRequest,
  res: NextApiResponse,
  prisma: ExtendedPrismaClient,
  defaultTransactionOptions?: TransactionOptions
) {
  const ctx = {
    options: req.body.transactionOptions,
    txId: req.body.transactionUUID,
    parentTxId: req.body.parentTransactionUUID,
  };
  const debug = debugFn(ctx);

  try {
    debug(
      `prismaLocalProxy: ${JSON.stringify(req.body)}, handler count: ${
        transactionQueue.size
      }`
    );

    if (req.body.transactionUUID) {
      let handler: TransactionHandler | undefined = transactionQueue.get(
        req.body.transactionUUID
      );
      if (!handler) {
        if (req.body.parentTransactionUUID) {
          const parentHandler = transactionQueue.get(
            req.body.parentTransactionUUID
          );
          if (!parentHandler) {
            throw new Error(
              `prismaLocalProxy: parent transaction ${req.body.parentTransactionUUID} not found`
            );
          }
          handler = await parentHandler.nestedTransaction(
            req.body.transactionUUID
          );
        } else {
          handler = transactionHandler(prisma, req.body.transactionUUID, ctx, {
            ...defaultTransactionOptions,
            ...req.body.transactionOptions,
          });
        }
        transactionQueue.set(req.body.transactionUUID, handler);
      }
      if (req.body.operation === "$commit") {
        const result = await handler.commit();
        transactionQueue.delete(req.body.transactionUUID);
        res.json(serialize({ transactionCommitResult: result }));
      } else if (req.body.operation === "$cleanup") {
        transactionQueue.delete(req.body.transactionUUID);
        res.json(serialize({ cleanup: true }));
      } else if (req.body.operation === "$start") {
        res.json(serialize({ started: true }));
      } else {
        const result = await handler.exec(req.body);
        res.json(serialize(result));
      }
    } else {
      const result = await execQuery(prisma, req.body);
      res.json(serialize(result));
    }
  } catch (e) {
    res.status(500);
    res.json(serialize({ error: e }));
    if (e && typeof e === "object") {
      if (
        "code" in e &&
        ["P2002", "P2003", "P2004", "P2028"].includes(`${e.code}`)
      ) {
        // https://www.prisma.io/docs/reference/api-reference/error-reference:
        // - P2002-P2004 are "unique constraint" errors
        // - P2028 is Transaction API errors
        //   (e.g. "unable to start a transaction in the given time")
        // eslint-disable-next-line no-console
        console.warn(
          `${new Date().toISOString()} prismaLocalProxy: Prisma error: ${
            e.code
          } ${e}`
        );
      } else if ("name" in e && e.name == "PrismaClientUnknownRequestError") {
        // eslint-disable-next-line no-console
        console.warn(
          `${new Date().toISOString()} prismaLocalProxy: PrismaClientUnknownRequestError error: ${e}`
        );
      } else {
        debug(`prismaLocalProxy.proxy: error: ${e}`);
        throw e;
      }
    } else {
      debug(`prismaLocalProxy.proxy: error: ${e}`);
      throw e;
    }
  }
  debug(`prismaLocalProxy.proxy: done`);
}

function debugFn(ctx: Context) {
  return (msg: string) =>
    sharedDebug(
      `[${ctx.parentTxId ? `${ctx.parentTxId} -> ` : ""}${ctx.txId}] ${msg}`
    );
}
