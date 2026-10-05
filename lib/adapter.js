import { LlmAdapter, LlmError, ToolCallId, ReasoningEffortId, attributionHeaders } from "@deepseek-ai/dsh-llm";
function flattenText(blocks) {
  let out = "";
  for (const block of blocks) {
    if (block.type === "text") out += block.text;
  }
  return out;
}
function serializeImagePart(attachment, bytes) {
  const mediaType = attachment.mediaType || "image/png";
  return {
    type: "input_image",
    image_url: `data:${mediaType};base64,${Buffer.from(bytes).toString("base64")}`
  };
}
async function serializeUserImage(block, attachments, signal) {
  const attachment = block.attachment ?? {};
  if (attachments !== void 0 && typeof attachments.readImage === "function") {
    try {
      const stored = await attachments.readImage(attachment, signal);
      return serializeImagePart(attachment, stored.data);
    } catch {
      return { type: "input_text", text: "[image omitted: attachment unreadable]" };
    }
  }
  return { type: "input_text", text: "[image omitted: no attachment service]" };
}
async function serializeRequest(options, o, reasoning, attachments) {
  const input = [];
  let instructions = options.system;
  for (const message of options.messages) {
    if (message.role === "system") {
      const text = flattenText(message.content);
      instructions = instructions !== void 0 ? `${instructions}

${text}` : text;
      continue;
    }
    if (message.role === "assistant") {
      const textParts = [];
      const calls = [];
      for (const block of message.content) {
        if (block.type === "text") {
          textParts.push(block.text);
        } else if (block.type === "tool-call") {
          calls.push({
            type: "function_call",
            call_id: block.id,
            name: block.name,
            arguments: block.arguments
          });
        }
      }
      if (textParts.length > 0) {
        input.push({
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: textParts.join("") }]
        });
      }
      input.push(...calls);
      continue;
    }
    if (message.role === "tool") {
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: flattenText(message.content) || "(no output)"
      });
      continue;
    }
    const contentParts = [];
    for (const block of message.content) {
      if (block.type === "text") {
        contentParts.push({ type: "input_text", text: block.text });
      } else if (block.type === "image") {
        contentParts.push(await serializeUserImage(block, attachments, options.signal));
      } else if (block.type === "tool-result") {
        input.push({
          type: "function_call_output",
          call_id: block.toolCallId,
          output: flattenText(block.content) || "(no output)"
        });
      }
    }
    if (contentParts.length > 0) {
      input.push({
        type: "message",
        role: "user",
        content: contentParts
      });
    }
  }
  const body = {
    model: options.model,
    input,
    stream: true,
    store: false
  };
  if (instructions !== void 0) body.instructions = instructions;
  if (reasoning !== void 0 && options.reasoningEffort !== void 0) {
    body.reasoning = { effort: options.reasoningEffort };
  }
  if (options.tools !== void 0 && options.tools.length > 0) {
    body.tools = options.tools.map((t) => ({
      type: "function",
      name: t.name,
      description: t.description,
      parameters: t.parameters
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
  const cacheRead = usage?.input_tokens_details?.cached_tokens;
  const reasoning = usage?.output_tokens_details?.reasoning_tokens;
  return {
    inputTokens: (usage?.input_tokens ?? 0) - (cacheRead ?? 0),
    outputTokens: usage?.output_tokens ?? 0,
    ...cacheRead !== void 0 ? { cacheReadTokens: cacheRead } : {},
    ...reasoning !== void 0 ? { reasoningTokens: reasoning } : {}
  };
}
function mapStatus(status) {
  switch (status) {
    case "completed":
      return { kind: "stop" };
    case "incomplete":
      return { kind: "max-tokens" };
    case "cancelled":
      return { kind: "stop" };
    case "failed":
      return { kind: "error", failure: { message: "model response failed", code: "FAILED" } };
    default:
      return { kind: "stop" };
  }
}
async function* translate(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let nextIndex = 0;
  let textBlock;
  let reasoningBlock;
  const order = [];
  const toolBlocks = /* @__PURE__ */ new Map();
  const pendingToolMeta = /* @__PURE__ */ new Map();
  let pendingStatus;
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
      case "response.output_item.added": {
        const item = chunk.item;
        if (item?.type === "function_call") {
          const meta = {
            callId: String(item.call_id ?? item.id ?? ""),
            name: String(item.name ?? "")
          };
          const oi = Number(chunk.output_index);
          const b = toolBlocks.get(oi);
          if (b) {
            b.callId = meta.callId;
            b.name = meta.name;
          } else {
            pendingToolMeta.set(oi, meta);
          }
        }
        break;
      }
      case "response.output_text.delta": {
        const text = chunk.delta;
        if (typeof text === "string" && text.length > 0) {
          if (!textBlock) {
            textBlock = { index: nextIndex++, text: "" };
            order.push({ kind: "text", index: textBlock.index });
            out.push({ type: "block-start", index: textBlock.index, blockType: "text" });
          }
          textBlock.text += text;
          out.push({ type: "text-delta", index: textBlock.index, text });
        }
        break;
      }
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta": {
        const text = chunk.delta;
        if (typeof text === "string" && text.length > 0) {
          if (!reasoningBlock) {
            reasoningBlock = { index: nextIndex++, text: "" };
            order.push({ kind: "reasoning", index: reasoningBlock.index });
            out.push({ type: "block-start", index: reasoningBlock.index, blockType: "reasoning" });
          }
          reasoningBlock.text += text;
          out.push({ type: "reasoning-delta", index: reasoningBlock.index, text });
        }
        break;
      }
      case "response.function_call_arguments.delta": {
        const oi = Number(chunk.output_index);
        let b = toolBlocks.get(oi);
        if (!b) {
          const meta = pendingToolMeta.get(oi) ?? { callId: "", name: "" };
          b = { index: nextIndex++, text: "", callId: meta.callId, name: meta.name };
          toolBlocks.set(oi, b);
          order.push({ kind: "tool-call", index: b.index });
          out.push({ type: "block-start", index: b.index, blockType: "tool-call" });
        }
        const frag = typeof chunk.delta === "string" ? chunk.delta : "";
        b.text += frag;
        out.push({
          type: "tool-call-delta",
          index: b.index,
          id: ToolCallId(b.callId),
          ...b.name !== "" ? { name: b.name } : {},
          argumentsDelta: frag
        });
        break;
      }
      case "response.completed": {
        pendingStatus = chunk.response?.status;
        pendingUsage = chunk.response?.usage;
        break;
      }
      case "response.failed": {
        pendingStatus = "failed";
        break;
      }
      case "error": {
        throw new LlmError(
          chunk?.message ?? String(chunk?.error ?? "provider stream error"),
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
  const status = mapStatus(pendingStatus);
  let reason;
  if (status.kind === "stop" && order.length === 0) {
    reason = {
      kind: "error",
      failure: { message: "model returned a completed response with no content", code: "EMPTY_RESPONSE" }
    };
  } else if (status.kind === "error") {
    reason = { kind: "error", failure: status.failure };
  } else if (status.kind === "max-tokens") {
    reason = { kind: "max-tokens" };
  } else {
    reason = { kind: "stop" };
  }
  yield { type: "finish", reason };
}
class ChatGptAdapter extends LlmAdapter {
  cfg;
  constructor(cfg) {
    super();
    this.cfg = cfg;
  }
  providerInfo(provider) {
    return { id: provider, name: this.cfg.displayName ?? "ChatGPT (\u8BA2\u9605)" };
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
    const label = this.cfg.label ?? "chatgpt";
    const token = await this.cfg.resolveAccessToken();
    const attachments = typeof this.cfg.attachments === "function" ? this.cfg.attachments() : this.cfg.attachments;
    const body = await serializeRequest(options, o, this.cfg.reasoning, attachments);
    const headers = {
      authorization: `Bearer ${token.access}`,
      "content-type": "application/json",
      accept: "text/event-stream",
      ...attributionHeaders()
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
    yield* translate(response.body);
  }
}
export {
  ChatGptAdapter
};
