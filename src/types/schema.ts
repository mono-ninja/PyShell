// Re-export all generated types from ts-rs bindings
// This file is hand-maintained; the individual files in bindings/ are generated.
export type { ScriptSchema } from "./bindings/ScriptSchema";
export type { ScriptDoc } from "./bindings/ScriptDoc";
export type { DocVariant } from "./bindings/DocVariant";
export type { SchemaSource } from "./bindings/SchemaSource";
export type { Runtime } from "./bindings/Runtime";
export type { InputSpec } from "./bindings/InputSpec";
export type { InputType } from "./bindings/InputType";
export type { ChoiceOption } from "./bindings/ChoiceOption";
export type { Binding } from "./bindings/Binding";
export type { ArgStyle } from "./bindings/ArgStyle";
export type { Condition } from "./bindings/Condition";
export type { Outputs } from "./bindings/Outputs";
export type { ResultKind } from "./bindings/ResultKind";
export type { ScriptEntry } from "./bindings/ScriptEntry";
export type { RepoScript } from "./bindings/RepoScript";
export type { RepoInstallResult } from "./bindings/RepoInstallResult";
export type { EnvStatus } from "./bindings/EnvStatus";
export type { DiskUsage } from "./bindings/DiskUsage";
export type { Artifact } from "./bindings/Artifact";
export type { ScriptState } from "./bindings/ScriptState";
export type { Preset } from "./bindings/Preset";
export type { HistoryEntry } from "./bindings/HistoryEntry";
export type { LogLine } from "./bindings/LogLine";
export type { JobEvent } from "./bindings/JobEvent";
export type { ExitReason } from "./bindings/ExitReason";
export type { CommandPreview } from "./bindings/CommandPreview";

export type JobId = string;
