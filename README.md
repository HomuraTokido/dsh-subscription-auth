# dsh-subscription-auth

给 DSH 和 DSR 增加订阅账号登录。此仓库由 [HomuraTokido](https://github.com/HomuraTokido/dsh-subscription-auth) 独立维护；原始出处和许可证见 [UPSTREAM.md](UPSTREAM.md)。本分叉当前通过源码/Git 安装，npm 上同名包不代表本仓库的最新实现。

| 渠道 | 登录方式 | 模型协议 |
|---|---|---|
| ChatGPT | 浏览器授权；本地回调不可用时自动用官方设备授权 | Codex Responses |
| Claude | 浏览器授权与本地回调 | Anthropic Messages |
| Grok | 设备授权 | xAI Responses |
| Kimi | 设备授权 | Anthropic Messages |

认证由插件负责，模型请求由宿主的 `@deepseek-ai/dsh-llm-pi-ai` / `@earendil-works/pi-ai` 负责。插件不再维护消息序列化、SSE 解析和思考签名重放的独立实现。

## 宿主要求

使用 DSH 0.2.1 alpha 系列的原生凭据记录与事务接口，或提供相同接口的 DSR。PiAiAdapter 与插件直接使用的 pi-ai 应解析到同一 SDK 版本，避免公开类型中的唯一标记发生版本分裂。具体依赖契约以 `package.json` 为准；不再宣称兼容尚无 `CredentialProvider.modifyRecord` 的旧宿主。

需要 Node.js 20 或更新版本，以及宿主的 LLM、credentials、settings、PiAiAdapter 服务包。图片输入需要宿主 attachment 服务。宿主没有附件服务或模型不支持图片时，适配器给出明确错误。

## 构建与验证

```sh
git clone https://github.com/HomuraTokido/dsh-subscription-auth.git
cd dsh-subscription-auth
npm ci
npm run typecheck
npm run build
npm test
```

构建使用 Node.js 和 esbuild，将 `src` 转为 `lib` 并生成公开声明类型。`lib/client.js` 是独立维护的设置页，不会被构建覆盖。历史 Bun/shell 构建脚本不是当前入口。

不要在已经链接到运行中宿主 `node_modules` 的源码目录执行依赖安装。先在独立检出中构建、测试，再按宿主自己的插件安装与重载流程加载包。DSR 的主备实例也应通过自身生命周期入口更新。

## 登录与使用

打开 **设置 → 订阅服务**，选择渠道并点击登录。设备流会展示验证链接和授权码。完成授权后，插件保存凭据、发现模型，模型选择器才注册该渠道。注销会清除本地凭据和自动发现的列表。

ChatGPT 在打开浏览器之前实际绑定 `127.0.0.1` 的回调监听，只使用 OpenAI 注册的 **1455 / 1457**。配置指定其中一个时优先使用它；遇到 `EACCES` 或 `EADDRINUSE` 才换另一个。两个端口都不可用时，直接展示 [官方设备授权页](https://auth.openai.com/codex/device) 与授权码，不需要用户修改 Windows 端口保留或防火墙配置。其他监听失败会显示具体错误。

Claude 回调端口默认 54545。Grok/Kimi 不依赖本地回调。回调与设备授权各有有效期，网络请求有独立超时；取消或重试会立即作废旧尝试，旧授权结果不能覆盖新登录。

四个渠道使用共享认证生命周期。快过期的访问令牌通过宿主凭据事务刷新，并发请求共用刷新结果。注销、取消和卸载会阻止迟到的授权、刷新或模型发现重新写回状态。错误会在设置页显示；日志不写令牌或授权响应片段。

## 凭据迁移

首次读取时，将旧的 `*_SUBSCRIPTION_TOKEN` JSON 令牌迁移为插件自己的原生 credential record。先成功提交新记录，再移除旧引用；已有有效记录优先，不能被旧引用覆盖。新记录无法提交时保留旧引用并报告错误；新记录已提交而旧引用清理失败时保留两者，并写安全日志。正常迁移无需重新登录。

凭据仍由宿主 credentials 服务管理，插件没有第二份 `auth.json`，也不向 PiAiAdapter 的环境发现暴露其他应用的凭据。

## 模型与配置

每渠道配置放在插件条目的 `config` 下，支持运行时更新。模型列表优先级为：手动 `models` → 本次发现 → 上次保存的 `discoveredModels` → 内置默认列表。提供商返回的模型与用户手动模型仍使用原来的渠道 ID，不自动替换模型或新增账号池。

```yaml
- id: dsh-subscription-auth
  name: dsh-subscription-auth
  config:
    chatgpt:
      apiBaseURL: https://chatgpt.com/backend-api/codex/responses
      redirectPort: 1455
      maxTokens: 8192
    claude:
      apiBaseURL: https://api.anthropic.com/v1/messages
      redirectPort: 54545
      maxTokens: 64000
    grok:
      apiBaseURL: https://api.x.ai/v1/responses
      maxTokens: 8192
    kimi:
      apiBaseURL: https://api.kimi.com/coding/v1/messages
      maxTokens: 32768
```

手动模型可以指定上下文窗口：

```yaml
    chatgpt:
      models:
        - id: your-model-id
          name: Your model
          contextWindow: 1000000
```

模型的推理档位、思考预算、图片能力和请求格式由渠道配置与 SDK 的模型信息共同确定。支持输出上限的协议中，请求显式指定的值优先于渠道配置。Codex 端点拒绝该参数，和之前的实现一样不发送。Claude 的自适应思考与思考签名交由 SDK 处理。

ChatGPT 模型发现会从 npm 查询 Codex 客户端版本，6 小时内复用，失败回退已有值。需要指定版本时设置 `chatgpt.clientVersion`。

## 测试范围

CI 在 Windows/Linux/macOS 的 Node.js 24 上执行干净依赖安装、类型检查、构建和测试。回归用例覆盖回调端口不可用、设备授权、取消/重试交错、凭据迁移、刷新/注销竞争、模型发现迟到，以及通过真实适配器与 SDK 的模型请求和流式错误解析。测试使用合成凭据与模拟网络，不调用真实订阅服务。

## License

BSD-3-Clause。原作者版权声明保留在 `LICENSE` 中。宿主适配器和 SDK 作为依赖使用，遵循各自许可证。
