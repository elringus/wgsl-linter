# WebGPU Conformance

The analyzer is checked against the [WebGPU conformance test suite](https://github.com/gpuweb/cts) (CTS): `bun run cts [query...]` fetches the suite into `cts/suite` and runs its WGSL validation tests with the analyzer standing in for the shader compiler.

## Results

As of the suite commit [`e325d0b`](https://github.com/gpuweb/cts/commit/e325d0b) (2026-10-15):

- **WGSL validation** (`webgpu:shader,validation,*`): 47,410 of 47,535 tests pass (99.74%); 124 are skipped and 1 fails.
- **Const-evaluation accuracy**: all 949 tests pass, each checking the const cases of a CTS execution test.

### Skipped

The suite skips these tests itself, as they don't apply to Chrome's feature set:

| Tests | Reason                                                                                                                  |
| ----: | ----------------------------------------------------------------------------------------------------------------------- |
|    87 | Combinations the suite rules out: vertex outputs without `@builtin(position)`, read-only `bgra8unorm` storage textures. |
|    18 | Require the experimental `chromium-experimental-primitive-id` device feature.                                           |
|    16 | Cover `packed_4x8_integer_dot_product` being unsupported, while it is supported.                                        |
|     3 | Require the `fragment_depth` language feature, which Chrome doesn't support yet.                                        |

### Failing

`parse,requires:have_all_language_features:feature="fragment_depth"` expects every language feature known to the suite to be supported; Chrome doesn't support `fragment_depth` yet and fails it as well.

## Accuracy Check

[`accuracy.spec.ts`](accuracy.spec.ts) runs the CTS execution tests of the builtins and operators with stubs capturing their const cases, evaluates the inputs with the analyzer and checks the results lie within the expected intervals.

Generating the cases takes a few minutes, so you may want to run the accuracy check separately with `bun run cts accuracy`.
