/**
 * Pure YAML-structure helpers (no vscode imports) so they can be unit tested.
 * They work line-by-line on indentation, which is robust while the user is
 * mid-edit and the document isn't valid YAML yet.
 */

export const TASK_LIST_KEYS = new Set(['tasks', 'pre_tasks', 'post_tasks', 'handlers', 'block', 'rescue', 'always']);

export const TASK_KEYWORDS: Record<string, string> = {
  name: 'Task name shown in output',
  when: 'Conditional expression; the task runs only if it is true',
  register: 'Save the task result into a variable',
  loop: 'List to iterate over (item available as `item`)',
  loop_control: 'Control loop behaviour (loop_var, label, pause, index_var)',
  with_items: 'Legacy loop over a list',
  vars: 'Variables scoped to this task',
  become: 'Run with privilege escalation',
  become_user: 'User to become',
  become_method: 'Privilege escalation method (sudo, su, ...)',
  notify: 'Handlers to notify when the task reports changed',
  tags: 'Tags to select/skip this task',
  ignore_errors: 'Continue even if the task fails',
  ignore_unreachable: 'Continue even if the host is unreachable',
  changed_when: 'Override when the task reports changed',
  failed_when: 'Override when the task reports failure',
  until: 'Retry until this condition is true',
  retries: 'Number of retries for `until`',
  delay: 'Seconds between retries',
  delegate_to: 'Run the task on another host',
  delegate_facts: 'Assign gathered facts to the delegated host',
  run_once: 'Run on only the first host in the batch',
  environment: 'Environment variables for the task',
  no_log: 'Hide task output (for secrets)',
  check_mode: 'Force check mode on/off for this task',
  diff: 'Show diffs for this task',
  async: 'Run asynchronously for up to N seconds',
  poll: 'Poll interval for async tasks (0 = fire and forget)',
  throttle: 'Limit concurrent workers for this task',
  timeout: 'Task timeout in seconds',
  args: 'Module arguments as a mapping',
  module_defaults: 'Default module arguments',
  any_errors_fatal: 'Fail the whole play if this task fails on any host',
  connection: 'Connection plugin to use',
  listen: 'Topic(s) a handler listens on',
  block: 'Group tasks together',
  rescue: 'Tasks to run if the block fails',
  always: 'Tasks that always run after the block',
};

export interface LineInfo {
  /** Column where the mapping key starts (after any `- `). -1 for blank/comment lines. */
  keyCol: number;
  /** Column of the leading `-` if this line starts a list item. */
  dashCol?: number;
  /** The key, if the line is `key:` or `key: value`. */
  key?: string;
  /** True if the key has no inline value (so it opens a nested block). */
  opensBlock?: boolean;
}

const KEY_RE = /^([A-Za-z0-9_.\-]+)\s*:(?:\s+(.*))?$/;

export function analyseLine(text: string): LineInfo {
  const m = /^(\s*)(-\s+)?(.*)$/.exec(text)!;
  const rest = m[3];
  if (!rest.trim() && !m[2]) return { keyCol: -1 };
  if (rest.trimStart().startsWith('#') && !m[2]) return { keyCol: -1 };
  const dashCol = m[2] ? m[1].length : undefined;
  const keyCol = m[1].length + (m[2]?.length ?? 0);
  const body = rest.replace(/\s+#.*$/, '').trimEnd();
  const km = KEY_RE.exec(body);
  if (km) {
    const value = (km[2] ?? '').trim();
    return { keyCol, dashCol, key: km[1], opensBlock: value === '' };
  }
  return { keyCol, dashCol };
}

export interface Enclosing {
  /** The list item we're in belongs to this key (e.g. `tasks`), if any. */
  listParentKey?: string;
  /** True if we're directly inside a list item (task-like position). */
  inListItem: boolean;
  /** True if that list is at the document root (a tasks/handlers file). */
  topLevelList: boolean;
  /** Key of the mapping directly containing this position (e.g. a module name). */
  mapParentKey?: string;
  mapParentLine?: number;
  /** Line where the enclosing list item starts. */
  itemLine?: number;
}

/**
 * Work out what encloses a key at (line, keyCol).
 * If `selfLine` starts the list item itself (`- foo`), it counts as being in that item.
 */
export function findEnclosing(lines: string[], lineNo: number, keyCol: number, currentDashCol?: number): Enclosing {
  if (currentDashCol !== undefined) {
    return { inListItem: true, itemLine: lineNo, ...listOwner(lines, lineNo, currentDashCol) };
  }
  for (let i = lineNo - 1; i >= 0; i--) {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) continue;
    if (li.keyCol === keyCol) {
      if (li.dashCol !== undefined) {
        return { inListItem: true, itemLine: i, ...listOwner(lines, i, li.dashCol) };
      }
      continue; // sibling key in the same mapping
    }
    if (li.keyCol < keyCol) {
      // A `- ` line whose dash is at our column means we're in a list, not a mapping.
      if (li.key && li.opensBlock) return { inListItem: false, topLevelList: false, mapParentKey: li.key, mapParentLine: i };
      return { inListItem: false, topLevelList: false };
    }
  }
  return { inListItem: false, topLevelList: keyCol === 0 };
}

function listOwner(lines: string[], itemLine: number, dashCol: number): { listParentKey?: string; topLevelList: boolean } {
  for (let i = itemLine - 1; i >= 0; i--) {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) continue;
    const col = li.dashCol ?? li.keyCol;
    if (col < dashCol || (col === dashCol && li.dashCol === undefined)) {
      // `tasks:` followed by `- ...` at the same indent is valid YAML too.
      return li.key && li.opensBlock ? { listParentKey: li.key, topLevelList: false } : { topLevelList: false };
    }
  }
  return { topLevelList: true };
}

/** Keys already present at `keyCol` in the block that contains `lineNo`. */
export function siblingKeys(lines: string[], lineNo: number, keyCol: number): Set<string> {
  const keys = new Set<string>();
  const visit = (i: number): boolean => {
    const li = analyseLine(lines[i]);
    if (li.keyCol < 0) return true;
    if (li.keyCol < keyCol) return false;
    if (li.keyCol === keyCol && li.key) keys.add(li.key);
    return true;
  };
  // Upwards: stop at a lower indent, or at the start of our own list item.
  for (let i = lineNo - 1; i >= 0; i--) {
    if (!visit(i)) break;
    const li = analyseLine(lines[i]);
    if (li.keyCol === keyCol && li.dashCol !== undefined) break;
  }
  for (let i = lineNo + 1; i < lines.length; i++) {
    const li = analyseLine(lines[i]);
    if (li.keyCol === keyCol && li.dashCol !== undefined) break; // next list item
    if (!visit(i)) break;
  }
  return keys;
}

export interface KeyToken {
  /** Column where the token starts. */
  start: number;
  token: string;
  /** Column of `-` if the token is the first key of a list item. */
  dashCol?: number;
}

/** If the text before the cursor is a (partial) mapping key, return it. */
export function keyTokenBeforeCursor(prefix: string): KeyToken | undefined {
  const m = /^(\s*)(-\s+)?([A-Za-z0-9_.]*)$/.exec(prefix);
  if (!m) return undefined;
  return { start: m[1].length + (m[2]?.length ?? 0), token: m[3], dashCol: m[2] ? m[1].length : undefined };
}

export interface ValueToken {
  key: string;
  keyCol: number;
  dashCol?: number;
  valueStart: number;
  value: string;
}

/** If the cursor is in the value of `key: <here>`, return it. */
export function valueTokenBeforeCursor(prefix: string): ValueToken | undefined {
  const m = /^(\s*)(-\s+)?([A-Za-z0-9_]+):(\s+)(['"]?[^\s'"#]*)$/.exec(prefix);
  if (!m) return undefined;
  const keyCol = m[1].length + (m[2]?.length ?? 0);
  return {
    key: m[3],
    keyCol,
    dashCol: m[2] ? m[1].length : undefined,
    valueStart: keyCol + m[3].length + 1 + m[4].length,
    value: m[5],
  };
}

/** Heuristic for "is this YAML file Ansible?" */
export function looksLikeAnsible(filePath: string, text: string): boolean {
  const p = filePath.replace(/\\/g, '/');
  if (/\/(tasks|handlers|playbooks?|roles)\//.test(p)) return true;
  if (/(^|\/)(site|playbook|main)[^/]*\.ya?ml$/.test(p) && /^\s*-\s/m.test(text)) return true;
  if (/^\s*-?\s*(hosts|tasks|handlers|gather_facts|become|import_playbook|roles)\s*:/m.test(text)) return true;
  if (/^\s*-?\s*[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+\s*:/m.test(text)) return true;
  if (/^\s*-\s+name\s*:/m.test(text)) return true;
  return false;
}
