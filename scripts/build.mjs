/**
 * 用 esbuild 把 src 目录下的所有 .ts 递归转译为 lib 目录下的 .js。
 *
 * 语义与它取代的 scripts/build-bun.mjs 完全一致：只去类型、不打包、不降级、
 * 不改写相对导入（源里的 './adapter.js' 指向转译后的 lib/adapter.js）。
 * 换掉 bun 的原因是这个 fork 由 DSR 维护，构建应当只依赖已有的 node 工具链；
 * 更早的 scripts/build.sh 依赖 dsh 源码检出的 packages/ + vendor/ 布局，
 * 上游改用 npm 分发之后那套布局已不存在，该脚本无法再运行。
 *
 * 类型检查不在这一步。src 里存在一批既有的类型错误（作者当年对着 dsh 源码
 * 检出的类型编写，peer 升到 0.1.x 之后不再匹配），需要时单独运行 tsc --noEmit。
 *
 * 运行：node scripts/build.mjs
 */
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
