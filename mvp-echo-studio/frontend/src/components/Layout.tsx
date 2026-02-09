import type { ReactNode } from "react";
import HealthIndicator from "./HealthIndicator";

export default function Layout({ children }: { children: ReactNode }) {
  return (
    <div className="min-h-screen flex flex-col">
      <header className="flex items-center justify-between px-6 py-4 border-b border-border bg-surface-1">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-mvp-blue flex items-center justify-center text-white font-bold text-sm">
            E
          </div>
          <div>
            <h1 className="text-lg font-semibold text-white leading-tight">
              MVP-Echo Studio
            </h1>
            <p className="text-xs text-gray-500">
              Batch transcription + speaker diarization
            </p>
          </div>
        </div>
        <HealthIndicator />
      </header>
      <main className="flex-1 flex flex-col">{children}</main>
    </div>
  );
}
