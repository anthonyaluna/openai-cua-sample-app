import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, it, vi } from "vitest";

import {
  runDetailSchema,
  runnerErrorResponseSchema,
  scenarioWorkspaceStateSchema,
  scenariosResponseSchema,
  startRunResponseSchema,
} from "@cua-sample/replay-schema";

import { RunnerManager } from "@cua-sample/runner-core";

import { createServer } from "../src/server.js";

describe("runner server", () => {
  it("reports health", async () => {
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/health",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({
        status: "ok",
        service: "runner",
      });
    } finally {
      await app.close();
    }
  });

  it("starts, retrieves, stops, and resets scenario workspaces", async () => {
    const dataRoot = await mkdtemp(join(tmpdir(), "cua-sample-runner-server-"));
    const app = createServer({
      dataRoot,
      stepDelayMs: 50,
    });

    try {
      const startResponse = await app.inject({
        method: "POST",
        payload: {
          browserMode: "headless",
          maxResponseTurns: 17,
          mode: "native",
          prompt: [
            "Reorganize the board to match this requested final board state exactly.",
            "",
            "backlog: Refresh workspace docs",
            "in_progress: Close nav bug triage -> Finalize analytics spec",
            "done: Circulate launch brief -> Audit replay artifacts -> Polish stage tooltips",
          ].join("\n"),
          scenarioId: "kanban-reprioritize-sprint",
        },
        url: "/api/runs",
      });

      expect(startResponse.statusCode).toBe(202);
      const started = startRunResponseSchema.parse(startResponse.json());

      const runResponse = await app.inject({
        method: "GET",
        url: `/api/runs/${started.runId}`,
      });

      expect(runResponse.statusCode).toBe(200);
      const detail = runDetailSchema.parse(runResponse.json());

      expect(detail.run.id).toBe(started.runId);
      expect(detail.run.maxResponseTurns).toBe(17);
      expect(detail.run.status).toBe("running");
      expect(detail.run.verificationEnabled).toBe(false);

      const stopResponse = await app.inject({
        method: "POST",
        url: `/api/runs/${started.runId}/stop`,
      });

      expect(stopResponse.statusCode).toBe(200);
      expect(runDetailSchema.parse(stopResponse.json()).run.status).toBe(
        "cancelled",
      );

      const resetResponse = await app.inject({
        method: "POST",
        url: "/api/scenarios/kanban-reprioritize-sprint/reset",
      });

      expect(resetResponse.statusCode).toBe(200);
      expect(
        scenarioWorkspaceStateSchema.parse(resetResponse.json()).scenarioId,
      ).toBe("kanban-reprioritize-sprint");
    } finally {
      await app.close();
    }
  });

  it("serves the validated scenario registry", async () => {
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/scenarios",
      });

      expect(response.statusCode).toBe(200);
      expect(scenariosResponseSchema.parse(response.json())).toHaveLength(3);
    } finally {
      await app.close();
    }
  });

  it("rejects code mode on the remote run API", async () => {
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        payload: {
          browserMode: "headless",
          mode: "code",
          prompt: "Run the scenario.",
          scenarioId: "kanban-reprioritize-sprint",
        },
        url: "/api/runs",
      });

      expect(response.statusCode).toBe(403);
      expect(runnerErrorResponseSchema.parse(response.json())).toMatchObject({
        code: "remote_code_mode_disabled",
        error: "Code mode is disabled for remote run requests.",
        hint: "Use native computer mode for remote runs.",
      });
    } finally {
      await app.close();
    }
  });

  it("requires a bearer token for non-loopback runner requests", async () => {
    const app = createServer({ authToken: "test-runner-token", webOrigin: "http://127.0.0.1:3000" });

    try {
      const missing = await app.inject({
        headers: { host: "runner.example.test" },
        method: "GET",
        url: "/api/scenarios",
      });
      expect(missing.statusCode).toBe(401);

      const allowed = await app.inject({
        headers: {
          authorization: "Bearer test-runner-token",
          host: "runner.example.test",
          origin: "http://127.0.0.1:3000",
        },
        method: "GET",
        url: "/api/scenarios",
      });
      expect(allowed.statusCode).toBe(200);

      const wrongOrigin = await app.inject({
        headers: {
          authorization: "Bearer test-runner-token",
          host: "runner.example.test",
          origin: "https://untrusted.example.test",
        },
        method: "GET",
        url: "/api/scenarios",
      });
      expect(wrongOrigin.statusCode).toBe(403);
    } finally {
      await app.close();
    }
  });

  it("applies the browser origin policy before route handlers and event subscriptions", async () => {
    const manager = new RunnerManager({ dataRoot: tmpdir() });
    const reset = vi.spyOn(manager, "resetScenario").mockRejectedValue(new Error("unexpected call"));
    const detail = vi.spyOn(manager, "getRunDetail").mockRejectedValue(new Error("unexpected call"));
    const app = createServer({ manager });
    try {
      const headers = { origin: "https://other.example.test" };
      const denied = await app.inject({ method: "POST", url: "/api/scenarios/demo/reset", headers });
      const stream = await app.inject({ method: "GET", url: "/api/runs/demo/events", headers });
      expect([denied.statusCode, stream.statusCode]).toEqual([403, 403]);
      expect(reset).not.toHaveBeenCalled();
      expect(detail).not.toHaveBeenCalled();
    } finally {
      await app.close();
    }
  });

  it("handles an approved preflight while authenticating the subsequent remote API call", async () => {
    const app = createServer({ host: "0.0.0.0", authToken: "unit-test-token" });
    try {
      const headers = { host: "localhost", origin: "http://127.0.0.1:3000" };
      const preflight = await app.inject({ method: "OPTIONS", url: "/api/scenarios", headers });
      expect(preflight.statusCode).toBe(204);
      expect(preflight.headers["access-control-allow-origin"]).toBe(headers.origin);
      expect(preflight.headers["access-control-allow-headers"]).toContain("Authorization");
      expect(preflight.headers.vary).toBe("Origin");
      const unauthenticated = await app.inject({ method: "GET", url: "/api/scenarios", headers });
      expect(unauthenticated.statusCode).toBe(401);
    } finally {
      await app.close();
    }
  });

  it("accepts IPv6 loopback and serves an existing screenshot inside its run", async () => {
    const root = await mkdtemp(join(tmpdir(), "cua-sample-screenshot-"));
    const id = "12345678-1234-4234-8234-123456789abc";
    const dir = join(root, "runs", id, "screenshots");
    const app = createServer({ host: "::1", dataRoot: root });
    try {
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, "0001.png"), "fixture");
      const result = await app.inject({
        headers: { host: "[::1]:4001" }, remoteAddress: "::1",
        method: "GET", url: `/api/runs/${id}/artifacts/screenshots/0001.png`,
      });
      expect(result.statusCode).toBe(200);
      expect(result.headers["content-type"]).toBe("image/png");
      expect(result.payload).toBe("fixture");
    } finally {
      await app.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("rejects malformed screenshot artifact paths before reading files", async () => {
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/runs/not-a-run/artifacts/screenshots/.env",
      });

      expect(response.statusCode).toBe(404);
      expect(response.json()).toMatchObject({ code: "artifact_not_found" });
    } finally {
      await app.close();
    }
  });

  it("returns the structured error envelope for invalid requests", async () => {
    const app = createServer();

    try {
      const response = await app.inject({
        method: "POST",
        payload: {
          scenarioId: "",
        },
        url: "/api/runs",
      });

      expect(response.statusCode).toBe(400);
      expect(runnerErrorResponseSchema.parse(response.json())).toMatchObject({
        code: "invalid_request",
        hint: expect.stringContaining("published replay-schema contracts"),
      });
    } finally {
      await app.close();
    }
  });

  it("returns the structured error envelope for missing runs", async () => {
    const app = createServer();

    try {
      const response = await app.inject({
        method: "GET",
        url: "/api/runs/missing-run",
      });

      expect(response.statusCode).toBe(404);
      expect(runnerErrorResponseSchema.parse(response.json())).toMatchObject({
        code: "run_not_found",
        hint: expect.stringContaining("Start a new run"),
      });
    } finally {
      await app.close();
    }
  });
});
