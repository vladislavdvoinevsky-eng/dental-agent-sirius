"use client";

import { Thread } from "@/components/thread";
import { StreamProvider } from "@/providers/Stream";
import { ThreadProvider } from "@/providers/Thread";
import { ArtifactProvider } from "@/components/thread/artifact";
import { Toaster } from "@/components/ui/sonner";
import React from "react";
import { AuthProvider } from "@/components/clinic/auth";

export default function DemoPage(): React.ReactNode {
  return (
    <React.Suspense
      fallback={
        <div className="text-muted-foreground flex h-screen items-center justify-center text-sm">
          Загружаю чат…
        </div>
      }
    >
      <Toaster />
      <AuthProvider>
        <ThreadProvider>
          <StreamProvider>
            <ArtifactProvider>
              <Thread />
            </ArtifactProvider>
          </StreamProvider>
        </ThreadProvider>
      </AuthProvider>
    </React.Suspense>
  );
}
