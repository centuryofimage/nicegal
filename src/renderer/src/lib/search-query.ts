/**
 * What a query matches against, named for the target rather than the engine behind it — `meaning`
 * and the CLIP `like` scope are both "semantic", so that word cannot distinguish them.
 * - `all`: file names plus `ocr`'s literal text match, combined — no embeddings involved.
 * - `ocr`: words read out of the picture, matched literally (FTS5).
 * - `meaning`: those same words, matched by embedding similarity instead of spelling.
 * - `like`: images matched by the CLIP meaning of a text description.
 */
export type SearchScope = "all" | "name" | "ocr" | "meaning" | "like";
export type TemporalOperator = "before" | "after" | "during";
export type MediaFilter = "image" | "video";

/**
 * How an `ocr:` body should be executed against the backend's text modes:
 * - `terms`: plain words — sent to FTS5 `match`, where bare words AND together.
 * - `glob`: contains an unquoted `*` or `?` — sent to the brute-force glob mode for
 *   prefix/substring matching on OCR'd words.
 * - `raw`: FTS5 query syntax (quoted phrases, AND/OR/NOT/NEAR, column filters) — passed to
 *   `match` verbatim; a malformed query surfaces the backend's own syntax error.
 */
export type OcrMode = "terms" | "glob" | "raw";

export type DateFilter =
  | {
      kind: "date";
      raw: string;
      valid: true;
      operator: TemporalOperator;
      value: string;
      from: string;
      to: string;
    }
  | { kind: "date"; raw: string; valid: false; operator: TemporalOperator };

export type QueryToken =
  | { kind: "scope"; scope: Exclude<SearchScope, "all">; raw: string }
  | { kind: "path"; value: string; raw: string }
  | { kind: "folder"; path: string; raw: string }
  | { kind: "media"; media: MediaFilter; raw: string }
  | DateFilter
  | { kind: "text"; raw: string };

export type ParsedQuery = {
  scope: SearchScope;
  path: string | null;
  folder: string | null;
  body: string;
  dates: DateFilter[];
  media: MediaFilter | null;
  tokens: QueryToken[];
  ocrMode: OcrMode;
};

const scopePattern = /^(name|filename|ocr|meaning|like):/i;
const temporalPattern = /^(before|after|during):(.*)$/i;
const mediaPattern = /^type:(image|video)$/i;
const dateValuePattern = /^(\d{4})(?:-(\d{2}))?(?:-(\d{2}))?$/;

type DateBounds = { from: string; to: string };

export function parseQuery(raw: string): ParsedQuery {
  const parts = raw.match(/\s+|(?:[^\s"]|"[^"]*")+/g) ?? [];
  const tokens: QueryToken[] = [];
  let scope: SearchScope = "all";
  let path: string | null = null;
  let folder: string | null = null;
  const dates: DateFilter[] = [];
  let media: MediaFilter | null = null;

  for (const part of parts) {
    if (/^\s+$/.test(part)) {
      tokens.push({ kind: "text", raw: part });
      continue;
    }

    // A scope may follow filters (for example `type:video like:cat`). Keep the first
    // scope authoritative so a second scope-like word remains searchable text.
    const scopeMatch = scope === "all" ? part.match(scopePattern) : null;
    const temporalMatch = part.match(temporalPattern);
    const folderMatch = /^in:(?:"([^"]*)"|([^\s"]+))$/i.exec(part);
    const pathMatch = /^path:(?:"([^"]*)"|([^\s"]*))$/i.exec(part);

    if (folderMatch) {
      folder = folderMatch[1] ?? folderMatch[2];
      tokens.push({ kind: "folder", path: folder, raw: part });
      continue;
    }

    if (pathMatch) {
      path = pathMatch[1] ?? pathMatch[2];
      tokens.push({ kind: "path", value: path, raw: part });
      continue;
    }

    if (scopeMatch) {
      const rawScope = scopeMatch[0];
      const name = scopeMatch[1].toLowerCase();
      scope = name === "filename" ? "name" : (name as Exclude<SearchScope, "all">);
      tokens.push({ kind: "scope", scope, raw: rawScope });
      if (part.length > rawScope.length)
        tokens.push({ kind: "text", raw: part.slice(rawScope.length) });
      continue;
    }

    if (temporalMatch) {
      const operator = temporalMatch[1].toLowerCase() as TemporalOperator;
      const token = parseDateToken(part, operator, temporalMatch[2]);
      dates.push(token);
      tokens.push(token);
      continue;
    }

    const mediaMatch = part.match(mediaPattern);
    if (mediaMatch) {
      media = mediaMatch[1].toLowerCase() as MediaFilter;
      tokens.push({ kind: "media", media, raw: part });
      continue;
    }

    tokens.push({ kind: "text", raw: part });
  }

  const body = tokens
    .filter((token): token is Extract<QueryToken, { kind: "text" }> => token.kind === "text")
    .map((token) => token.raw)
    .join("");

  return {
    scope,
    path,
    folder,
    body,
    dates,
    media,
    tokens,
    ocrMode: detectOcrMode(body),
  };
}

/** Folder selection changes only the structural focus term. */
export function withFolder(raw: string, folder: string | null): string {
  const body = textWithoutFolder(parseQuery(raw).tokens).trim();
  return folder ? `${body}${body ? " " : ""}in:"${folder}"` : body;
}

/** Hide a structural folder term when a compact chip already represents it. */
export function textWithoutFolder(tokens: readonly QueryToken[]): string {
  let text = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "folder") {
      if (tokens[index + 1]?.kind === "text" && /^\s+$/.test(tokens[index + 1].raw)) {
        index += 1;
      } else if (text.endsWith(" ")) {
        text = text.slice(0, -1);
      }
      continue;
    }
    text += token.raw;
  }
  return text;
}

/**
 * Worked examples of what `detectOcrMode` below reacts to, and the only description of `ocr:`
 * syntax the app has. Shown in the scope menu's tooltip, as ghost text in an empty search box,
 * and under an FTS5 syntax error. Examples rather than abstract tokens: a `*` or a bare `OR`
 * with a label beside it reads as a legend nobody parses, while each of these is a query you
 * could type as-is. Keep in step with `detectOcrMode`.
 */
export const OCR_SYNTAX_NOTES: readonly string[] = [
  "dre* (starts with)",
  '"red dress" (exact phrase)',
  "cat OR dog (either)",
];

/** Classifies the query body for OCR search. Quotes toggle operator detection off inside them,
 * so `"a * b"` is a phrase, but a quoted phrase itself (`"…"`) marks the query as raw FTS5. */
function detectOcrMode(body: string): OcrMode {
  let inQuotes = false;
  let sawGlob = false;
  let sawRaw = false;
  for (let index = 0; index < body.length; index += 1) {
    const char = body[index];
    if (char === '"') {
      inQuotes = !inQuotes;
      sawRaw = true;
      continue;
    }
    if (inQuotes) continue;
    if (char === "*" || char === "?") sawGlob = true;
    else if (char === "(" || char === ")" || char === "^" || char === "{") sawRaw = true;
    else if (char === ":" && isColumnFilterColon(body, index)) sawRaw = true;
  }
  if (!inQuotes && /\b(?:AND|OR|NOT|NEAR)\b/.test(body)) sawRaw = true;
  if (sawRaw) return "raw";
  if (sawGlob) return "glob";
  return "terms";
}

/**
 * A bare `:` only signals SQLite FTS5 column-filter syntax (`column : term`) when it directly
 * follows an identifier-like word — one starting with a letter or underscore, not a digit — and
 * is directly followed by a term. Digit-led runs like a time (`12:30`) or a ratio (`16:9`) stay
 * ordinary text.
 */
function isColumnFilterColon(body: string, index: number): boolean {
  const before = /(\S*)$/.exec(body.slice(0, index))?.[1] ?? "";
  if (!/^[A-Za-z_]/.test(before)) return false;
  return /^\S/.test(body.slice(index + 1));
}

export function withScope(raw: string, scope: SearchScope): string {
  const body = textWithoutScope(parseQuery(raw).tokens).trim();

  if (scope === "all") return body;
  return body ? `${scope}: ${body}` : `${scope}:`;
}

/** Preserves typed text while closing the whitespace gap left by a removed scope token. */
export function textWithoutScope(tokens: readonly QueryToken[]): string {
  let text = "";
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.kind === "scope") {
      if (
        text.endsWith(" ") &&
        tokens[index + 1]?.kind === "text" &&
        /^\s+$/.test(tokens[index + 1].raw)
      )
        index += 1;
      continue;
    }
    text += token.raw;
  }
  return text;
}

export function withMediaFilter(raw: string, media: MediaFilter | null): string {
  const body = parseQuery(raw)
    .tokens.filter((token) => token.kind !== "media")
    .map((token) => token.raw)
    .join("")
    .trim();
  return media ? `${body}${body ? " " : ""}type:${media}` : body;
}

function parseDateToken(raw: string, operator: TemporalOperator, value: string): DateFilter {
  const period = parseDateValue(value);
  const bounds = period && boundsForOperator(operator, period);
  return bounds
    ? { kind: "date", raw, valid: true, operator, value, ...bounds }
    : { kind: "date", raw, valid: false, operator };
}

function boundsForOperator(operator: TemporalOperator, period: DateBounds): DateBounds {
  switch (operator) {
    case "before":
      return period.from === "0000-01-01"
        ? { from: "9999-12-31", to: "0000-01-01" }
        : { from: "0000-01-01", to: previousDay(period.from) };
    case "after":
      return period.to === "9999-12-31"
        ? { from: "9999-12-31", to: "0000-01-01" }
        : { from: nextDay(period.to), to: "9999-12-31" };
    case "during":
      return period;
  }
}

function parseDateValue(value: string): DateBounds | null {
  const match = value.match(dateValuePattern);
  if (!match) return null;

  const [, year, month, day] = match;
  if (month && (month < "01" || month > "12")) return null;

  if (!month) return { from: `${year}-01-01`, to: `${year}-12-31` };
  const lastDay = daysInMonth(Number(year), Number(month));
  if (!day)
    return {
      from: `${year}-${month}-01`,
      to: `${year}-${month}-${String(lastDay).padStart(2, "0")}`,
    };
  if (Number(day) < 1 || Number(day) > lastDay) return null;
  return { from: value, to: value };
}

function nextDay(day: string): string {
  let [year, month, date] = day.split("-").map(Number);
  if (date < daysInMonth(year, month)) date += 1;
  else if (month < 12) {
    month += 1;
    date = 1;
  } else {
    year += 1;
    month = 1;
    date = 1;
  }
  return formatDate(year, month, date);
}

function previousDay(day: string): string {
  let [year, month, date] = day.split("-").map(Number);
  if (date > 1) date -= 1;
  else if (month > 1) {
    month -= 1;
    date = daysInMonth(year, month);
  } else {
    year -= 1;
    month = 12;
    date = 31;
  }
  return formatDate(year, month, date);
}

function daysInMonth(year: number, month: number): number {
  if (month === 2) return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0) ? 29 : 28;
  return month === 4 || month === 6 || month === 9 || month === 11 ? 30 : 31;
}

function formatDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}
