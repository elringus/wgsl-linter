/** Kinds of the lexical tokens. */
export enum Tok {
    EOF,
    Invalid,
    Ident,
    Int,
    IntI,
    IntU,
    Float,
    FloatF,
    FloatH,

    Alias,
    Break,
    Case,
    Const,
    ConstAssert,
    Continue,
    Continuing,
    Default,
    Diagnostic,
    Discard,
    Else,
    Enable,
    False,
    Fn,
    For,
    If,
    Let,
    Loop,
    Override,
    Requires,
    Return,
    Struct,
    Switch,
    True,
    Var,
    While,

    And,
    AndAnd,
    Arrow,
    At,
    Slash,
    Bang,
    BracketLeft,
    BracketRight,
    BraceLeft,
    BraceRight,
    Colon,
    Comma,
    Equal,
    EqualEqual,
    NotEqual,
    Greater,
    GreaterEqual,
    ShiftRight,
    Less,
    LessEqual,
    ShiftLeft,
    Percent,
    Minus,
    MinusMinus,
    Period,
    Plus,
    PlusPlus,
    Or,
    OrOr,
    ParenLeft,
    ParenRight,
    Semicolon,
    Star,
    Tilde,
    Underscore,
    Xor,
    PlusEqual,
    MinusEqual,
    StarEqual,
    SlashEqual,
    PercentEqual,
    AndEqual,
    OrEqual,
    XorEqual,
    ShiftRightEqual,
    ShiftLeftEqual,
    TemplateStart,
    TemplateEnd,
}

export const keywords: ReadonlyMap<string, Tok> = new Map([
    ["alias", Tok.Alias],
    ["break", Tok.Break],
    ["case", Tok.Case],
    ["const", Tok.Const],
    ["const_assert", Tok.ConstAssert],
    ["continue", Tok.Continue],
    ["continuing", Tok.Continuing],
    ["default", Tok.Default],
    ["diagnostic", Tok.Diagnostic],
    ["discard", Tok.Discard],
    ["else", Tok.Else],
    ["enable", Tok.Enable],
    ["false", Tok.False],
    ["fn", Tok.Fn],
    ["for", Tok.For],
    ["if", Tok.If],
    ["let", Tok.Let],
    ["loop", Tok.Loop],
    ["override", Tok.Override],
    ["requires", Tok.Requires],
    ["return", Tok.Return],
    ["struct", Tok.Struct],
    ["switch", Tok.Switch],
    ["true", Tok.True],
    ["var", Tok.Var],
    ["while", Tok.While],
]);

export const reserved: ReadonlySet<string> = new Set(
    (
        "NULL Self abstract active alignas alignof as asm asm_fragment async attribute auto await " +
        "become cast catch class co_await co_return co_yield coherent column_major common compile " +
        "compile_fragment concept const_cast consteval constexpr constinit crate debugger decltype " +
        "delete demote demote_to_helper do dynamic_cast enum explicit export extends extern external " +
        "fallthrough filter final finally friend from fxgroup get goto groupshared highp impl " +
        "implements import inline instanceof interface layout lowp macro macro_rules match mediump " +
        "meta mod module move mut mutable namespace new nil noexcept noinline nointerpolation " +
        "non_coherent noncoherent noperspective null nullptr of operator package packoffset " +
        "partition pass patch pixelfragment precise precision premerge priv protected pub public " +
        "readonly ref regardless register reinterpret_cast require resource restrict self set " +
        "shared sizeof smooth snorm static static_assert static_cast std subroutine super target " +
        "template this thread_local throw trait try type typedef typeid typename typeof union " +
        "unless unorm unsafe unsized use using varying virtual volatile wgsl where with writeonly " +
        "yield"
    ).split(" "),
);

const spellings: Partial<Record<Tok, string>> = {
    [Tok.EOF]: "end of file",
    [Tok.Ident]: "identifier",
    [Tok.And]: "&",
    [Tok.AndAnd]: "&&",
    [Tok.Arrow]: "->",
    [Tok.At]: "@",
    [Tok.Slash]: "/",
    [Tok.Bang]: "!",
    [Tok.BracketLeft]: "[",
    [Tok.BracketRight]: "]",
    [Tok.BraceLeft]: "{",
    [Tok.BraceRight]: "}",
    [Tok.Colon]: ":",
    [Tok.Comma]: ",",
    [Tok.Equal]: "=",
    [Tok.EqualEqual]: "==",
    [Tok.NotEqual]: "!=",
    [Tok.Greater]: ">",
    [Tok.GreaterEqual]: ">=",
    [Tok.ShiftRight]: ">>",
    [Tok.Less]: "<",
    [Tok.LessEqual]: "<=",
    [Tok.ShiftLeft]: "<<",
    [Tok.Percent]: "%",
    [Tok.Minus]: "-",
    [Tok.MinusMinus]: "--",
    [Tok.Period]: ".",
    [Tok.Plus]: "+",
    [Tok.PlusPlus]: "++",
    [Tok.Or]: "|",
    [Tok.OrOr]: "||",
    [Tok.ParenLeft]: "(",
    [Tok.ParenRight]: ")",
    [Tok.Semicolon]: ";",
    [Tok.Star]: "*",
    [Tok.Tilde]: "~",
    [Tok.Underscore]: "_",
    [Tok.Xor]: "^",
    [Tok.PlusEqual]: "+=",
    [Tok.MinusEqual]: "-=",
    [Tok.StarEqual]: "*=",
    [Tok.SlashEqual]: "/=",
    [Tok.PercentEqual]: "%=",
    [Tok.AndEqual]: "&=",
    [Tok.OrEqual]: "|=",
    [Tok.XorEqual]: "^=",
    [Tok.ShiftRightEqual]: ">>=",
    [Tok.ShiftLeftEqual]: "<<=",
    [Tok.TemplateStart]: "<",
    [Tok.TemplateEnd]: ">",
};

for (const [word, tok] of keywords) spellings[tok] = word;

/** Returns the human-readable spelling of the token kind for the diagnostic messages. */
export function spell(tok: Tok): string {
    return spellings[tok] ?? "literal";
}

/** Whether the token is a keyword, including the boolean literals. */
export function isKeyword(tok: Tok): boolean {
    return tok >= Tok.Alias && tok <= Tok.While;
}

/** Whether the token is spelled like an identifier: an identifier or a keyword. */
export function isWord(tok: Tok): boolean {
    return tok === Tok.Ident || isKeyword(tok);
}

/** Whether the token is a numeric literal. */
export function isNumber(tok: Tok): boolean {
    return tok >= Tok.Int && tok <= Tok.FloatH;
}
