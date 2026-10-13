/**
 * dsh-subscription-auth：给 dsh 增加订阅会员（ChatGPT / Claude / Grok / Kimi）的
 * OAuth 登录支持。
 *
 * 本模块是薄的通用驱动：遍历 {@link CHANNELS} 里的渠道定义，为每个渠道声明一段
 * volatile 配置（Config.<id>）、注册 llm provider + adapter，以及配置中心
 * 的登录/注销/状态路由。每个渠道的 OAuth 流程、模型发现与适配器都封装在
 * src/channels/<id>.ts 里（见 src/channel.ts 的 ChannelDefinition 契约）。
 *
 * 登录入口在配置中心的「订阅服务」页（client half）：三条端点
 * providers / login / logout 挂在 Typert Gateway 的 /api 通道上（见 src/remote.ts，
 * 官方 Electron 壳没有 webserver，HTTP 路由挂不上）。
 * @module dsh-subscription-auth
 */
import z from '@deepseek-ai/schemastery';
import type { Context as CordisContext } from '@deepseek-ai/cordis';
import type LlmRuntime from '@deepseek-ai/dsh-llm';
import type { ChannelConfig, ChannelDefinition } from './channel.js';
type Context = CordisContext & {
    llm: LlmRuntime;
};
export declare const name = "dsh-subscription-auth";
export declare const inject: string[];
/** 所有订阅渠道（顺序即「订阅服务」页卡片顺序）。 */
export declare const CHANNELS: ChannelDefinition[];
/**
 * 插件配置：每个渠道一段，整段 volatile。core 0.2 的 settings 服务只编辑插件自己
 * Config 里声明为 volatile 的字段（旧的 settings.register 已经没有了），写入经
 * configEditor 落到当前 profile 的 cordis.patch.yml，运行中的引用随之更新、不重挂。
 */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    [k: string]: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        apiBaseURL: z<string, string, "defined">;
        redirectPort: z<number, number, "defined">;
        models: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
        defaultContextWindow: z<number, number, "defined">;
        maxTokens: z<number, number, "defined">;
        clientVersion: z<string, string, "plain">;
        discoveredModels: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        apiBaseURL: z<string, string, "defined">;
        redirectPort: z<number, number, "defined">;
        models: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
        defaultContextWindow: z<number, number, "defined">;
        maxTokens: z<number, number, "defined">;
        clientVersion: z<string, string, "plain">;
        discoveredModels: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
    }>>>, "volatile">;
}>>, Schemastery.ObjectT<NoInfer<{
    [k: string]: z<NoInfer<Schemastery.ObjectS<NoInfer<{
        apiBaseURL: z<string, string, "defined">;
        redirectPort: z<number, number, "defined">;
        models: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
        defaultContextWindow: z<number, number, "defined">;
        maxTokens: z<number, number, "defined">;
        clientVersion: z<string, string, "plain">;
        discoveredModels: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
    }>>>, NoInfer<Schemastery.ObjectT<NoInfer<{
        apiBaseURL: z<string, string, "defined">;
        redirectPort: z<number, number, "defined">;
        models: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
        defaultContextWindow: z<number, number, "defined">;
        maxTokens: z<number, number, "defined">;
        clientVersion: z<string, string, "plain">;
        discoveredModels: z<({
            id?: string | null | undefined;
            name?: string | null | undefined;
            contextWindow?: number | null | undefined;
        } & import("@deepseek-ai/cosmokit").Dict)[], Schemastery.ObjectT<NoInfer<{
            id: z<string, string, "defined">;
            name: z<string, string, "defined">;
            contextWindow: z<number, number, "plain">;
        }>>[], "plain">;
    }>>>, "volatile">;
}>>, "plain">;
/** 一个渠道的配置引用（volatile：.get() 返回当前快照）。 */
type ChannelConfigRef = {
    get(): ChannelConfig | undefined;
};
export declare function apply(ctx: Context, config?: Record<string, ChannelConfigRef | undefined>): void;
export {};
