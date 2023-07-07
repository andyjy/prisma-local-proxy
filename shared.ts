/* eslint-disable no-console, security-node/detect-crlf */

declare global {
  // eslint-disable-next-line no-var
  var isPrismaLocalProxy: boolean;
}

export function debug(msg: unknown) {
  if (
    !process.env.DEBUG_PRISMA_LOCAL_PROXY &&
    !process.env.DEBUG?.includes("prisma")
  ) {
    return;
  }
  if (typeof msg === "string") {
    console.log(`${new Date().toISOString()} ${msg}`);
  } else {
    console.dir(msg);
  }
}
