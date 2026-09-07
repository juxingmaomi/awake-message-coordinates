import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
const core = await fs.readFile(path.join(root, 'index.js'), 'utf8');
const loader = await fs.readFile(path.join(root, 'tavern-helper-loader.js'), 'utf8');
const version = `v${pkg.version}`;
assert.ok(core.includes(`const SCRIPT_VERSION = '${version}';`));
assert.ok(loader.includes(`const VERSION = '${version}';`));
const entries = [];
for (const name of await fs.readdir(root)) {
    if (!name.endsWith('.json') || name === 'package.json') continue;
    const entry = JSON.parse(await fs.readFile(path.join(root, name), 'utf8'));
    if (entry.type === 'script' && entry.content?.includes('awake-message-coordinates')) {
        entries.push({ name, entry });
    }
}
assert.equal(entries.length, 1, 'expected one script entry template');
const { name, entry } = entries[0];
const description = core.match(/^\/\/ description: (.+)$/m)?.[1] ?? '';
entry.content = loader;
entry.info = `${version}: ${description}`;
await fs.writeFile(path.join(root, name), `${JSON.stringify(entry, null, 2)}\n`, 'utf8');

if (process.argv[2]) {
    const output = path.resolve(process.argv[2]);
    await fs.mkdir(output, { recursive: true });
    const local = {
        ...entry,
        id: randomUUID(),
        enabled: false,
        name: `${entry.name} - ${version} Local Test`,
        content: core,
        info: `LOCAL TEST, disabled by default. Enable only one version of this script. ${description}`,
    };
    const outputFile = path.join(output, `awake-message-coordinates-${version}-local.json`);
    await fs.writeFile(outputFile, `${JSON.stringify(local, null, 2)}\n`, 'utf8');
    console.log(outputFile);
}
