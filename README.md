# dsh-subscription-auth

给 dsh 增加**订阅会员 OAuth 登录**支持（模型提供商按订阅账号登录，而不是 API key）。内置四个订阅渠道：

| 渠道 | 登录方式 | 推理 API |
|---|---|---|
| ChatGPT 订阅（Plus/Pro） | 授权码 + PKCE + localhost 回调 | codex Responses API |
| Claude（Pro/Max） | 授权码 + PKCE + localhost 回调 | Anthropic Messages API |
| Grok（SuperGrok / X Premium+） | RFC 8628 设备授权流 | xAI Responses API |
| Kimi（Kimi Code） | RFC 8628 设备授权流 | Kimi Anthropic Messages API |

每个渠道是一个自包含模块（`src/channels/<id>.ts`，实现 `ChannelDefinition` 契约），`src/index.ts` 是薄的通用驱动（遍历渠道定义注册 settings / provider / adapter / 路由）。OAuth 常量与 wire 格式以 omp（`@oh-my-pi/pi-ai`、`@oh-my-pi/pi-catalog`）源码为准。对接方法见内置 skill：`subscription-channel-migration`。

## 渠道详情

| 环节 | ChatGPT | Claude | Grok | Kimi |
|---|---|---|---|---|
| 授权端点 | `https://auth.openai.com/oauth/authorize` | `https://claude.ai/oauth/authorize` | `https://auth.x.ai/oauth2/device/code` | `https://auth.kimi.com/api/oauth/device_authorization` |
| 令牌端点 | `https://auth.openai.com/oauth/token` | `https://api.anthropic.com/v1/oauth/token` | （OIDC 发现 `https://auth.x.ai/.well-known/openid-configuration`） | `https://auth.kimi.com/api/oauth/token` |
| `client_id` | `app_EMoamEEZ73f0CkXaXp7hrann` | `9d1c250a-e61b-44d9-88ed-5944d1962f5e` | `b1a00492-073a-47ea-816f-4c329264a828` | `17e5f671-d194-4dfb-9706-5516cb48c098` |
| scope | `openid profile email offline_access api.connectors.read api.connectors.invoke` | `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload` | `openid profile email offline_access grok-cli:access api:access` | （设备流，无 scope） |
| 回调 | `http://localhost:1455/auth/callback` | `http://localhost:54545/callback` | 设备流（无回调） | 设备流（无回调） |
| 调用端点 | `https://chatgpt.com/backend-api/codex/responses` | `https://api.anthropic.com/v1/messages` | `https://api.x.ai/v1/responses` | `https://api.kimi.com/coding/v1/messages` |

**登录时**：授权码渠道（ChatGPT / Claude）生成 PKCE 挑战 → 用 `rundll32` 打开浏览器（**不能用 `cmd /c start`**：URL 里的 `&` 会被截断）→ 本地一次性 HTTP 服务器收 `code`+`state`（10 分钟超时）→ 换令牌 → 存进 credential 服务。设备流渠道（Grok / Kimi）请求设备码 → 打开验证页并展示授权码 → 后台轮询直到用户完成授权 → 存令牌。之后每次请求前检查 access token 快过期则静默续期。

## 安装（dsh 标准插件方式，与 dsh-vision 相同）

`lib/` 已随仓库提供（产物入库），可以直接挂载；改过 `src/` 后重新构建。

1. 取码并放进插件目录（和 `dsh-vision` 平级，如 `E:\workspace\dsh-plugins\dsh-subscription-auth`）。

2. 构建：

    ```sh
    cd dsh-subscription-auth
    bun scripts/build-bun.mjs     # 递归把 src 下所有 .ts 转译为 lib 下 .js
    ```

3. 依赖解析：插件的 `node_modules` 需要有 `@deepseek-ai/*`（cordis / dsh-llm / dsh-credentials / dsh-settings / schemastery）。可把本机 running dsh 的依赖指进来（Windows 示例）：

    ```powershell
    cmd /c mklink /J "$HOME\dsh-plugins\dsh-subscription-auth\node_modules" "E:\nvm\nvm\v22.22.3\node_modules\@deepseek-ai\dsh\node_modules"
    ```

4. 注册到 dsh 的插件锚点（包名解析）：

    ```powershell
    cmd /c mklink /J "$HOME\.dsh\profiles\node_modules\dsh-subscription-auth" "$HOME\dsh-plugins\dsh-subscription-auth"
    ```

5. 在 `~/.dsh/cordis.patch.yml` 加条目：

    ```yaml
    - insert:
        - id: dsh-subscription-auth
          name: "dsh-subscription-auth"
    ```

6. 重启 dsh。

## 使用

1. 打开 **设置 → 订阅服务**：列出四个订阅提供商，显示登录状态、账号与可用模型（折叠列表）。

2. 点「登录」：
   - **ChatGPT / Claude**：浏览器自动打开授权页 → 登录并授权 → 跳回 localhost 回调 → 页面轮询到「已登录」→ 自动拉取官方模型列表。
   - **Grok / Kimi**：页面显示验证链接 + 设备授权码 → 在浏览器打开链接并输入代码 → 页面轮询到「已登录」→ 自动拉取模型列表。

3. 在模型选择里切到对应的提供商（如「Claude (订阅)」），选一个模型即可对话。

   模型选择器可为订阅模型选择**思考强度（推理等级）**：
   - ChatGPT：`minimal / low / medium / high`（默认 `medium`，作为 codex Responses 的 `reasoning.effort` 发送）
   - Claude：`low / medium / high`（默认 `medium`，映射为 extended thinking 的 `budget_tokens` 8192 / 16384 / 32000）
   - Grok：`low / medium / high`（不设默认，选择后作为 xAI Responses 的 `reasoning.effort` 发送）
   - Kimi：`low / medium / high`（不设默认，映射为 `thinking.budget_tokens` 4096 / 16384 / 32768）

   不选择时走提供商默认行为（请求体不带思考参数）。

4. 点右上角「注销」删除已保存的令牌与模型列表。

> 注意：授权码渠道（ChatGPT / Claude）需要在本机运行 dsh，因为回调落在 `127.0.0.1`。

> 注意：**未登录的提供商不会出现在模型选择器里**（provider/adapter 按登录状态注册）：登录成功后才注册进模型列表，注销后自动移除。设置 → 订阅服务 页始终列出全部四个渠道以便登录。

> 注意：**已登录的提供商在 dsh 启动时即自动注册并发现模型**（启动门控会等待 credential 服务就绪，settings 就绪后还会补一次检查），无需先进入设置页。

## 配置

每个渠道一个 settings 命名空间（`subscription-auth-<id>`）。模型优先级：手动 `models` → 登录发现并持久化的 `discoveredModels` → 渠道内置默认列表。

```yaml
subscription-auth-chatgpt:
  apiBaseURL: https://chatgpt.com/backend-api/codex/responses
  redirectPort: 1455
  maxTokens: 8192

subscription-auth-claude:
  apiBaseURL: https://api.anthropic.com/v1/messages
  redirectPort: 54545
  maxTokens: 64000

subscription-auth-grok:
  apiBaseURL: https://api.x.ai/v1/responses
  maxTokens: 8192

subscription-auth-kimi:
  apiBaseURL: https://api.kimi.com/coding/v1/messages
  maxTokens: 32768
```

`models` 可手动固定模型列表（可选；不配则用登录后自动发现的官方列表），例如：

```yaml
subscription-auth-claude:
  models:
    - { id: claude-sonnet-5, name: Claude Sonnet 5, contextWindow: 1000000 }
```

## 检测（日志）

```powershell
Get-Content "$HOME\.dsh\tmp\subscription-auth.log"          # 插件日志（登录/发现/错误）
Get-Content "$HOME\.dsh\settings.yaml" | Select-String -Pattern "subscription-auth" -Context 0,15  # 持久化模型列表
Invoke-WebRequest "http://127.0.0.1:<dsh-port>/subscription-auth/providers"  # 实时状态
```

## 测试

```sh
bun tests/smoke.mjs      # 依赖解析 / PKCE / Responses+Anthropic 序列化 / SSE 翻译 / 错误映射 / localhost 回调 / 多渠道 apply 接线 / 路由注册
bun tests/lib-check.mjs  # 验证 lib/*.js 产物与 src/*.ts 行为一致
node --check lib/client.js  # 配置中心页语法检查
```

## 已知限制

- 各渠道模型列表以**登录后自动发现**为准（官方 `/models` 接口），手动 `models` 配置可覆盖；
- Anthropic 订阅的 OAuth 授权约 30 天过期（refresh 不延长授权期），过期后需重新登录；
- 登录令牌存于 credential 服务，属于本机敏感信息，请勿外传；
- 并发刷新存在极小的重复续期竞争，但两者都会写入等价的新令牌，无副作用。

## 扩展新渠道

参考 skill `subscription-channel-migration`（对接订阅渠道的一般方法，含 omp 源码迁移指引）：在 `src/channels/<id>.ts` 实现 `ChannelDefinition`（OAuth 登录 + 模型发现 + 适配器），再把它加入 `src/index.ts` 的 `CHANNELS` 数组即可。

## License

BSD-3-Clause
