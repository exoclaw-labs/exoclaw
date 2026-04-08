/**
 * Media Tools — vision analysis and image generation via external APIs.
 *
 * Gateway-level wrappers that expose media capabilities as HTTP endpoints.
 * Actual AI processing is done by external providers (Anthropic, OpenAI, etc.).
 *
 * Two capabilities:
 *   - Vision: analyze images via the Anthropic Messages API
 *   - Image Generation: generate images via OpenAI DALL-E or compatible APIs
 *
 * These are intentionally thin — for deeper integration, use MCP servers.
 *
 * Inspired by Hermes's vision_tools.py and OpenClaw's media generation system.
 */

// ── Vision Analysis ──

export interface VisionRequest {
  imageUrl?: string;
  imageBase64?: string;
  prompt?: string;
}

export interface VisionResult {
  description: string;
  model: string;
  durationMs: number;
}

/**
 * Analyze an image using the Anthropic Messages API.
 * Requires ANTHROPIC_API_KEY env var.
 */
export async function analyzeImage(req: VisionRequest): Promise<VisionResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not configured");

  const start = Date.now();
  const model = "claude-sonnet-4-6";
  const prompt = req.prompt || "Describe this image in detail.";

  // Build image content block
  let imageBlock: any;
  if (req.imageBase64) {
    imageBlock = {
      type: "image",
      source: { type: "base64", media_type: "image/png", data: req.imageBase64 },
    };
  } else if (req.imageUrl) {
    imageBlock = {
      type: "image",
      source: { type: "url", url: req.imageUrl },
    };
  } else {
    throw new Error("imageUrl or imageBase64 required");
  }

  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model,
      max_tokens: 1024,
      messages: [{
        role: "user",
        content: [imageBlock, { type: "text", text: prompt }],
      }],
    }),
  });

  if (!response.ok) {
    throw new Error(`Anthropic API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;
  const text = data.content?.[0]?.text || "No description generated";

  return {
    description: text,
    model,
    durationMs: Date.now() - start,
  };
}

// ── Image Generation ──

export interface ImageGenRequest {
  prompt: string;
  size?: string;    // e.g., "1024x1024"
  quality?: string; // "standard" | "hd"
  model?: string;
}

export interface ImageGenResult {
  url: string;
  revisedPrompt?: string;
  model: string;
  durationMs: number;
}

/**
 * Generate an image using OpenAI's DALL-E API.
 * Requires OPENAI_API_KEY env var.
 */
export async function generateImage(req: ImageGenRequest): Promise<ImageGenResult> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not configured");

  const start = Date.now();
  const model = req.model || "dall-e-3";

  const response = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "authorization": `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      prompt: req.prompt,
      n: 1,
      size: req.size || "1024x1024",
      quality: req.quality || "standard",
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${await response.text()}`);
  }

  const data = await response.json() as any;
  const image = data.data?.[0];

  if (!image?.url) throw new Error("No image generated");

  return {
    url: image.url,
    revisedPrompt: image.revised_prompt,
    model,
    durationMs: Date.now() - start,
  };
}
