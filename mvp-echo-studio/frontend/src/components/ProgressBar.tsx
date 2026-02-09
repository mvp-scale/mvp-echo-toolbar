import { useState, useEffect } from "react";

interface Props {
  active: boolean;
  filename?: string;
}

export default function ProgressBar({ active, filename }: Props) {
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    if (!active) {
      setElapsed(0);
      return;
    }
    const start = Date.now();
    const timer = setInterval(() => {
      setElapsed(Math.floor((Date.now() - start) / 1000));
    }, 1000);
    return () => clearInterval(timer);
  }, [active]);

  if (!active) return null;

  const mins = Math.floor(elapsed / 60);
  const secs = elapsed % 60;
  const timeStr = mins > 0
    ? `${mins}:${String(secs).padStart(2, "0")}`
    : `${secs}s`;

  return (
    <div className="flex flex-col gap-3 p-6 bg-surface-2 rounded-xl border border-border">
      <div className="flex items-center justify-between text-sm">
        <div className="flex items-center gap-2">
          <div className="w-4 h-4 border-2 border-mvp-blue border-t-transparent rounded-full animate-spin" />
          <span className="text-gray-300">
            Transcribing{filename ? `: ${filename}` : ""}...
          </span>
        </div>
        <span className="text-gray-500 tabular-nums">{timeStr}</span>
      </div>
      <div className="h-1 bg-surface-3 rounded-full overflow-hidden">
        <div className="h-full bg-mvp-blue rounded-full animate-[indeterminate_1.5s_ease-in-out_infinite] w-1/3" />
      </div>
      <p className="text-xs text-gray-500">
        Audio is being diarized and transcribed on the GPU. Long files may take several minutes.
      </p>
    </div>
  );
}
