# Prisma local proxy - test Prisma Edge client locally with local database instead of remote Data Proxy

> This is - currently - in "proof of concept" form. It's being used extensively
> in a project, but the code likely still has rough edges, could do with some tidying,
> and isn't (yet) covered by it's own test suite. (It does pass all integration tests in
> the project I'm using it with).

## Problem

When developing for Edge runtimes (e.g. Cloudflare Workers) we need to use the Prisma Edge client.
This doesn't include the Prisma engine, and instead requires connection to a remote Prisma Data Proxy.
This prevents us from testing locally with a local database connection.

## Solution

This library implements a proxy that enables testing use of the Prisma Edge client with a local database (or any database supported by the normal non-edge Prisma client).

Required elements:

1. Two generated copies of the Prisma client:

   - one with the Edge client (for your app, used in production)

   - the other with the "normal" non-Edge client, to be used by this proxy to query the local database

2. The proxy server itself as defined in `server.ts` running during local development under a HTTP endpoint using the Node.JS runtime - to call the Prisma Query Engine and send the queries to your local database

3. The Prisma Client Extension as defined in `client.ts` applied to your app's Prisma Client during development only (i.e. not in production) - to intercept all queries and send them via the local proxy instead of remote Data Proxy.

## How to set this up

### 1. Generate two copies of the Prisma client, one for each runtime:

In your `schema.prisma` file:

```
// your existing client
generator client {
  provider = "prisma-client-js"
  ...
}

// generate a second client to a different output location
generator client_localproxy {
  provider = "prisma-client-js"

  // generate to whatever output location you choose:
  output   = "./prisma-local-proxy-client"

  ...
}
```

To generate the clients using the `PRISMA_GENERATE_DATAPROXY` environment variable:

```sh
PRISMA_GENERATE_DATAPROXY=1 prisma generate --generator=client
PRISMA_GENERATE_DATAPROXY=0 prisma generate --generator=client_localproxy
```

..or to generate the clients using the `--data-proxy` CLI option:

```sh
prisma generate --generator=client --data-proxy
prisma generate --generator=client_localproxy
```

### 2. Serve the proxy server endpoint under local development

E.g. this Next.JS api route handler:

```typescript
import { ExtendedPrismaClient, proxy } from "prisma-local-proxy";

// import from wherever you generated the non-Edge version of the Prisma Client:
// (the output path for "client_localproxy" in schema.prisma)
import { PrismaClient } from "./prisma-local-proxy-client";

const prisma = new PrismaClient();

export default async function prismaLocalProxy(
  req: NextApiRequest,
  res: NextApiResponse
) {
  await proxy(req, res, prisma);
}
```

(The above is currently implemented as a Next.JS API route handler - but only because this is what I am using. It could be altered to be any generic Node server handler.)

### 3. Under local development, extend your Prisma Client with the proxy Prisma Client Extension from `client.ts`

Required env vars:

```env
# the URL of the proxy endpoint from (2) above:
PRISMA_LOCAL_PROXY=http://localhost:3001/
```

```typescript
import { PrismaClient } from "@prisma/client";

import {
  shouldUsePrismaLocalProxy,
  withLocalProxyPre,
  withLocalProxyPost,
} from "prisma-local-proxy";

function generatePrismaClient() {
  const baseClient = new PrismaClient();

  const applyExtensions = (client: typeof baseClient) => {
    // attach other client extensions required by our app
    const extendedClient = pre.$extends(...);

    return extendedClient;
  }

  if (shouldUsePrismaLocalProxy()) {
    console.info(
      "Edge runtime detected; routing Prisma Client requests via local proxy"
    );

    // withLocalProxyPre() is required *before* any other client extensions
    // but we don't want it to affect the type of our client
    const pre = baseClient.$extends(
      withLocalProxyPre()
    ) as unknown as typeof prismaClient;

    const extendedClient = applyExtensions(prismaClient);

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
  globalForPrisma._prismaClientSingletonUnderDev || prismaGenerator();
if (process.env.NODE_ENV !== "production") {
  globalForPrisma._prismaClientSingletonUnderDev = prisma;
}
```

## Debugging

Set `DEBUG_PRISMA_LOCAL_PROXY=1` to enable debug output from both client + server.
