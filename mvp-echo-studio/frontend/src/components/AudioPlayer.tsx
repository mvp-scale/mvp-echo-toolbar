import { useRef, useState, useEffect, useCallback } from "react";
import { formatTime } from "../utils/format-time";

interface Props {
  file: File | null;
  onTimeUpdate?: (time: number) => void;
  seekTo?: number;
}

export default function AudioPlayer({ file, onTimeUpdate, seekTo }: Props) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [playing, setPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const seekRef = useRef<number | undefined>(undefined);

  // Create object URL for file
  useEffect(() => {
    if (!file) {
      setUrl(null);
      return;
    }
    const objUrl = URL.createObjectURL(file);
    setUrl(objUrl);
    return () => URL.revokeObjectURL(objUrl);
  }, [file]);

  // Handle external seek requests
  useEffect(() => {
    if (seekTo !== undefined && seekTo !== seekRef.current && audioRef.current) {
      audioRef.current.currentTime = seekTo;
      seekRef.current = seekTo;
      if (!playing) {
        audioRef.current.play();
        setPlaying(true);
      }
    }
  }, [seekTo, playing]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (playing) {
      audio.pause();
    } else {
      audio.play();
    }
    setPlaying(!playing);
  }, [playing]);

  const handleTimeUpdate = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    setCurrentTime(audio.currentTime);
    onTimeUpdate?.(audio.currentTime);
  }, [onTimeUpdate]);

  const handleSeek = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
    const audio = audioRef.current;
    if (!audio || !duration) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const ratio = (e.clientX - rect.left) / rect.width;
    audio.currentTime = ratio * duration;
  }, [duration]);

  const skip = useCallback((delta: number) => {
    const audio = audioRef.current;
    if (!audio) return;
    audio.currentTime = Math.max(0, Math.min(duration, audio.currentTime + delta));
  }, [duration]);

  if (!url) return null;

  const progress = duration ? (currentTime / duration) * 100 : 0;

  return (
    <div className="flex flex-col gap-2 p-4 bg-surface-2 rounded-xl border border-border">
      <audio
        ref={audioRef}
        src={url}
        onTimeUpdate={handleTimeUpdate}
        onLoadedMetadata={() => setDuration(audioRef.current?.duration ?? 0)}
        onEnded={() => setPlaying(false)}
      />

      <div className="flex items-center gap-3">
        {/* Skip back */}
        <button
          onClick={() => skip(-10)}
          className="text-gray-400 hover:text-white p-1"
          title="Back 10s"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M12.5 8c-2.65 0-5.05 1-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z" />
          </svg>
        </button>

        {/* Play/Pause */}
        <button
          onClick={togglePlay}
          className="w-10 h-10 rounded-full bg-mvp-blue hover:bg-mvp-blue-light flex items-center justify-center text-white transition-colors"
        >
          {playing ? (
            <svg className="w-5 h-5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 ml-0.5" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>

        {/* Skip forward */}
        <button
          onClick={() => skip(10)}
          className="text-gray-400 hover:text-white p-1"
          title="Forward 10s"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor">
            <path d="M18 13c0 3.31-2.69 6-6 6s-6-2.69-6-6 2.69-6 6-6v4l5-5-5-5v4c-4.42 0-8 3.58-8 8s3.58 8 8 8 8-3.58 8-8h-2z" />
          </svg>
        </button>

        {/* Time display */}
        <span className="text-xs text-gray-400 tabular-nums font-mono min-w-[90px]">
          {formatTime(currentTime)} / {formatTime(duration)}
        </span>

        {/* Seek bar */}
        <div
          className="flex-1 h-2 bg-surface-3 rounded-full cursor-pointer group relative"
          onClick={handleSeek}
        >
          <div
            className="h-full bg-mvp-blue rounded-full transition-[width] duration-75 relative"
            style={{ width: `${progress}%` }}
          >
            <div className="absolute right-0 top-1/2 -translate-y-1/2 w-3 h-3 bg-white rounded-full opacity-0 group-hover:opacity-100 transition-opacity shadow" />
          </div>
        </div>
      </div>
    </div>
  );
}
