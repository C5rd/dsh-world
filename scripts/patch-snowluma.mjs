import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, extname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** SDK 1.x supports Node 22 but publishes extensionless ESM imports; keep the fix in every install. */
export function patchSnowluma(packageDir) {
  const changes = [];
  function visit(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const file = join(directory, entry.name);
      if (entry.isDirectory()) { visit(file); continue; }
      if (extname(file) !== '.js') continue;
      const source = readFileSync(file, 'utf8');
      const patched = source.replace(/(\b(?:from|import)\s*['"])(\.[^'"]+)(['"])/g, (match, prefix, specifier, quote) => {
        if (extname(specifier)) return match;
        const suffix = ['.js', '/index.js'].find(value => existsSync(resolve(dirname(file), specifier + value)));
        if (!suffix) throw new Error(`SnowLuma SDK import cannot be resolved: ${file}: ${specifier}`);
        return prefix + specifier + suffix + quote;
      });
      if (patched !== source) changes.push([file, patched]);
    }
  }
  const dist = join(packageDir, 'dist');
  if (!existsSync(dist)) return 0;
  visit(dist);
  for (const [file, patched] of changes) writeFileSync(file, patched, 'utf8');
  return changes.length;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const require = createRequire(import.meta.url);
  // The SDK is optional (only the QQ module, switched on in the console, loads it): a missing SDK must not fail the install.
  let manifest;
  try { manifest = require.resolve('@snowluma/sdk/package.json'); }
  catch { process.stdout.write('@snowluma/sdk is not installed; QQ stays unavailable until it is.\n'); process.exit(0); }
  const count = patchSnowluma(dirname(manifest));
  process.stdout.write(`SnowLuma SDK ESM imports ready (${count} files updated).\n`);
}
