import type { Diagnostic } from "./diagnostic.ts";
import { lex, type Tokens } from "./lexer.ts";
import { isWord, reserved, spell, Tok } from "./token.ts";
import { Node, type Tree } from "./tree.ts";

/** Maximum nesting of statements and expressions, guarding the recursive passes. */
const maxDepth = 512;

/** Parses the text into a syntax tree, recovering from the syntax errors. */
export function parse(text: string): Tree {
    return new Parser(text).parse();
}

class Parser {
    private readonly text: string;
    private readonly diagnostics: Diagnostic[] = [];
    private readonly tokens: Tokens;
    private readonly tk: Uint8Array;
    private readonly ts: Uint32Array;
    private readonly te: Uint32Array;
    private pos = 0;
    private panic = false;
    private depth = 0;

    private capacity: number;
    private count = 0;
    private kinds: Uint8Array;
    private starts: Uint32Array;
    private ends: Uint32Array;
    private tokenOf: Uint32Array;
    private parents: Uint32Array;
    private firsts: Uint32Array;
    private nexts: Uint32Array;
    private lasts: Uint32Array;

    constructor(text: string) {
        this.text = text;
        this.tokens = lex(text, this.diagnostics);
        this.tk = this.tokens.kinds;
        this.ts = this.tokens.starts;
        this.te = this.tokens.ends;
        this.capacity = this.tokens.count + 16;
        this.kinds = new Uint8Array(this.capacity);
        this.starts = new Uint32Array(this.capacity);
        this.ends = new Uint32Array(this.capacity);
        this.tokenOf = new Uint32Array(this.capacity);
        this.parents = new Uint32Array(this.capacity);
        this.firsts = new Uint32Array(this.capacity);
        this.nexts = new Uint32Array(this.capacity);
        this.lasts = new Uint32Array(this.capacity);
    }

    parse(): Tree {
        this.module();
        if (this.diagnostics.length > 1) this.diagnostics.sort((a, b) => a.start - b.start);
        return {
            text: this.text,
            tokens: this.tokens,
            count: this.count,
            kinds: this.kinds,
            starts: this.starts,
            ends: this.ends,
            tokenOf: this.tokenOf,
            parents: this.parents,
            firsts: this.firsts,
            nexts: this.nexts,
            diagnostics: this.diagnostics,
        };
    }

    // ---- module ----

    private module(): void {
        const root = this.open(Node.Module);
        let declared = false;
        while (this.peek() !== Tok.EOF) {
            const k = this.peek();
            if (k === Tok.Enable || k === Tok.Requires || k === Tok.Diagnostic) {
                const start = this.pos;
                this.add(root, this.directive());
                if (declared)
                    this.errorAt(start, "directives must come before all global declarations");
            } else {
                const start = this.pos;
                const decl = this.globalDecl();
                if (decl) {
                    this.add(root, decl);
                    declared = true;
                } else if (this.pos === start && k !== Tok.Semicolon) {
                    this.error(this.pos, "unexpected token");
                    this.next();
                }
            }
            if (this.panic) this.recoverGlobal();
        }
        this.starts[root] = 0;
        this.ends[root] = this.text.length;
    }

    private directive(): number {
        const k = this.peek();
        const node = this.open(
            k === Tok.Enable ? Node.Enable : k === Tok.Requires ? Node.Requires : Node.Directive,
        );
        this.next();
        if (k === Tok.Diagnostic) this.diagnosticControl(node);
        else {
            if (this.peek() === Tok.ParenLeft)
                this.error(
                    this.pos,
                    `${k === Tok.Enable ? "enable" : "requires"} directives don't take parenthesis`,
                );
            else
                do {
                    this.add(node, this.name());
                    if (!this.match(Tok.Comma)) break;
                } while (this.peek() !== Tok.Semicolon && !this.panic);
        }
        this.expect(Tok.Semicolon);
        return this.close(node);
    }

    private diagnosticControl(node: number): void {
        if (!this.expect(Tok.ParenLeft)) return;
        this.add(node, this.name());
        this.expect(Tok.Comma);
        const rule = this.open(Node.Rule);
        this.add(rule, this.name());
        if (this.match(Tok.Period)) this.add(rule, this.name());
        this.add(node, this.close(rule));
        this.match(Tok.Comma);
        this.expect(Tok.ParenRight);
    }

    private globalDecl(): number {
        if (this.match(Tok.Semicolon)) return 0;
        const attrs = this.attributes();
        let node = 0;
        switch (this.peek()) {
            case Tok.Var:
                node = this.varDecl(attrs);
                this.expect(Tok.Semicolon);
                break;
            case Tok.Const:
            case Tok.Override:
                node = this.valueDecl(attrs);
                this.expect(Tok.Semicolon);
                break;
            case Tok.Fn:
                return this.fnDecl(attrs);
            case Tok.Struct:
                this.noAttributes(attrs);
                return this.structDecl(attrs);
            case Tok.Alias:
                this.noAttributes(attrs);
                node = this.aliasDecl();
                this.expect(Tok.Semicolon);
                break;
            case Tok.ConstAssert:
                this.noAttributes(attrs);
                node = this.constAssert();
                this.expect(Tok.Semicolon);
                break;
            default:
                if (attrs.length > 0) this.error(this.pos, "expected declaration after attributes");
                else if (this.startsStatement(this.peek()))
                    this.error(this.pos, "statement found outside of function body");
                return 0;
        }
        return this.close(node);
    }

    private noAttributes(attrs: number[]): void {
        if (attrs.length > 0) this.errorNode(attrs[0]!, "unexpected attributes");
    }

    private attributes(): number[] {
        const attrs: number[] = [];
        while (this.peek() === Tok.At) attrs.push(this.attribute());
        return attrs;
    }

    private attribute(): number {
        const node = this.open(Node.Attribute);
        this.next();
        if (!isWord(this.peek())) {
            this.error(this.pos, "expected attribute name");
            return this.close(node);
        }
        this.tokenOf[node] = this.pos;
        const diagnostic = this.peek() === Tok.Diagnostic;
        this.next();
        if (diagnostic) this.diagnosticControl(node);
        else if (this.match(Tok.ParenLeft)) this.list(node, Tok.ParenRight);
        return this.close(node);
    }

    private varDecl(attrs: number[]): number {
        const node = this.openWith(Node.Var, attrs);
        this.next();
        if (this.peek() === Tok.TemplateStart) {
            const template = this.open(Node.Template);
            this.templateList(template);
            this.add(node, this.close(template));
        }
        this.typedName(node);
        if (this.match(Tok.Equal)) this.add(node, this.expression());
        return node;
    }

    private valueDecl(attrs: number[]): number {
        const k = this.peek();
        const node = this.openWith(
            k === Tok.Const ? Node.Const : k === Tok.Let ? Node.Let : Node.Override,
            attrs,
        );
        this.next();
        this.typedName(node);
        if (k === Tok.Override ? this.match(Tok.Equal) : this.expect(Tok.Equal))
            this.add(node, this.expression());
        return node;
    }

    private typedName(node: number): void {
        this.add(node, this.name());
        if (this.match(Tok.Colon)) this.add(node, this.typeAnnotation());
    }

    private typeAnnotation(): number {
        const node = this.open(Node.Type);
        this.add(node, this.type());
        return this.close(node);
    }

    private type(): number {
        if (this.peek() !== Tok.Ident) return this.missing("expected type");
        return this.ident();
    }

    private aliasDecl(): number {
        const node = this.open(Node.Alias);
        this.next();
        this.add(node, this.name());
        this.expect(Tok.Equal);
        this.add(node, this.typeAnnotation());
        return node;
    }

    private constAssert(): number {
        const node = this.open(Node.ConstAssert);
        this.next();
        this.add(node, this.expression());
        return node;
    }

    private structDecl(attrs: number[]): number {
        const node = this.openWith(Node.Struct, attrs);
        this.next();
        this.add(node, this.name());
        if (this.expect(Tok.BraceLeft)) {
            while (this.peek() !== Tok.BraceRight && this.peek() !== Tok.EOF) {
                const member = this.openWith(Node.StructMember, this.attributes());
                this.add(member, this.name());
                this.expect(Tok.Colon);
                this.add(member, this.typeAnnotation());
                this.add(node, this.close(member));
                if (!this.match(Tok.Comma)) break;
            }
            this.expect(Tok.BraceRight);
        }
        return this.close(node);
    }

    private fnDecl(attrs: number[]): number {
        const node = this.openWith(Node.Function, attrs);
        this.next();
        this.add(node, this.name());
        if (this.expect(Tok.ParenLeft)) {
            while (this.peek() !== Tok.ParenRight && this.peek() !== Tok.EOF) {
                const param = this.openWith(Node.Param, this.attributes());
                this.add(param, this.name());
                this.expect(Tok.Colon);
                this.add(param, this.typeAnnotation());
                this.add(node, this.close(param));
                if (!this.match(Tok.Comma)) break;
            }
            this.expect(Tok.ParenRight);
        }
        if (this.peek() === Tok.Arrow) {
            const result = this.open(Node.Result);
            this.next();
            this.addAll(result, this.attributes());
            this.add(result, this.type());
            this.add(node, this.close(result));
        }
        this.add(node, this.block([]));
        return this.close(node);
    }

    private name(): number {
        if (this.peek() !== Tok.Ident) {
            this.error(this.pos, "expected identifier");
            return 0;
        }
        const node = this.open(Node.Name);
        const text = this.text.slice(this.ts[this.pos], this.te[this.pos]);
        if (reserved.has(text)) this.error(this.pos, `'${text}' is a reserved keyword`);
        this.next();
        return this.close(node);
    }

    // ---- statements ----

    private block(attrs: number[]): number {
        const node = this.openWith(Node.Block, attrs);
        if (this.expect(Tok.BraceLeft)) {
            this.statements(node, false);
            this.expect(Tok.BraceRight);
        }
        return this.close(node);
    }

    private statements(parent: number, continuing: boolean): void {
        while (true) {
            const k = this.peek();
            if (k === Tok.BraceRight || k === Tok.EOF || isGlobalKeyword(k) || k === Tok.Continuing)
                break;
            const start = this.pos;
            const node =
                continuing && k === Tok.Break && this.peekAt(1) === Tok.If
                    ? this.breakIf()
                    : this.statement();
            this.add(parent, node);
            if (this.panic) this.recoverStatement();
            if (this.pos === start) this.next();
        }
    }

    private statement(): number {
        if (!this.enter()) return 0;
        const node = this.statementInner();
        this.depth--;
        return node;
    }

    private statementInner(): number {
        const attrs = this.attributes();
        let node: number;
        switch (this.peek()) {
            case Tok.Semicolon:
                this.noAttributes(attrs);
                this.next();
                return 0;
            case Tok.BraceLeft:
                return this.block(attrs);
            case Tok.If:
                return this.ifStatement(attrs);
            case Tok.Switch:
                return this.switchStatement(attrs);
            case Tok.Loop:
                return this.loopStatement(attrs);
            case Tok.For:
                return this.forStatement(attrs);
            case Tok.While:
                return this.whileStatement(attrs);
            case Tok.Return:
                node = this.open(Node.Return);
                this.next();
                if (this.startsExpression(this.peek())) this.add(node, this.expression());
                break;
            case Tok.Var:
                node = this.varDecl([]);
                break;
            case Tok.Let:
            case Tok.Const:
                node = this.valueDecl([]);
                break;
            case Tok.Break:
                node = this.open(Node.Break);
                this.next();
                break;
            case Tok.Continue:
                node = this.open(Node.Continue);
                this.next();
                break;
            case Tok.Discard:
                node = this.open(Node.Discard);
                this.next();
                break;
            case Tok.ConstAssert:
                node = this.constAssert();
                break;
            default:
                if (!this.startsExpression(this.peek()) && this.peek() !== Tok.Underscore) {
                    this.error(
                        this.pos,
                        attrs.length > 0
                            ? "expected statement after attributes"
                            : "expected statement",
                    );
                    return 0;
                }
                node = this.updating();
        }
        this.noAttributes(attrs);
        this.expect(Tok.Semicolon);
        return this.close(node);
    }

    private updating(): number {
        const k = this.peek();
        if (k === Tok.Ident && this.peekAt(1) === Tok.Colon) {
            this.error(this.pos, "expected 'var' for variable declaration");
            return this.missing("");
        }
        if (k === Tok.PlusPlus || k === Tok.MinusMinus) {
            this.error(this.pos, "prefix increment and decrement operators are not supported");
            return this.missing("");
        }
        let lhs: number;
        if (k === Tok.Underscore) {
            lhs = this.open(Node.Phony);
            this.next();
            this.close(lhs);
        } else {
            lhs = this.unary();
            const op = this.peek();
            if (op === Tok.PlusPlus || op === Tok.MinusMinus) {
                const node = this.wrap(Node.IncDec, lhs);
                this.next();
                return this.close(node);
            }
            if (!isAssignment(op) && this.kinds[lhs] === Node.Call) return lhs;
        }
        const node = this.wrap(Node.Assign, lhs);
        if (isAssignment(this.peek()) && (k !== Tok.Underscore || this.peek() === Tok.Equal))
            this.next();
        else this.error(this.pos, "expected '=' for assignment");
        this.add(node, this.expression());
        return this.close(node);
    }

    private ifStatement(attrs: number[]): number {
        const node = this.openWith(Node.If, attrs);
        this.next();
        this.add(node, this.expression());
        this.add(node, this.block(this.attributes()));
        if (this.match(Tok.Else)) {
            if (this.peek() === Tok.If) {
                if (this.enter()) {
                    this.add(node, this.ifStatement([]));
                    this.depth--;
                }
            } else this.add(node, this.block(this.attributes()));
        }
        return this.close(node);
    }

    private switchStatement(attrs: number[]): number {
        const node = this.openWith(Node.Switch, attrs);
        this.next();
        this.add(node, this.expression());
        this.addAll(node, this.attributes());
        if (this.expect(Tok.BraceLeft)) {
            while (this.peek() === Tok.Case || this.peek() === Tok.Default) {
                const clause = this.open(Node.Case);
                if (this.peek() === Tok.Default) {
                    const selector = this.open(Node.Default);
                    this.next();
                    this.add(clause, this.close(selector));
                } else {
                    this.next();
                    do {
                        if (this.peek() === Tok.Default) {
                            const selector = this.open(Node.Default);
                            this.next();
                            this.add(clause, this.close(selector));
                        } else if (this.startsExpression(this.peek()))
                            this.add(clause, this.expression());
                        else {
                            this.error(this.pos, "expected case selector expression or 'default'");
                            break;
                        }
                    } while (
                        this.match(Tok.Comma) &&
                        this.peek() !== Tok.Colon &&
                        this.peek() !== Tok.BraceLeft
                    );
                }
                this.match(Tok.Colon);
                this.add(clause, this.block(this.attributes()));
                this.add(node, this.close(clause));
                if (this.panic) this.recoverStatement();
            }
            this.expect(Tok.BraceRight);
        }
        return this.close(node);
    }

    private loopStatement(attrs: number[]): number {
        const node = this.openWith(Node.Loop, attrs);
        this.next();
        const body = this.openWith(Node.Block, this.attributes());
        if (this.expect(Tok.BraceLeft)) {
            this.statements(body, false);
            if (this.peek() === Tok.Continuing) {
                const continuing = this.open(Node.Continuing);
                this.next();
                const block = this.openWith(Node.Block, this.attributes());
                if (this.expect(Tok.BraceLeft)) {
                    this.statements(block, true);
                    this.expect(Tok.BraceRight);
                }
                this.add(continuing, this.close(block));
                this.add(body, this.close(continuing));
            }
            this.expect(Tok.BraceRight);
        }
        this.add(node, this.close(body));
        return this.close(node);
    }

    private breakIf(): number {
        const node = this.open(Node.BreakIf);
        this.next();
        this.next();
        this.add(node, this.expression());
        this.expect(Tok.Semicolon);
        return this.close(node);
    }

    private forStatement(attrs: number[]): number {
        const node = this.openWith(Node.For, attrs);
        this.next();
        if (this.expect(Tok.ParenLeft)) {
            const k = this.peek();
            if (k === Tok.Var) this.add(node, this.close(this.varDecl([])));
            else if (k === Tok.Let || k === Tok.Const)
                this.add(node, this.close(this.valueDecl([])));
            else if (this.startsExpression(k) || k === Tok.Underscore)
                this.add(node, this.updating());
            else this.add(node, this.empty());
            this.expect(Tok.Semicolon);
            this.add(node, this.startsExpression(this.peek()) ? this.expression() : this.empty());
            this.expect(Tok.Semicolon);
            const u = this.peek();
            this.add(
                node,
                this.startsExpression(u) || u === Tok.Underscore ? this.updating() : this.empty(),
            );
            this.expect(Tok.ParenRight);
        }
        this.add(node, this.block(this.attributes()));
        return this.close(node);
    }

    private whileStatement(attrs: number[]): number {
        const node = this.openWith(Node.While, attrs);
        this.next();
        this.add(node, this.expression());
        this.add(node, this.block(this.attributes()));
        return this.close(node);
    }

    // ---- expressions ----

    private expression(): number {
        if (!this.startsExpression(this.peek())) return this.missing("expected expression");
        const lhs = this.unary();
        const op = this.peek();
        let result: number;
        if (op === Tok.And || op === Tok.Or || op === Tok.Xor) {
            result = lhs;
            while (this.peek() === op) result = this.binary(result);
        } else {
            result = this.relationalPost(lhs);
            const logical = this.peek();
            if (logical === Tok.AndAnd || logical === Tok.OrOr)
                while (this.peek() === logical) {
                    const node = this.wrap(Node.Binary, result);
                    this.next();
                    this.add(node, this.relational());
                    result = this.close(node);
                }
        }
        if (this.kinds[result] === Node.Binary && isBinaryOperator(this.peek())) {
            const first = spell(this.tk[this.tokenOf[result]!] as Tok);
            this.error(
                this.pos,
                `mixing '${first}' and '${spell(this.peek())}' requires parenthesis`,
            );
        }
        return result;
    }

    private relational(): number {
        if (!this.startsExpression(this.peek())) return this.missing("expected expression");
        return this.relationalPost(this.unary());
    }

    private relationalPost(lhs: number): number {
        const result = this.shiftPost(lhs);
        const op = this.peek();
        if (
            op !== Tok.Less &&
            op !== Tok.Greater &&
            op !== Tok.LessEqual &&
            op !== Tok.GreaterEqual &&
            op !== Tok.EqualEqual &&
            op !== Tok.NotEqual
        )
            return result;
        const node = this.wrap(Node.Binary, result);
        this.next();
        const rhs = this.startsExpression(this.peek())
            ? this.shiftPost(this.unary())
            : this.missing("expected expression");
        this.add(node, rhs);
        return this.close(node);
    }

    private shiftPost(lhs: number): number {
        const op = this.peek();
        if (op === Tok.ShiftLeft || op === Tok.ShiftRight) return this.binary(lhs);
        return this.additivePost(this.multiplicativePost(lhs));
    }

    private multiplicativePost(lhs: number): number {
        for (
            let op = this.peek();
            op === Tok.Star || op === Tok.Slash || op === Tok.Percent;
            op = this.peek()
        )
            lhs = this.binary(lhs);
        return lhs;
    }

    private additivePost(lhs: number): number {
        for (
            let op = this.peek();
            op === Tok.Plus || op === Tok.Minus || op === Tok.MinusMinus;
            op = this.peek()
        ) {
            const node = this.wrap(Node.Binary, lhs);
            this.next();
            let rhs: number;
            if (op === Tok.MinusMinus) {
                rhs = this.openAt(Node.Unary, this.pos - 1);
                this.starts[rhs]++;
                this.add(rhs, this.unaryOperand());
                this.close(rhs);
            } else rhs = this.unaryOperand();
            this.add(node, this.multiplicativePost(rhs));
            lhs = this.close(node);
        }
        return lhs;
    }

    private binary(lhs: number): number {
        const node = this.wrap(Node.Binary, lhs);
        this.next();
        this.add(node, this.unaryOperand());
        return this.close(node);
    }

    private unaryOperand(): number {
        if (!this.startsExpression(this.peek())) return this.missing("expected expression");
        return this.unary();
    }

    private unary(): number {
        const k = this.peek();
        if (k === Tok.PlusPlus) {
            this.error(this.pos, "prefix increment and decrement operators are not supported");
            return this.missing("");
        }
        if (!isUnaryOperator(k)) return this.singular();
        if (!this.enter()) return this.missing("");
        const node = this.open(Node.Unary);
        this.next();
        if (k === Tok.MinusMinus || k === Tok.AndAnd) {
            const inner = this.openAt(Node.Unary, this.pos - 1);
            this.starts[inner]++;
            this.add(inner, this.unaryOperand());
            this.add(node, this.close(inner));
        } else this.add(node, this.unaryOperand());
        this.depth--;
        return this.close(node);
    }

    private singular(): number {
        let node = this.primary();
        while (true) {
            const k = this.peek();
            if (k === Tok.BracketLeft) {
                const index = this.wrap(Node.Index, node);
                this.next();
                this.add(index, this.expression());
                this.expect(Tok.BracketRight);
                node = this.close(index);
            } else if (k === Tok.Period) {
                const member = this.wrap(Node.Member, node);
                this.next();
                if (this.peek() === Tok.Ident) {
                    this.tokenOf[member] = this.pos;
                    this.next();
                } else this.error(this.pos, "expected identifier");
                node = this.close(member);
            } else return node;
        }
    }

    private primary(): number {
        const k = this.peek();
        if ((k >= Tok.Int && k <= Tok.FloatH) || k === Tok.True || k === Tok.False) {
            const node = this.open(Node.Literal);
            this.next();
            return this.close(node);
        }
        if (k === Tok.Ident) {
            const ident = this.ident();
            if (this.peek() !== Tok.ParenLeft) return ident;
            const call = this.wrap(Node.Call, ident);
            this.next();
            this.list(call, Tok.ParenRight);
            return this.close(call);
        }
        if (k === Tok.ParenLeft) {
            if (!this.enter()) return this.missing("");
            const node = this.open(Node.Paren);
            this.next();
            this.add(node, this.expression());
            this.expect(Tok.ParenRight);
            this.depth--;
            return this.close(node);
        }
        return this.missing("expected expression");
    }

    private ident(): number {
        const node = this.open(Node.Ident);
        this.next();
        if (this.peek() === Tok.TemplateStart) this.templateList(node);
        return this.close(node);
    }

    /** Parses a template list of at least one expression, starting at its opening token. */
    private templateList(parent: number): void {
        this.next();
        if (this.peek() === Tok.TemplateEnd) this.add(parent, this.missing("expected expression"));
        this.list(parent, Tok.TemplateEnd);
    }

    /** Parses comma-separated expressions with an optional trailing comma, then the closing token. */
    private list(parent: number, close: Tok): void {
        while (this.peek() !== close && this.peek() !== Tok.EOF) {
            this.add(parent, this.expression());
            if (!this.match(Tok.Comma)) break;
        }
        this.expect(close);
    }

    private startsExpression(k: Tok): boolean {
        return (
            k === Tok.Ident ||
            (k >= Tok.Int && k <= Tok.FloatH) ||
            k === Tok.True ||
            k === Tok.False ||
            k === Tok.ParenLeft ||
            k === Tok.Minus ||
            k === Tok.MinusMinus ||
            k === Tok.Bang ||
            k === Tok.Tilde ||
            k === Tok.Star ||
            k === Tok.And ||
            k === Tok.AndAnd ||
            k === Tok.PlusPlus
        );
    }

    private startsStatement(k: Tok): boolean {
        return isStatementKeyword(k) || this.startsExpression(k) || k === Tok.BraceLeft;
    }

    // ---- recovery ----

    private recoverGlobal(): void {
        let nesting = 0;
        for (let k = this.peek(); k !== Tok.EOF; k = this.peek()) {
            if (nesting === 0) {
                if (isGlobalKeyword(k) || k === Tok.Var || k === Tok.Const || k === Tok.At) break;
                if (k === Tok.Semicolon) {
                    this.next();
                    break;
                }
            }
            if (k === Tok.BraceLeft || k === Tok.ParenLeft || k === Tok.BracketLeft) nesting++;
            else if (
                (k === Tok.BraceRight || k === Tok.ParenRight || k === Tok.BracketRight) &&
                nesting > 0
            ) {
                nesting--;
                if (nesting === 0 && k === Tok.BraceRight) {
                    this.next();
                    break;
                }
            }
            this.next();
        }
        this.panic = false;
    }

    private recoverStatement(): void {
        let nesting = 0;
        for (let k = this.peek(); k !== Tok.EOF; k = this.peek()) {
            if (nesting === 0) {
                if (k === Tok.Semicolon) {
                    this.next();
                    break;
                }
                if (
                    k === Tok.BraceRight ||
                    isStatementKeyword(k) ||
                    isGlobalKeyword(k) ||
                    k === Tok.Case ||
                    k === Tok.Default
                )
                    break;
            }
            if (k === Tok.BraceLeft || k === Tok.ParenLeft || k === Tok.BracketLeft) nesting++;
            else if (k === Tok.BraceRight || k === Tok.ParenRight || k === Tok.BracketRight) {
                if (nesting > 0) nesting--;
                if (nesting === 0 && k === Tok.BraceRight) {
                    this.next();
                    break;
                }
            }
            this.next();
        }
        this.panic = false;
    }

    // ---- tokens ----

    private peek(): Tok {
        return this.tk[this.pos] as Tok;
    }

    private peekAt(offset: number): Tok {
        return this.tk[Math.min(this.pos + offset, this.tokens.count - 1)] as Tok;
    }

    private next(): void {
        if (this.pos < this.tokens.count - 1) this.pos++;
    }

    private match(k: Tok): boolean {
        if (this.peek() !== k) return false;
        this.next();
        return true;
    }

    private expect(k: Tok): boolean {
        if (this.peek() === k) {
            this.next();
            this.panic = false;
            return true;
        }
        this.error(this.pos, `expected '${spell(k)}'`);
        return false;
    }

    private enter(): boolean {
        if (this.depth < maxDepth) {
            this.depth++;
            return true;
        }
        this.error(this.pos, "maximum nesting depth reached");
        return false;
    }

    private error(token: number, message: string): void {
        if (this.panic) return;
        this.panic = true;
        this.diagnostics.push({
            start: this.ts[token]!,
            end: this.te[token]!,
            severity: "error",
            message,
        });
    }

    private errorAt(token: number, message: string): void {
        this.diagnostics.push({
            start: this.ts[token]!,
            end: this.te[token]!,
            severity: "error",
            message,
        });
    }

    private errorNode(node: number, message: string): void {
        this.diagnostics.push({
            start: this.starts[node]!,
            end: this.ends[node]!,
            severity: "error",
            message,
        });
    }

    // ---- nodes ----

    private open(kind: Node): number {
        return this.openAt(kind, this.pos);
    }

    private openAt(kind: Node, token: number): number {
        if (this.count === this.capacity) this.grow();
        const node = this.count++;
        this.kinds[node] = kind;
        this.starts[node] = this.ends[node] = this.ts[token]!;
        this.tokenOf[node] = token;
        return node;
    }

    /** Opens the node at the current token, starting it at the first attribute. */
    private openWith(kind: Node, attrs: number[]): number {
        const node = this.open(kind);
        if (attrs.length > 0) this.starts[node] = this.starts[attrs[0]!]!;
        this.addAll(node, attrs);
        return node;
    }

    private close(node: number): number {
        const end = this.pos > 0 ? this.te[this.pos - 1]! : 0;
        if (end > this.starts[node]!) this.ends[node] = end;
        return node;
    }

    private wrap(kind: Node, child: number): number {
        const node = this.open(kind);
        this.starts[node] = this.starts[child]!;
        this.add(node, child);
        return node;
    }

    private missing(message: string): number {
        if (message) this.error(this.pos, message);
        const node = this.open(Node.Error);
        this.ends[node] = this.starts[node]!;
        return node;
    }

    private empty(): number {
        const node = this.open(Node.Empty);
        this.ends[node] = this.starts[node]!;
        return node;
    }

    private add(parent: number, child: number): void {
        if (!child) return;
        this.parents[child] = parent;
        if (this.firsts[parent]) this.nexts[this.lasts[parent]!] = child;
        else this.firsts[parent] = child;
        this.lasts[parent] = child;
    }

    private addAll(parent: number, children: number[]): void {
        for (const child of children) this.add(parent, child);
    }

    private grow(): void {
        this.capacity *= 2;
        const grow = <T extends Uint8Array | Uint32Array>(from: T, to: T): T => {
            to.set(from);
            return to;
        };
        this.kinds = grow(this.kinds, new Uint8Array(this.capacity));
        this.starts = grow(this.starts, new Uint32Array(this.capacity));
        this.ends = grow(this.ends, new Uint32Array(this.capacity));
        this.tokenOf = grow(this.tokenOf, new Uint32Array(this.capacity));
        this.parents = grow(this.parents, new Uint32Array(this.capacity));
        this.firsts = grow(this.firsts, new Uint32Array(this.capacity));
        this.nexts = grow(this.nexts, new Uint32Array(this.capacity));
        this.lasts = grow(this.lasts, new Uint32Array(this.capacity));
    }
}

function isGlobalKeyword(k: Tok): boolean {
    return (
        k === Tok.Fn ||
        k === Tok.Struct ||
        k === Tok.Alias ||
        k === Tok.Override ||
        k === Tok.Enable ||
        k === Tok.Requires ||
        k === Tok.Diagnostic
    );
}

function isStatementKeyword(k: Tok): boolean {
    return (
        k === Tok.Let ||
        k === Tok.Var ||
        k === Tok.Const ||
        k === Tok.Return ||
        k === Tok.If ||
        k === Tok.Switch ||
        k === Tok.Loop ||
        k === Tok.For ||
        k === Tok.While ||
        k === Tok.Break ||
        k === Tok.Continue ||
        k === Tok.Discard ||
        k === Tok.ConstAssert
    );
}

function isUnaryOperator(k: Tok): boolean {
    return (
        k === Tok.Minus ||
        k === Tok.MinusMinus ||
        k === Tok.Bang ||
        k === Tok.Tilde ||
        k === Tok.Star ||
        k === Tok.And ||
        k === Tok.AndAnd
    );
}

function isAssignment(k: Tok): boolean {
    return k === Tok.Equal || (k >= Tok.PlusEqual && k <= Tok.ShiftLeftEqual);
}

function isBinaryOperator(k: Tok): boolean {
    switch (k) {
        case Tok.And:
        case Tok.AndAnd:
        case Tok.EqualEqual:
        case Tok.NotEqual:
        case Tok.Slash:
        case Tok.Greater:
        case Tok.GreaterEqual:
        case Tok.Less:
        case Tok.LessEqual:
        case Tok.Minus:
        case Tok.Percent:
        case Tok.Or:
        case Tok.OrOr:
        case Tok.Plus:
        case Tok.ShiftLeft:
        case Tok.ShiftRight:
        case Tok.Star:
        case Tok.Xor:
            return true;
        default:
            return false;
    }
}
