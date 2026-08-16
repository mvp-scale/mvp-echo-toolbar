import { useState, useCallback } from 'react';

interface Props {
  text: string;
  processingTime?: number;
  /**
   * Returns whether the clipboard write actually succeeded. main computes this
   * (it reads the clipboard back), but the old `() => void` signature threw the
   * answer away, so the badge said "Copied!" unconditionally -- including when
   * nothing had been copied.
   */
  onCopy: () => Promise<{ success: boolean }> | void;
}

export default function TranscriptionDisplay({ text, processingTime, onCopy }: Props) {
  const [copied, setCopied] = useState(false);

  const [failed, setFailed] = useState(false);

  const handleClick = useCallback(async () => {
    if (!text) return;
    const result = await onCopy();
    const ok = result ? result.success !== false : true;
    setCopied(ok);
    setFailed(!ok);
    setTimeout(() => { setCopied(false); setFailed(false); }, 1500);
  }, [text, onCopy]);

  return (
    <div
      className={`px-3 py-2 cursor-pointer transition-colors ${
        text ? 'hover:bg-muted/30' : ''
      } ${copied ? 'bg-green-500/10' : ''}`}
      onClick={handleClick}
    >
      {text ? (
        <div className="h-full flex flex-col">
          <div className="flex items-center gap-2 mb-1">
            {processingTime && (
              <span className="text-[9px] px-1.5 py-0.5 bg-purple-100 text-purple-700 rounded-full font-medium">
                {processingTime}ms
              </span>
            )}
            {copied && (
              <span className="text-[9px] px-1.5 py-0.5 bg-green-100 text-green-700 rounded-full font-medium">
                Copied!
              </span>
            )}
            {failed && (
              <span className="text-[9px] px-1.5 py-0.5 bg-red-100 text-red-700 rounded-full font-medium">
                Copy failed
              </span>
            )}
          </div>
          <div className="flex-1 overflow-y-auto">
            <p className="text-sm leading-relaxed text-foreground">
              {text}
            </p>
          </div>
          <p className="text-[9px] text-muted-foreground mt-1 text-center">
            Click to copy
          </p>
        </div>
      ) : (
        <div className="h-full flex flex-col items-center justify-center text-center">
          <p className="text-sm text-muted-foreground">No transcription yet</p>
          <p className="text-[10px] text-muted-foreground mt-1">
            Press Ctrl+Alt+Z to start recording
          </p>
        </div>
      )}
    </div>
  );
}
