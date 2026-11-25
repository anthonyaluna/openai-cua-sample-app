import { createServer } from "./server.js";

const port = Number(process.env.PORT ?? 4001);
const host = process.env.HOST ?? "127.0.0.1";

if (!["127.0.0.1", "localhost", "::1"].includes(host) && !process.env.RUNNER_AUTH_TOKEN) {
  throw new Error("RUNNER_AUTH_TOKEN is required when the runner listens beyond loopback.");
}

const server = createServer();

try {
  await server.listen({ port, host });
  console.log(`Runner listening on http://${host}:${port}`);
} catch (error) {
  server.log.error(error);
  process.exit(1);
}
