import { useRef, useEffect } from "react";
import type { Segment } from "../types";
import SpeakerSegmentRow from "./SpeakerSegment";

interface Props {
  segments: Segment[];
  currentTime?: number;
  searchQuery?: string;
  onClickTimestamp?: (time: number) => void;
}

export default function TranscriptViewer({
  segments,
  currentTime = 0,
  searchQuery,
  onClickTimestamp,
}: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const activeRef = useRef<HTMLDivElement>(null);

  // Find active segment
  const activeIndex = segments.findIndex(
    (seg) => currentTime >= seg.start && currentTime < seg.end
  );

  // Auto-scroll to active segment
  useEffect(() => {
    if (activeRef.current && containerRef.current) {
      const container = containerRef.current;
      const el = activeRef.current;
      const top = el.offsetTop - container.offsetTop - container.clientHeight / 3;
      container.scrollTo({ top, behavior: "smooth" });
    }
  }, [activeIndex]);

  // Filter segments by search
  const filtered = searchQuery
    ? segments.filter((s) =>
        s.text.toLowerCase().includes(searchQuery.toLowerCase())
      )
    : segments;

  if (filtered.length === 0 && searchQuery) {
    return (
      <div className="flex items-center justify-center p-8 text-gray-500 text-sm">
        No results for "{searchQuery}"
      </div>
    );
  }

  return (
    <div
      ref={containerRef}
      className="flex-1 overflow-y-auto space-y-1 p-2"
    >
      {filtered.map((seg) => (
        <div
          key={seg.id}
          ref={seg.id === segments[activeIndex]?.id ? activeRef : undefined}
        >
          <SpeakerSegmentRow
            segment={seg}
            isActive={seg.id === segments[activeIndex]?.id}
            searchQuery={searchQuery}
            onClickTimestamp={onClickTimestamp}
          />
        </div>
      ))}
    </div>
  );
}
