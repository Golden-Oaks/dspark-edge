"use client";

import { useMemo, useState } from "react";
import { useChat } from "@ai-sdk/react";
import { DefaultChatTransport } from "ai";
import { toast } from "sonner";
import {
  Conversation,
  ConversationContent,
  ConversationEmptyState,
  ConversationScrollButton,
} from "@/components/ai-elements/conversation";
import {
  Message,
  MessageContent,
  MessageResponse,
} from "@/components/ai-elements/message";
import {
  PromptInput,
  PromptInputBody,
  PromptInputFooter,
  PromptInputSubmit,
  PromptInputTextarea,
  PromptInputTools,
  type PromptInputMessage,
} from "@/components/ai-elements/prompt-input";
import { Button } from "@/components/ui/button";
import { Slider } from "@/components/ui/slider";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { useStore } from "@/lib/store";
import { MessageSquareText, Settings2, Eraser, Sparkles } from "lucide-react";

const SUGGESTIONS = [
  "Explain speculative decoding in two sentences.",
  "Write a haiku about fast inference.",
  "def fibonacci(n):",
  "The capital of France is",
];

export function ChatPanel() {
  const serverModel = useStore((s) => s.config?.server.targetModel ?? "");
  const serverState = useStore((s) => s.status.server.state);
  const [system, setSystem] = useState("");
  const [temperature, setTemperature] = useState(0.7);

  const transport = useMemo(
    () => new DefaultChatTransport({ api: "/api/chat" }),
    [],
  );

  const { messages, sendMessage, status, stop, setMessages, error } = useChat({
    transport,
    onError: (e) =>
      toast.error("Chat error", {
        description: e.message || "Is the target server running?",
      }),
  });

  const modelName = serverModel.split("/").pop() || "target model";
  const running = serverState === "running";

  const submit = (text: string) => {
    const trimmed = text.trim();
    if (!trimmed) return;
    sendMessage(
      { text: trimmed },
      { body: { system: system.trim() || undefined, temperature } },
    );
  };

  const onSubmit = (message: PromptInputMessage) => {
    submit(message.text ?? "");
  };

  return (
    <div className="flex h-[600px] flex-col overflow-hidden rounded-2xl border border-border/60 bg-card/50 shadow-sm">
      <div className="flex items-center justify-between gap-2 border-b border-border/60 bg-muted/30 px-4 py-2.5">
        <div className="flex items-center gap-2">
          <MessageSquareText className="size-4 text-emerald-500" />
          <span className="text-sm font-medium">Chat</span>
          <span className="rounded-md bg-muted px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
            {modelName}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <Popover>
            <PopoverTrigger
              render={
                <Button variant="ghost" size="sm" title="Generation settings">
                  <Settings2 />
                </Button>
              }
            />
            <PopoverContent align="end" className="w-80">
              <div className="flex flex-col gap-4">
                <div className="flex flex-col gap-2">
                  <Label className="text-xs font-medium text-muted-foreground">
                    System prompt
                  </Label>
                  <Textarea
                    value={system}
                    onChange={(e) => setSystem(e.target.value)}
                    placeholder="You are a helpful assistant…"
                    className="min-h-20 text-xs"
                  />
                </div>
                <div className="flex flex-col gap-2">
                  <div className="flex items-center justify-between">
                    <Label className="text-xs font-medium text-muted-foreground">
                      Temperature
                    </Label>
                    <span className="font-mono text-xs tabular-nums">
                      {temperature.toFixed(2)}
                    </span>
                  </div>
                  <Slider
                    value={temperature}
                    min={0}
                    max={2}
                    step={0.05}
                    onValueChange={(v) =>
                      setTemperature(Array.isArray(v) ? v[0] : v)
                    }
                  />
                </div>
              </div>
            </PopoverContent>
          </Popover>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setMessages([])}
            disabled={messages.length === 0}
            title="Clear conversation"
          >
            <Eraser />
          </Button>
        </div>
      </div>

      <Conversation className="flex-1">
        <ConversationContent>
          {messages.length === 0 ? (
            <div className="flex size-full flex-col items-center justify-center gap-4 p-8">
              <ConversationEmptyState
                className="p-0"
                icon={<Sparkles className="size-8" />}
                title={running ? "Send a message" : "Start the target server first"}
                description={
                  running
                    ? "Prompts stream through llama-server's OpenAI-compatible endpoint."
                    : "The chat talks to /v1/chat/completions on the target server."
                }
              />
              <div className="flex max-w-md flex-wrap justify-center gap-2">
                {SUGGESTIONS.map((s) => (
                  <button
                    key={s}
                    onClick={() => submit(s)}
                    className="rounded-full border border-border/60 bg-background/60 px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:border-border hover:text-foreground"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          ) : (
            messages.map((message) => (
              <Message from={message.role} key={message.id}>
                <MessageContent>
                  {message.parts.map((part, i) =>
                    part.type === "text" ? (
                      message.role === "assistant" ? (
                        <MessageResponse key={i}>{part.text}</MessageResponse>
                      ) : (
                        <span key={i} className="whitespace-pre-wrap">
                          {part.text}
                        </span>
                      )
                    ) : null,
                  )}
                </MessageContent>
              </Message>
            ))
          )}
        </ConversationContent>
        <ConversationScrollButton />
      </Conversation>

      {error && (
        <div className="border-t border-destructive/30 bg-destructive/5 px-4 py-2 text-xs text-destructive">
          {error.message}
        </div>
      )}

      <div className="border-t border-border/60 p-3">
        <PromptInput onSubmit={onSubmit} className="rounded-xl">
          <PromptInputBody>
            <PromptInputTextarea
              placeholder={
                running ? "Message the target model…" : "Start the server to chat…"
              }
            />
          </PromptInputBody>
          <PromptInputFooter className="justify-between">
            <PromptInputTools>
              <span className="pl-1 text-[10px] text-muted-foreground">
                temp {temperature.toFixed(2)}
                {system.trim() ? " · system set" : ""}
              </span>
            </PromptInputTools>
            <PromptInputSubmit
              status={status}
              onClick={
                status === "streaming" || status === "submitted"
                  ? () => stop()
                  : undefined
              }
            />
          </PromptInputFooter>
        </PromptInput>
      </div>
    </div>
  );
}
