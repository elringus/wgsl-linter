import type { Diagnostic } from "./diagnostic.ts";
import type { Tokens } from "./lexer.ts";

/**
 * Kinds of the syntax tree nodes. The comments list the children in order;
 * `?` marks an optional child, `*` repeated children.
 */
export enum Node {
    /** Directives and declarations. */
    Module,
    /** Unparsable input; the expected node is missing or malformed. */
    Error,
    /** Placeholder of an absent optional part, such as a `for` header clause. */
    Empty,
    /** Name*; the token is `enable`. */
    Enable,
    /** Name*; the token is `requires`. */
    Requires,
    /** Name (severity), Rule; the token is `diagnostic`. */
    Directive,
    /** Name, Name? (category and name); the token is the first name. */
    Rule,
    /** A declared or context-dependent name; the token is the identifier. */
    Name,
    /** Expression* or Name, Rule for `diagnostic`; the token is the name after `@`. */
    Attribute,
    /** Expression*; the template list of `var`. */
    Template,
    /** Expression; the explicit type of a declaration. */
    Type,
    /** Attribute*, Name, StructMember*. */
    Struct,
    /** Attribute*, Name, Type. */
    StructMember,
    /** Name, Type. */
    Alias,
    /** Attribute*, Name, Param*, Result?, Block. */
    Function,
    /** Attribute*, Name, Type. */
    Param,
    /** Attribute*, Expression; the declared return type. */
    Result,
    /** Attribute*, Template?, Name, Type?, Expression?. */
    Var,
    /** Attribute*, Name, Type?, Expression?. */
    Let,
    /** Attribute*, Name, Type?, Expression?. */
    Const,
    /** Attribute*, Name, Type?, Expression?. */
    Override,
    /** Expression. */
    ConstAssert,
    /** Attribute*, Statement*. */
    Block,
    /** Expression?. */
    Return,
    /** Attribute*, Expression, Block, (If | Block)?. */
    If,
    /** Attribute*, Expression, Attribute* (body), Case*. */
    Switch,
    /** (Expression | Default)*, Block. */
    Case,
    /** The `default` case selector. */
    Default,
    /** Attribute*, Block; the body block may end with Continuing. */
    Loop,
    /** Block; the block may end with BreakIf. */
    Continuing,
    /** Expression. */
    BreakIf,
    /** Attribute*, (Statement | Empty), (Expression | Empty), (Statement | Empty), Block. */
    For,
    /** Attribute*, Expression, Block. */
    While,
    Break,
    Continue,
    Discard,
    /** Expression | Phony, Expression; the token is the assignment operator. */
    Assign,
    /** Expression; the token is `++` or `--`. */
    IncDec,
    /** The `_` left-hand side of a phony assignment. */
    Phony,
    /** Expression* (template arguments); the token is the identifier. */
    Ident,
    /** Ident, Expression* (arguments). */
    Call,
    /** The token is the literal. */
    Literal,
    /** Expression. */
    Paren,
    /** Expression; the token is the operator. */
    Unary,
    /** Expression, Expression; the token is the operator. */
    Binary,
    /** Expression, Expression (index). */
    Index,
    /** Expression; the token is the member name. */
    Member,
}

/** Syntax tree of a source text with the nodes stored in flat arrays; the root node is 0. */
export interface Tree {
    readonly text: string;
    readonly tokens: Tokens;
    readonly count: number;
    readonly kinds: Uint8Array;
    readonly starts: Uint32Array;
    readonly ends: Uint32Array;
    /** Main token of the node, see {@link Node}. */
    readonly tokenOf: Uint32Array;
    readonly parents: Uint32Array;
    /** First child of the node, or 0 when it has no children. */
    readonly firsts: Uint32Array;
    /** Next sibling of the node, or 0 when it's the last child. */
    readonly nexts: Uint32Array;
    /** Syntax errors, in source order. */
    readonly diagnostics: readonly Diagnostic[];
}

/** Returns the source text of the node's main token. */
export function tokenText(tree: Tree, node: number): string {
    const token = tree.tokenOf[node]!;
    return tree.text.slice(tree.tokens.starts[token], tree.tokens.ends[token]);
}

/** Returns the first child of the node with the kind, or 0. */
export function childOf(tree: Tree, node: number, kind: Node): number {
    for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!)
        if (tree.kinds[child] === kind) return child;
    return 0;
}

/** Returns the n-th child of the node, or 0. */
export function nthChild(tree: Tree, node: number, n: number): number {
    let child = tree.firsts[node]!;
    while (child && n-- > 0) child = tree.nexts[child]!;
    return child;
}

/** Returns the first child of the node that is not an attribute, or 0. */
export function skipAttributes(tree: Tree, node: number): number {
    let child = tree.firsts[node]!;
    while (child && tree.kinds[child] === Node.Attribute) child = tree.nexts[child]!;
    return child;
}

/** Returns the expression following the declaration's name and type: its initializer, or 0. */
export function initializerOf(tree: Tree, decl: number): number {
    let child = childOf(tree, decl, Node.Name);
    if (!child) return 0;
    child = tree.nexts[child]!;
    if (child && tree.kinds[child] === Node.Type) child = tree.nexts[child]!;
    return child;
}

/** Returns the type expression of the declaration, or 0 when it's not explicitly typed. */
export function typeOf(tree: Tree, decl: number): number {
    const type = childOf(tree, decl, tree.kinds[decl] === Node.Function ? Node.Result : Node.Type);
    return type ? lastChild(tree, type) : 0;
}

/** Returns the last child of the node, or 0. */
export function lastChild(tree: Tree, node: number): number {
    let last = 0;
    for (let child = tree.firsts[node]!; child; child = tree.nexts[child]!) last = child;
    return last;
}

/** Returns the source text of the node's declared name, or empty when it's missing. */
export function nameOf(tree: Tree, decl: number): string {
    const name = childOf(tree, decl, Node.Name);
    return name ? tokenText(tree, name) : "";
}

/** Whether the node is an expression. */
export function isExpression(kind: Node): boolean {
    return kind >= Node.Ident || kind === Node.Error;
}
