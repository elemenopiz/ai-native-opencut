# AGENTS.md

## Overview

Privacy-first video editor, with a focus on simplicity and ease of use.

## Product Direction

Byorn is local-first. If a capability has a good free local alternative with no
meaningful downside, prefer the local path and avoid adding another provider cog.

The core cloud stack is intentionally small:

- **BytePlus ModelArk / Seedance** — direct video generation.
- **OpenAI GPT Image** — reference stills for persona/product/scene consistency.
- **Cloudflare R2** — durable storage for generated videos and reference stills.

Everything else is optional or legacy unless the user explicitly asks to revive
that feature: Replicate, PiAPI Seedance, Stability, Luma, Sarvam, Smallest,
Freesound, Pexels, YouTube OAuth, analytics, and CMS integrations.

Brand assets follow the same split: keep the full embedded-raster logo as
`apps/web/public/byorn.svg` for source/master use, but load the optimized
runtime mark (`byorn-mark.png`) and favicon/app icons in the UI. Because the
mark is black and the app is dark, render it on a subtle gray tile.

## Lib vs Utils

- `lib/` - domain logic (specific to this app)
- `utils/` - small helper utils (generic, could be copy-pasted into any other app)

## Core Editor System

The editor uses a **singleton EditorCore** that manages all editor state through specialized managers.

### Architecture

```
EditorCore (singleton)
├── playback: PlaybackManager
├── timeline: TimelineManager
├── scene: SceneManager
├── project: ProjectManager
├── media: MediaManager
└── renderer: RendererManager
```

### When to Use What

#### In React Components

**Always use the `useEditor()` hook:**

```typescript
import { useEditor } from '@/hooks/use-editor';

function MyComponent() {
  const editor = useEditor();
  const tracks = editor.timeline.getTracks();

  // Call methods
  editor.timeline.addTrack({ type: 'media' });

  // Display data (auto re-renders on changes)
  return <div>{tracks.length} tracks</div>;
}
```

The hook:

- Returns the singleton instance
- Subscribes to all manager changes
- Automatically re-renders when state changes

#### Outside React Components

**Use `EditorCore.getInstance()` directly:**

```typescript
// In utilities, event handlers, or non-React code
import { EditorCore } from "@/core";

const editor = EditorCore.getInstance();
await editor.export({ format: "mp4", quality: "high" });
```

## Actions System

Actions are the trigger layer for user-initiated operations. The single source of truth is `@/lib/actions/definitions.ts`.

**To add a new action:**

1. Add it to `ACTIONS` in `@/lib/actions/definitions.ts`:

```typescript
export const ACTIONS = {
  "my-action": {
    description: "What the action does",
    category: "editing",
    defaultShortcuts: ["ctrl+m"],
  },
  // ...
};
```

2. Add handler in `@/hooks/use-editor-actions.ts`:

```typescript
useActionHandler(
  "my-action",
  () => {
    // implementation
  },
  undefined,
);
```

**In components, use `invokeAction()` for user-triggered operations:**

```typescript
import { invokeAction } from '@/lib/actions';

// Good - uses action system
const handleSplit = () => invokeAction("split-selected");

// Avoid - bypasses UX layer (toasts, validation feedback)
const handleSplit = () => editor.timeline.splitElements({ ... });
```

Direct `editor.xxx()` calls are for internal use (commands, tests, complex multi-step operations).

## Commands System

Commands handle undo/redo. They live in `@/lib/commands/` organized by domain (timeline, media, scene).

Each command extends `Command` from `@/lib/commands/base-command` and implements:

- `execute()` - saves current state, then does the mutation
- `undo()` - restores the saved state

Actions and commands work together: actions are "what triggered this", commands are "how to do it (and undo it)".

<!-- gitnexus:start -->
# GitNexus — Code Intelligence

This project is indexed by GitNexus as **ai-native-opencut** (30956 symbols, 80858 relationships, 1116 execution flows).

> Index stale? Run `node .gitnexus/run.cjs analyze --index-only` from the project root — it auto-selects an available runner. No `.gitnexus/run.cjs` yet? Bootstrap with `npx`, `bunx`, or `pnpm dlx` — e.g. `bunx gitnexus@latest analyze` (npm 11 npx crash; #1939).

## Always Do

- **MUST run impact before editing.** Use `impact({target: "symbolName", direction: "upstream"})` or `node .gitnexus/run.cjs impact "symbolName" --direction upstream --repo .`; report callers, processes, and risk. Never substitute grep for graph analysis.
- **MUST analyze graph changes before committing.** Use `detect_changes({scope: "all"})` (MCP) or `node .gitnexus/run.cjs detect-changes --scope all --repo .` (CLI fallback). `partial: true` or `truncated: true` is not a clean check — a zero means unseen, not unaffected; re-run it. For regression review: `detect_changes({scope: "compare", base_ref: "main"})` or `node .gitnexus/run.cjs detect-changes --scope compare --base-ref "main" --repo .`.
- MUST warn on HIGH/CRITICAL `risk` pre-edit; never use `riskSharedAxes` to waive a HIGH/CRITICAL `risk` warning. Compare File/symbol: MCP File omits axes; Graph-RAG expands File.
- **MUST treat `risk: UNKNOWN` as unresolved, not as low.** An empty caller set is not evidence the symbol is unused — it can also mean the callers are not resolvable by the index (plain-object property access, dynamic dispatch, cross-language calls). `impact` pairs `UNKNOWN` with a `riskNote` saying so. Confirm with a text search before treating the symbol as safe to change or delete; do not proceed on the strength of a zero.
- **MUST use `query({search_query: "concept"})` for concepts/flows, `context({name: "symbolName"})` for a named symbol, or `impact` for blast radius, on read-only callers, dependencies, imports, or execution flow.** Graph first; text search only for empty/`UNKNOWN`/literals.
- For security review, `explain({target: "fileOrSymbol"})` lists taint findings (source→sink flows; needs `analyze --pdg`).

## Never Do

- NEVER edit a function, class, or method before MCP/CLI impact analysis.
- NEVER ignore HIGH or CRITICAL risk warnings from impact analysis, and never read `UNKNOWN` as an all-clear — it means the walk could not answer, which is the one verdict that requires confirming by other means.
- NEVER rename symbols with find-and-replace — use `rename` which understands the call graph.
- NEVER commit before MCP/CLI graph change analysis.

## Resources

| Resource | Use for |
| --- | --- |
| `gitnexus://repo/ai-native-opencut/context` | Codebase overview, check index freshness |
| `gitnexus://repo/ai-native-opencut/clusters` | All functional areas |
| `gitnexus://repo/ai-native-opencut/processes` | All execution flows |
| `gitnexus://repo/ai-native-opencut/process/{name}` | Step-by-step execution trace |

## CLI

| Task | Read this skill file |
| --- | --- |
| Understand architecture / "How does X work?" | `.claude/skills/gitnexus-exploring/SKILL.md` |
| Blast radius / "What breaks if I change X?" | `.claude/skills/gitnexus-impact-analysis/SKILL.md` |
| Trace bugs / "Why is X failing?" | `.claude/skills/gitnexus-debugging/SKILL.md` |
| Rename / extract / split / refactor | `.claude/skills/gitnexus-refactoring/SKILL.md` |
| Tools, resources, schema reference | `.claude/skills/gitnexus-guide/SKILL.md` |
| Index, status, clean, wiki CLI commands | `.claude/skills/gitnexus-cli/SKILL.md` |

<!-- gitnexus:end -->
