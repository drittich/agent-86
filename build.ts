/**
 * Build script for Agent 86.
 * Replaces esbuild.cjs — now uses Vite 8 (Rolldown) for both bundles.
 *
 * Usage:
 *   npx tsx build.ts                   # dev build
 *   npx tsx build.ts --watch           # watch mode
 *   npx tsx build.ts --production      # production + patch version bump
 *   npx tsx build.ts --production --bump-version  # same (explicit)
 *   npx tsx build.ts --minor           # minor version bump + production build
 */

import { build, createServer, type InlineConfig } from 'vite';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const isWatch = process.argv.includes('--watch');
const isProduction = process.argv.includes('--production');
const isMinorBump = process.argv.includes('--minor');
const isBumpVersion = process.argv.includes('--bump-version') || isProduction || isMinorBump;

// Node built-ins that must be kept external in the extension host bundle.
const NODE_EXTERNALS = [
  'vscode',
  'path', 'fs', 'os', 'crypto', 'stream', 'util', 'events',
  'child_process', 'url', 'http', 'https', 'net', 'tls', 'zlib',
  'buffer', 'assert', 'module', 'worker_threads', 'perf_hooks',
];

// CJS compatibility shims injected at the top of every ESM chunk.
// tiktoken's CJS code (inlined by the bundler) uses __dirname to locate its
// WASM file, so we must polyfill it. The banner uses _vite_ prefixed helpers
// to avoid colliding with Rolldown's own imports from the same modules.
const CJS_BANNER =
  `import{fileURLToPath as _viteFileURLToPath}from'url';` +
  `import{dirname as _viteDirname}from'path';` +
  `const __filename=_viteFileURLToPath(import.meta.url);` +
  `const __dirname=_viteDirname(__filename);`;

// ---------------------------------------------------------------------------
// Version bumping
// ---------------------------------------------------------------------------

function bumpVersion(): void {
  const pkgPath = path.join(__dirname, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  const parts: string[] = pkg.version.split('.');
  if (parts.length !== 3) {
    console.error('Invalid version format. Expected semver (e.g., 1.2.3)');
    process.exit(1);
  }
  if (isMinorBump) {
    parts[1] = String(parseInt(parts[1], 10) + 1);
    parts[2] = '0';
  } else {
    parts[2] = String(parseInt(parts[2], 10) + 1);
  }
  pkg.version = parts.join('.');
  fs.writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + '\n');
  console.log(`[build] version → ${pkg.version}`);
}

// ---------------------------------------------------------------------------
// Asset bundling
// ---------------------------------------------------------------------------

function bundleRipgrepBinary(): void {
  const exeName = process.platform === 'win32' ? 'rg.exe' : 'rg';
  const src = path.join(__dirname, 'node_modules', '@vscode', 'ripgrep', 'bin', exeName);
  const destDir = path.join(__dirname, 'bin');
  const dest = path.join(destDir, exeName);
  try {
    if (!fs.existsSync(src)) {
      console.warn(`[build] ripgrep binary not found at ${src} (search_file will fall back to PATH)`);
      return;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`[build] bundled ripgrep → ${path.relative(__dirname, dest)}`);
  } catch (err) {
    console.warn(`[build] failed to bundle ripgrep: ${String(err)}`);
  }
}

function bundleTiktokenWasm(): void {
  const src = path.join(__dirname, 'node_modules', 'tiktoken', 'lite', 'tiktoken_bg.wasm');
  const destDir = path.join(__dirname, 'dist');
  const dest = path.join(destDir, 'tiktoken_bg.wasm');
  try {
    if (!fs.existsSync(src)) {
      console.warn(`[build] tiktoken_bg.wasm not found at ${src}`);
      return;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`[build] bundled tiktoken WASM → ${path.relative(__dirname, dest)}`);
  } catch (err) {
    console.warn(`[build] failed to bundle tiktoken WASM: ${String(err)}`);
  }
}

// ---------------------------------------------------------------------------
// Vite configs
// ---------------------------------------------------------------------------

/**
 * Extension host: Node.js, ESM, code-split into dist/chunks/.
 */
const extensionConfig: InlineConfig = {
  configFile: false,
  root: __dirname,
  ssr: {
    // Bundle all npm packages into the output — the packaged .vsix excludes
    // node_modules, so everything must be inlined.
    noExternal: true,
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    sourcemap: !isProduction,
    minify: isProduction,
    ssr: 'src/extension.ts',
    rolldownOptions: {
      external: NODE_EXTERNALS,
      output: {
        format: 'esm',
        banner: CJS_BANNER,
        chunkFileNames: 'chunks/[name]-[hash].js',
        entryFileNames: '[name].js',
      },
    },
    ...(isWatch ? { watch: {} } : {}),
  },
};

/**
 * Webview: browser, IIFE, single file at dist/webview.js.
 */
const webviewConfig: InlineConfig = {
  configFile: false,
  root: __dirname,
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    sourcemap: !isProduction,
    minify: isProduction,
    lib: {
      entry: path.resolve(__dirname, 'webview-ui/main.ts'),
      formats: ['iife'],
      name: 'AgentWebview',
      fileName: () => 'webview.js',
    },
    ...(isWatch ? { watch: {} } : {}),
  },
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (isBumpVersion) {
    bumpVersion();
  }

  bundleRipgrepBinary();

  if (isWatch) {
    // In watch mode run both builds concurrently; each returns a watcher.
    await Promise.all([
      build({ ...extensionConfig }),
      build({ ...webviewConfig }),
    ]);
    // Copy WASM after builds so emptyOutDir doesn't delete it.
    bundleTiktokenWasm();
    console.log('[build] watching for changes…');
  } else {
    // Sequential: extension first (clears dist/), then webview (emptyOutDir: false).
    await build(extensionConfig);
    await build(webviewConfig);
    // Copy WASM after builds so emptyOutDir doesn't delete it.
    bundleTiktokenWasm();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
