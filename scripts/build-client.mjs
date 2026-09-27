/**
 * 构建 dsh-desktop-tauriapp 的 client bundle（== 参考项目 dsh-plugin-desktop 的 client 构建）。
 * 产物 lib/client.js 包裹在 `window.__ModuleLoader__.load({ id, factory })` 中，
 * React / cordis / dsh client 运行时走 loader 注入的 require（external），
 * 其余按需内联。浏览器端由 dsh web 以 /plugins/dsh-desktop-tauriapp/client.js 加载。
 */
import { build } from 'esbuild'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const PACKAGE_NAME = 'dsh-desktop-tauriapp'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')

const result = await build({
  entryPoints: [join(root, 'src/client/index.ts')],
  outfile: join(root, 'lib/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  sourcemap: true,
  external: [
    'react',
    'react/jsx-runtime',
    'react-dom',
    'react-dom/client',
    '@deepseek-ai/cordis',
    '@deepseek-ai/dsh-client-runtime/client',
    '@deepseek-ai/dsh-client-ui-slots',
    '@deepseek-ai/dsh-client-web-react',
    '@deepseek-ai/dsh-client-ui-primitives',
  ],
  banner: {
    js: `window.__ModuleLoader__.load({\n  id: ${JSON.stringify(PACKAGE_NAME)},\n  factory: (require) => {\nvar module = { exports: {} };\nvar exports = module.exports;\n`,
  },
  footer: {
    js: 'return module.exports;\n  }\n});\n',
  },
})
if (result.errors.length > 0) process.exit(1)
