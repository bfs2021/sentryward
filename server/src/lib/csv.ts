// A spreadsheet runs a cell starting with one of these as a formula, so such
// cells are prefixed with a quote to keep exported values inert.
const FORMULA_START = /^[=+\-@\t\r]/;

// One RFC 4180 field.
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return "";
  let text = value instanceof Date ? value.toISOString() : String(value);
  if (typeof value === "string" && FORMULA_START.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

export function csvRow(values: unknown[]): string {
  return `${values.map(csvField).join(",")}\r\n`;
}
