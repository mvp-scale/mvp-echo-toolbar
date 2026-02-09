import type { Segment } from "../types";
import { formatTime } from "../utils/format-time";
import SpeakerBadge, { speakerColor } from "./SpeakerBadge";

interface Props {
  segment: Segment;
  isActive?: boolean;
  searchQuery?: string;
  onClickTimestamp?: (time: number) => void;
}

function highlightText(text: string, query: string) {
  if (!query) return text;
  const escaped = query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const parts = text.split(new RegExp(`(${escaped})`, "gi"));
  return parts.map((part, i) =>
    part.toLowerCase() === query.toLowerCase() ? (
      <mark key={i} className="bg-yellow-500/30 text-yellow-200 rounded px-0.5">
        {part}
      </mark>
    ) : (
      part
    )
  );
}

export default function SpeakerSegment({
  segment,
  isActive,
  searchQuery,
  onClickTimestamp,
}: Props) {
  const borderColor = segment.speaker
    ? speakerColor(segment.speaker)
    : "transparent";

  return (
    <div
      className={`flex gap-3 p-3 rounded-lg transition-colors ${
        isActive ? "bg-mvp-blue/10" : "hover:bg-surface-2/50"
      }`}
      style={{ borderLeft: `3px solid ${borderColor}` }}
    >
      <button
        onClick={() => onClickTimestamp?.(segment.start)}
        className="text-xs text-gray-500 hover:text-mvp-blue-light tabular-nums shrink-0 mt-0.5 font-mono"
        title="Jump to this time"
      >
        {formatTime(segment.start)}
      </button>
      <div className="flex flex-col gap-1 min-w-0">
        {segment.speaker && <SpeakerBadge speaker={segment.speaker} />}
        <p className="text-sm text-gray-200 leading-relaxed">
          {searchQuery ? highlightText(segment.text, searchQuery) : segment.text}
        </p>
      </div>
    </div>
  );
}
