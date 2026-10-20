import assert from 'node:assert/strict';
import { analyseLine, findEnclosing, keyTokenBeforeCursor, siblingKeys, valueTokenBeforeCursor, looksLikeAnsible } from '../src/context';
import { ModuleIndex } from '../src/indexer';
import { DocProvider, cleanMarkup } from '../src/docs';
import { planGhost } from '../src/ghost';

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (e) {
    console.error(`  FAIL ${name}\n`, e);
    process.exitCode = 1;
  }
}

const playbook = `- hosts: firewall
  gather_facts: false
  tasks:
    - name: Allow SSH
      pfsensible.core.pfsense_rule:
        name: allow ssh
        action: pass

    - name: Copy file
      ansible.builtin.copy:
        src: a
        dest: b
    - name: New task

  handlers:
    - name: restart
      ansible.builtin.service:
        state:
`.split('\n');

(async () => {
  console.log('context');
  await test('analyseLine handles dash + key', () => {
    assert.deepEqual(analyseLine('    - name: Allow SSH'), { keyCol: 6, dashCol: 4, key: 'name', opensBlock: false });
    assert.equal(analyseLine('      pfsensible.core.pfsense_rule:').key, 'pfsensible.core.pfsense_rule');
    assert.equal(analyseLine('      pfsensible.core.pfsense_rule:').opensBlock, true);
    assert.equal(analyseLine('   # comment').keyCol, -1);
  });
  await test('task position inside tasks:', () => {
    const e = findEnclosing(playbook, 13, 6);
    assert.equal(e.inListItem, true);
    assert.equal(e.listParentKey, 'tasks');
  });
  await test('module option position', () => {
    const e = findEnclosing(playbook, 7, 8);
    assert.equal(e.mapParentKey, 'pfsensible.core.pfsense_rule');
  });
  await test('handlers count as task lists', () => {
    assert.equal(findEnclosing(playbook, 16, 6).listParentKey, 'handlers');
  });
  await test('play-level keys are not tasks', () => {
    const e = findEnclosing(playbook, 1, 2);
    assert.equal(e.inListItem, true);
    assert.equal(e.topLevelList, true);
    assert.ok(siblingKeys(playbook, 1, 2).has('hosts'));
  });
  await test('sibling keys of module options', () => {
    const s = siblingKeys(playbook, 7, 8);
    assert.deepEqual([...s].sort(), ['action', 'name']);
  });
  await test('sibling keys stay inside one task', () => {
    const s = siblingKeys(playbook, 13, 6);
    assert.deepEqual([...s], ['name']);
  });
  await test('dash-started task in a tasks file', () => {
    const lines = ['- name: x', '  ansible.builtin.ping:', '- ansible.b'];
    const tok = keyTokenBeforeCursor(lines[2])!;
    assert.equal(tok.token, 'ansible.b');
    const e = findEnclosing(lines, 2, tok.start, tok.dashCol);
    assert.equal(e.inListItem, true);
    assert.equal(e.topLevelList, true);
  });
  await test('nested list in module option is not a task', () => {
    const lines = ['- ansible.builtin.apt:', '    name:', '      - git', '      - cu'];
    const tok = keyTokenBeforeCursor(lines[3])!;
    const e = findEnclosing(lines, 3, tok.start, tok.dashCol);
    assert.equal(e.listParentKey, 'name');
  });
  await test('key + value tokens', () => {
    assert.deepEqual(keyTokenBeforeCursor('      pfsensible.'), { start: 6, token: 'pfsensible.', dashCol: undefined });
    assert.equal(keyTokenBeforeCursor('      name: foo'), undefined);
    const v = valueTokenBeforeCursor('        state: st')!;
    assert.equal(v.key, 'state');
    assert.equal(v.valueStart, 15);
    assert.equal(v.value, 'st');
  });
  await test('looksLikeAnsible', () => {
    assert.ok(looksLikeAnsible('/x/site.yml', playbook.join('\n')));
    assert.ok(looksLikeAnsible('/x/roles/web/tasks/main.yml', ''));
    assert.ok(!looksLikeAnsible('/x/k8s/deploy.yaml', 'apiVersion: v1\nkind: Pod\nmetadata:\n  name: x\n'));
  });
  await test('cleanMarkup', () => {
    assert.equal(cleanMarkup('Use C(state=present) and I(path) see RV(changed)'), 'Use `state=present` and *path* see `changed`');
  });

  console.log('index (real ansible install)');
  const index = new ModuleIndex({ collectionsPaths: [], workspaceFolders: [], includeDeprecated: false });
  const t0 = Date.now();
  await index.build();
  console.log(`  built in ${Date.now() - t0}ms: ${index.allCollections().map((c) => c.fqcn).join(', ')}`);
  await test('finds ansible.builtin, ansible.posix and pfsensible.core', () => {
    assert.ok(index.getCollection('ansible', 'builtin'));
    assert.ok(index.getCollection('ansible', 'posix'));
    assert.ok(index.getCollection('pfsensible', 'core'));
    assert.equal(index.getCollection('ansible', 'builtin')!.source, 'builtin');
  });
  await test('lists builtin modules with descriptions', async () => {
    const mods = await index.getModules(index.getCollection('ansible', 'builtin')!);
    assert.ok(mods.size > 60, `got ${mods.size}`);
    assert.equal(mods.get('copy')?.shortDescription, 'Copy files to remote locations');
    assert.ok(!mods.has('__init__'));
  });
  await test('lists pfsensible.core modules', async () => {
    const mods = await index.getModules(index.getCollection('pfsensible', 'core')!);
    assert.ok(mods.has('pfsense_rule'));
    assert.equal(mods.get('pfsense_rule')!.fqcn, 'pfsensible.core.pfsense_rule');
    console.log(`    ${mods.size} modules, e.g. ${[...mods.keys()].slice(0, 5).join(', ')}`);
  });
  await test('resolves short and FQCN names', async () => {
    assert.equal((await index.resolveModule('copy'))?.fqcn, 'ansible.builtin.copy');
    assert.equal((await index.resolveModule('ansible.posix.mount'))?.name, 'mount');
    assert.equal(await index.resolveModule('nope.nope.nope'), undefined);
  });

  console.log('docs');
  for (const useCli of [true, false]) {
    const provider = new DocProvider(index, () => useCli);
    const label = useCli ? 'ansible-doc' : 'source file';
    await test(`copy options via ${label}`, async () => {
      const d = (await provider.get((await index.resolveModule('ansible.builtin.copy'))!))!;
      assert.equal(d.source, 'file');
      assert.ok(d.options.dest?.required, 'dest required');
      assert.ok(d.options.src);
      assert.equal(d.options.backup.type, 'bool');
    });
    await test(`pfsense_rule options via ${label}`, async () => {
      const d = (await provider.get((await index.resolveModule('pfsensible.core.pfsense_rule'))!))!;
      assert.ok(d.options.action.choices?.includes('pass'));
      const req = Object.values(d.options).filter((o) => o.required).map((o) => o.name);
      console.log(`    required: ${req.join(', ')}; ${Object.keys(d.options).length} options`);
    });
  }

  await test('doc fragments resolved without ansible-doc (files fragment on copy)', async () => {
    const d = (await new DocProvider(index, () => false).get((await index.resolveModule('ansible.builtin.copy'))!))!;
    for (const k of ['owner', 'group', 'mode']) assert.ok(d.options[k], k);
  });

  console.log('inline ghost text');
  const dp = new DocProvider(index, () => true);
  const lookup = async (k: string) => { const m = await index.resolveModule(k); return m ? dp.get(m) : undefined; };
  const g = async (text: string) => {
    const lines = text.split('\n');
    const lineNo = lines.findIndex((l) => l.includes('|'));
    const col = lines[lineNo].indexOf('|');
    lines[lineNo] = lines[lineNo].replace('|', '');
    const r = await planGhost(lines, lineNo, col, lookup);
    return r && { ...r, typed: lines[lineNo].slice(r.start, col) };
  };
  const head = '- hosts: fw\n  tasks:\n    - name: t\n';
  await test('end of module line -> first required param on next line', async () => {
    const r = (await g(head + '      pfsensible.core.pfsense_rule:|'))!;
    assert.equal(r.text, '\n        name: ');
  });
  await test('empty line in block -> next missing required param', async () => {
    const r = (await g(head + '      pfsensible.core.pfsense_rule:\n        name: ssh\n        |'))!;
    assert.equal(r.text, 'interface: ');
  });
  await test('all required present -> no ghost on empty line', async () => {
    assert.equal(await g(head + '      pfsensible.core.pfsense_rule:\n        name: ssh\n        interface: lan\n        |'), undefined);
  });
  await test('partial name completes (optional too)', async () => {
    const r = (await g(head + '      pfsensible.core.pfsense_rule:\n        name: ssh\n        interface: lan\n        dest|'))!;
    assert.ok(r.text.startsWith('dest') && r.text.endsWith(': '), r.text);
    assert.equal(r.typed, 'dest');
  });
  await test('bool/choice with default shows the default', async () => {
    const r = (await g(head + '      ansible.builtin.copy:\n        dest: /x\n        backu|'))!;
    assert.equal(r.text, 'backup: false');
  });
  await test('value position -> default choice', async () => {
    const r = (await g(head + '      ansible.builtin.service:\n        name: nginx\n        state: |'));
    const r2 = (await g(head + '      pfsensible.core.pfsense_rule:\n        action: |'))!;
    assert.equal(r2.text, 'pass');
    console.log(`    service state -> ${JSON.stringify(r?.text)}`);
  });
  await test('partial value completes a choice', async () => {
    const r = (await g(head + '      pfsensible.core.pfsense_rule:\n        action: bl|'))!;
    assert.equal(r.text, 'block');
    assert.equal(r.typed, 'bl');
  });
  await test('short module name in a task', async () => {
    const r = (await g(head + '      copy:|'))!;
    assert.equal(r.text, '\n        dest: ');
  });
  await test('no ghost for task keys or text after cursor', async () => {
    assert.equal(await g(head + '      |'), undefined);
    assert.equal(await g(head + '      ansible.builtin.copy:\n        de|st: x'), undefined);
  });

  // Fallback mode: no ansible CLI reachable
  console.log('fallback (no CLI)');
  const noCli = new ModuleIndex({ ansibleBinPath: '/nonexistent', collectionsPaths: [], workspaceFolders: [], includeDeprecated: false });
  (noCli.cli as any).env.PATH = '/nonexistent';
  await noCli.build();
  await test('bundled builtin list + disk scan still find collections', async () => {
    assert.equal(noCli.getCollection('ansible', 'builtin')!.source, 'fallback');
    assert.ok((await noCli.getModules(noCli.getCollection('ansible', 'builtin')!)).has('template'));
    assert.ok(noCli.getCollection('pfsensible', 'core'), 'found by scanning ~/.ansible/collections');
  });

  console.log(`\n${passed} passed${process.exitCode ? ', some FAILED' : ''}`);
})();
