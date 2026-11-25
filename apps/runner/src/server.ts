import { constants } from "node:fs";
import { open, readlink, realpath } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

import Fastify, { type FastifyReply } from "fastify";

import {
  runDetailSchema,
  runnerErrorResponseSchema,
  scenarioWorkspaceStateSchema,
  scenariosResponseSchema,
  startRunRequestSchema,
  startRunResponseSchema,
  type RunEvent,
} from "@cua-sample/replay-schema";
import {
  RunnerCoreError,
  RunnerManager,
  toRunnerErrorResponse,
} from "@cua-sample/runner-core";
import { listScenarios } from "@cua-sample/scenario-kit";

type CreateServerOptions = {
  dataRoot?: string;
  manager?: RunnerManager;
  stepDelayMs?: number;
  authToken?: string;
  host?: string;
  webOrigin?: string;
};

const defaultDataRoot = fileURLToPath(new URL("../../../data", import.meta.url));

function isLoopback(address: string | undefined) {
  return address === "localhost" || address === "127.0.0.1" ||
    address === "::1" || address === "::ffff:127.0.0.1";
}

function missingArtifact() {
  return new RunnerCoreError("Screenshot artifact not found", {
    code: "artifact_not_found",
    hint: "Refresh the run detail and choose a screenshot that still exists on disk.",
    statusCode: 404,
  });
}

function writeSseEvent(reply: FastifyReply, payload: unknown) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

export function createServer(options: CreateServerOptions = {}) {
  const resolvedDataRoot = resolve(options.dataRoot ?? defaultDataRoot);
  const managerOptions = {
    dataRoot: resolvedDataRoot,
    ...(options.stepDelayMs === undefined
      ? {}
      : { stepDelayMs: options.stepDelayMs }),
  };
  const manager = options.manager ?? new RunnerManager(managerOptions);
  const host = options.host ?? process.env.HOST ?? "127.0.0.1";
  const authToken = (options.authToken ?? process.env.RUNNER_AUTH_TOKEN)?.trim();
  if (!isLoopback(host) && !authToken) {
    throw new Error("RUNNER_AUTH_TOKEN is required when the runner listens beyond loopback.");
  }
  const webOrigin = options.webOrigin ?? process.env.RUNNER_WEB_ORIGIN ?? "http://127.0.0.1:3000";
  const parsedOrigin = new URL(webOrigin);
  if (!["http:", "https:"].includes(parsedOrigin.protocol) || parsedOrigin.origin !== webOrigin) {
    throw new Error("RUNNER_WEB_ORIGIN must be an exact HTTP or HTTPS origin.");
  }
  const app = Fastify({ logger: false });

  app.addHook("onRequest", async (request, reply) => {
    const origin = request.headers.origin;
    reply.header("Vary", "Origin");
    if (origin !== undefined) {
      if (origin !== webOrigin) {
        return reply.code(403).send({ code: "origin_not_allowed", error: "The request origin is not allowed." });
      }
      reply.header("Access-Control-Allow-Origin", webOrigin);
      reply.header("Access-Control-Allow-Headers", "Authorization, Content-Type");
      reply.header("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    }

    const localHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]+)?$/i.test(request.headers.host ?? "");
    const bound = request.socket.localAddress;
    const remote = !isLoopback(host) || !isLoopback(request.ip) || !localHost ||
      (bound !== undefined && !isLoopback(bound));
    if (remote && !authToken) {
      return reply.code(503).send({ code: "remote_auth_not_configured", error: "Remote runner authentication is not configured." });
    }
    const preflight = request.method === "OPTIONS" && origin === webOrigin;
    if (remote && !preflight && request.routeOptions.url !== "/health" &&
        request.headers.authorization !== `Bearer ${authToken}`) {
      return reply.code(401).send({ code: "unauthorized", error: "A valid runner bearer token is required." });
    }

    if (request.routeOptions.url?.startsWith("/api/runs/:id")) {
      const { id, name } = request.params as { id: string; name?: string };
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(id)) {
        if (name !== undefined) throw missingArtifact();
        throw new RunnerCoreError("Run not found", {
          code: "run_not_found", hint: "Start a new run and use its returned ID.", statusCode: 404,
        });
      }
    }
  });

  app.options("*", async (_request, reply) => {
    reply.code(204);
    return null;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof RunnerCoreError) {
      reply.code(error.statusCode).send(
        runnerErrorResponseSchema.parse(toRunnerErrorResponse(error)),
      );
      return;
    }

    if (error instanceof Error && "issues" in error) {
      reply.code(400).send(
        runnerErrorResponseSchema.parse({
          code: "invalid_request",
          error: error.message,
          hint:
            "Review the request payload against the published replay-schema contracts.",
        }),
      );
      return;
    }

    reply.code(500).send(
      runnerErrorResponseSchema.parse({
        code: "internal_runner_error",
        error: "Internal runner error",
        hint: "Check the runner logs for the full stack trace.",
      }),
    );
  });

  app.get("/health", async () => ({
    status: "ok",
    service: "runner",
  }));

  app.get("/api/scenarios", async () =>
    scenariosResponseSchema.parse(listScenarios()),
  );

  app.post("/api/scenarios/:id/reset", async (request) =>
    scenarioWorkspaceStateSchema.parse(
      await manager.resetScenario(
        (request.params as { id: string }).id,
      ),
    ),
  );

  app.post("/api/runs", async (request, reply) => {
    const input = startRunRequestSchema.parse(request.body);

    if (input.mode === "code") {
      throw new RunnerCoreError(
        "Code mode is disabled for remote run requests.",
        {
          code: "remote_code_mode_disabled",
          hint: "Use native computer mode for remote runs.",
          statusCode: 403,
        },
      );
    }

    const detail = await manager.startRun(input);

    reply.code(202);

    return startRunResponseSchema.parse({
      eventStreamUrl: detail.eventStreamUrl,
      replayUrl: detail.replayUrl,
      runId: detail.run.id,
      status: detail.run.status,
    });
  });

  app.get("/api/runs/:id", async (request) =>
    runDetailSchema.parse(
      await manager.getRunDetail((request.params as { id: string }).id),
    ),
  );

  app.post("/api/runs/:id/stop", async (request) =>
    runDetailSchema.parse(
      await manager.stopRun((request.params as { id: string }).id),
    ),
  );

  app.get("/api/runs/:id/replay", async (request) =>
    manager.getReplayBundle((request.params as { id: string }).id),
  );

  app.get("/api/runs/:id/artifacts/screenshots/:name", async (request, reply) => {
    const params = request.params as { id: string; name: string };
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(params.id) ||
      !/^[A-Za-z0-9][A-Za-z0-9._-]*\.png$/.test(params.name) ||
      params.name.includes("..")
    ) {
      throw missingArtifact();
    }

    try {
      const root = await realpath(resolvedDataRoot);
      const path = join(root, "runs", params.id, "screenshots", params.name);
      if (await realpath(path) !== path) throw missingArtifact();
      const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
      try {
        // On Linux verify the kernel path of the open file before reading it,
        // including ancestors that could have changed after path validation.
        if (process.platform === "linux" && await readlink(`/proc/self/fd/${file.fd}`) !== path) {
          throw missingArtifact();
        }
        if (!(await file.stat()).isFile()) throw missingArtifact();
        const payload = await file.readFile();
        reply.header("Content-Type", "image/png");
        return payload;
      } finally {
        await file.close();
      }
    } catch {
      throw missingArtifact();
    }
  });

  app.get("/api/runs/:id/events", async (request, reply) => {
    const runId = (request.params as { id: string }).id;
    const detail = await manager.getRunDetail(runId);

    reply.raw.writeHead(200, {
      ...(request.headers.origin === webOrigin ? { "Access-Control-Allow-Origin": webOrigin } : {}),
      Vary: "Origin",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream",
    });

    for (const event of detail.events) {
      writeSseEvent(reply, event);
    }

    const unsubscribe = manager.subscribe(runId, (event: RunEvent) => {
      writeSseEvent(reply, event);
    });

    request.raw.on("close", () => {
      unsubscribe();
      reply.raw.end();
    });

    return reply.hijack();
  });

  return app;
}
