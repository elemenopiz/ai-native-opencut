import { describe, expect, it } from "bun:test";
import { runProgram } from "./executor";

/**
 * A SECOND, INDEPENDENT pass at the sandbox boundary, written by a different
 * author than the engine and its own `interpreter.test.ts`. The overlap with
 * that file is deliberate: on a security boundary, agreement between two
 * separately-written suites is worth more than either alone, and the cases
 * here that it does not already cover (reserved words used as call targets,
 * chained/computed calls, `eval`/`Function` reached as plain identifiers) are
 * exactly the spellings an author who knows their own grammar is least likely
 * to think to try against it.
 *
 * Every case asserts only `ok === false`. That is the point — the engine's
 * defence is that these have no spelling in the language at all, so WHICH
 * error fires is an implementation detail, while "it never runs" is contract.
 */
const ATTACKS: [string, string][] = [
  ["globalThis reach",        "log(globalThis)"],
  ["process reach",           "log(process)"],
  ["require reach",           "log(require(\"fs\"))"],
  ["fetch reach",             "log(fetch(\"http://x\"))"],
  ["ctor escape",             "let s = \"\"; log(s.constructor)"],
  ["proto literal key",       "let o = { __proto__: 1 }; log(o)"],
  ["proto index write",       "let o = {}; o[\"__proto__\"] = 1; log(o)"],
  ["ctor index read",         "let o = {}; log(o[\"constructor\"])"],
  ["prototype member",        "let o = {}; log(o.prototype)"],
  ["double call",             "let f = log; log(f()())"],
  ["array map callable",      "let a = [1]; log(a[\"map\"](log))"],
  ["while reserved",          "while (true) { log(1) }"],
  ["function reserved",       "function f() { log(1) }"],
  ["new reserved",            "log(new Object())"],
  ["import reserved",         "import(\"fs\")"],
  ["eval as name",            "log(eval(\"1\"))"],
  ["Function as name",        "log(Function(\"return 1\"))"],
];

describe("orchestrator adversarial probe", () => {
  for (const [name, source] of ATTACKS) {
    it(`refuses: ${name}`, () => {
      const r = runProgram({ source });
      expect(r.ok).toBe(false);
    });
  }

  it("Object.prototype is not polluted after an attempted write", () => {
    runProgram({ source: 'let o = {}; o["__proto__"] = { pwned: 1 };' });
    expect(({} as Record<string, unknown>).pwned).toBeUndefined();
  });

  it("an infinite loop terminates on a cap rather than hanging", () => {
    const r = runProgram({ source: "let i = 0; for (x of [1,2,3]) { i = i + 1 }", limits: { maxLoopIterations: 1 } });
    expect(r.ok).toBe(false);
  });

  it("defaults to dry-run (applies nothing without an explicit mode)", () => {
    const r = runProgram({ source: "log(1)" });
    expect(r.mode).toBe("dry-run");
  });
});
