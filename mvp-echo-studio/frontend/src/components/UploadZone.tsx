import { useCallback, useState, useRef } from "react";

interface Props {
  onFile: (file: File) => void;
  disabled?: boolean;
}

const ACCEPTED = ".mp3,.wav,.m4a,.ogg,.flac,.webm,.mp4,.aac,.wma";

export default function UploadZone({ onFile, disabled }: Props) {
  const [dragOver, setDragOver] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      if (disabled) return;
      const file = e.dataTransfer.files[0];
      if (file) onFile(file);
    },
    [onFile, disabled]
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) onFile(file);
      e.target.value = "";
    },
    [onFile]
  );

  return (
    <div
      onDragOver={(e) => {
        e.preventDefault();
        if (!disabled) setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={handleDrop}
      onClick={() => !disabled && inputRef.current?.click()}
      className={`
        relative flex flex-col items-center justify-center gap-4 p-12
        border-2 border-dashed rounded-xl cursor-pointer transition-all
        ${dragOver ? "border-mvp-blue bg-mvp-blue/5" : "border-border hover:border-border-light hover:bg-surface-2/50"}
        ${disabled ? "opacity-50 cursor-not-allowed" : ""}
      `}
    >
      <input
        ref={inputRef}
        type="file"
        accept={ACCEPTED}
        onChange={handleChange}
        className="hidden"
        disabled={disabled}
      />
      <div className="w-16 h-16 rounded-full bg-surface-2 flex items-center justify-center">
        <svg
          className="w-8 h-8 text-gray-400"
          fill="none"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth={1.5}
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            d="M3 16.5v2.25A2.25 2.25 0 005.25 21h13.5A2.25 2.25 0 0021 18.75V16.5m-13.5-9L12 3m0 0l4.5 4.5M12 3v13.5"
          />
        </svg>
      </div>
      <div className="text-center">
        <p className="text-gray-300 font-medium">
          Drop an audio file here, or click to browse
        </p>
        <p className="text-sm text-gray-500 mt-1">
          MP3, WAV, M4A, FLAC, OGG, WebM, MP4, AAC, WMA
        </p>
      </div>
    </div>
  );
}
