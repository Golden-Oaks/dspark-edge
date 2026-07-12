"use client";

import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Header } from "@/components/dashboard/header";
import { LiveSync } from "@/components/dashboard/live-sync";
import { ControlPanel } from "@/components/dashboard/control-panel";
import { MetricsPanel } from "@/components/dashboard/metrics-panel";
import { ChatPanel } from "@/components/dashboard/chat-panel";
import { LogsPanel } from "@/components/dashboard/logs-panel";
import { Activity, MessageSquareText, Terminal } from "lucide-react";

export default function Page() {
  return (
    <div className="flex min-h-full flex-col">
      <LiveSync />
      <Header />

      <main className="mx-auto flex w-full max-w-[1500px] flex-1 flex-col gap-5 px-5 py-6 lg:flex-row">
        <ControlPanel />

        <section className="min-w-0 flex-1">
          <Tabs defaultValue="metrics" className="flex flex-col gap-4">
            <TabsList className="w-full justify-start sm:w-auto">
              <TabsTrigger value="metrics">
                <Activity className="size-4" />
                Metrics
              </TabsTrigger>
              <TabsTrigger value="chat">
                <MessageSquareText className="size-4" />
                Chat
              </TabsTrigger>
              <TabsTrigger value="logs">
                <Terminal className="size-4" />
                Logs
              </TabsTrigger>
            </TabsList>

            <TabsContent value="metrics" className="outline-none">
              <MetricsPanel />
            </TabsContent>
            <TabsContent value="chat" className="outline-none">
              <ChatPanel />
            </TabsContent>
            <TabsContent value="logs" className="outline-none">
              <LogsPanel />
            </TabsContent>
          </Tabs>
        </section>
      </main>
    </div>
  );
}
