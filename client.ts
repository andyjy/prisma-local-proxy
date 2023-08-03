import { AsyncLocalStorage } from "node:async_hooks";
import { SerializedRecord, deserialize } from "@ungap/structured-clone";

import type { Prisma } from "@prisma/client/extension";

import { debug } from "./shared";

/* eslint-disable @typescript-eslint/no-explicit-any */

// This is a variable that Next.js will string replace during build with a string if run in an edge runtime from Next.js
// v12.2.1-canary.3 onwards:
// https://github.com/vercel/next.js/blob/166e5fb9b92f64c4b5d1f6560a05e2b9778c16fb/packages/next/build/webpack-config.ts#L206
declare const EdgeRuntime: string | undefined;
function isEdgeRuntime(): boolean {
  return typeof EdgeRuntime === "string";
}

const defineExtension = ((ext) => {
  if (typeof ext === "function") {
    return ext;
  }
  return (client) => client.$extends(ext);
}) as typeof Prisma.defineExtension;

const inTransaction = new AsyncLocalStorage<{
  options: any;
  txId: string;
  parentTxId?: string;
}>();

export function shouldUsePrismaLocalProxy(databaseUrl?: string): boolean {
  return (
    (isEdgeRuntime() || !!process.env.FORCE_PRISMA_LOCAL_PROXY) &&
    !isPrismaLocalProxy() &&
    (!databaseUrl || !databaseUrl?.startsWith("prisma://"))
  );
}

export function getConnectionString(defaultUrl: string) {
  if (shouldUsePrismaLocalProxy()) {
    return `prisma://${process.env.PRISMA_LOCAL_PROXY?.replace(
      "http://",
      ""
    )}?api_key=dummy`;
  }
  return defaultUrl;
}

export function isPrismaLocalProxy(): boolean {
  return !!globalThis.isPrismaLocalProxy;
}

// 1. first we override $transaction() to:
// - generate a transaction ID for the local proxy; passed via AsyncLocalStorage
// - make a final call to our local proxy to commit the transaction at the end
//
// this needs to be the first client extension applied, so that any subsequent extensions
// that use $transaction will use our override (e.g. Row Level Security)
export function withLocalProxyPre() {
  return defineExtension((prisma) => {
    let finalPrismaClient: typeof Prisma;

    const addClientMethods = {
      // callback to set a reference to the final Prisma client after all extensions have been applied
      // so we pass it to interactive transactions correctly
      $setFinalClient(prismaClient: typeof Prisma) {
        finalPrismaClient = prismaClient;
      },
      async $transaction(batchOrFn: any, options?: any) {
        const txId =
          typeof EdgeRuntime === "string"
            ? crypto.randomUUID()
            : (await import("crypto")).randomUUID();

        const existingInteractiveTxId = inTransaction.getStore()?.txId;

        const logInfo = `withLocalProxyPre: $transaction override: ${
          Array.isArray(batchOrFn) ? "batch" : "interactive"
        }; ${Array.isArray(batchOrFn) ? batchOrFn.length : ""}`;

        if (existingInteractiveTxId) {
          debug(`[${existingInteractiveTxId} -> nested tx:${txId}] ${logInfo}`);
        } else {
          debug(`[${txId}] ${logInfo}`);
        }

        return inTransaction.run(
          { options, txId, parentTxId: existingInteractiveTxId },
          async () => {
            let result: any;
            try {
              if (typeof batchOrFn === "function") {
                await callLocalProxy({
                  operation: "$start",
                  parentTransactionUUID: inTransaction.getStore()?.parentTxId,
                  transactionUUID: inTransaction.getStore()?.txId,
                  transactionOptions: inTransaction.getStore()?.options,
                });
                result = await batchOrFn(finalPrismaClient);
              } else {
                result = [];
                for (const request of batchOrFn) {
                  result.push(await request);
                }
              }
            } catch (e) {
              debug(`$transaction exception: ${e} - calling $cleanup`);
              await callLocalProxy({
                operation: "$cleanup",
                parentTransactionUUID: inTransaction.getStore()?.parentTxId,
                transactionUUID: inTransaction.getStore()?.txId,
              });
              throw e;
            }
            await callLocalProxy({
              operation: "$commit",
              parentTransactionUUID: inTransaction.getStore()?.parentTxId,
              transactionUUID: inTransaction.getStore()?.txId,
            });
            return result;
          }
        );
      },
    };

    return prisma.$extends({
      name: "local-proxy",
      // $setFinalClient() is for internal use by the withLocalProxyPost extension only
      // so we exclude it from our extended Prisma client types
      client: addClientMethods as Omit<
        typeof addClientMethods,
        "$setFinalClient"
      >,
    });
  });
}

// 2. finally we override $allOperations() to call our local proxy instead of
// the usual Prisma client methods. This must be applied after all other
// client extensions, so that any other overrides are applied first and not bypassed
// (since we don't eventually call `query(args)` here, but instead call our local proxy directly)
export function withLocalProxyPost() {
  return defineExtension((prisma) => {
    const extended = prisma.$extends({
      name: "local-proxy",
      query: {
        async $allOperations({ args, model, operation }) {
          debug(`prisma $allOperations: ${model}.${operation}`);
          const callback = async () => {
            const result = await callLocalProxy({
              args,
              model,
              operation,
              parentTransactionUUID: inTransaction.getStore()?.parentTxId,
              transactionUUID: inTransaction.getStore()?.txId,
              transactionOptions: inTransaction.getStore()?.options,
            });
            debug(
              `local proxy result (${model}.${operation}): ${JSON.stringify(
                result
              )}`
            );
            return result;
          };

          const result: Prisma.PrismaPromise<unknown> & {
            requestTransaction: () => Promise<any>;
            _model?: string;
            _operation?: string;
          } = {
            then(onFulfilled, onRejected) {
              return callback().then(onFulfilled, onRejected);
            },
            catch(onRejected) {
              return callback().catch(onRejected);
            },
            finally(onFinally) {
              return callback().finally(onFinally);
            },

            requestTransaction() {
              const promise = callback();
              // if (promise.requestTransaction) {
              //   // we want to have support for nested promises
              //   return promise.requestTransaction(batchTransaction);
              // }
              return promise;
            },
            [Symbol.toStringTag]: "PrismaPromise",
            _model: model,
            _operation: operation,
          };
          return result;
        },
      },
    });
    if ("$setFinalClient" in prisma) {
      (prisma.$setFinalClient as any)(extended);
    }
    return extended;
  });
}

async function callLocalProxy(body: any) {
  const proxyEndpoint = process.env.PRISMA_LOCAL_PROXY;
  if (!proxyEndpoint) {
    throw new Error("env.PRISMA_LOCAL_PROXY must be set to use local proxy");
  }
  let result: Response;
  try {
    result = await fetch(proxyEndpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        ...body,
      }),
    });
  } catch (e) {
    throw new Error(
      `Prisma Local Proxy: failed to get successful result from proxy, is the local proxy service running?\nfetch() error was: ${e}`
    );
  }
  let resultData, bodyJson;
  try {
    bodyJson = await result.json();
    resultData = deserialize(bodyJson);
  } catch (e) {
    try {
      // example bodyJson in case of Error:
      // [[2,[[1,2]]],[0,"error"],[7,{"name":"PrismaClientKnownRequestError","message":"..."}]]
      if (Array.isArray(bodyJson)) {
        const error = bodyJson[2][1];
        error.name = "Error";
        resultData = deserialize(bodyJson as SerializedRecord);
      } else {
        throw e;
      }
    } catch (e) {
      debug(
        `Prisma Local Proxy deserialize error: ${e}; ${JSON.stringify(
          bodyJson
        )}`
      );
      throw new Error(
        `local proxy error (${body.model ?? ""}.${body.operation}): ${e}`
      );
    }
  }
  if (result.ok) {
    return resultData;
  } else {
    const error = resultData.error;
    debug(
      `Prisma Local Proxy error: ${typeof error} ${error instanceof Error} ${
        "name" in error ? error.name : ""
      } ${"message" in error ? error.message : ""}`
    );
    throw error;
  }
}
