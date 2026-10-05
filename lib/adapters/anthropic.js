import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId, attributionHeaders } from "@deepseek-ai/dsh-llm";
function flattenText(blocks) {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text") out += block.text;
  }
  return out;
}
function mergeProviderHeaders(headers) {
  const providerHeaders = headers ?? {};
  const providerNames = new Set(Object.keys(providerHeaders).map((name) => name.toLowerCase()));
  return {
    ...Object.fromEntries(
      Object.entries(attributionHeaders()).filter(([name]) => !providerNames.has(name.toLowerCase()))
    ),
    ...providerHeaders
  };
}
function serializeImageBlock(a, bytes) {
  return {
    type: "image",
    source: { type: "base64", media_type: a.mediaType, data: Buffer.from(bytes).toString("base64") }
  };
}
async function serializeRequest(options, o, reasoning, attachments) {
  const messages = [];
  let system = options.system;
  const push = (role, block) => {
    const last = messages[messages.length - 1];
    if (last !== void 0 && last.role === role) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const message of options.messages) {
    if (message.role === "system") {
      const text = flattenText(message.content);
      system = system !== void 0 ? `${system}

${text}` : text;
      continue;
    }
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "text") {
          push("assistant", { type: "text", text: block.text });
        } else if (block.type === "tool-call") {
          let input = {};
          try {
            input = block.arguments !== void 0 && block.arguments !== "" ? JSON.parse(block.arguments) : {};
          } catch {
            input = {};
          }
          push("assistant", { type: "tool_use", id: block.id, name: block.name, input });
        }
      }
      continue;
    }
    if (message.role === "tool") {
      push("user", {
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: flattenText(message.content) || "(no output)",
        ...message.isError === true ? { is_error: true } : {}
      });
      continue;
    }
    for (const block of message.content) {
      if (block.type === "text") {
        push("user", { type: "text", text: block.text });
      } else if (block.type === "image") {
        const a = block.attachment ?? {};
        if (attachments !== void 0 && typeof attachments.readImage === "function") {
          try {
            const stored = await attachments.readImage(a, options.signal);
            push("user", serializeImageBlock(a, stored.data));
          } catch {
            push("user", { type: "text", text: "[image omitted: attachment unreadable]" });
          }
        } else {
          push("user", { type: "text", text: "[image omitted: no attachment service]" });
        }
      } else if (block.type === "tool-result") {
        push("user", {
          type: "tool_result",
          tool_use_id: block.toolCallId,
          content: flattenText(block.content) || "(no output)"
        });
      }
    }
  }
  const body = {
    model: options.model,
    messages,
    max_tokens: o.maxTokens,
    stream: true
  };
  if (system !== void 0 && system !== "") body.system = system;
  if (reasoning !== void 0 && options.reasoningEffort !== void 0) {
    const effort = reasoning.efforts.find((e) => e.id === options.reasoningEffort);
    body.thinking = {
      type: "enabled",
      budget_tokens: effort?.budgetTokens ?? 16384
    };
  }
  if (options.tools !== void 0 && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters ?? { type: "object", properties: {} }
    }));
  }
  return body;
}
function httpErrorCode(status) {
  if (status === 401 || status === 403) return "AUTH";
  if (status === 429) return "RATE_LIMIT";
  if (status === 400) return "INVALID_REQUEST";
  if (status >= 500) return "SERVER";
  return `HTTP_${status}`;
}
function mapUsage(usage) {
  const cacheRead = usage?.cache_read_input_tokens;
  return {
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {}
  };
}
function mapStopReason(stop) {
  switch (stop) {
    case "max_tokens":
    case "model_context_window_exceeded":
      return { kind: "max-tokens" };
    default:
      return { kind: "stop" };
  }
}
async function* translate(body, label) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const order = [];
  const toolBlocks = /* @__PURE__ */ new Map();
  let pendingStop;
  let pendingUsage;
  const handle = (event, data) => {
    let chunk = {};
    if (data.trim() !== "") {
      try {
        chunk = JSON.parse(data);
      } catch {
        return [];
      }
    }
    const out = [];
    switch (event) {
      case "message_start": {
        pendingUsage = chunk.message?.usage;
        break;
      }
      case "content_block_start": {
        const block = chunk.content_block;
        const idx = Number(chunk.index);
        if (block?.type === "tool_use") {
          toolBlocks.set(idx, {
            index: nextIndex++,
            text: "",
            callId: String(block.id ?? ""),
            name: String(block.name ?? "")
          });
          order.push({ kind: "tool-call", index: toolBlocks.get(idx).index });
          out.push({ type: "block-start", index: toolBlocks.get(idx).index, blockType: "tool-call" });
        }
        break;
      }
      case "content_block_delta": {
        const delta = chunk.delta;
        const idx = Number(chunk.index);
        const tool = toolBlocks.get(idx);
        if (delta?.type === "text_delta" && typeof delta.text === "string" && delta.text.length > 0) {
          if (!textBlock) {
            textBlock = { index: nextIndex++, text: "" };
            order.push({ kind: "text", index: textBlock.index });
            out.push({ type: "block-start", index: textBlock.index, blockType: "text" });
          }
          textBlock.text += delta.text;
          out.push({ type: "text-delta", index: textBlock.index, text: delta.text });
        } else if (delta?.type === "thinking_delta" && typeof delta.thinking === "string" && delta.thinking.length > 0) {
          if (!reasoningBlock) {
            reasoningBlock = { index: nextIndex++, text: "" };
            order.push({ kind: "reasoning", index: reasoningBlock.index });
            out.push({ type: "block-start", index: reasoningBlock.index, blockType: "reasoning" });
          }
          reasoningBlock.text += delta.thinking;
          out.push({ type: "reasoning-delta", index: reasoningBlock.index, text: delta.thinking });
        } else if (delta?.type === "input_json_delta" && tool) {
          const frag = typeof delta.partial_json === "string" ? delta.partial_json : "";
          tool.text += frag;
          out.push({
            type: "tool-call-delta",
            index: tool.index,
            id: ToolCallId(tool.callId),
            ...tool.name !== "" ? { name: tool.name } : {},
            argumentsDelta: frag
          });
        }
        break;
      }
      case "message_delta": {
        pendingStop = chunk.delta?.stop_reason;
        if (chunk.usage !== void 0) {
          pendingUsage = { ...pendingUsage ?? {}, ...chunk.usage };
        }
        break;
      }
      case "message_stop": {
        break;
      }
      case "error": {
        throw new LlmError(
          chunk?.error?.message ?? String(chunk?.error ?? "provider stream error"),
          "PROVIDER"
        );
      }
      default:
        break;
    }
    return out;
  };
  const dispatch = (event, dataLines2) => {
    if (dataLines2.length === 0) return [];
    const data = dataLines2.join("\n");
    dataLines2.length = 0;
    return handle(event, data);
  };
  let eventName = "";
  const dataLines = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf("\n")) >= 0) {
      let line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      if (line === "") {
        for (const c of dispatch(eventName, dataLines)) yield c;
        eventName = "";
        continue;
      }
      if (line.startsWith(":")) continue;
      if (line.startsWith("event:")) {
        eventName = line.slice(6).trim();
        continue;
      }
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).replace(/^ /, ""));
        continue;
      }
    }
  }
  for (const c of dispatch(eventName, dataLines)) yield c;
  for (const o of order) {
    if (o.kind === "text" && textBlock) {
      yield { type: "block-end", index: o.index, block: { type: "text", text: textBlock.text } };
    } else if (o.kind === "reasoning" && reasoningBlock) {
      yield { type: "block-end", index: o.index, block: { type: "reasoning", text: reasoningBlock.text } };
    } else if (o.kind === "tool-call") {
      const b = [...toolBlocks.values()].find((x) => x.index === o.index);
      if (b) {
        yield {
          type: "block-end",
          index: b.index,
          block: { type: "tool-call", id: ToolCallId(b.callId), name: b.name, arguments: b.text }
        };
      }
    }
  }
  if (pendingUsage !== void 0) {
    yield { type: "usage", usage: mapUsage(pendingUsage) };
  }
  const status = mapStopReason(pendingStop);
  let reason;
  if (status.kind === "stop" && order.length === 0) {
    reason = {
      kind: "error",
      failure: { message: "model returned a completed response with no content", code: "EMPTY_RESPONSE" }
    };
  } else if (status.kind === "max-tokens") {
    reason = { kind: "max-tokens" };
  } else {
    reason = { kind: "stop" };
  }
  yield { type: "finish", reason };
}
class AnthropicMessagesAdapter extends LlmAdapter {
  cfg;
  constructor(cfg) {
    super();
    this.cfg = cfg;
  }
  providerInfo(provider) {
    return { id: provider, name: this.cfg.displayName ?? "Claude (\u8BA2\u9605)" };
  }
  listModels(provider) {
    const o = this.cfg.options();
    return Promise.resolve(
      o.models.map((m) => ({
        provider,
        id: m.id,
        name: m.name,
        inputModalities: ["text", "image"]
      }))
    );
  }
  resolveModel(provider, model, _signal) {
    const o = this.cfg.options();
    const m = o.models.find((x) => x.id === model);
    const reasoning = this.cfg.reasoning;
    return Promise.resolve({
      provider,
      id: model,
      name: m?.name ?? model,
      inputModalities: ["text", "image"],
      context: { contextWindow: m?.contextWindow ?? o.defaultContextWindow },
      defaultMaxTokens: o.maxTokens,
      // 声明思考强度档位 → 模型选择器显示「推理等级」菜单。
      ...reasoning !== void 0 ? {
        reasoning: {
          efforts: reasoning.efforts.map((e) => ({
            id: ReasoningEffortId(e.id),
            name: e.name,
            ...e.description !== void 0 ? { description: e.description } : {}
          })),
          ...reasoning.defaultEffort !== void 0 ? { defaultEffort: ReasoningEffortId(reasoning.defaultEffort) } : {}
        }
      } : {}
    });
  }
  async *stream(options) {
    const o = this.cfg.options();
    const label = this.cfg.label ?? "anthropic";
    const token = await this.cfg.resolveAccessToken();
    const body = await serializeRequest(options, o, this.cfg.reasoning, this.cfg.attachments?.());
    const headers = {
      authorization: `Bearer ${token.access}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...mergeProviderHeaders(o.headers ? o.headers() : {})
    };
    let response;
    try {
      response = await fetch(o.apiBaseURL, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: options.signal
      });
    } catch (error) {
      if (options.signal?.aborted) {
        throw new LlmError(`${label} request aborted by caller`, "ABORTED", { cause: error });
      }
      throw new LlmError(`${label} request to ${o.apiBaseURL} failed`, "TRANSPORT", {
        cause: error
      });
    }
    if (!response.ok) {
      let message = `${label} API error (HTTP ${response.status})`;
      try {
        const err = await response.json();
        if (err?.error?.message) message = err.error.message;
      } catch {
      }
      throw new LlmError(message, httpErrorCode(response.status), { status: response.status });
    }
    if (!response.body) {
      throw new LlmError(`${label} API returned no response body`, "EMPTY_RESPONSE");
    }
    yield* translate(response.body, label);
  }
}
export {
  AnthropicMessagesAdapter
};
