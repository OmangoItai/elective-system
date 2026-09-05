/** CSV cell escaping per RFC 4180. */
export function csvCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  if (/[",\n\r]/.test(text)) {
    return '"' + text.replace(/"/g, '""') + '"';
  }
  return text;
}

/**
 * Cell for identifier columns (账号/身份证号). Values get a leading
 * apostrophe, which Excel treats as a text marker and does not display; it
 * prevents long digit strings (身份证号) from becoming floats or scientific
 * notation and keeps X-ending IDs visually consistent.
 */
export function csvIdCell(value: unknown): string {
  const text = value == null ? "" : String(value);
  return text ? "'" + text : text;
}

export function csvRow(values: unknown[]): string {
  return values.map(csvCell).join(",");
}

/**
 * Join rows into a CSV document with an explicit `sep=,` delimiter
 * declaration (Excel convention). Caller adds the UTF-8 BOM when writing.
 */
export function csvDocument(rows: unknown[][]): string {
  return "sep=,\r\n" + rows.map(csvRow).join("\r\n") + "\r\n";
}

/** UTF-8 BOM so Excel opens Chinese CSVs with the right encoding. */
export const CSV_BOM = "\ufeff";
