import { PrismaClient } from "@prisma/client/edge";

import {
  getConnectionString,
  shouldUsePrismaLocalProxy,
  withLocalProxyPre,
  withLocalProxyPost,
} from "prisma-local-proxy/client";

// attach any other Prisma Client extensions required by our app
// we encapsulate this in a function so we can call it separately
// for dev vs. production, below:
const applyExtensions = (client: PrismaClient) => {
  const extendedClient = client; //.$extends(...);
  return extendedClient;
};

function generatePrismaClient() {
  const baseClient = new PrismaClient({
    datasources: {
      db: { url: getConnectionString(process.env.DATABASE_URL ?? "") },
    },
  });

  if (shouldUsePrismaLocalProxy()) {
    console.info(
      "Edge runtime detected; routing Prisma Client requests via local proxy"
    );

    // withLocalProxyPre() is required *before* any other client extensions
    // but we don't want it to affect the type of our client
    const pre = baseClient.$extends(
      withLocalProxyPre()
    ) as unknown as typeof baseClient;

    const extendedClient = applyExtensions(pre);

    // withLocalProxyPost() is required *after* any other client extensions
    // but we don't want it to affect the type of our client
    return extendedClient.$extends(
      withLocalProxyPost()
    ) as unknown as typeof extendedClient;
  } else {
    // in production - just apply any other extensions as required
    return applyExtensions(baseClient);
  }
}

// export Prisma Client instance according to best practice
// - see https://www.prisma.io/docs/guides/performance-and-optimization/connection-management#prevent-hot-reloading-from-creating-new-instances-of-prismaclient

export type PrismaClientExtended = ReturnType<typeof generatePrismaClient>;

const globalForPrisma = global as typeof globalThis & {
  _prismaClientSingletonUnderDev?: PrismaClientExtended;
};

export const prisma: PrismaClientExtended =
  globalForPrisma._prismaClientSingletonUnderDev || generatePrismaClient();
if (process.env.NODE_ENV !== "production") {
  globalForPrisma._prismaClientSingletonUnderDev = prisma;
}
