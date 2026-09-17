import fs from 'node:fs';
import path from 'node:path';

const root = process.cwd();
const read = (file) => fs.readFileSync(path.join(root, file), 'utf8');
const fail = (message) => {
  console.error(`TYPESCRIPT COMPAT ERROR: ${message}`);
  process.exitCode = 1;
};

const pkg = JSON.parse(read('package.json'));
const typescriptSpec = pkg.devDependencies?.typescript ?? '';
const typescriptMajor = Number((typescriptSpec.match(/\d+/) ?? [])[0]);
const main = read('src/main.ts');
const viteEnvPath = path.join(root, 'src', 'vite-env.d.ts');
const hasSideEffectAssetImport = /^\s*import\s+['"][^'"]+\.(?:css|scss|sass|less|styl|stylus)['"];?\s*$/m.test(main);

if (!Number.isInteger(typescriptMajor) || typescriptMajor < 1) {
  fail(`Could not determine the TypeScript major version from '${typescriptSpec}'.`);
}

if (typescriptMajor >= 7 && hasSideEffectAssetImport) {
  if (!fs.existsSync(viteEnvPath)) {
    fail('TypeScript 7+ side-effect asset imports require src/vite-env.d.ts.');
  } else {
    const viteEnv = read('src/vite-env.d.ts');
    if (!/\/\/\/\s*<reference\s+types=['"]vite\/client['"]\s*\/>/.test(viteEnv)) {
      fail('src/vite-env.d.ts must reference vite/client so TypeScript can resolve Vite asset imports.');
    }
  }
}

if (!process.exitCode) {
  console.log(`TypeScript compatibility: v${typescriptMajor} side-effect asset import declarations are configured.`);
}
