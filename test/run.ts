import assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  analyseLine,
  findEnclosing,
  keyTokenBeforeCursor,
  siblingKeys,
  siblingValue,
  valueTokenBeforeCursor,
  looksLikeAnsible,
  roleContext,
  roleReferenceAt,
} from '../src/context';
import { ModuleIndex } from '../src/indexer';
import { RoleIndex } from '../src/roles';
import { pickSetting } from '../src/settings';
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
    assert.ok(looksLikeAnsible('/x/roles/web/handlers/main.yml', ''));
    assert.ok(looksLikeAnsible('/x/roles/web/meta/main.yml', ''));
    // Role folders that never hold tasks, even when the content looks like tasks
    assert.ok(!looksLikeAnsible('/x/roles/web/files/list.yml', '- name: not a task\n'));
    assert.ok(!looksLikeAnsible('/x/roles/web/templates/app.yml', '- name: x\n'));
    assert.ok(!looksLikeAnsible('/x/roles/web/defaults/main.yml', 'web_port: 80\n'));
  });
  await test('siblingValue', () => {
    const lines = ['- include_role:', '    name: "web"  # comment', '    tasks_from: '];
    assert.equal(siblingValue(lines, 2, 4, 'name'), 'web');
    assert.equal(siblingValue(lines, 2, 4, 'missing'), undefined);
  });

  console.log('role context');
  const rcAt = (text: string) => {
    const lines = text.split('\n');
    const lineNo = lines.findIndex((l) => l.includes('|'));
    const col = lines[lineNo].indexOf('|');
    lines[lineNo] = lines[lineNo].replace('|', '');
    return { rc: roleContext(lines, lineNo, lines[lineNo].slice(0, col)), lines, lineNo, col };
  };
  const play = '- hosts: all\n  roles:\n';
  await test('new entry in roles: is a role name inserted as `role:`', () => {
    const { rc } = rcAt(play + '    - we|');
    assert.deepEqual(rc, { kind: 'roleName', start: 6, token: 'we', value: false, asKey: true });
  });
  await test('role: / name: values in roles: and dependencies:', () => {
    assert.equal(rcAt(play + '    - role: acme.|').rc?.kind, 'roleName');
    assert.equal(rcAt(play + '    - role: acme.|').rc?.token, 'acme.');
    assert.equal(rcAt(play + '    - name: w|').rc?.kind, 'roleName');
    assert.equal(rcAt('dependencies:\n  - role: |').rc?.kind, 'roleName');
    assert.equal(rcAt("dependencies:\n  - role: 'co|").rc?.token, 'co');
  });
  await test('keywords inside a roles: entry', () => {
    const { rc } = rcAt(play + '    - role: web\n      ta|');
    assert.equal(rc?.kind, 'roleKeyword');
    assert.ok(rc?.kind === 'roleKeyword' && rc.siblings.has('role'));
  });
  await test('include_role / import_role name and tasks_from', () => {
    const t = '- hosts: all\n  tasks:\n    - ansible.builtin.include_role:\n        name: web\n';
    assert.deepEqual(rcAt('- hosts: all\n  tasks:\n    - import_role:\n        name: |').rc, { kind: 'roleName', start: 14, token: '', value: true, asKey: false });
    const f = rcAt(t + '        tasks_from: ins|').rc;
    assert.deepEqual(f, { kind: 'roleFile', start: 20, token: 'ins', value: true, folder: 'tasks', role: 'web' });
    assert.equal(rcAt(t + '        vars_from: |').rc?.kind, 'roleFile');
  });
  await test('not role positions', () => {
    assert.equal(rcAt('- hosts: all\n  tasks:\n    - name: x|').rc, undefined);
    assert.equal(rcAt('- hosts: all\n  tasks:\n    - ansible.b|').rc, undefined);
    assert.equal(rcAt(play + '    - role: web\n      vars:\n        x|').rc, undefined, 'role vars are phase 2');
    assert.equal(rcAt('- ansible.builtin.copy:\n    name: |').rc, undefined);
  });
  await test('roleReferenceAt finds role names and files under the cursor', () => {
    const lines = ['- hosts: all', '  roles:', '    - web', "    - role: 'acme.infra.base'", '  tasks:', '    - include_role:', '        name: db', '        tasks_from: install'];
    assert.deepEqual(roleReferenceAt(lines, 2, 7), { kind: 'role', name: 'web', start: 6, end: 9 });
    assert.equal((roleReferenceAt(lines, 3, 20) as any)?.name, 'acme.infra.base');
    assert.equal(roleReferenceAt(lines, 3, 7), undefined, 'the `role` key itself');
    assert.equal((roleReferenceAt(lines, 6, 15) as any)?.name, 'db');
    assert.deepEqual(roleReferenceAt(lines, 7, 22), { kind: 'file', role: 'db', folder: 'tasks', file: 'install', start: 20, end: 27 });
    assert.equal(roleReferenceAt(lines, 0, 4), undefined);
  });

  console.log('role index (fixtures)');
  const fx = path.resolve(__dirname, '../test/fixtures/project');
  const roleIndex = new RoleIndex({ rolesPaths: [], workspaceFolders: [fx] });
  const acmeRoot = path.join(fx, 'collections/ansible_collections/acme/infra');
  roleIndex.build([{ namespace: 'acme', name: 'infra', fqcn: 'acme.infra', version: '1.2.0', root: acmeRoot, source: 'scan' }]);
  await test('roles_path from ansible.cfg comes before ./roles', () => {
    assert.deepEqual(roleIndex.roots.filter((r) => r.startsWith(fx)), [path.join(fx, 'extra_roles'), path.join(fx, 'roles')]);
    assert.equal(roleIndex.resolve('web')?.root, path.join(fx, 'extra_roles/web'));
    assert.ok(roleIndex.resolve('common'));
    assert.equal(roleIndex.resolve('not_a_role'), undefined, 'folders without tasks/meta/... are skipped');
  });
  await test("roles/ next to the playbook wins over roles_path", () => {
    const site = path.join(fx, 'site.yml');
    assert.equal(roleIndex.resolve('web', site)?.root, path.join(fx, 'roles/web'));
    assert.equal(roleIndex.resolve('web', site)?.source, 'playbook');
    // A playbook in a subfolder still finds the project's roles/
    assert.equal(roleIndex.resolve('db', path.join(fx, 'playbooks/deploy.yml'))?.source, 'playbook');
    // And a role's own task file finds its sibling roles
    assert.ok(roleIndex.resolve('db', path.join(fx, 'roles/web/tasks/main.yml')));
  });
  await test('Galaxy role names with a dot, and installed version', () => {
    const r = roleIndex.resolve('geerlingguy.docker')!;
    assert.equal(r.version, '7.4.1');
  });
  await test('collection roles by FQCN', () => {
    const r = roleIndex.resolve('acme.infra.base')!;
    assert.equal(r.source, 'collection');
    assert.equal(r.version, '1.2.0');
    assert.deepEqual(roleIndex.collectionRolesIn('acme.infra').map((x) => x.name), ['acme.infra.base']);
    assert.deepEqual([...roleIndex.roleCollections().get('acme')!], ['infra']);
  });
  await test('roles by path', () => {
    assert.equal(roleIndex.resolve('./roles/db', path.join(fx, 'site.yml'))?.root, path.join(fx, 'roles/db'));
  });
  await test('entry files for tasks_from', () => {
    const web = roleIndex.resolve('web', path.join(fx, 'site.yml'))!;
    assert.deepEqual(roleIndex.entryFiles(web, 'tasks'), ['main', 'install', 'sub/tls']);
    assert.equal(roleIndex.entryFile(web, 'tasks', 'install'), path.join(web.root, 'tasks/install.yml'));
    assert.equal(roleIndex.entryFile(web, 'tasks', 'sub/tls'), path.join(web.root, 'tasks/sub/tls.yaml'));
    assert.equal(roleIndex.entryFile(web, 'tasks', 'nope'), undefined);
    assert.equal(roleIndex.mainFile(web), path.join(web.root, 'tasks/main.yml'));
  });
  await test('details: argument_specs, meta and dependencies', () => {
    const d = roleIndex.details(roleIndex.resolve('web', path.join(fx, 'site.yml'))!);
    assert.equal(d.description, 'Installs the `nginx` web server', 'argument_specs short_description wins over galaxy_info');
    assert.equal(d.author, 'ops');
    assert.equal(d.options.web_port.required, true);
    assert.equal(d.options.web_port.type, 'int');
    assert.deepEqual(Object.keys(d.options.web_tls.suboptions!), ['cert'], 'nested `options:` become suboptions');
    assert.deepEqual(d.dependencies, ['common', 'acme.infra.base']);
    assert.equal(roleIndex.details(roleIndex.resolve('acme.infra.base')!).description, 'Base hardening');
    assert.deepEqual(roleIndex.details(roleIndex.resolve('db', path.join(fx, 'site.yml'))!).options, {});
  });

  console.log('settings');
  await test('new key wins within a scope, more specific scope wins overall', () => {
    assert.equal(pickSetting({ defaultValue: 'auto' }, undefined, 'x'), 'auto');
    assert.equal(pickSetting({ defaultValue: 'auto' }, { globalValue: 'always' }, 'x'), 'always', 'old key still read');
    assert.equal(pickSetting({ globalValue: 'auto' }, { globalValue: 'always' }, 'x'), 'auto', 'new beats old');
    assert.equal(pickSetting({ globalValue: 'auto' }, { workspaceValue: 'always' }, 'x'), 'always', 'old workspace beats new user');
    assert.equal(pickSetting<boolean>(undefined, undefined, true), true);
    assert.equal(pickSetting<boolean>({ globalValue: false }, undefined, true), false, 'false is a value');
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
