import { parse } from 'csv-parse/sync';

const googleIdFromUrl = (url: string): { sheetId: string; gid?: string } | null => {
  const match = url.match(/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  if (!match?.[1]) {
    return null;
  }

  const gid = url.match(/[?#&]gid=(\d+)/)?.[1] ?? url.match(/#gid=(\d+)/)?.[1];
  return { sheetId: match[1], ...(gid ? { gid } : {}) };
};

const toKeyValue = (csvText: string): Record<string, string> => {
  const rows = parse(csvText, {
    skip_empty_lines: true
  }) as string[][];

  const result: Record<string, string> = {};
  for (const row of rows) {
    const key = row[0]?.trim();
    const value = row[1]?.trim();
    if (!key) {
      continue;
    }
    result[key] = value ?? '';
  }

  return result;
};

export const resolveSheetData = async (input: {
  sheetUrl?: string;
  csvContent?: string;
}): Promise<Record<string, string>> => {
  if (input.csvContent?.trim()) {
    return toKeyValue(input.csvContent);
  }

  if (!input.sheetUrl) {
    return {};
  }

  const parsed = googleIdFromUrl(input.sheetUrl);
  if (!parsed) {
    throw new Error('Invalid Google Sheet URL.');
  }

  const exportUrl = parsed.gid
    ? `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv&gid=${parsed.gid}`
    : `https://docs.google.com/spreadsheets/d/${parsed.sheetId}/export?format=csv`;

  const response = await fetch(exportUrl);
  if (!response.ok) {
    throw new Error(`Failed to fetch Google Sheet CSV (${response.status}). Ensure the sheet is public.`);
  }

  const csvText = await response.text();
  return toKeyValue(csvText);
};
