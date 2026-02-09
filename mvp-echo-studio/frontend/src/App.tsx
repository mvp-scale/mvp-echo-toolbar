import { useState, useCallback } from "react";
import type { Segment, AppState, TranscriptionResponse } from "./types";
import { transcribe } from "./api";
import Layout from "./components/Layout";
import UploadZone from "./components/UploadZone";
import ProgressBar from "./components/ProgressBar";
import TranscriptViewer from "./components/TranscriptViewer";
import AudioPlayer from "./components/AudioPlayer";
import SearchBar from "./components/SearchBar";
import ExportBar from "./components/ExportBar";

export default function App() {
  const [state, setState] = useState<AppState>("idle");
  const [file, setFile] = useState<File | null>(null);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [fullText, setFullText] = useState("");
  const [duration, setDuration] = useState(0);
  const [error, setError] = useState("");
  const [currentTime, setCurrentTime] = useState(0);
  const [seekTo, setSeekTo] = useState<number | undefined>(undefined);
  const [searchQuery, setSearchQuery] = useState("");

  const handleFile = useCallback(async (f: File) => {
    setFile(f);
    setState("transcribing");
    setError("");
    setSegments([]);
    setFullText("");
    setSearchQuery("");

    try {
      const result: TranscriptionResponse = await transcribe(f, { diarize: true });
      setSegments(result.segments ?? []);
      setFullText(result.text);
      setDuration(result.duration ?? 0);
      setState("done");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Transcription failed");
      setState("error");
    }
  }, []);

  const handleClickTimestamp = useCallback((time: number) => {
    setSeekTo(time);
  }, []);

  const handleNewFile = useCallback(() => {
    setState("idle");
    setFile(null);
    setSegments([]);
    setFullText("");
    setError("");
    setSearchQuery("");
    setSeekTo(undefined);
  }, []);

  const filteredCount = searchQuery
    ? segments.filter((s) =>
        s.text.toLowerCase().includes(searchQuery.toLowerCase())
      ).length
    : undefined;

  return (
    <Layout>
      <div className="flex-1 flex flex-col max-w-5xl w-full mx-auto p-6 gap-4">
        {/* Upload / Progress */}
        {state === "idle" && (
          <UploadZone onFile={handleFile} />
        )}

        {state === "transcribing" && (
          <ProgressBar active filename={file?.name} />
        )}

        {state === "error" && (
          <div className="flex flex-col items-center gap-4 p-8">
            <div className="w-12 h-12 rounded-full bg-red-500/10 flex items-center justify-center">
              <svg className="w-6 h-6 text-red-400" viewBox="0 0 24 24" fill="currentColor">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" />
              </svg>
            </div>
            <p className="text-red-400 text-sm">{error}</p>
            <button
              onClick={handleNewFile}
              className="px-4 py-2 text-sm bg-surface-2 border border-border rounded-lg text-gray-300 hover:text-white hover:border-border-light"
            >
              Try again
            </button>
          </div>
        )}

        {/* Results */}
        {state === "done" && segments.length > 0 && (
          <>
            {/* Audio Player */}
            <AudioPlayer
              file={file}
              onTimeUpdate={setCurrentTime}
              seekTo={seekTo}
            />

            {/* Toolbar */}
            <div className="flex items-center justify-between gap-4 flex-wrap">
              <div className="flex items-center gap-3">
                <button
                  onClick={handleNewFile}
                  className="px-3 py-1.5 text-xs font-medium bg-surface-2 border border-border rounded-md
                    text-gray-300 hover:text-white hover:border-border-light transition-colors"
                >
                  New file
                </button>
                <span className="text-xs text-gray-500">
                  {segments.length} segments
                  {duration > 0 && ` \u00b7 ${Math.floor(duration / 60)}m ${Math.floor(duration % 60)}s`}
                </span>
              </div>
              <ExportBar segments={segments} filename={file?.name ?? "transcript"} />
            </div>

            {/* Search */}
            <SearchBar
              value={searchQuery}
              onChange={setSearchQuery}
              resultCount={filteredCount}
            />

            {/* Transcript */}
            <div className="flex-1 min-h-0 bg-surface-1 rounded-xl border border-border overflow-hidden flex flex-col">
              <TranscriptViewer
                segments={segments}
                currentTime={currentTime}
                searchQuery={searchQuery}
                onClickTimestamp={handleClickTimestamp}
              />
            </div>
          </>
        )}

        {state === "done" && segments.length === 0 && (
          <div className="flex flex-col items-center gap-4 p-8">
            <p className="text-gray-400 text-sm">
              Transcription completed but no segments were returned.
            </p>
            {fullText && (
              <div className="p-4 bg-surface-2 rounded-lg text-sm text-gray-300 max-w-full overflow-auto">
                {fullText}
              </div>
            )}
            <button
              onClick={handleNewFile}
              className="px-4 py-2 text-sm bg-surface-2 border border-border rounded-lg text-gray-300 hover:text-white hover:border-border-light"
            >
              Upload another
            </button>
          </div>
        )}
      </div>
    </Layout>
  );
}
