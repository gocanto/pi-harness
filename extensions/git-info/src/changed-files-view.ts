import { basename } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import { Effect } from "effect";
import { runCommand } from "./process.ts";

const DIFF_SCROLL_STEP = 5;
/** Exported so tests can assert the documented truncation bound. */
export const MAX_DIFF_LINES = 20_000;
const COMMAND_TIMEOUT_MS = 10_000;
// Cheap per-file `numstat` calls run concurrently, bounded so a working tree
// with hundreds of changed files does not spawn unbounded git processes.
const STATS_CONCURRENCY = 8;
// Strip terminal control sequences from repository-controlled paths and diff
// text before applying trusted theme styling.
// eslint-disable-next-line no-control-regex
const OSC_PATTERN =
  /(?:\u001b\]|\u009d)(?:[^\u0007\u001b\u009c]|\u001b(?!\\))*(?:\u0007|\u001b\\|\u009c)/g;
// eslint-disable-next-line no-control-regex
const CSI_PATTERN = /(?:\u001b\[|\u009b)[0-?]*[ -/]*[@-~]/g;
// eslint-disable-next-line no-control-regex
const ESCAPE_PATTERN = /\u001b(?:[()][0-2A-Z]|[ -/]*[@-~])/g;

export function sanitizeTerminalText(text: string) {
  return text
    .replace(OSC_PATTERN, "")
    .replace(CSI_PATTERN, "")
    .replace(ESCAPE_PATTERN, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

interface ChangedPath {
  path: string;
  status: string;
}

export interface ChangedFile {
  additions: number | null;
  deletions: number | null;
  name: string;
  path: string;
  /**
   * Original (unsanitized) repository-relative path, used only to build git
   * command arguments for lazy diff loading. Never render this field
   * directly; use `path`/`name` instead.
   */
  rawPath: string;
  /** Porcelain XY status code, used to choose the diff strategy on demand. */
  status: string;
}

export interface ChangedFilesResult {
  files: ChangedFile[];
  hasHead: boolean;
  repoRoot: string;
}

export type DiffLoadResult =
  | { _tag: "loaded"; lines: string[] }
  | { _tag: "unavailable"; message: string };

function parseChangedPaths(output: string) {
  const records = output.split("\0");
  const paths: ChangedPath[] = [];

  for (let index = 0; index < records.length; index += 1) {
    const record = records[index];
    if (!record || record.length < 4) continue;

    const status = record.slice(0, 2);
    const path = record.slice(3);
    paths.push({ path, status });

    // In porcelain v1 -z output, rename/copy records are followed by the old path.
    if (status.includes("R") || status.includes("C")) index += 1;
  }

  return [...new Map(paths.map((entry) => [entry.path, entry])).values()];
}

function parseNumstat(output: string) {
  const line = output.split("\n").find(Boolean);
  if (!line) return { additions: 0, deletions: 0 };

  const [added, deleted] = line.split("\t");
  return {
    additions: added === "-" ? null : Number.parseInt(added ?? "0", 10),
    deletions: deleted === "-" ? null : Number.parseInt(deleted ?? "0", 10),
  };
}

function cleanDisplayPath(path: string) {
  return sanitizeTerminalText(path).replace(/[\r\n\t]/g, " ");
}

const run = (cwd: string, args: string[]) =>
  runCommand("git", args, cwd, COMMAND_TIMEOUT_MS);

// Untracked paths and repositories with no HEAD commit yet have nothing to
// diff against, so they compare the working tree file to `/dev/null`.
function usesNoIndexDiff(status: string, hasHead: boolean) {
  return status === "??" || !hasHead;
}

function statArguments(path: string, status: string, hasHead: boolean) {
  return usesNoIndexDiff(status, hasHead)
    ? ["diff", "--no-index", "--numstat", "--", "/dev/null", path]
    : ["diff", "--numstat", "HEAD", "--", path];
}

function diffArguments(path: string, status: string, hasHead: boolean) {
  return usesNoIndexDiff(status, hasHead)
    ? [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "--",
        "/dev/null",
        path,
      ]
    : [
        "diff",
        "--no-ext-diff",
        "--no-color",
        "--unified=3",
        "HEAD",
        "--",
        path,
      ];
}

// Loads only the cheap `numstat` summary for a changed path. The full
// textual diff (which can retain up to MAX_DIFF_LINES lines) is loaded
// lazily via `loadFileDiff` once a file is actually selected.
const loadFileStats = Effect.fn("git-info.loadFileStats")(function* (
  repoRoot: string,
  changedPath: ChangedPath,
  hasHead: boolean,
) {
  const statResult = yield* run(
    repoRoot,
    statArguments(changedPath.path, changedPath.status, hasHead),
  );
  const stats = parseNumstat(statResult.stdout);

  return {
    ...stats,
    name: cleanDisplayPath(basename(changedPath.path)),
    path: cleanDisplayPath(changedPath.path),
    rawPath: changedPath.path,
    status: changedPath.status,
  } satisfies ChangedFile;
});

/** Loads the full textual diff for a single changed file, on demand. */
export const loadFileDiff = Effect.fn("git-info.loadFileDiff")(function* (
  repoRoot: string,
  file: Pick<ChangedFile, "rawPath" | "status">,
  hasHead: boolean,
) {
  const diffResult = yield* run(
    repoRoot,
    diffArguments(file.rawPath, file.status, hasHead),
  );
  if (diffResult.code !== 0) {
    const reason =
      sanitizeTerminalText(diffResult.stderr).trim() ||
      `git exited with code ${diffResult.code}`;
    return {
      _tag: "unavailable",
      message: `Diff unavailable: ${reason}`,
    } satisfies DiffLoadResult;
  }

  const allDiffLines = diffResult.stdout
    .trimEnd()
    .split("\n")
    .map(sanitizeTerminalText);
  const diff =
    allDiffLines.length > MAX_DIFF_LINES
      ? [
          ...allDiffLines.slice(0, MAX_DIFF_LINES),
          `… diff truncated after ${MAX_DIFF_LINES.toLocaleString()} lines …`,
        ]
      : allDiffLines;

  return {
    _tag: "loaded",
    lines:
      diff.length === 1 && diff[0] === ""
        ? ["No textual diff available."]
        : diff,
  } satisfies DiffLoadResult;
});

// Returns changed paths and cheap per-file stats in a bounded first pass.
// No full diff text is loaded here; callers load a file's diff lazily via
// `loadFileDiff` once it is selected.
export const loadChangedFiles = Effect.fn("git-info.loadChangedFiles")(
  function* (cwd: string) {
    const rootResult = yield* run(cwd, ["rev-parse", "--show-toplevel"]);
    if (rootResult.code !== 0) return null;

    const repoRoot = rootResult.stdout.trim();
    const [statusResult, headResult] = yield* Effect.all(
      [
        run(repoRoot, [
          "status",
          "--porcelain=v1",
          "-z",
          "--untracked-files=all",
        ]),
        run(repoRoot, ["rev-parse", "--verify", "HEAD"]),
      ],
      { concurrency: "unbounded" },
    );
    if (statusResult.code !== 0) return null;

    const changedPaths = parseChangedPaths(statusResult.stdout);
    const hasHead = headResult.code === 0;
    const files = yield* Effect.all(
      changedPaths.map((changedPath) =>
        loadFileStats(repoRoot, changedPath, hasHead),
      ),
      { concurrency: STATS_CONCURRENCY },
    );

    return { files, hasHead, repoRoot } satisfies ChangedFilesResult;
  },
);

function padToWidth(text: string, width: number) {
  const truncated = truncateToWidth(text, width, "");
  return `${truncated}${" ".repeat(Math.max(0, width - visibleWidth(truncated)))}`;
}

/** Loads a single file's diff, given an abort signal for cancellation. */
export type LoadFileDiff = (
  file: ChangedFile,
  signal: AbortSignal,
) => Promise<DiffLoadResult>;

const LOADING_DIFF_PLACEHOLDER = ["Loading diff…"];

export async function showChangedFiles(
  ctx: ExtensionContext,
  result: ChangedFilesResult,
  loadFileDiffLazily: LoadFileDiff,
) {
  if (ctx.mode !== "tui") return;
  const { files } = result;

  await ctx.ui.custom<void>(
    (tui, theme, _keybindings, done) => {
      let focus: "files" | "diff" = "files";
      let selectedIndex = 0;
      let sidebarOffset = 0;
      let diffOffset = 0;
      let disposed = false;
      // Diffs are loaded lazily, at most one in-flight fetch per file, and
      // cached by raw path so revisiting a file does not re-run git.
      const diffCache = new Map<string, string[]>();
      const pendingDiffLoads = new Map<string, AbortController>();

      function bodyHeight() {
        return Math.max(8, Math.floor(tui.terminal.rows * 0.8) - 2);
      }

      function currentDiffLines(file: ChangedFile) {
        return diffCache.get(file.rawPath) ?? LOADING_DIFF_PLACEHOLDER;
      }

      function ensureDiffLoaded(file: ChangedFile) {
        if (diffCache.has(file.rawPath) || pendingDiffLoads.has(file.rawPath)) {
          return;
        }

        // Only one file's diff is visible at a time, so cancel any other
        // in-flight load: at most one diff-loading git process runs
        // concurrently. Delete synchronously so a quick re-selection of the
        // cancelled file starts a fresh fetch instead of appearing "pending".
        for (const [rawPath, controller] of pendingDiffLoads) {
          if (rawPath === file.rawPath) continue;
          controller.abort();
          pendingDiffLoads.delete(rawPath);
        }

        const controller = new AbortController();
        pendingDiffLoads.set(file.rawPath, controller);

        // Ignore results from a fetch that a later selection has since
        // superseded and removed from `pendingDiffLoads`.
        const settle = (lines: string[]) => {
          if (pendingDiffLoads.get(file.rawPath) !== controller) return;
          pendingDiffLoads.delete(file.rawPath);
          if (disposed) return;
          diffCache.set(file.rawPath, lines);
          tui.requestRender();
        };

        loadFileDiffLazily(file, controller.signal)
          .then((diffResult) => {
            settle(
              diffResult._tag === "loaded"
                ? diffResult.lines
                : [diffResult.message],
            );
          })
          .catch((error: unknown) => {
            const message =
              error instanceof Error ? error.message : String(error);
            settle([`Diff unavailable: ${message}`]);
          });
      }

      function ensureSelectedFileVisible() {
        const visibleFiles = Math.max(1, Math.floor(bodyHeight() / 2));
        if (selectedIndex < sidebarOffset) sidebarOffset = selectedIndex;
        if (selectedIndex >= sidebarOffset + visibleFiles) {
          sidebarOffset = selectedIndex - visibleFiles + 1;
        }
      }

      function selectFile(newIndex: number) {
        selectedIndex = newIndex;
        diffOffset = 0;
        ensureSelectedFileVisible();
        ensureDiffLoaded(files[selectedIndex]!);
        tui.requestRender();
      }

      function moveFile(amount: number) {
        selectFile((selectedIndex + amount + files.length) % files.length);
      }

      function moveDiff(amount: number) {
        const maxOffset = Math.max(
          0,
          currentDiffLines(files[selectedIndex]!).length - bodyHeight(),
        );
        diffOffset = Math.max(0, Math.min(maxOffset, diffOffset + amount));
        tui.requestRender();
      }

      function styleDiffLine(line: string) {
        const expanded = line.replaceAll("\t", "    ");
        if (
          expanded.startsWith("diff --git") ||
          expanded.startsWith("index ")
        ) {
          return theme.fg("accent", theme.bold(expanded));
        }
        if (expanded.startsWith("@@")) return theme.fg("mdHeading", expanded);
        if (expanded.startsWith("---") || expanded.startsWith("+++")) {
          return theme.fg("muted", expanded);
        }
        if (expanded.startsWith("+")) return theme.fg("success", expanded);
        if (expanded.startsWith("-")) return theme.fg("error", expanded);
        if (expanded.startsWith("…")) return theme.fg("warning", expanded);
        return theme.fg("text", expanded);
      }

      function border(width: number, label: string, top: boolean) {
        const left = top ? "┌" : "└";
        const right = top ? "┐" : "┘";
        const text = `─ ${label} `;
        const remaining = Math.max(0, width - visibleWidth(text) - 2);
        return theme.fg(
          "borderAccent",
          truncateToWidth(
            `${left}${text}${"─".repeat(remaining)}${right}`,
            width,
            "",
          ),
        );
      }

      function handleInput(data: string) {
        if (focus === "files") {
          if (matchesKey(data, Key.escape)) {
            done(undefined);
            return;
          }
          if (matchesKey(data, Key.down) || data === "j") {
            moveFile(1);
            return;
          }
          if (matchesKey(data, Key.up) || data === "k") {
            moveFile(-1);
            return;
          }
          if (matchesKey(data, Key.home) || data === "g") {
            selectFile(0);
            return;
          }
          if (matchesKey(data, Key.end) || data === "G") {
            selectFile(files.length - 1);
            return;
          }
          if (
            matchesKey(data, Key.enter) ||
            matchesKey(data, Key.space) ||
            matchesKey(data, Key.right) ||
            data === "l"
          ) {
            focus = "diff";
            tui.requestRender();
          }
          return;
        }

        if (
          matchesKey(data, Key.escape) ||
          matchesKey(data, Key.left) ||
          data === "h"
        ) {
          focus = "files";
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.down) || data === "j") {
          moveDiff(DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.up) || data === "k") {
          moveDiff(-DIFF_SCROLL_STEP);
          return;
        }
        if (matchesKey(data, Key.ctrl("d"))) {
          moveDiff(Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.ctrl("u"))) {
          moveDiff(-Math.max(1, Math.floor(bodyHeight() / 2)));
          return;
        }
        if (matchesKey(data, Key.home) || data === "g") {
          diffOffset = 0;
          tui.requestRender();
          return;
        }
        if (matchesKey(data, Key.end) || data === "G") {
          diffOffset = Math.max(
            0,
            currentDiffLines(files[selectedIndex]!).length - bodyHeight(),
          );
          tui.requestRender();
        }
      }

      function render(width: number) {
        const height = bodyHeight();
        const sidebarWidth = Math.min(
          48,
          Math.max(24, Math.floor(width * 0.34)),
        );
        const diffWidth = Math.max(1, width - sidebarWidth - 3);
        const selectedFile = files[selectedIndex]!;
        const title = `local changes · ${files.length} ${files.length === 1 ? "file" : "files"} · ${focus === "files" ? "FILES" : "DIFF"}`;
        const lines = [border(width, title, true)];

        for (let row = 0; row < height; row += 1) {
          const fileIndex = sidebarOffset + Math.floor(row / 2);
          const file = files[fileIndex];
          let sidebar = "";

          if (file) {
            const isSelected = fileIndex === selectedIndex;
            if (row % 2 === 0) {
              const marker = isSelected ? "› " : "  ";
              const isBinary =
                file.additions === null || file.deletions === null;
              const stats = isBinary
                ? "binary"
                : `+${file.additions} -${file.deletions}`;
              const styledStats = isBinary
                ? theme.fg("success", stats)
                : `${theme.fg("success", `+${file.additions}`)} ${theme.fg("error", `-${file.deletions}`)}`;
              const nameWidth = Math.max(
                1,
                sidebarWidth - visibleWidth(marker) - visibleWidth(stats) - 1,
              );
              const name = truncateToWidth(file.name, nameWidth, "…");
              const gap = " ".repeat(
                Math.max(
                  1,
                  sidebarWidth -
                    visibleWidth(marker) -
                    visibleWidth(name) -
                    visibleWidth(stats),
                ),
              );
              sidebar = `${marker}${name}${gap}${styledStats}`;
            } else {
              sidebar = `  ${theme.fg("dim", truncateToWidth(file.path, Math.max(1, sidebarWidth - 2), "…"))}`;
            }

            sidebar = padToWidth(sidebar, sidebarWidth);
            if (isSelected) {
              sidebar = theme.bg(
                focus === "files" ? "selectedBg" : "customMessageBg",
                sidebar,
              );
            }
          } else {
            sidebar = " ".repeat(sidebarWidth);
          }

          const diffLine = currentDiffLines(selectedFile)[diffOffset + row];
          const diff = padToWidth(
            diffLine === undefined ? "" : styleDiffLine(diffLine),
            diffWidth,
          );
          const separator = theme.fg(
            focus === "diff" ? "borderAccent" : "borderMuted",
            "│",
          );
          lines.push(
            `${theme.fg("borderMuted", "│")}${sidebar}${separator}${diff}${theme.fg("borderMuted", "│")}`,
          );
        }

        const help =
          focus === "files"
            ? "j/k or ↑/↓ select · enter/space/l open diff · esc close"
            : "j/k or ↑/↓ scroll · ctrl-d/u page · g/G top/bottom · esc/h files";
        lines.push(border(width, help, false));
        return lines;
      }

      ensureDiffLoaded(files[selectedIndex]!);

      return {
        dispose() {
          disposed = true;
          for (const controller of pendingDiffLoads.values()) {
            controller.abort();
          }
          pendingDiffLoads.clear();
        },
        handleInput,
        invalidate() {},
        render,
      };
    },
    {
      overlay: true,
      overlayOptions: {
        anchor: "center",
        margin: 1,
        maxHeight: "90%",
        minWidth: 60,
        width: "95%",
      },
    },
  );
}
