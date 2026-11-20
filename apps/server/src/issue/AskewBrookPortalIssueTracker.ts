/**
 * Askew Brook Portal as an issue tracker, over its `/api/portal` task API and a staff member's
 * personal API token. A scope is a project id and an issue key a task id. Comments written from
 * here are internal notes: nothing posted through this tracker reaches a customer.
 */
import * as Config from "effect/Config";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";
import {
  IssueTrackerKind,
  type IssueActor,
  type IssueCapabilities,
  type IssueComment,
  type IssueState,
  type IssueViewerPermissions,
} from "@t3tools/contracts";
import {
  IssueTrackerError,
  type StandaloneIssueTrackerApi,
  type TrackerIssueSummary,
} from "@t3tools/source-control-core/server/IssueTracker";
import * as IssueTrackerHost from "@t3tools/source-control-core/server/IssueTrackerHost";

const KIND = IssueTrackerKind.make("abportal");

const PortalConfig = Config.all({
  url: Config.String("T3CODE_ABPORTAL_URL").pipe(
    Config.withDefault("https://portal.askewbrook.com"),
  ),
});

const CAPABILITIES: IssueCapabilities = {
  create: true,
  edit: true,
  comment: true,
  labels: false,
  assignees: false,
  reactions: false,
  templates: false,
  linkedPullRequests: false,
  events: false,
  search: true,
};

const VIEWER_PERMISSIONS: IssueViewerPermissions = {
  setState: true,
  comment: true,
  edit: true,
  labels: false,
  assignees: false,
};

const Person = Schema.Struct({ name: Schema.String, avatar: Schema.NullOr(Schema.String) });
const Status = Schema.Struct({
  value: Schema.String,
  label: Schema.String,
  is_open: Schema.Boolean,
});
const Task = Schema.Struct({
  id: Schema.Number,
  project_id: Schema.Number,
  title: Schema.String,
  description: Schema.optional(Schema.NullOr(Schema.String)),
  url: Schema.String,
  status: Schema.String,
  status_label: Schema.String,
  is_open: Schema.Boolean,
  statuses: Schema.optional(Schema.Array(Status)),
  author: Schema.NullOr(Person),
  assignees: Schema.Array(Person),
  comments_count: Schema.Number,
  completed_at: Schema.NullOr(Schema.String),
  created_at: Schema.String,
  updated_at: Schema.String,
});
type Task = typeof Task.Type;
const Comment = Schema.Struct({
  id: Schema.Number,
  body: Schema.String,
  author: Person,
  created_at: Schema.String,
});
const Named = Schema.Struct({ id: Schema.Number, name: Schema.String });
const Cursor = Schema.Struct({ next_cursor: Schema.NullOr(Schema.String) });

const decodeTask = Schema.decodeUnknownOption(Schema.Struct({ data: Task }));
const decodeTasks = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Array(Task), meta: Cursor }),
);
const decodeComments = Schema.decodeUnknownOption(
  Schema.Struct({ data: Schema.Array(Comment), meta: Cursor }),
);
const decodeMe = Schema.decodeUnknownOption(Schema.Struct({ data: Named }));
const decodeProjects = Schema.decodeUnknownOption(Schema.Struct({ data: Schema.Array(Named) }));
const decodeAnything = Schema.decodeUnknownOption(Schema.Unknown);
const decodeFailure = Schema.decodeUnknownOption(Schema.Struct({ message: Schema.String }));

const fail = (
  operation: string,
  reason: IssueTrackerError["reason"],
  detail: string,
  extra: { readonly retryAt?: number; readonly cause?: unknown } = {},
) => new IssueTrackerError({ tracker: KIND, operation, reason, detail, ...extra });

function toActor(person: typeof Person.Type): IssueActor {
  return {
    login: person.name.trim() || "Askew Brook",
    name: person.name,
    avatarUrl: person.avatar?.startsWith("https://") ? person.avatar : null,
  };
}

function toState(status: typeof Status.Type): IssueState {
  return status.is_open
    ? { category: "open", name: status.label }
    : {
        category: "closed",
        name: status.label,
        closeReason: status.value === "done" ? "completed" : status.label,
      };
}

function toSummary(task: Task): TrackerIssueSummary {
  return {
    key: String(task.id),
    displayKey: `#${task.id}`,
    title: task.title.trim() || "Untitled",
    url: task.url,
    author: task.author === null ? null : toActor(task.author),
    state: toState({ value: task.status, label: task.status_label, is_open: task.is_open }),
    createdAt: task.created_at,
    updatedAt: task.updated_at,
    closedAt: task.completed_at,
    assignees: task.assignees.map(toActor),
    labels: [],
    commentCount: task.comments_count,
  };
}

/** Portal pages comments newest first; a conversation reads oldest first. */
function toComments(comments: ReadonlyArray<typeof Comment.Type>): IssueComment[] {
  return comments
    .map((comment) => ({
      id: String(comment.id),
      author: toActor(comment.author),
      body: comment.body,
      createdAt: comment.created_at,
      url: null,
    }))
    .toReversed();
}

export const make = Effect.gen(function* () {
  // Only a default-carrying string: nothing in the environment can make it fail.
  const { url } = yield* PortalConfig.pipe(Effect.orDie);
  const origin = new URL(url).origin;
  const host = new URL(url).host;
  const http = yield* HttpClient.HttpClient;
  const trackerHost = yield* IssueTrackerHost.IssueTrackerHost;

  const storedToken = (operation: string) =>
    trackerHost.credentials
      .get(KIND)
      .pipe(
        Effect.flatMap(
          Effect.fromOption(() =>
            fail(operation, "unauthenticated", "Portal is not connected on this server."),
          ),
        ),
      );

  const call = Effect.fn("AskewBrookPortalIssueTracker.call")(function* <A>(
    operation: string,
    decode: (body: unknown) => Option.Option<A>,
    request: HttpClientRequest.HttpClientRequest,
    token?: string,
  ): Effect.fn.Return<A, IssueTrackerError> {
    const key = token ?? (yield* storedToken(operation));
    const response = yield* http
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(`${origin}/api/portal`),
          HttpClientRequest.bearerToken(key),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(
        Effect.mapError((cause) =>
          fail(operation, "failed", "Portal could not be reached.", { cause }),
        ),
      );
    const body = yield* response.json.pipe(Effect.orElseSucceed(() => null));
    if (response.status === 401 || response.status === 403) {
      return yield* fail(operation, "unauthenticated", "Portal rejected the API token.");
    }
    if (response.status === 404) {
      return yield* fail(operation, "not-found", "Portal has no such task or project.");
    }
    if (response.status === 429) {
      const seconds = Number(response.headers["retry-after"]);
      const now = DateTime.toEpochMillis(yield* DateTime.now);
      return yield* fail(
        operation,
        "rate-limited",
        "Portal's rate limit was reached.",
        Number.isFinite(seconds) ? { retryAt: now + seconds * 1000 } : {},
      );
    }
    if (response.status >= 400) {
      // Laravel writes its validation messages for people.
      const message = Option.getOrUndefined(decodeFailure(body))?.message;
      return yield* fail(
        operation,
        "failed",
        message ?? `Portal returned HTTP ${response.status}.`,
      );
    }
    const decoded = decode(body);
    if (Option.isNone(decoded)) {
      return yield* fail(operation, "failed", "Portal returned an unexpected body.");
    }
    return decoded.value;
  });

  const numeric = Effect.fn("AskewBrookPortalIssueTracker.numeric")(function* (
    operation: string,
    value: string,
  ) {
    if (!/^[1-9]\d*$/.test(value.trim())) {
      return yield* fail(operation, "not-found", "Portal ids are numbers.");
    }
    return value.trim();
  });

  const getTask = Effect.fn("AskewBrookPortalIssueTracker.getTask")(function* (
    operation: string,
    key: string,
  ) {
    const id = yield* numeric(operation, key);
    const body = yield* call(operation, decodeTask, HttpClientRequest.get(`/tasks/${id}`));
    return body.data;
  });

  /** Task ids are global: a write proves the task sits in the bound project first. */
  const requireProjectTask = Effect.fn("AskewBrookPortalIssueTracker.requireProjectTask")(
    function* (operation: string, input: { readonly scope: string; readonly key: string }) {
      const task = yield* getTask(operation, input.key);
      if (String(task.project_id) !== input.scope.trim()) {
        return yield* fail(operation, "failed", `Task #${task.id} belongs to another project.`);
      }
      return task;
    },
  );

  const getComments = Effect.fn("AskewBrookPortalIssueTracker.getComments")(function* (
    operation: string,
    key: string,
    cursor?: string,
  ) {
    const id = yield* numeric(operation, key);
    const body = yield* call(
      operation,
      decodeComments,
      HttpClientRequest.get(`/tasks/${id}/comments`, {
        urlParams: cursor === undefined ? {} : { cursor },
      }),
    );
    return { comments: toComments(body.data), nextCursor: body.meta.next_cursor };
  });

  const viewer = (operation: string, token?: string) =>
    call(operation, decodeMe, HttpClientRequest.get("/me"), token).pipe(
      Effect.map((me) => me.data.name.trim() || String(me.data.id)),
    );

  const api: StandaloneIssueTrackerApi = {
    kind: KIND,
    capabilities: CAPABILITIES,
    standalone: {
      tracker: KIND,
      displayName: "Askew Brook Portal",
      host,
      scopeNoun: "project",
      credential: { label: "API token", helpUrl: `${origin}/admin/users` },
    },

    // A task link names no project, so it resolves read-only through any bound project.
    parseIssueUrl: (link) => {
      const key =
        link.origin === origin ? /^\/admin\/tasks\/([1-9]\d*)\/?$/.exec(link.pathname) : null;
      return key === null ? null : { host, workspace: host, scope: "tasks", key: key[1]! };
    },

    probeCredential: Effect.fn("AskewBrookPortalIssueTracker.probeCredential")(function* (token) {
      const [account, projects] = yield* Effect.all(
        [
          viewer("probeCredential", token),
          call("probeCredential", decodeProjects, HttpClientRequest.get("/projects"), token),
        ],
        { concurrency: 2 },
      );
      return {
        account,
        workspace: host,
        scopes: projects.data.map((project) => ({
          key: String(project.id),
          name: project.name.trim() || String(project.id),
        })),
      };
    }),

    getViewer: () => viewer("getViewer"),

    listIssues: Effect.fn("AskewBrookPortalIssueTracker.listIssues")(function* (input) {
      // Portal has no labels, and knows who a task is assigned to but not who was mentioned.
      if (
        (input.labels ?? []).length > 0 ||
        input.involvement === "authored" ||
        input.involvement === "mentioned"
      ) {
        return { items: [], nextCursor: null };
      }
      const project = yield* numeric("listIssues", input.scope);
      const body = yield* call(
        "listIssues",
        decodeTasks,
        HttpClientRequest.get(`/projects/${project}/tasks`, {
          urlParams: {
            state: input.state,
            sort: input.sort === "created" ? "created" : "updated",
            ...(input.query === undefined ? {} : { q: input.query }),
            ...(input.involvement === "assigned" ? { mine: "1" } : {}),
            ...(input.cursor === undefined ? {} : { cursor: input.cursor }),
          },
        }),
      );
      return { items: body.data.map(toSummary), nextCursor: body.meta.next_cursor };
    }),

    getIssue: Effect.fn("AskewBrookPortalIssueTracker.getIssue")(function* (input) {
      const [task, conversation, me] = yield* Effect.all(
        [
          getTask("getIssue", input.key),
          getComments("getIssue", input.key),
          viewer("getIssue").pipe(Effect.orElseSucceed(() => null)),
        ],
        { concurrency: 3 },
      );
      return {
        ...toSummary(task),
        // Portal stores rich text as HTML, which the clients' Markdown renderers accept.
        body: task.description ?? "",
        viewer: me,
        viewerPermissions: VIEWER_PERMISSIONS,
        states: (task.statuses ?? []).map(toState),
        comments: conversation.comments,
        commentsCursor: conversation.nextCursor,
        events: [],
        linkedPullRequests: [],
      };
    }),

    getComments: (input) => getComments("getComments", input.key, input.cursor),

    create: Effect.fn("AskewBrookPortalIssueTracker.create")(function* (input) {
      const project = yield* numeric("create", input.scope);
      const body = yield* call(
        "create",
        decodeTask,
        HttpClientRequest.post(`/projects/${project}/tasks`).pipe(
          // Portal requires a description; a bare title is its own.
          HttpClientRequest.bodyJsonUnsafe({
            title: input.title,
            description: input.body.trim() || input.title,
          }),
        ),
      );
      const task = toSummary(body.data);
      return { key: task.key, displayKey: task.displayKey, url: task.url };
    }),

    comment: Effect.fn("AskewBrookPortalIssueTracker.comment")(function* (input) {
      const task = yield* requireProjectTask("comment", input);
      yield* call(
        "comment",
        decodeAnything,
        HttpClientRequest.post(`/tasks/${task.id}/comments`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ body: input.body }),
        ),
      );
    }),

    update: Effect.fn("AskewBrookPortalIssueTracker.update")(function* (input) {
      const task = yield* requireProjectTask("update", input);
      yield* call(
        "update",
        decodeAnything,
        HttpClientRequest.patch(`/tasks/${task.id}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            ...(input.title === undefined ? {} : { title: input.title }),
            ...(input.body === undefined ? {} : { description: input.body }),
          }),
        ),
      );
    }),

    setState: Effect.fn("AskewBrookPortalIssueTracker.setState")(function* (input) {
      const task = yield* requireProjectTask("setState", input);
      const status = task.statuses?.find((candidate) => candidate.label === input.state);
      if (status === undefined) {
        return yield* fail("setState", "failed", `Portal has no "${input.state}" status.`);
      }
      yield* call(
        "setState",
        decodeAnything,
        HttpClientRequest.patch(`/tasks/${task.id}`).pipe(
          HttpClientRequest.bodyJsonUnsafe({ status: status.value }),
        ),
      );
    }),
  };
  return api;
});
