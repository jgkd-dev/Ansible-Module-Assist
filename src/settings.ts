/**
 * Settings moved from `ansibleModules.*` to `assistable.*` in 0.4.0.
 * Pure precedence logic (no vscode imports) so it can be unit tested.
 */

export const SECTION = 'assistable';
export const LEGACY_SECTION = 'ansibleModules';

/** Settings that existed under `ansibleModules.*` and are still read from there as a fallback. */
export const LEGACY_KEYS = [
  'ansibleBinPath',
  'collectionsPaths',
  'useAnsibleDoc',
  'insertRequiredOptions',
  'inlineSuggestions',
  'suggestShortNames',
  'suggestTaskKeywords',
  'includeDeprecated',
  'activation',
] as const;

/** The parts of `WorkspaceConfiguration.inspect()` we use. */
export interface Inspected<T> {
  defaultValue?: T;
  globalValue?: T;
  workspaceValue?: T;
  workspaceFolderValue?: T;
}

export const SCOPES = ['workspaceFolderValue', 'workspaceValue', 'globalValue'] as const;

/**
 * Most specific scope wins, as in VS Code. Within a scope the new key wins
 * over the old one, so an old workspace setting still beats a new user setting.
 */
export function pickSetting<T>(now: Inspected<T> | undefined, old: Inspected<T> | undefined, fallback: T): T {
  for (const scope of SCOPES) {
    const v = now?.[scope] ?? old?.[scope];
    if (v !== undefined) return v;
  }
  return now?.defaultValue ?? fallback;
}
