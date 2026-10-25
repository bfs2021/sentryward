import type { ChangedFile, Hunk } from "../core/models.ts";

// The diff as the model reads it. Every line that exists in the new file
// carries its new-file line number, so the model reports the coordinates the
// rest of the pipeline uses and never has to count. Removed lines have none.
export function renderFileHeader(file: ChangedFile): string {
  const details = [file.changeType, file.language].filter(Boolean).join(", ");
  const renamed = file.previousPath ? ` [renamed from ${file.previousPath}]` : "";
  return `=== FILE: ${file.path} (${details})${renamed} ===`;
}

export interface HunkLine {
  marker: "+" | "-" | " ";
  // The new-file line number; absent on a removed line.
  line?: number;
  text: string;
}

// The lines of a hunk's text after its header, numbered as the model reads
// them. "\ No newline at end of file" is not a line of either file, so it is
// left out. Team rules (rules.ts) match against these same numbers.
export function hunkLines(hunk: Hunk): HunkLine[] {
  const out: HunkLine[] = [];
  let newLine = hunk.newStart;
  for (const raw of hunk.content.split("\n").slice(1)) {
    const marker = raw[0];
    const text = raw.slice(1);
    if (marker === "-") {
      out.push({ marker, text });
    } else if (marker !== "\\") {
      out.push({ marker: marker === "+" ? "+" : " ", line: newLine, text });
      newLine += 1;
    }
  }
  return out;
}

export function renderHunk(hunk: Hunk): string {
  const header = hunk.content.split("\n", 1)[0] ?? "";
  const body = hunkLines(hunk).map(({ marker, line, text }) =>
    marker === "-" ? `${"".padStart(6)} - | ${text}` : `${String(line).padStart(6)} ${marker} | ${text}`,
  );
  return [header, ...body].join("\n");
}

export function renderFileDiff(file: ChangedFile, hunks: Hunk[] = file.hunks): string {
  return [renderFileHeader(file), ...hunks.map(renderHunk)].join("\n");
}
