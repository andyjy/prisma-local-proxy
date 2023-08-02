import type { NextApiRequest, NextApiResponse } from "next";

import { prisma } from "../../lib/prisma";

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse
) {
  const fields = prisma.placeholder.fields;
  res.status(200);
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.send(
    JSON.stringify(
      {
        status: "ok",
        runtime: "node",
        example_model_fields: fields,
      },
      undefined,
      2
    )
  );
}
