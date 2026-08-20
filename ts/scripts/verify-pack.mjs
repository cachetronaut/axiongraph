import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const packageJson = JSON.parse(readFileSync(resolve(packageRoot, 'package.json'), 'utf8'));
const packOutput = execFileSync('npm', ['pack', '--dry-run', '--json', '--ignore-scripts'], {
  cwd: packageRoot,
  encoding: 'utf8',
});
const [pack] = JSON.parse(packOutput);

if (!pack?.files) {
  throw new Error('npm pack did not report the package file list');
}

const packedFiles = new Set(pack.files.map((file) => file.path));
const requiredFiles = new Set([
  ...collectExportTargets(packageJson.exports),
  'dist/store-convex/component/convex.config.ts',
  'dist/store-convex/component/events.ts',
  'dist/store-convex/component/schema.ts',
]);
const missingFiles = [...requiredFiles].filter((file) => !packedFiles.has(file));

if (missingFiles.length > 0) {
  throw new Error(`Package is missing declared export files:\n${missingFiles.join('\n')}`);
}

for (const exportPath of [
  'axiongraph/store-convex',
  'axiongraph/store-convex/server',
  'axiongraph/store-convex/convex.config',
]) {
  const resolvedPath = fileURLToPath(import.meta.resolve(exportPath));
  if (!existsSync(resolvedPath)) {
    throw new Error(`${exportPath} resolves to a missing file: ${resolvedPath}`);
  }
}

process.stdout.write(`Verified ${requiredFiles.size} packed export and Convex component files.\n`);

function collectExportTargets(exportsValue) {
  if (typeof exportsValue === 'string') {
    return [exportsValue.replace(/^\.\//, '')];
  }
  if (exportsValue === null || typeof exportsValue !== 'object') {
    return [];
  }
  return Object.values(exportsValue).flatMap(collectExportTargets);
}
