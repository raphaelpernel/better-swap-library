// Shared message protocol between the main thread (code.ts) and the UI (ui/*.tsx).
// Kept in one file so both sides stay in sync at compile time.

export type SwapScope = "selection" | "page";

export interface BaseLibrary {
  fileKey: string;
  fileUrl: string;
  fileName: string;
  variableLibraryName?: string;
}

export interface TargetLibrary {
  id: string;
  fileKey: string;
  fileUrl: string;
  fileName: string;
  label: string;
  variableLibraryName?: string;
}

export interface PluginConfig {
  hasToken: boolean;
  base: BaseLibrary | null;
  targets: TargetLibrary[];
}

export type SwapDirection = "BaseToTarget" | "TargetToBase";

export type SwapCategory = "components" | "variables" | "textStyles" | "effectStyles";

export interface SwapCounts {
  components: number;
  variables: number;
  textStyles: number;
  effectStyles: number;
}

export interface UnmatchedEntry {
  category: SwapCategory;
  name: string;
  nodeName: string;
}

// ---------- UI -> main thread ----------

export type UiToMainMessage =
  | { type: "ui-ready" }
  | { type: "save-token"; token: string }
  | { type: "clear-token" }
  | { type: "set-base"; fileUrl: string; variableLibraryName?: string }
  | { type: "clear-base" }
  | { type: "add-target"; label: string; fileUrl: string; variableLibraryName?: string }
  | { type: "delete-target"; id: string }
  | { type: "get-scope-info"; scope: SwapScope }
  | { type: "run-swap"; targetId: string; direction: SwapDirection; scope: SwapScope }
  | { type: "cancel-swap" };

// ---------- main thread -> UI ----------

export type MainToUiMessage =
  | {
      type: "init";
      config: PluginConfig;
      enabledVariableLibraries: string[];
      hasSelection: boolean;
    }
  | { type: "base-set"; base: BaseLibrary }
  | { type: "base-error"; message: string }
  | { type: "target-added"; target: TargetLibrary }
  | { type: "target-deleted"; id: string }
  | { type: "target-error"; message: string }
  | { type: "token-saved" }
  | { type: "scope-info"; scope: SwapScope; count: number; label: string }
  | {
      type: "progress";
      phase: SwapCategory;
      done: number;
      total: number;
      elapsedMs: number;
    }
  | { type: "log"; level: "info" | "warn" | "error"; message: string }
  | {
      type: "done";
      counts: SwapCounts;
      unmatched: UnmatchedEntry[];
      elapsedMs: number;
    }
  | { type: "error"; message: string };
