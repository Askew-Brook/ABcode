// Askew Brook fork: the open issues of a thread's project, as a right-panel tab beside the thread.
import type { EnvironmentIssueEntry } from "@t3tools/client-runtime/issue-list";
import { issueEntryKey } from "@t3tools/client-runtime/state/issues";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import { RefreshCwIcon } from "lucide-react";

import { useRightPanelStore } from "~/rightPanelStore";
import { useThreadShell } from "~/state/entities";
import { useIssueList } from "~/state/issues";

import { ThreadDetailsControl } from "../chat/ThreadDetailsControl";
import { THREAD_DETAILS_PANEL_LABEL_CLASS } from "../chat/threadDetailsPanelStyles";
import { Button } from "../ui/button";
import { IssueRow } from "./IssueRow";
import { IssueGlyph } from "./issuePresentation";

export function ProjectIssuesPanel({ threadRef }: { threadRef: ScopedThreadRef }) {
  const gt = useGT();
  const projectId = useThreadShell(threadRef)?.projectId;
  const list = useIssueList(
    projectId === undefined
      ? []
      : [
          {
            environmentId: threadRef.environmentId,
            input: { state: "open", involvement: "all", projectId, limit: 100 },
          },
        ],
  );
  const answer = list.answers[0]?.[1];
  const entries: ReadonlyArray<EnvironmentIssueEntry> = (answer?.entries ?? [])
    .map((entry) => ({ ...entry, environmentId: threadRef.environmentId }))
    // Portal tasks lead; a git host's issues follow, each group newest first as the server sent it.
    .toSorted(
      (left, right) => Number(right.tracker === "abportal") - Number(left.tracker === "abportal"),
    );
  const errors = [...(answer?.errors ?? []).map((error) => error.message), list.error].filter(
    (message) => message !== null,
  );
  const trackers = new Set(entries.map((entry) => `${entry.tracker} ${entry.host}`));

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between px-3 py-2">
        <span className="text-sm font-medium">
          <T>Issues</T>
        </span>
        <Button
          size="icon-xs"
          variant="ghost"
          aria-label={gt("Refresh issues")}
          disabled={list.isPending}
          onClick={list.refresh}
        >
          <RefreshCwIcon aria-hidden />
        </Button>
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-2">
        {errors.map((message) => (
          <p key={message} className="px-3 py-1 text-xs text-destructive">
            {message}
          </p>
        ))}
        {entries.length === 0 && errors.length === 0 && !list.isPending ? (
          <p className="px-3 py-1 text-sm text-muted-foreground">
            <T>No issues under these filters.</T>
          </p>
        ) : null}
        {entries.map((entry) => (
          <IssueRow
            key={issueEntryKey(entry)}
            entry={entry}
            selected={false}
            showScope={false}
            showTracker={trackers.size > 1}
            onSelect={(target) => useRightPanelStore.getState().openIssue(threadRef, target)}
          />
        ))}
      </div>
    </div>
  );
}

/** The thread details row that opens the list. */
export function ThreadDetailsProjectIssuesRow({ threadRef }: { threadRef: ScopedThreadRef }) {
  return (
    <ThreadDetailsControl
      size="xs"
      variant="ghost"
      part="row"
      panel
      onClick={() => useRightPanelStore.getState().open(threadRef, "issues")}
    >
      <IssueGlyph.issue className="size-3.5" aria-hidden />
      <span className={`ml-0.5 ${THREAD_DETAILS_PANEL_LABEL_CLASS}`}>
        <T>Issues</T>
      </span>
    </ThreadDetailsControl>
  );
}
