import type { NextRequest } from "next/server";

import { prisma } from "../../lib/prisma";

export const config = {
  runtime: "edge",
};

export default async function handler(req: NextRequest) {
  const fields = prisma.placeholder.fields;

  return new Response(
    JSON.stringify(
      {
        status: "ok",
        runtime: "edge",
        example_model_fields: fields,
      },
      undefined,
      2
    ),
    {
      status: 200,
      headers: { "Content-Type": "application/json; charset=utf-8" },
    }
  );
}
