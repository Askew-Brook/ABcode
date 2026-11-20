---
name: ab-client
description: Update the Askew Brook fork of T3 Code to the latest upstream stable release and build a fresh "AB Code" desktop app. Use for /ab-client, or when asked to update, rebuild, or reinstall the AB client.
---

# AB Code client

This fork (`origin` = Askew-Brook/ABcode) is upstream T3 Code (`upstream` =
pingdotgg/t3code) plus one feature: Askew Brook Portal as an issue tracker.
`main` is the latest upstream **stable tag** with our commits merged on top.

The whole fork is:

- `apps/server/src/issue/AskewBrookPortalIssueTracker.ts` and its test: ours.
- `apps/server/src/issue/IssueTrackerRegistry.ts`: one import and one entry in
  `STANDALONE_TRACKERS`.
- `apps/web/src/components/issue/issuePresentation.tsx`: one `abportal` line in
  `STANDALONE_TRACKERS`.
- `apps/web/src/components/issue/ProjectIssuesPanel.tsx`: ours. An "Open issues"
  right-panel tab listing the thread's project, opened from an Issues row in
  thread details. Its seams are an `"issues"` surface kind in `rightPanelStore.ts`
  (three places) and `closedViewStore.ts`, a title and icon case in
  `RightPanelTabs.tsx`, a render case in `chat/RightPanelSurfaceContent.tsx`, and
  the row in `chat/ThreadDetailsPanel.tsx`. It reuses already-translated strings;
  a new string means regenerating every locale catalog, so avoid one.
- This skill.

Keep it that way. New fork features go in new files with one-line seams, and
packaging differences go in `build.sh` as post-build steps, never in upstream's
build scripts.

AB Code deliberately keeps T3 Code's bundle id and data directory (`~/.t3`), so
it shows the same projects, threads and settings as the stock app. That only
works while both are the same version: track stable tags, not `upstream/main`,
whose migrations can run ahead of the stock app.

## Update

1. Check `git status` is clean and you are on `main`. Stop and report
   anything unexpected rather than discarding it.
2. Find the newest stable tag:

   ```sh
   git fetch upstream --tags
   git tag -l 'v*' --sort=-v:refname | grep -v -- '-' | head -1
   ```

   If `git merge-base --is-ancestor <tag> HEAD` succeeds there is nothing to
   merge; go to Build.

3. `git merge --no-edit <tag>`. Never rebase, reset, or force-push `main`.
   Conflicts should only appear in the two seam files: take upstream's
   version and re-add our line. If upstream changed the
   `StandaloneIssueTrackerApi` interface or the issue contracts, update
   `AskewBrookPortalIssueTracker.ts` to match; Linear's tracker in
   `packages/issue-tracker-linear` is the reference implementation.
4. Verify, using the pinned toolchain (`build.sh` shows the `npm exec`
   wrapper; the machine has no global `pnpm` or `vp`):

   ```sh
   pnpm install --frozen-lockfile
   pnpm exec vp run check:changed
   pnpm exec vp test run apps/server/src/issue/AskewBrookPortalIssueTracker.test.ts
   ```

5. `git push origin main`.

## Build

```sh
.agents/skills/ab-client/build.sh
```

It produces `release/ab/AB Code.app` and prints its version. It takes several
minutes. The app is the stock unsigned build with the AB icon and name, an
ad-hoc signature, and no update feed.

## Install

You are probably running inside T3 Code or AB Code, and replacing a running
app breaks the session. Do not install or launch it yourself. Give the user
this to run after quitting both apps:

```sh
rm -rf "/Applications/AB Code.app" && ditto "release/ab/AB Code.app" "/Applications/AB Code.app" && open "/Applications/AB Code.app"
```

Tell them:

- Run only one of T3 Code and AB Code at a time; they share one database.
- macOS asks for the login keychain password once per build, because the
  ad-hoc signature changes. "Always Allow" is fine.
- If the stock app has updated itself past AB Code's version, rebuild before
  opening AB Code.

## Portal

The tracker talks to `/api/portal` on `https://portal.askewbrook.com`
(`T3CODE_ABPORTAL_URL` overrides it) with the staff member's API token from
their Portal account page, pasted in Settings → Source control & issues. The
routes live in the Portal repo's `PortalTaskController`; change both sides
together.
