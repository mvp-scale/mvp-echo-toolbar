import type { Segment, ExportFormat } from "../types";
import { formatTimestamp } from "./format-time";

function toSRT(segments: Segment[]): string {
  return segments
    .map((seg, i) => {
      const start = formatTimestamp(seg.start).replace(".", ",");
      const end = formatTimestamp(seg.end).replace(".", ",");
      const speaker = seg.speaker ? `[${speakerLabel(seg.speaker)}] ` : "";
      return `${i + 1}\n${start} --> ${end}\n${speaker}${seg.text.trim()}\n`;
    })
    .join("\n");
}

function toVTT(segments: Segment[]): string {
  const lines = segments.map((seg) => {
    const start = formatTimestamp(seg.start);
    const end = formatTimestamp(seg.end);
    const speaker = seg.speaker ? `<v ${speakerLabel(seg.speaker)}>` : "";
    return `${start} --> ${end}\n${speaker}${seg.text.trim()}\n`;
  });
  return `WEBVTT\n\n${lines.join("\n")}`;
}

function toTXT(segments: Segment[]): string {
  let txt = "";
  let lastSpeaker = "";
  for (const seg of segments) {
    const label = seg.speaker ? speakerLabel(seg.speaker) : "";
    if (label && label !== lastSpeaker) {
      txt += `\n${label}:\n`;
      lastSpeaker = label;
    }
    txt += `${seg.text.trim()} `;
  }
  return txt.trim();
}

function toJSON(segments: Segment[]): string {
  return JSON.stringify(
    segments.map((s) => ({
      start: s.start,
      end: s.end,
      speaker: s.speaker ? speakerLabel(s.speaker) : undefined,
      text: s.text.trim(),
    })),
    null,
    2
  );
}

function speakerLabel(raw: string): string {
  // "speaker_SPEAKER_00" -> "Speaker 1"
  const match = raw.match(/(\d+)$/);
  if (match) {
    return `Speaker ${parseInt(match[1], 10) + 1}`;
  }
  return raw;
}

export function exportTranscript(
  segments: Segment[],
  format: ExportFormat,
  filename: string
): void {
  let content: string;
  let mimeType: string;
  let ext: string;

  switch (format) {
    case "srt":
      content = toSRT(segments);
      mimeType = "text/srt";
      ext = "srt";
      break;
    case "vtt":
      content = toVTT(segments);
      mimeType = "text/vtt";
      ext = "vtt";
      break;
    case "txt":
      content = toTXT(segments);
      mimeType = "text/plain";
      ext = "txt";
      break;
    case "json":
      content = toJSON(segments);
      mimeType = "application/json";
      ext = "json";
      break;
  }

  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `${filename.replace(/\.[^.]+$/, "")}.${ext}`;
  a.click();
  URL.revokeObjectURL(url);
}
