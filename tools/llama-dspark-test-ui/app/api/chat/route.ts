import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import {
  convertToModelMessages,
  createUIMessageStreamResponse,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { loadConfig } from "@/lib/config-store";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 600;

interface ChatBody {
  messages: UIMessage[];
  system?: string;
  temperature?: number;
  base?: string;
}

export async function POST(req: Request) {
  const body = (await req.json()) as ChatBody;
  const cfg = loadConfig();
  const host = cfg.server.host === "0.0.0.0" ? "127.0.0.1" : cfg.server.host;
  const base = (body.base || `http://${host}:${cfg.server.httpPort}`).replace(/\/$/, "");

  const provider = createOpenAICompatible({
    name: "llama-server",
    baseURL: `${base}/v1`,
    // llama-server ignores auth; some clients still require a token to be set.
    apiKey: "sk-no-key-required",
  });

  const result = streamText({
    model: provider("dspark-target"),
    system: body.system,
    temperature: body.temperature,
    messages: await convertToModelMessages(body.messages),
  });

  return createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      onError: (error) =>
        error instanceof Error
          ? error.message
          : "Failed to reach llama-server. Is it running?",
    }),
  });
}
