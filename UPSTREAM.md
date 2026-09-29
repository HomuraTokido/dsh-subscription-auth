# 上游与分叉说明

这是 `dsh-subscription-auth` 的维护性分叉（maintained fork）。原作者已停止维护，
本仓库接手继续开发，不以向上游提交 PR 为目标。

## 原始出处

| 项 | 值 |
|---|---|
| 上游仓库 | <https://github.com/Khellendros97/dsh-subscription-auth> |
| 上游作者 | Khellendros97 |
| 许可证 | BSD-3-Clause（`LICENSE` 原样保留，版权归 Khellendros97, 2026） |
| npm 包 | `dsh-subscription-auth@0.2.1`，发布于 2026-08-15T03:58:44Z |
| 基线 commit | `164f711e0f5dbe0b7144111970fb9b9ff75f6183`（2026-08-15T04:00:01Z，"chore: 按 DSH 标准发布 npm 包"） |
| 分叉点 | `338c02ea814af0d3579bf323cff491104f16f3ea`（上游 HEAD） |
| 分叉日期 | 2026-09-05 |

### 基线 commit 是怎么确定的

上游仓库没有任何 tag，四个 commit 里有三个是候选。用 blob 比对定死：

- npm tarball 里的 `README.md` 与 `164f711e` 版的 blob sha 相同（`3b8bdf3f`），
  与上游 HEAD `338c02e` 版不同（`6dfff2cc`）。
- `164f711e` 引入了 `LICENSE` 与 `cordis.patch.yml`，二者都在 tarball 中。
- npm 的发布时间（03:58:44Z）比 `164f711e` 的提交时间（04:00:01Z）早 77 秒，
  即作者先执行 publish、随后补提交；`338c02e`（04:02:08Z）只改了 `README.md`，
  发生在发布之后。

分叉从上游 HEAD `338c02e` 起，它相对基线只多一次 `README.md` 修改，代码零差异。

## 上游状态（2026-09-05 核查）

- 仓库公开、未归档，只有 `main` 一个分支，共 4 次 commit，无 tag。
- 最后一次代码 push 为 2026-08-15，此后无新提交。
- npm 上只发布过 `0.2.1` 一个版本，单一维护者，发布后无更新。
- 三个 open issue（均创建于 2026-08-19，无回复），其中 #1（grok-4.6 缺
  `contextWindow` 导致 HTTP 400）由本仓库维护者提出，本分叉已修复。
- 无其他 fork，作者名下也没有该包的后继或改名版本。

## 本分叉相对上游的改动

改动最初以 pnpm `patchedDependencies` 形式存在（390 行、33 hunk、9 个文件），
只打在编译产物 `lib/*.js` 上，TypeScript 源未同步。本次分叉时全部并入源码，
补丁文件随之退役。

### 功能与缺陷修复

- **Anthropic token 计数修复**：`mapUsage()` 原先用
  `input_tokens - cache_read_input_tokens` 计算 `inputTokens`，而 Anthropic 的
  `input_tokens` 本就不含缓存读取部分，重复扣减会得到负数。改为直接取
  `input_tokens`。这是整批改动最初的起因。
- **图片输入支持**：user 消息中的图片块经宿主 `attachments` 服务读取原始字节后
  序列化——Responses 适配器组装 `input_image`（data URI），Anthropic 适配器组装
  `{ type: 'image', source: { type: 'base64', ... } }`。读取失败或宿主未注册附件
  服务时退化为文本占位，不中断请求。两个适配器各自实现，与上游一样不共享模块。
- **grok-4.6**：加入默认模型表（`contextWindow` 500000），渠道默认上下文窗口从
  1e6 下调为 500000。修复上游 issue #1。
- **grok 设备码轮询**：`exchangeDeviceCode()` 原先在 `!res.ok` 时立即返回失败，
  改为先解析响应体，仅当 `res.ok` 且取到 `access_token` 才判定完成，否则交由
  `body.error` 分支处理。
- **grok 登录初始化失败可见**：原先吞掉异常并返回 `{ status: 'pending' }`，但
  同时已清空 pending 状态，界面表现为"点击登录后毫无反应"。改为抛出异常，
  由配置页的 `login()` 捕获并显示真实原因。
- **配置页错误显示**：`login()` 改为先解析响应体再判断状态码，错误信息优先取
  `data.error` 而非裸 HTTP 状态码；`setBusyId(null)` 移入 `finally`，避免异常
  路径下按钮持续处于加载态。以上两条与前一条构成同一条错误传递链。
- **kimi 渠道**：`User-Agent` 升至 `KimiCLI/1.5`，补充 `anthropic-version` 请求头。
- **provider headers 合并**：新增 `mergeProviderHeaders()`，渠道自定义请求头
  以大小写不敏感的方式覆盖 `attributionHeaders()` 的默认值。

### 适配当前 DSH 版本

- `CallId` 重命名为 `ToolCallId`：上游 `@deepseek-ai/dsh-llm` 已改用后者，
  原符号不再导出。
- 移除 `settingsNamespace` 的值导入（该包已不再导出它），命名空间改为直接拼接
  字符串；保留 `import type {}` 形式的类型侧引用，因为该包通过 `declare module`
  为 cordis 的 `Context` 增强出 `settings` 字段。
- `peerDependencies` 中三个 `@deepseek-ai/*` 从 `^0.0.1-rc.1` 提升到 `^0.1.0-rc.5`，
  并新增 `@deepseek-ai/dsh-attachment`（图片支持所需，上游 JS 实现靠鸭子类型
  规避了这条依赖声明）。该 peer 标记为 optional：图片序列化在宿主未注册附件
  服务时退化为文本占位，插件本身不依赖它才能启动。
- **2026-09-29：四个 peer 放宽为 `^0.1.0-rc.5 || ^0.2.0-rc.1`**（dsh-llm、dsh-credentials、
  dsh-settings、dsh-attachment）。core 0.1.7 起宿主会逐个核对插件的 `@deepseek-ai/dsh-*`
  peer，`^0.1.x` 覆盖不到 0.2.0-rc.1，插件会被整个跳过。依据：这四个包（加上本插件
  实际用到的 dsh-typert-protocol）的 `src` 在 `dsh-v0.1.7-rc.2` 与 `dsh-v0.2.0-rc.1`
  两个 tag 之间零差异，只有 package.json 的版本号变了；代码没有改。升 core 时核对：
  这几个包的公开接口有没有动，动了就不能只改范围。

### 工程改动

- **构建改用 esbuild**：`scripts/build-bun.mjs` 依赖 Bun 专有 API
  （`Bun.Transpiler`/`Bun.write`/`import.meta.dir`），替换为 `scripts/build.mjs`，
  语义相同（仅去类型，不打包、不降级、不改写相对导入）。更早的
  `scripts/build.sh` 依赖 DSH 源码检出的 `packages/` + `vendor/` 布局，
  上游改用 npm 分发后该布局已不存在，脚本无法运行。
- **`.gitattributes`**：钉住 LF 为仓库规范文本形式（分叉时全仓已是 LF）。
- **`scripts.prepublishOnly` 改为 `typecheck`**：本分叉不发布到 npm，
  由消费方以 `github:` 依赖直接引用。

## 已知遗留

`src/` 在当前 peer 版本下有 34 个类型错误，全部来自上游原始代码——作者当年
针对 DSH 源码检出中的类型编写，peer 升级到 0.1.x 后不再匹配。本次分叉未处理
这些错误（`esbuild` 不做类型检查，不影响构建与运行）。`pnpm run typecheck`
可以复现。
