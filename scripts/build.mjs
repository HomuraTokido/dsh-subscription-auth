/** 构建 src 的运行代码与公开类型，保留独立维护的 lib/client.js。 */
import { spawnSync } from 'node:child_process'
import { readdir, mkdir } from 'node:fs/promises'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const srcRoot = join(root, 'src')
const libRoot = join(root, 'lib')

async function listTsFiles(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await listTsFiles(full)))
    } else if (entry.name.endsWith('.ts')) {
      files.push(full)
    }
  }
  return files
}

const files = await listTsFiles(srcRoot)
await mkdir(libRoot, { recursive: true })

await build({
  entryPoints: files,
  outdir: libRoot,
  outbase: srcRoot,
  bundle: false,
  format: 'esm',
  platform: 'node',
  target: 'es2024',
  logLevel: 'warning',
})

for (const f of files) {
  console.log('built lib/' + relative(srcRoot, f).replace(/\.ts$/, '.js'))
}
console.log('done (' + files.length + ' files)')

const declarations = spawnSync(process.execPath, [
  fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url)),
  '-p', join(root, 'tsconfig.json'), '--emitDeclarationOnly',
], { stdio: 'inherit' })
if (declarations.error) throw declarations.error
if (declarations.status !== 0) process.exit(declarations.status ?? 1)
