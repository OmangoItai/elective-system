/** CSV cell escaping per RFC 4180. */
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

/** Join rows into a CSV document. Caller adds the UTF-8 BOM when writing. */
export function csvDocument(rows: unknown[][]): string {
  return rows.map(csvRow).join("\r\n") + "\r\n";
}

/** UTF-8 BOM so Excel opens Chinese CSVs with the right encoding. */
export const CSV_BOM = "\ufeff";
