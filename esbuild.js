const esbuild = require('esbuild');
const fs = require('fs');
const path = require('path');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');
const isMinorBump = process.argv.includes('--minor');

const baseOptions = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  logLevel: 'info',
};

function incrementPatchVersion() {
  const packageJsonPath = path.join(__dirname, 'package.json');
  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, 'utf8'));
  
  const versionParts = packageJson.version.split('.');
  if (versionParts.length !== 3) {
    console.error('Invalid version format. Expected semver (e.g., 1.2.3)');
    process.exit(1);
  }
  
  if (isMinorBump) {
    const minor = parseInt(versionParts[1], 10) + 1;
    versionParts[1] = minor.toString();
    versionParts[2] = '0';
  } else {
    const patch = parseInt(versionParts[2], 10) + 1;
    versionParts[2] = patch.toString();
  }
  
  const newVersion = versionParts.join('.');
  
  packageJson.version = newVersion;
  fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
  
  console.log(`Version incremented to ${newVersion}`);
}

async function build() {
  incrementPatchVersion();
  // Extension host bundle (Node/CJS, external: vscode)
  const extensionCtx = await esbuild.context({
    ...baseOptions,
    entryPoints: ['src/extension.ts'],
    outfile: 'dist/extension.js',
    platform: 'node',
    format: 'cjs',
    external: ['vscode'],
  });

  // Webview bundle (browser)
  const webviewCtx = await esbuild.context({
    ...baseOptions,
    entryPoints: ['webview-ui/main.ts'],
    outfile: 'dist/webview.js',
    platform: 'browser',
    format: 'iife',
  });

  if (isWatch) {
    await Promise.all([extensionCtx.watch(), webviewCtx.watch()]);
    console.log('Watching for changes...');
  } else {
    await Promise.all([extensionCtx.rebuild(), webviewCtx.rebuild()]);
    await Promise.all([extensionCtx.dispose(), webviewCtx.dispose()]);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
