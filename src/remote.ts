/**
 * 「订阅服务」页的 host 半边：三条端点挂在 Typert Gateway 的 /api 通道上。
 *
 * 为什么不再挂 webServer 路由（2026-09-15 实测）：官方 Electron 壳的组合补丁把
 * webserver 行 disabled（references/deepseek-harness/apps/desktop-host/config/
 * desktop.cordis.patch.yml），缺服务时 webServer.register 不成立，页面的 fetch 落到
 * 静态处理的 SPA 回退、拿到 index.html，表现为
 * 「读取提供商列表失败：Unexpected token '<', "<!doctype "... is not valid JSON」。
 * gateway 的 /api interceptor 是官方壳唯一通行、legacy 壳同样具备的 host↔client
 * 通道，与本仓库 plugins/dsh-update-watch 走的是同一条。
 *
 * 这个文件只被 ./index.ts 动态 import() 加载：标准 ES 装饰器在 tsc 与真实构建里成立，
 * 但本仓库的 Vitest dev-transform 还不支持（同 plugins/dsh-update-watch/src/remote.ts
 * 顶部注释），静态 import 会让任何 import './index.ts' 的测试跟着解析这段代码。
 * @module dsh-subscription-auth/remote
 */
import type { Context } from '@deepseek-ai/cordis'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

/** 页面要的一行渠道卡片：目录 + 登录状态（结构见 index.ts 的 channelCard）。 */
export type RemoteChannelCard = Record<string, unknown>

/** host 半边交给 Remote 服务的三个操作，由 apply() 按当前 states 注入。 */
export interface SubscriptionAuthRemoteDeps {
  /** 所有渠道的目录 + 登录状态，顺序即页面卡片顺序。 */
  providers: () => Promise<RemoteChannelCard[]>
  /** 启动某渠道的 OAuth；未知渠道应抛错。 */
  login: (provider: string) => Promise<unknown>
  /** 注销某渠道并清除本地令牌；未知渠道应抛错。 */
  logout: (provider: string) => Promise<{ ok: true }>
}

/**
 * 构造 Remote 服务类，wire 端点是 `subscriptionAuth/providers`、`subscriptionAuth/login`、
 * `subscriptionAuth/logout`（gateway 拼 `${namespace}/${方法名}`）。
 *
 * 第三方插件没有 core 的 typert 代码生成步骤，所以没有生成的 descriptor；
 * TypertGatewayService 走 SRC 回退，直接从类原型上读 @Remote 标记和方法参数名
 * （references/deepseek-harness/packages/api/gateway/src/index.ts 的 resolveSrcDescriptor）。
 * 参数名会进 wire 并被 assertExactArguments 逐字比对，所以参数必须是无解构、
 * 无默认值、无 rest 的裸标识符。
 * @param deps - 三个操作，绑定插件运行时的 states / CHANNELS。
 */
export function createSubscriptionAuthRemote(
  deps: SubscriptionAuthRemoteDeps,
): new (ctx: Context) => TypertRemoteService {
  class SubscriptionAuthRemote extends TypertRemoteService {
    constructor(ctx: Context) {
      super(ctx, 'subscriptionAuth')
    }

    @Remote('providers')
    async providers(): Promise<{ providers: RemoteChannelCard[] }> {
      return { providers: await deps.providers() }
    }

    @Remote('login')
    async login(provider: string): Promise<unknown> {
      return await deps.login(provider)
    }

    @Remote('logout')
    async logout(provider: string): Promise<{ ok: true }> {
      return await deps.logout(provider)
    }
  }
  return SubscriptionAuthRemote
}
