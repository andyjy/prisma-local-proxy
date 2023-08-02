import type { NextApiRequest, NextApiResponse } from "next";
import { ExtendedPrismaClient, proxy } from "prisma-local-proxy/server";

// import from wherever you generated the non-Edge version of the Prisma Client:
// (the output path for "client_localproxy" in schema.prisma)
import { PrismaClient } from "../../prisma-local-proxy-client";

const prisma = new PrismaClient();

export default async function prismaLocalProxy(
  req: NextApiRequest,
  res: NextApiResponse
) {
  await proxy(req, res, prisma);
}
