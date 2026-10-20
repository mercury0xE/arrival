/**
 * Canonical front desugar for the arrival Mercury instance (organ boundary:
 * sugar → core forms before CoreForm classification). Total: never throws;
 * unexpandable `case` / `cond` / `match` / `define-variant` clauses leave the
 * form for classify() to door.
 *
 * Expands: SRFI-26 `cut`; `->`/`~>`/`->>`/`~>>`; `compose`/`comp`/`pipe`/`flow`;
 * `when`/`unless`/`cond` → `if`; `define-variant` → constructor/predicate `define`s;
 * exhaustive `match` → guarded `if`/`let` field projections.
 * `and`/`or` do NOT desugar (CoreForm nodes for Law T).
 * Semantics match arrival-scheme bootstrap macros and evaluator special forms.
 */
import { type Atom, isAtom, isBool, isKeyword, isList, isNumber, type ListNode, type Node } from "./nodes.js";

export interface VariantFieldMeta {
  readonly name: string;
  readonly schemeType: string;
  readonly tsType: string;
}

export interface VariantClauseMeta {
  readonly typeName: string;
  readonly typeParams: readonly string[];
  readonly variantName: string;
  readonly tag: string;
  readonly fields: readonly VariantFieldMeta[];
  readonly allVariants: readonly string[];
}

export interface VariantTypeMeta {
  readonly typeName: string;
  readonly typeParams: readonly string[];
  readonly variants: readonly VariantClauseMeta[];
  readonly tsUnionDeclaration: string;
}

export interface VariantFieldAccessMeta {
  readonly typeName: string;
  readonly typeParams: readonly string[];
  readonly variantName: string;
  readonly tag: string;
  readonly fieldName: string;
  readonly fieldTsType: string;
  readonly targetAtom?: string;
}

export interface DesugarErrorMeta {
  readonly slug: string;
  readonly message: string;
}

export type AnnotatedListNode = ListNode & {
  variantTypeMeta?: VariantTypeMeta;
  variantCtorMeta?: VariantClauseMeta;
  variantPredMeta?: VariantClauseMeta;
  variantFieldAccess?: VariantFieldAccessMeta;
  desugarError?: DesugarErrorMeta;
};

const TS_IDENT = /^[A-Z_$][\w$]*$/i;

function variantTagOf(name: string): string {
  return name
    .replaceAll(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replaceAll(/([A-Z]+)([A-Z][a-z])/g, "$1-$2")
    .toLowerCase();
}

function schemeFieldTypeToTs(schemeType: string, typeParams: readonly string[]): string {
  const paramIdx = typeParams.indexOf(schemeType);
  if (paramIdx !== -1) return schemeType.toUpperCase();
  switch (schemeType) {
    case "integer":
    case "number":
    case "real":
    case "float":
    case "inexact":
    case "exact":
      return "number";
    case "string":
    case "symbol":
    case "keyword":
      return "string";
    case "boolean":
    case "bool":
      return "boolean";
    case "any":
    case "dynamic":
    case "unknown":
      return "unknown";
    default:
      return schemeType;
  }
}

function parseVariantDecl(n: ListNode): VariantTypeMeta | DesugarErrorMeta {
  if (n.list.length < 3) {
    return {
      slug: "define-variant-shape",
      message: "`define-variant` requires a type header and at least one variant clause.",
    };
  }
  const header = n.list[1]!;
  let typeName: string;
  const typeParams: string[] = [];
  if (isAtom(header) && !header.str) {
    typeName = header.atom;
  } else if (isList(header) && header.list.length >= 1 && isAtom(header.list[0]) && !header.list[0]!.str) {
    typeName = header.list[0]!.atom;
    for (const p of header.list.slice(1)) {
      if (!isAtom(p) || p.str) {
        return {
          slug: "define-variant-shape",
          message: "`define-variant` type parameters must be plain symbols.",
        };
      }
      typeParams.push(p.atom);
    }
  } else {
    return {
      slug: "define-variant-shape",
      message: "`define-variant` header must be `TypeName` or `(TypeName param...)`.",
    };
  }

  const rawClauses = n.list.slice(2);
  const prelim: Array<{ variantName: string; tag: string; fields: VariantFieldMeta[] }> = [];
  for (const c of rawClauses) {
    if (!isList(c) || c.list.length === 0 || !isAtom(c.list[0]) || c.list[0]!.str) {
      return {
        slug: "define-variant-shape",
        message: "each `define-variant` clause must be `(VariantName (fieldName fieldType)...)`.",
      };
    }
    const variantName = c.list[0]!.atom;
    const fields: VariantFieldMeta[] = [];
    for (const fSpec of c.list.slice(1)) {
      if (isList(fSpec) && fSpec.list.length === 2 && isAtom(fSpec.list[0]) && !fSpec.list[0]!.str && isAtom(fSpec.list[1]) && !fSpec.list[1]!.str) {
        const fName = fSpec.list[0]!.atom;
        const sType = fSpec.list[1]!.atom;
        fields.push({ name: fName, schemeType: sType, tsType: schemeFieldTypeToTs(sType, typeParams) });
      } else if (isAtom(fSpec) && !fSpec.str) {
        fields.push({ name: fSpec.atom, schemeType: "unknown", tsType: "unknown" });
      } else {
        return {
          slug: "define-variant-shape",
          message: `variant \`${variantName}\`: field spec must be \`(fieldName fieldType)\` or \`fieldName\`.`,
        };
      }
    }
    prelim.push({ variantName, tag: variantTagOf(variantName), fields });
  }

  const allVariants = prelim.map((p) => p.variantName);
  const variants: VariantClauseMeta[] = prelim.map((p) => ({
    typeName,
    typeParams,
    variantName: p.variantName,
    tag: p.tag,
    fields: p.fields,
    allVariants,
  }));

  const typeParamStr = typeParams.length > 0 ? `<${typeParams.map((p) => p.toUpperCase()).join(", ")}>` : "";
  const unionArms = variants
    .map((v) => {
      const fieldParts = v.fields
        .map((f) => `; readonly ${TS_IDENT.test(f.name) ? f.name : JSON.stringify(f.name)}: ${f.tsType}`)
        .join("");
      return `| { readonly kind: ${JSON.stringify(v.tag)}${fieldParts} }`;
    })
    .join(" ");
  const tsUnionDeclaration = `export type ${typeName}${typeParamStr} = ${unionArms};`;

  return { typeName, typeParams, variants, tsUnionDeclaration };
}

function collectVariantsInForest(
  nodes: readonly Node[],
  byVariant: Map<string, VariantClauseMeta>,
  types: VariantTypeMeta[],
): void {
  for (const n of nodes) {
    if (!isList(n) || n.list.length === 0) continue;
    const h = isAtom(n.list[0]) && !n.list[0]!.str ? n.list[0]!.atom : undefined;
    if (h === "define-variant") {
      const parsed = parseVariantDecl(n);
      if ("variants" in parsed) {
        types.push(parsed);
        for (const v of parsed.variants) {
          byVariant.set(v.variantName, v);
        }
      }
      continue;
    }
    const annotated = n as AnnotatedListNode;
    if (annotated.variantTypeMeta !== undefined) {
      types.push(annotated.variantTypeMeta);
      for (const v of annotated.variantTypeMeta.variants) {
        byVariant.set(v.variantName, v);
      }
    }
    collectVariantsInForest(n.list, byVariant, types);
  }
}

/** Extract all `define-variant` type declarations from a raw or desugared forest. */
export function extractVariantTypes(forest: readonly Node[]): VariantTypeMeta[] {
  const byVariant = new Map<string, VariantClauseMeta>();
  const types: VariantTypeMeta[] = [];
  collectVariantsInForest(forest, byVariant, types);
  return types;
}

/** Expand every sugar form in a parse forest. Pure: returns a new forest, leaves input alone. */
export function desugar(forest: Node[]): Node[] {
  const byVariant = new Map<string, VariantClauseMeta>();
  const types: VariantTypeMeta[] = [];
  collectVariantsInForest(forest, byVariant, types);
  return expandSequence(forest, byVariant);
}

function expandSequence(nodes: readonly Node[], byVariant: ReadonlyMap<string, VariantClauseMeta>): Node[] {
  const out: Node[] = [];
  for (const n of nodes) {
    if (isList(n) && isAtom(n.list[0]) && !n.list[0]!.str && n.list[0]!.atom === "define-variant") {
      const parsed = parseVariantDecl(n);
      if ("slug" in parsed) {
        const errNode: AnnotatedListNode = { ...n, desugarError: parsed };
        out.push(errNode);
        continue;
      }
      const synthesized = synthesizeVariantDefines(n, parsed);
      out.push(...synthesized);
      continue;
    }
    out.push(expand(n, byVariant));
  }
  return out;
}

function synthesizeVariantDefines(origin: ListNode, meta: VariantTypeMeta): Node[] {
  const out: Node[] = [];
  const span = origin.span;
  for (const [idx, v] of meta.variants.entries()) {
    const paramAtoms: Atom[] = v.fields.map((f) => ({ atom: f.name, ...(span ? { span } : {}) }));
    const dictItems: Node[] = [
      { atom: "dict" },
      { atom: ":kind" },
      { list: [{ atom: "quote" }, { atom: v.tag }] },
    ];
    for (const f of v.fields) {
      dictItems.push({ atom: `:${f.name}` }, { atom: f.name });
    }
    const ctorNode: AnnotatedListNode = {
      ...(span ? { span } : {}),
      list: [
        { atom: "define" },
        { list: [{ atom: v.variantName, ...(span ? { span } : {}) }, ...paramAtoms] },
        { list: dictItems, ...(span ? { span } : {}) },
      ],
      variantCtorMeta: v,
      ...(idx === 0 ? { variantTypeMeta: meta } : {}),
    };
    out.push(ctorNode);

    const predName = `${v.variantName}?`;
    const predArg: Atom = { atom: "__x" };
    const predNode: AnnotatedListNode = {
      ...(span ? { span } : {}),
      list: [
        { atom: "define" },
        { list: [{ atom: predName, ...(span ? { span } : {}) }, predArg] },
        {
          list: [
            { atom: "and" },
            { list: [{ atom: "dict?" }, predArg] },
            {
              list: [
                { atom: "equal?" },
                { list: [{ atom: ":kind" }, predArg] },
                { list: [{ atom: "quote" }, { atom: v.tag }] },
              ],
            },
          ],
          ...(span ? { span } : {}),
        },
      ],
      variantPredMeta: v,
    };
    out.push(predNode);
  }
  return out;
}

/** Bottom-up: expand children first (so a nested sugar form's own slots/threads are consumed
 *  by ITS expansion), then expand this node if it is itself a sugar form. `{ ...n, list }`
 *  PRESERVES every other property the parser attached (notably `span`, which the classifier
 *  carries onto CoreForm nodes) — rebuilding as a bare `{ list }` would strip comments and
 *  positions. */
function expand(n: Node, byVariant: ReadonlyMap<string, VariantClauseMeta>): Node {
  if (!isList(n)) return n;
  const rawHead = isAtom(n.list[0]) && !n.list[0]!.str ? n.list[0]!.atom : undefined;
  if (rawHead === "define-variant") {
    const parsed = parseVariantDecl(n);
    if ("slug" in parsed) {
      const errNode: AnnotatedListNode = { ...n, desugarError: parsed };
      return errNode;
    }
    return withSpan(n, { list: [SYM.begin, ...synthesizeVariantDefines(n, parsed)] });
  }
  const list = expandSequence(n.list, byVariant);
  const h = isAtom(n.list[0]) && !n.list[0].str ? n.list[0].atom : undefined;
  switch (h) {
    case "cut":
      return { ...n, list: cutLambda(list) }; // keep the form's span on the synthetic node
    case "->":
    case "~>":
      return withSpan(n, thread(list[1], list.slice(2), "first"));
    case "->>":
    case "~>>":
      return withSpan(n, thread(list[1], list.slice(2), "last"));
    case "compose":
    case "comp":
      return { ...n, list: composeLambda(list.slice(1), "right-to-left") };
    case "pipe":
    case "flow":
      return { ...n, list: composeLambda(list.slice(1), "left-to-right") };
    case "when":
      return withSpan(n, { list: [SYM.if, list[1]!, body(list.slice(2))] });
    case "unless":
      return withSpan(n, { list: [SYM.if, { list: [SYM.not, list[1]!] }, body(list.slice(2))] });
    case "cond": {
      // Unexpandable clause shapes (`=>` receivers, bare `(test)`) leave the whole form
      // for classify() to door — a loud door beats a possibly-divergent expansion.
      const expanded = expandCond(list.slice(1));
      return expanded === undefined ? { ...n, list } : withSpan(n, expanded);
    }
    case "match": {
      const expanded = expandMatch(n, list, byVariant);
      if ("slug" in expanded) {
        const errNode: AnnotatedListNode = { ...n, list, desugarError: expanded };
        return errNode;
      }
      return withSpan(n, expanded);
    }
    case "case":
      // Unused by any example; its datum eqv/quoting semantics are subtle enough that a
      // clean door beats a possibly-divergent expansion. Left unexpanded for classify()
      // to door (`unsupported-form/case`). Desugar to `cond` (or-of-`equal?`) if needed.
      return { ...n, list };
  }
  return { ...n, list };
}

/** Reused atom heads for synthesized forms. */
const SYM = {
  if: { atom: "if" } as Atom,
  not: { atom: "not" } as Atom,
  begin: { atom: "begin" } as Atom,
  let: { atom: "let" } as Atom,
  equalQ: { atom: "equal?" } as Atom,
  quote: { atom: "quote" } as Atom,
  kindKw: { atom: ":kind" } as Atom,
};

/** A clause/`when` body: one expr stays bare; many wrap in `begin` (an IIFE/block downstream). */
function body(forms: Node[]): Node {
  return forms.length === 1 ? forms[0]! : { list: [SYM.begin, ...forms] };
}

const isElse = (n: Node): boolean => isAtom(n) && !n.str && n.atom === "else";
const isWildcard = (n: Node): boolean => isAtom(n) && !n.str && (n.atom === "else" || n.atom === "_");
const isPlainSymbolAtom = (n: Node | undefined): n is Atom => {
  if (!isAtom(n) || n.str) return false;
  const s = n.atom;
  if (s === "." || s.startsWith("#") || s.startsWith(":")) return false;
  if (isNumber(n) || isBool(n)) return false;
  return true;
};

function expandMatch(
  orig: ListNode,
  list: Node[],
  byVariant: ReadonlyMap<string, VariantClauseMeta>,
): Node | DesugarErrorMeta {
  if (list.length < 3) {
    return {
      slug: "match-shape",
      message: "`match` requires a target expression and at least one `(pattern body...)` clause.",
    };
  }
  const targetExpr = list[1]!;
  const rawClauses = list.slice(2);

  type ParsedClause =
    | {
        readonly kind: "variant";
        readonly variantName: string;
        readonly tag: string;
        readonly vMeta: VariantClauseMeta | undefined;
        readonly patVars: readonly Atom[];
        readonly bodyForms: Node[];
        readonly span?: readonly [number, number];
      }
    | {
        readonly kind: "catch-all";
        readonly bindVar: Atom | null;
        readonly bodyForms: Node[];
        readonly span?: readonly [number, number];
      };

  const parsed: ParsedClause[] = [];
  const covered = new Set<string>();
  let family: VariantClauseMeta | undefined;
  let hasCatchAll = false;

  for (const c of rawClauses) {
    if (!isList(c) || c.list.length < 2) {
      return {
        slug: "match-shape",
        message: "each `match` clause must be `(pattern body...)` with at least one body expression.",
      };
    }
    const pat = c.list[0]!;
    const bodyForms = c.list.slice(1);
    if (isWildcard(pat)) {
      hasCatchAll = true;
      parsed.push({ kind: "catch-all", bindVar: null, bodyForms, span: c.span });
      continue;
    }
    if (isPlainSymbolAtom(pat)) {
      const vMeta = byVariant.get(pat.atom);
      if (vMeta !== undefined) {
        if (vMeta.fields.length !== 0) {
          return {
            slug: "match-arity",
            message: `match: variant \`${vMeta.variantName}\` expects ${vMeta.fields.length} field pattern${vMeta.fields.length === 1 ? "" : "s"} (${vMeta.fields.map((f) => f.name).join(", ")}), got 0.`,
          };
        }
        family ??= vMeta;
        covered.add(vMeta.variantName);
        parsed.push({
          kind: "variant",
          variantName: vMeta.variantName,
          tag: vMeta.tag,
          vMeta,
          patVars: [],
          bodyForms,
          span: c.span,
        });
      } else {
        hasCatchAll = true;
        parsed.push({ kind: "catch-all", bindVar: pat, bodyForms, span: c.span });
      }
      continue;
    }
    if (isList(pat) && pat.list.length >= 1 && isPlainSymbolAtom(pat.list[0])) {
      const headAtom = pat.list[0]!;
      const variantName = headAtom.atom;
      const patVars: Atom[] = [];
      for (const pv of pat.list.slice(1)) {
        if (!isPlainSymbolAtom(pv)) {
          return {
            slug: "match-shape",
            message: `match pattern variable in \`(${variantName} ...)\` must be a plain symbol.`,
          };
        }
        patVars.push(pv);
      }
      const vMeta = byVariant.get(variantName);
      if (vMeta !== undefined) {
        if (patVars.length !== vMeta.fields.length) {
          return {
            slug: "match-arity",
            message: `match: variant \`${variantName}\` expects ${vMeta.fields.length} field pattern${vMeta.fields.length === 1 ? "" : "s"} (${vMeta.fields.map((f) => f.name).join(", ")}), got ${patVars.length}.`,
          };
        }
        family ??= vMeta;
      }
      covered.add(variantName);
      parsed.push({
        kind: "variant",
        variantName,
        tag: vMeta ? vMeta.tag : variantTagOf(variantName),
        vMeta,
        patVars,
        bodyForms,
        span: c.span,
      });
      continue;
    }
    return {
      slug: "match-shape",
      message: "match pattern must be `(VariantName var...)`, `else`, or `_`.",
    };
  }

  if (family !== undefined && !hasCatchAll) {
    const missing = family.allVariants.filter((v) => !covered.has(v));
    if (missing.length > 0) {
      return {
        slug: "non-exhaustive-match",
        message: `non-exhaustive match on ${family.typeName}: missing variant${missing.length === 1 ? "" : "s"} ${missing.join(", ")}`,
      };
    }
  }

  const targetIsAtom = isPlainSymbolAtom(targetExpr);
  const targetRef: Atom = targetIsAtom ? { atom: targetExpr.atom } : { atom: "__match_target" };
  const targetAtomName = targetIsAtom ? targetExpr.atom : undefined;

  const buildClauseArm = (clause: ParsedClause): Node => {
    if (clause.kind === "catch-all") {
      if (clause.bindVar !== null) {
        return {
          ...(clause.span ? { span: clause.span } : {}),
          list: [SYM.let, { list: [{ list: [clause.bindVar, targetRef] }] }, ...clause.bodyForms],
        };
      }
      return body(clause.bodyForms);
    }
    const bindings: Node[] = [];
    for (let i = 0; i < clause.patVars.length; i++) {
      const pv = clause.patVars[i]!;
      if (pv.atom === "_") continue;
      const fieldMeta = clause.vMeta?.fields[i];
      const fieldName = fieldMeta ? fieldMeta.name : pv.atom;
      const fieldAccess: AnnotatedListNode = {
        ...(pv.span ? { span: pv.span } : {}),
        list: [{ atom: `:${fieldName}` }, targetRef],
        ...(clause.vMeta && fieldMeta
          ? {
              variantFieldAccess: {
                typeName: clause.vMeta.typeName,
                typeParams: clause.vMeta.typeParams,
                variantName: clause.variantName,
                tag: clause.tag,
                fieldName,
                fieldTsType: fieldMeta.tsType,
                ...(targetAtomName ? { targetAtom: targetAtomName } : {}),
              },
            }
          : {}),
      };
      bindings.push({
        ...(pv.span ? { span: pv.span } : {}),
        list: [pv, fieldAccess],
      });
    }
    if (bindings.length === 0) {
      return body(clause.bodyForms);
    }
    return {
      ...(clause.span ? { span: clause.span } : {}),
      list: [SYM.let, { list: bindings }, ...clause.bodyForms],
    };
  };

  const buildClauseGuard = (clause: Extract<ParsedClause, { kind: "variant" }>): Node => {
    const kindAccess: AnnotatedListNode = {
      list: [SYM.kindKw, targetRef],
      ...(clause.vMeta
        ? {
            variantFieldAccess: {
              typeName: clause.vMeta.typeName,
              typeParams: clause.vMeta.typeParams,
              variantName: clause.variantName,
              tag: clause.tag,
              fieldName: "kind",
              fieldTsType: JSON.stringify(clause.tag),
              ...(targetAtomName ? { targetAtom: targetAtomName } : {}),
            },
          }
        : {}),
    };
    return {
      list: [SYM.equalQ, kindAccess, { list: [SYM.quote, { atom: clause.tag }] }],
    };
  };

  let chain: Node;
  if (parsed.length === 1) {
    const only = parsed[0]!;
    const arm = buildClauseArm(only);
    chain = only.kind === "catch-all" ? arm : { list: [SYM.if, buildClauseGuard(only), arm, arm] };
  } else {
    chain = buildClauseArm(parsed[parsed.length - 1]!);
    for (let i = parsed.length - 2; i >= 0; i--) {
      const c = parsed[i]!;
      const arm = buildClauseArm(c);
      if (c.kind === "catch-all") {
        chain = arm;
      } else {
        chain = {
          ...(orig.span ? { span: orig.span } : {}),
          list: [SYM.if, buildClauseGuard(c), arm, chain],
        };
      }
    }
  }

  if (targetIsAtom) {
    return chain;
  }
  return {
    ...(orig.span ? { span: orig.span } : {}),
    list: [SYM.let, { list: [{ list: [targetRef, targetExpr] }] }, chain],
  };
}

/**
 * `(cond (t1 e1…) (t2 e2…) (else e…))` → nested `(if t1 e1 (if t2 e2 e))`, built right-to-left.
 * Nested `if` lowers to a chained ternary downstream, so a `cond` is an expression — no
 * statement-position needed. Matches the bootstrap `cond` macro for the `(test body…)` +
 * `else` clause forms; the rarer `=>` / bare-`(test)` clauses (used by no example) return
 * `undefined` so the caller leaves the form intact for classify() to door — never a silent
 * mis-expansion (adaptation; the source chunk threw here).
 */
function expandCond(clauses: Node[]): Node | undefined {
  let acc: Node | undefined;
  for (let i = clauses.length - 1; i >= 0; i--) {
    const c = clauses[i];
    if (!isList(c) || c.list.length === 0) continue;
    const test = c.list[0]!;
    if (isElse(test)) {
      acc = body(c.list.slice(1));
      continue;
    }
    if (c.list.length === 1 || (isAtom(c.list[1]) && !(c.list[1] as Atom).str && (c.list[1] as Atom).atom === "=>")) {
      return undefined; // `=>` / bare-test clause — unexpandable, classify() doors the form
    }
    const e = body(c.list.slice(1));
    acc = acc === undefined ? { list: [SYM.if, test, e] } : { list: [SYM.if, test, e, acc] };
  }
  return acc ?? { atom: "undefined" };
}

/** Keep `n`'s span on a replacement node when the replacement is a list; pass atoms through. */
function withSpan(n: ListNode, replacement: Node): Node {
  return isList(replacement) ? { ...n, list: replacement.list } : replacement;
}

/**
 * Threading macros (Clojure/Racket positional — NOT a `_` placeholder). Thread `x` through
 * each step, inserting it as the FIRST arg (`->`/`~>`) or LAST arg (`->>`/`~>>`). A bare
 * symbol step `f` becomes `(f x)`; a call step `(f a b)` becomes `(f x a b)` / `(f a b x)`.
 * The result is an inline nested call — exactly what the bootstrap macro produces, so the
 * view matches execution.
 */
function thread(x: Node | undefined, forms: Node[], where: "first" | "last"): Node {
  if (x === undefined) return { list: [] };
  return forms.reduce<Node>((acc, form) => {
    if (!isList(form)) return { list: [form, acc] }; // bare `f` / `:kw` → (f acc)
    return where === "first"
      ? { list: [form.list[0]!, acc, ...form.list.slice(1)] } // (f a b) → (f acc a b)
      : { list: [...form.list, acc] }; // (f a b) → (f a b acc)
  }, x);
}

/**
 * `(compose f g h)` / `(pipe f g h)` → `(lambda (it) (f (g (h it))))` (compose, right-to-left)
 * or `(lambda (it) (h (g (f it))))` (pipe, left-to-right). Returns the lambda node's `.list`.
 * NESTING (rather than calling a runtime `compose`) keeps every function — including keyword
 * accessors — in head position, so `(compose :state last :versions)` lowers cleanly to
 * `(it) => last(it.versions).state` instead of erroring on a bare `:versions`. Faithful for
 * the unary pipelines `compose` is always used for here.
 */
function composeLambda(fns: Node[], dir: "right-to-left" | "left-to-right"): Node[] {
  const param: Atom = { atom: "it" };
  const ref: Atom = { atom: "it" };
  const wrap = (acc: Node, fn: Node): Node => ({ list: [fn, acc] });
  const body = dir === "left-to-right" ? fns.reduce(wrap, ref as Node) : fns.reduceRight(wrap, ref as Node);
  return [{ atom: "lambda" }, { list: [param] }, body];
}

/**
 * `(cut proc a <> b <>)` → `(lambda (a-slot b-slot) (proc a a-slot b b-slot))` — the `.list`
 * of a lambda node. One param per `<>` hole, filled left-to-right; non-slot items (already
 * expanded) pass through untouched. Slot naming matches the former emit-time lowerers exactly
 * (`it` for a single hole, then `a b c d e f`), so the projected output is byte-identical —
 * `cut` is just visible to the earlier passes now.
 */
function cutLambda(expandedCutList: Node[]): Node[] {
  const items = expandedCutList.slice(1);
  const isSlot = (x: Node): boolean => isAtom(x) && !x.str && x.atom === "<>";
  const names = items.filter(isSlot).length === 1 ? ["it"] : ["a", "b", "c", "d", "e", "f"];
  const slots: Atom[] = [];
  const fill = (x: Node): Node => {
    if (!isSlot(x)) return x;
    const g: Atom = { atom: names[slots.length] ?? `arg${slots.length + 1}` };
    slots.push(g);
    return g;
  };
  const call: ListNode = { list: items.map(fill) };
  return [{ atom: "lambda" }, { list: slots }, call];
}
