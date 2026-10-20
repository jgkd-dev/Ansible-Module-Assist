import * as fs from 'fs';
import * as path from 'path';
import { parse as parseYaml } from 'yaml';
import { ModuleIndex, ModuleInfo } from './indexer';

export interface OptionDoc {
  name: string;
  description: string;
  type?: string;
  elements?: string;
  required: boolean;
  default?: unknown;
  choices?: unknown[];
  aliases: string[];
  suboptions?: Record<string, OptionDoc>;
}

export interface ModuleDoc {
  fqcn: string;
  shortDescription?: string;
  description: string;
  options: Record<string, OptionDoc>;
  examples?: string;
  deprecated?: string;
  source: 'ansible-doc' | 'file';
}

/** Loads full module documentation, preferring `ansible-doc` (which resolves doc fragments). */
export class DocProvider {
  private cache = new Map<string, Promise<ModuleDoc | undefined>>();

  constructor(private index: ModuleIndex, private useAnsibleDoc: () => boolean) {}

  clear(): void {
    this.cache.clear();
  }

  get(mod: ModuleInfo): Promise<ModuleDoc | undefined> {
    let p = this.cache.get(mod.fqcn);
    if (!p) {
      p = this.load(mod).catch(() => undefined);
      this.cache.set(mod.fqcn, p);
    }
    return p;
  }

  /**
   * Reading the module file (+ its doc fragments) takes a few ms and matched
   * ansible-doc on 947/947 modules tested; ansible-doc takes ~0.7s per module,
   * too slow for inline suggestions. So the file is primary and ansible-doc is
   * the fallback when the file yields nothing.
   */
  private async load(mod: ModuleInfo): Promise<ModuleDoc | undefined> {
    let fromFile: ModuleDoc | undefined;
    if (mod.file) {
      const { doc, fragments } = await fromSourceFile(mod);
      for (const ref of fragments) {
        const opts = await this.loadFragmentOptions(ref);
        // Options defined by the module itself win over the fragment's.
        for (const [k, v] of Object.entries(opts)) if (!doc.options[k]) doc.options[k] = v;
      }
      fromFile = doc;
      if (Object.keys(doc.options).length || doc.description) return doc;
    }
    if (this.useAnsibleDoc() && this.index.cliAvailable) {
      const out = await this.index.cli.run('ansible-doc', ['-t', 'module', '-j', mod.fqcn]);
      const doc = out ? fromAnsibleDocJson(mod.fqcn, out) : undefined;
      if (doc) return doc;
    }
    return fromFile ?? fallbackDoc(mod);
  }

  private fragmentCache = new Map<string, Promise<Record<string, OptionDoc>>>();

  /**
   * Resolve an `extends_documentation_fragment` entry to its options:
   *   files                       -> ansible-core doc_fragments/files.py, DOCUMENTATION
   *   action_common_attributes.files -> same file, FILES attribute
   *   amazon.aws.common.modules   -> collection doc_fragments/common.py, MODULES attribute
   */
  private loadFragmentOptions(ref: string): Promise<Record<string, OptionDoc>> {
    let p = this.fragmentCache.get(ref);
    if (!p) {
      p = this.readFragment(ref).catch(() => ({}));
      this.fragmentCache.set(ref, p);
    }
    return p;
  }

  private async readFragment(ref: string): Promise<Record<string, OptionDoc>> {
    const parts = ref.split('.');
    let dir: string | undefined;
    let name: string;
    let attr = 'DOCUMENTATION';
    if (parts.length >= 3) {
      dir = this.index.getCollection(parts[0], parts[1])?.root;
      dir = dir && path.join(dir, 'plugins', 'doc_fragments');
      name = parts[2];
      if (parts[3]) attr = parts[3].toUpperCase();
    } else {
      const builtin = this.index.getCollection('ansible', 'builtin');
      dir = builtin?.source === 'builtin' && builtin.root ? path.join(builtin.root, 'plugins', 'doc_fragments') : undefined;
      name = parts[0];
      if (parts[1]) attr = parts[1].toUpperCase();
    }
    if (!dir) return {};
    const text = await fs.promises.readFile(path.join(dir, `${name}.py`), 'utf8');
    // Like Ansible: a missing named section (e.g. `.modules`) falls back to DOCUMENTATION.
    const yamlText = extractPyString(text, attr) ?? extractPyString(text, 'DOCUMENTATION');
    if (!yamlText) return {};
    const y = parseYaml(dedent(yamlText), { strict: false, uniqueKeys: false });
    return normaliseOptions(y?.options);
  }
}

function fallbackDoc(mod: ModuleInfo): ModuleDoc {
  return { fqcn: mod.fqcn, shortDescription: mod.shortDescription, description: mod.shortDescription ?? '', options: {}, source: 'file' };
}

function fromAnsibleDocJson(fqcn: string, out: string): ModuleDoc | undefined {
  try {
    const json = JSON.parse(out.slice(out.indexOf('{')));
    const entry = json[fqcn] ?? Object.values(json)[0];
    if (!entry?.doc) return undefined;
    return normaliseDoc(fqcn, entry.doc, typeof entry.examples === 'string' ? entry.examples : undefined, 'ansible-doc');
  } catch {
    return undefined;
  }
}

async function fromSourceFile(mod: ModuleInfo): Promise<{ doc: ModuleDoc; fragments: string[] }> {
  const file = mod.file!;
  const sidecar = file.replace(/\.(py|ps1)$/, '.yml');
  const fragmentsOf = (raw: any): string[] => {
    const f = raw?.extends_documentation_fragment;
    return (Array.isArray(f) ? f : f ? [f] : []).map(String);
  };
  try {
    if (fs.existsSync(sidecar)) {
      const y = parseYaml(await fs.promises.readFile(sidecar, 'utf8'), { strict: false, uniqueKeys: false });
      if (y?.DOCUMENTATION) {
        const examples = typeof y.EXAMPLES === 'string' ? y.EXAMPLES : undefined;
        return { doc: normaliseDoc(mod.fqcn, y.DOCUMENTATION, examples, 'file'), fragments: fragmentsOf(y.DOCUMENTATION) };
      }
    }
    const text = await fs.promises.readFile(file, 'utf8');
    const docStr = extractPyString(text, 'DOCUMENTATION');
    if (!docStr) return { doc: fallbackDoc(mod), fragments: [] };
    const raw = parseYaml(dedent(docStr), { strict: false, uniqueKeys: false });
    return { doc: normaliseDoc(mod.fqcn, raw, extractPyString(text, 'EXAMPLES'), 'file'), fragments: fragmentsOf(raw) };
  } catch {
    return { doc: fallbackDoc(mod), fragments: [] };
  }
}

function extractPyString(text: string, varName: string): string | undefined {
  const re = new RegExp(`^[ \\t]*${varName}\\s*=\\s*[rRuUbB]*('''|""")([\\s\\S]*?)\\1`, 'm');
  return re.exec(text)?.[2];
}

/** Strip common leading indentation (fragment strings often live indented inside a class). */
function dedent(s: string): string {
  const lines = s.split('\n');
  const indents = lines.filter((l) => l.trim()).map((l) => /^ */.exec(l)![0].length);
  const min = indents.length ? Math.min(...indents) : 0;
  return min ? lines.map((l) => l.slice(min)).join('\n') : s;
}

function normaliseDoc(fqcn: string, doc: any, examples: string | undefined, source: ModuleDoc['source']): ModuleDoc {
  const deprecated = doc?.deprecated ? toText(doc.deprecated.why ?? doc.deprecated.removed_in ?? 'deprecated') : undefined;
  return {
    fqcn,
    shortDescription: doc?.short_description ? cleanMarkup(String(doc.short_description)) : undefined,
    description: toText(doc?.description),
    options: normaliseOptions(doc?.options),
    examples: examples?.replace(/^\s*\n/, '').trimEnd(),
    deprecated,
    source,
  };
}

function normaliseOptions(raw: any): Record<string, OptionDoc> {
  const out: Record<string, OptionDoc> = {};
  if (!raw || typeof raw !== 'object') return out;
  for (const [name, o] of Object.entries<any>(raw)) {
    if (!o || typeof o !== 'object') continue;
    out[name] = {
      name,
      description: toText(o.description),
      type: o.type,
      elements: o.elements,
      required: o.required === true || o.required === 'true' || o.required === 'yes',
      default: o.default,
      choices: Array.isArray(o.choices) ? o.choices : o.choices && typeof o.choices === 'object' ? Object.keys(o.choices) : undefined,
      aliases: Array.isArray(o.aliases) ? o.aliases.map(String) : [],
      suboptions: o.suboptions ? normaliseOptions(o.suboptions) : undefined,
    };
  }
  return out;
}

function toText(v: unknown): string {
  if (v == null) return '';
  if (Array.isArray(v)) return v.map((x) => cleanMarkup(String(x))).join('\n\n');
  return cleanMarkup(String(v));
}

/** Converts Ansible doc markup (C(), I(), B(), M(), O(), V(), U(), L()) to Markdown. */
export function cleanMarkup(s: string): string {
  return s
    .replace(/L\(([^,)]+),\s*([^)]+)\)/g, '[$1]($2)')
    .replace(/U\(([^)]+)\)/g, '$1')
    .replace(/\bRV\(([^)]*)\)/g, '`$1`')
    .replace(/\b[CMOVE]\(([^)]*)\)/g, '`$1`')
    .replace(/\bI\(([^)]*)\)/g, '*$1*')
    .replace(/\bB\(([^)]*)\)/g, '**$1**')
    .replace(/HORIZONTALLINE/g, '---');
}

export function docsUrl(fqcn: string): string {
  const [ns, coll, name] = fqcn.split('.');
  return `https://docs.ansible.com/ansible/latest/collections/${ns}/${coll}/${name}_module.html`;
}

export function galaxyUrl(fqcn: string): string {
  const [ns, coll] = fqcn.split('.');
  return `https://galaxy.ansible.com/ui/repo/published/${ns}/${coll}/`;
}
