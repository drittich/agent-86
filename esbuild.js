const esbuild = require('esbuild');

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');

const baseOptions = {
  bundle: true,
  minify: isProduction,
  sourcemap: !isProduction,
  logLevel: 'info',
};

async function build() {
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
