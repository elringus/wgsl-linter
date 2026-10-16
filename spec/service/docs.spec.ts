import { describe, expect, it } from "vite-plus/test";
import { builtinValues } from "../../src/semantic/interface.ts";
import { builtinFunctionNames } from "../../src/semantic/overloads.ts";
import { functions, values } from "../../src/service/docs.ts";

describe("docs", () => {
    it("describe every builtin function", () => {
        expect(builtinFunctionNames().filter(name => !functions[name])).toEqual([]);
    });

    it("describe every builtin value", () => {
        expect([...builtinValues.keys()].filter(name => !values[name])).toEqual([]);
    });
});
