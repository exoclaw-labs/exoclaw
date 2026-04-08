/**
 * OpenAI-Compatible API — translates OpenAI chat completions protocol to ExoClaw.
 *
 * Exposes /v1/chat/completions so any OpenAI-speaking app (Cursor, Continue,
 * Open WebUI, LangChain, etc.) can use ExoClaw as a drop-in backend.
 *
 * Supports both streaming (SSE) and non-streaming responses.
 *
 * Inspired by OpenClaw's /v1/chat/completions endpoint.
 */

import type { Context } from "hono";
import type { Claude } from "./claude-sdk.js";

const MODEL_NAME = "exoclaw";

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface ChatCompletionRequest {
  model?: string;
  messages: ChatMessage[];
  stream?: boolean;
  max_tokens?: number;
  temperature?: number;
}

/** Register OpenAI-compatible routes on the Hono app. */
export function registerOpenAIRoutes(app: any, claude: Claude): void {
  // GET /v1/models — list available models
  app.get("/v1/models", (c: Context) => {
    return c.json({
      object: "list",
      data: [{
        id: MODEL_NAME,
        object: "model",
        created: Math.floor(Date.now() / 1000),
        owned_by: "exoclaw",
      }],
    });
  });

  // POST /v1/chat/completions — chat completions
  app.post("/v1/chat/completions", async (c: Context) => {
    const body = await c.req.json() as ChatCompletionRequest;

    if (!body.messages?.length) {
      return c.json({ error: { message: "messages is required", type: "invalid_request_error" } }, 400);
    }
    if (!claude.alive) {
      return c.json({ error: { message: "Model not available", type: "server_error" } }, 503);
    }

    // Extract the last user message as the prompt; prepend system message if present
    const systemMsg = body.messages.find(m => m.role === "system");
    const userMessages = body.messages.filter(m => m.role === "user");
    const lastUser = userMessages[userMessages.length - 1];

    if (!lastUser) {
      return c.json({ error: { message: "At least one user message is required", type: "invalid_request_error" } }, 400);
    }

    let prompt = lastUser.content;
    if (systemMsg) {
      prompt = `[System: ${systemMsg.content}]\n\n${prompt}`;
    }

    const requestId = `chatcmpl-${crypto.randomUUID().slice(0, 12)}`;
    const created = Math.floor(Date.now() / 1000);

    if (body.stream) {
      return streamResponse(c, claude, prompt, requestId, created);
    } else {
      return nonStreamResponse(c, claude, prompt, requestId, created);
    }
  });
}

async function nonStreamResponse(
  c: Context,
  claude: Claude,
  prompt: string,
  requestId: string,
  created: number,
): Promise<Response> {
  let fullText = "";

  try {
    for await (const event of claude.send(prompt)) {
      if (event.type === "chunk") fullText += event.content;
      if (event.type === "done") fullText = event.content || fullText;
    }
  } catch (err) {
    return c.json({ error: { message: String(err), type: "server_error" } }, 500);
  }

  return c.json({
    id: requestId,
    object: "chat.completion",
    created,
    model: MODEL_NAME,
    choices: [{
      index: 0,
      message: { role: "assistant", content: fullText },
      finish_reason: "stop",
    }],
    usage: {
      prompt_tokens: 0,  // Not available from SDK stream
      completion_tokens: 0,
      total_tokens: 0,
    },
  });
}

async function streamResponse(
  c: Context,
  claude: Claude,
  prompt: string,
  requestId: string,
  created: number,
): Promise<Response> {
  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const event of claude.send(prompt)) {
          if (event.type === "chunk") {
            const chunk = {
              id: requestId,
              object: "chat.completion.chunk",
              created,
              model: MODEL_NAME,
              choices: [{
                index: 0,
                delta: { content: event.content },
                finish_reason: null,
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          } else if (event.type === "done") {
            const finalChunk = {
              id: requestId,
              object: "chat.completion.chunk",
              created,
              model: MODEL_NAME,
              choices: [{
                index: 0,
                delta: {},
                finish_reason: "stop",
              }],
            };
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(finalChunk)}\n\n`));
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          }
        }
      } catch (err) {
        const errChunk = { error: { message: String(err), type: "server_error" } };
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(errChunk)}\n\n`));
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "text/event-stream",
      "cache-control": "no-cache",
      "connection": "keep-alive",
    },
  });
}
