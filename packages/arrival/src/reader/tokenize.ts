// The tokenizer: Lexer-driven string → token lifting + datum-comment (#;) stripping.
// Depends only on Lexer + eof + AString — cycle-neutral (Lexer imports neither this module
// nor the eval layer). `tokenize` is the one public entry; `tokens`/`strip_s_comments` are
// its private helpers.
import { Lexer } from "./Lexer.js";
import { eof } from "../values/primitives/EOF.js";
import { AString } from "../values/primitives/AString.js";
import invariant from "tiny-invariant";

// The lexer's per-token metadata record — the SHAPE the lexer's meta mode yields, not a
// Scheme value. (`Lexer.peek(true)` returns these; a token is reader-internal, never an
// AValue.) This is the canonical home for the type and its overload.
export interface TokenMeta {
  token: string;
  col: number;
  offset: number;
  line: number;
}

// `Lexer.peek` has no boolean overload, so `peek(true)`'s inferred return is the broad
// `EOF | TokenMeta | string | null` union even though meta mode always yields a TokenMeta.
// Narrow back to the real shape through a guard rather than a blind cast.
function isTokenMeta(value: unknown): value is TokenMeta {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as TokenMeta).token === "string" &&
    typeof (value as TokenMeta).col === "number"
  );
}

function tokens(str: string | AString): TokenMeta[] {
  if (str instanceof AString) {
    str = str.valueOf();
  }
  const lexer = new Lexer(str, { whitespace: true });
  const result: TokenMeta[] = [];
  while (true) {
    const token = lexer.peek(true);
    if (token === eof) {
      break;
    }
    invariant(isTokenMeta(token), "tokenize: lexer meta mode yielded a non-TokenMeta token");
    result.push(token);
    lexer.skip();
  }
  return result;
}

// `meta` is not a runtime flag the type system can branch on, so make it an overload: meta
// mode returns the lexer's `TokenMeta[]` records; default mode returns the cleaned `string[]`
// (whitespace-trimmed, comment-stripped).
export function tokenize(str: string | AString, meta: true): TokenMeta[];
export function tokenize(str: string | AString, meta?: false): string[];
export function tokenize(str: string | AString, meta = false): TokenMeta[] | string[] {
  if (str instanceof AString) {
    str = str.toString();
  }
  if (meta) {
    return tokens(str);
  } else {
    const result = tokens(str)
      .map(function (token) {
        // character literals `#\ ` and `#\newline` are meaningful whitespace — don't trim them
        if (token.token === String.raw`#\ ` || token.token == "#\\\n") {
          return token.token;
        }
        return token.token.trim();
      })
      .filter(function (token) {
        return token && !token.startsWith(";") && !/^#\|[\s\S]*\|#$/.test(token);
      });
    return strip_s_comments(result);
  }
}

const DATUM_OPEN = new Set(["(", "[", "{", "#(", "#u8("]);
const DATUM_CLOSE = new Set([")", "]", "}"]);
const DATUM_QUOTE = new Set(["'", "`", ",", ",@", "#attachment"]);

function isDatumPrefix(tok: string): boolean {
  return DATUM_QUOTE.has(tok) || /^#\d+=$/.test(tok);
}

function skipDatumTokens(tokens: readonly string[], start: number): number {
  let i = start;
  while (i < tokens.length && tokens[i] === "#;") {
    i = skipDatumTokens(tokens, i + 1);
  }
  while (i < tokens.length && isDatumPrefix(tokens[i]!)) {
    i++;
    while (i < tokens.length && tokens[i] === "#;") {
      i = skipDatumTokens(tokens, i + 1);
    }
  }
  if (i >= tokens.length || DATUM_CLOSE.has(tokens[i]!)) return i;
  if (DATUM_OPEN.has(tokens[i]!)) {
    let depth = 0;
    while (i < tokens.length) {
      const tok = tokens[i]!;
      if (DATUM_OPEN.has(tok)) depth++;
      else if (DATUM_CLOSE.has(tok)) {
        depth--;
        if (depth <= 0) return i + 1;
      }
      i++;
    }
    return i;
  }
  return i + 1;
}

function strip_s_comments(tokens: string[]): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (tokens[i] === "#;") {
      i = skipDatumTokens(tokens, i + 1);
      continue;
    }
    out.push(tokens[i]!);
    i++;
  }
  return out;
}

