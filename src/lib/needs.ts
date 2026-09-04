import type { ScriptEntry } from "../types/schema";

/**
 * Pure helpers around a script's declared `needs` (manifest ids of other
 * scripts it expects to be installed). Tested here rather than in the
 * component, per the repo's convention of testing logic instead of rendering.
 */

/** The `needs` ids that no imported script carries — the ones the header pill
 * warns about. Satisfied dependencies are deliberately not returned: a
 * resolved dependency is business as usual, a missing one is actionable.
 *
 * `needs` may be `undefined`: the backend skips the field over IPC when the
 * list is empty (serde `skip_serializing_if`), so every schema saved before
 * the feature arrives without it. */
export function missingNeeds(needs: string[] | undefined, scripts: ScriptEntry[]): string[] {
  const installed = new Set(scripts.map((s) => s.id));
  return (needs ?? []).filter((id) => !installed.has(id));
}
