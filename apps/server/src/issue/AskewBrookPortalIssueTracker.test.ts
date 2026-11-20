import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpClient, HttpClientResponse } from "effect/http";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

import * as AskewBrookPortalIssueTracker from "./AskewBrookPortalIssueTracker.ts";

const STATUSES = [
  { value: "in_progress", label: "In progress", is_open: true },
  { value: "done", label: "Done", is_open: false },
];

const task = (id: number, overrides: Record<string, unknown> = {}) => ({
  id,
  project_id: 7,
  title: `Task ${id}`,
  description: "<p>body</p>",
  url: `https://portal.askewbrook.com/admin/tasks/${id}`,
  status: "in_progress",
  status_label: "In progress",
  is_open: true,
  statuses: STATUSES,
  author: { name: "Richard", avatar: null },
  assignees: [{ name: "Jack", avatar: null }],
  comments_count: 2,
  completed_at: null,
  created_at: "2026-07-01T00:00:00.000000Z",
  updated_at: "2026-07-02T00:00:00.000000Z",
  ...overrides,
});

/** Answers each request by `METHOD path`, the way Portal's task API would. */
function fakePortal(answers: Record<string, unknown>) {
  const requests: Array<{ readonly route: string; readonly query: string; readonly body: string }> =
    [];
  const http = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request, url) =>
      Effect.sync(() => {
        const route = `${request.method} ${url.pathname.replace("/api/portal", "")}`;
        const body = request.body;
        requests.push({
          route,
          query: url.search,
          body: body._tag === "Uint8Array" ? new TextDecoder().decode(body.body) : "",
        });
        const answer = answers[route];
        return HttpClientResponse.fromWeb(
          request,
          answer instanceof Response
            ? answer
            : new Response(JSON.stringify(answer ?? {}), {
                status: answer === undefined ? 404 : 200,
                headers: { "content-type": "application/json" },
              }),
        );
      }),
    ),
  );
  const host = Layer.succeed(
    IssueTrackerHost.IssueTrackerHost,
    IssueTrackerHost.IssueTrackerHost.of({
      credentials: { get: () => Effect.succeedSome("ab_mcp_stored") },
    }),
  );
  return {
    requests,
    tracker: AskewBrookPortalIssueTracker.make.pipe(Effect.provide(Layer.merge(http, host))),
  };
}

const target = { cwd: "/repo", host: "portal.askewbrook.com", scope: "7" };

describe("AskewBrookPortalIssueTracker", () => {
  it.effect("lists a project's open tasks assigned to the viewer, a page at a time", () =>
    Effect.gen(function* () {
      const portal = fakePortal({
        "GET /projects/7/tasks": { data: [task(12)], meta: { next_cursor: "next" } },
      });
      const tracker = yield* portal.tracker;
      const page = yield* tracker.listIssues({
        ...target,
        involvement: "assigned",
        viewer: "Jack",
        state: "open",
        limit: 100,
        sort: "updated",
        cursor: "here",
      });
      expect(portal.requests[0]?.query).toBe("?state=open&sort=updated&mine=1&cursor=here");
      expect(page.nextCursor).toBe("next");
      expect(page.items[0]).toMatchObject({
        key: "12",
        displayKey: "#12",
        url: "https://portal.askewbrook.com/admin/tasks/12",
        author: { login: "Richard" },
        state: { category: "open", name: "In progress" },
        assignees: [{ login: "Jack" }],
        commentCount: 2,
      });
    }),
  );

  it.effect("reads a task with its conversation oldest first", () =>
    Effect.gen(function* () {
      const comment = (id: number) => ({
        id,
        body: `<p>${id}</p>`,
        author: { name: "Jack", avatar: null },
        created_at: "2026-07-03T00:00:00.000000Z",
      });
      const portal = fakePortal({
        "GET /tasks/12": { data: task(12) },
        "GET /tasks/12/comments": {
          data: [comment(2), comment(1)],
          meta: { next_cursor: "older" },
        },
        "GET /me": { data: { id: 1, name: "Jack" } },
      });
      const tracker = yield* portal.tracker;
      const detail = yield* tracker.getIssue({ ...target, key: "12" });
      expect(detail.comments.map((entry) => entry.id)).toEqual(["1", "2"]);
      expect(detail.commentsCursor).toBe("older");
      expect(detail.states).toEqual([
        { category: "open", name: "In progress" },
        { category: "closed", name: "Done", closeReason: "completed" },
      ]);
    }),
  );

  it.effect("writes only to tasks inside the bound project", () =>
    Effect.gen(function* () {
      const portal = fakePortal({
        "GET /tasks/12": { data: task(12) },
        "PATCH /tasks/12": { data: task(12) },
        "GET /tasks/13": { data: task(13, { project_id: 8 }) },
      });
      const tracker = yield* portal.tracker;
      yield* tracker.setState!({ ...target, key: "12", state: "Done" });
      expect(portal.requests.at(-1)).toMatchObject({
        route: "PATCH /tasks/12",
        body: JSON.stringify({ status: "done" }),
      });
      const refused = yield* tracker.comment!({ ...target, key: "13", body: "hello" }).pipe(
        Effect.flip,
      );
      expect(refused.detail).toBe("Task #13 belongs to another project.");
      expect(portal.requests.at(-1)?.route).toBe("GET /tasks/13");
    }),
  );

  it.effect("reports a rejected token as unauthenticated", () =>
    Effect.gen(function* () {
      const portal = fakePortal({
        "GET /me": new Response(JSON.stringify({ message: "Unauthenticated." }), { status: 401 }),
      });
      const tracker = yield* portal.tracker;
      const error = yield* tracker.probeCredential("ab_mcp_wrong").pipe(Effect.flip);
      expect(error.reason).toBe("unauthenticated");
    }),
  );
});
