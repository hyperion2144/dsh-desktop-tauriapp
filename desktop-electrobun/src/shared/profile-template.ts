// profile 脚手架：一份 DSH_HOME 里 `profiles/<name>/` 的最小可启动文件集。
//
// 迁移自旧壳 `desktop/src-tauri/src/profiles.rs`（`write_profile_templates`，:104-146）。
// 上游 dsh 的 `loadProfile()` 只认「目录里已有 package.json」的 profile，缺了就报
// `dsh: profile "desktop" does not exist`——全新 DSH_HOME 起不来就是这个原因，
// 所以这份模板必须由壳写出来（官方桌面同样自带 profile 模板）。
//
// 纯数据模块：不碰文件系统，写盘在 `src/bun/profile-scaffold.ts`。

/** 旧壳写死的两个 bundle（`profiles.rs:110`）：dsh 的底座与 web 应用。 */
export const PROFILE_BUNDLES = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] as const

/**
 * pnpm 的允许构建白名单（旧壳 `runtime/builtin.rs:52` 原样搬来）。
 * `@deepseek-ai/dsh-tools` 的两个 postinstall 脚本是上游模板自带的：它要求 pnpm 不要在
 * profile 里装 dsh-tools（那份是给 dsh 仓库自己开发用的），装了就删掉。
 */
export const PNPM_ALLOW_BUILDS = [
  'allowBuilds:',
  '  node-pty: true',
  '  protobufjs: true',
  '  git-hosted: true',
  '  cloudflared: true',
  '  sharp: true',
  '  ssh2: true',
  "  '@deepseek-ai/dsh-subprocess-local': true",
  "  '@google/genai': true",
  '  koffi: true',
  '',
].join('\n')

/** profile 根条目表：真正的树由 bundles + cordis.patch.yml + `--patch` 叠出来，这里永远是空表。 */
export const CORDIS_YML =
  '# dsh profile root — an empty entry list. The tree is composed as patches:\n' +
  "# each bundle in package.json's dsh.profile.bundles, then cordis.patch.yml, then any\n" +
  '# --patch overlays. Edit cordis.patch.yml, not this file.\n' +
  '[]\n'

/** 用户可编辑的补丁表，壳不碰它（壳自己的注入走 `--patch` 覆盖层）。 */
export const CORDIS_PATCH_YML = '[]\n'

export function profilePackageJson(profile: string): string {
  return `${JSON.stringify(
    {
      name: profile,
      private: true,
      dependencies: {},
      dsh: { profile: { bundles: [...PROFILE_BUNDLES] } },
      scripts: {
        postinstall: 'rm -rf node_modules/@deepseek-ai/dsh-tools',
        postuninstall: 'rm -rf node_modules/@deepseek-ai/dsh-tools',
      },
    },
    null,
    2,
  )}\n`
}

export function pnpmWorkspaceYaml(): string {
  return `packages:\n  - .\n\nnodeLinker: hoisted\nautoInstallPeers: false\n\n${PNPM_ALLOW_BUILDS}`
}

export interface ProfileFile {
  /** profile 目录内的文件名 */
  name: string
  content: string
}

/** 要落盘的四份文件。已存在的一律不动（用户可能自己改过 cordis.patch.yml）。 */
export function profileFiles(profile: string): ProfileFile[] {
  return [
    { name: 'package.json', content: profilePackageJson(profile) },
    { name: 'pnpm-workspace.yaml', content: pnpmWorkspaceYaml() },
    { name: 'cordis.yml', content: CORDIS_YML },
    { name: 'cordis.patch.yml', content: CORDIS_PATCH_YML },
  ]
}
