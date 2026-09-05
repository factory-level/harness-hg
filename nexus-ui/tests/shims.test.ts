// The plugin bundle's react shims re-export the HOST's React (src/shims/).
// These tests stand a real React behind the SDK global and prove the shim
// surface behaves like the real modules where it matters: jsx key
// handling, children-through-props, and the portal object shape.
import { describe, expect, test } from "bun:test";
import * as RealReact from "react";

// The SDK global is planted by tests/preload.ts before any module loads.
const { jsx, jsxs, Fragment } = await import("../src/shims/jsx-runtime");
const shimReact = await import("../src/shims/react");
const { createPortal, createRoot } = await import("../src/shims/react-dom");

describe("react shim", () => {
  test("re-exports the host instance's hooks and createElement", () => {
    expect(shimReact.useState).toBe(RealReact.useState);
    expect(shimReact.createElement).toBe(RealReact.createElement);
    expect(shimReact.default.version).toBe(RealReact.version);
  });
  test("covers every named import Astryx's compiled dist uses", () => {
    for (const name of [
      "Children", "createContext", "createElement", "Fragment", "isValidElement", "lazy",
      "memo", "Suspense", "use", "useCallback", "useEffect", "useId", "useImperativeHandle",
      "useInsertionEffect", "useLayoutEffect", "useMemo", "useOptimistic", "useRef",
      "useState", "useSyncExternalStore", "useTransition",
    ]) {
      expect((shimReact as Record<string, unknown>)[name], name).toBeDefined();
    }
  });
});

describe("jsx-runtime shim", () => {
  test("jsx without key produces a real element with children via props", () => {
    const el = jsx("div", { className: "a", children: "hi" }) as RealReact.ReactElement;
    expect(RealReact.isValidElement(el)).toBe(true);
    expect(el.key).toBeNull();
    expect((el.props as { className: string }).className).toBe("a");
  });
  test("jsx threads the key argument through", () => {
    const el = jsx("li", { children: "x" }, "k1") as RealReact.ReactElement;
    expect(el.key).toBe("k1");
  });
  test("jsxs and Fragment are wired", () => {
    const el = jsxs(Fragment, { children: [jsx("i", {}, "a"), jsx("i", {}, "b")] });
    expect(RealReact.isValidElement(el)).toBe(true);
  });
});

describe("react-dom shim", () => {
  test("createPortal returns the portal object shape the host reconciler expects", () => {
    const target = {};
    const p = createPortal("child", target, null, "pk") as Record<string, unknown>;
    expect(p["$$typeof"]).toBe(Symbol.for("react.portal"));
    expect(p["containerInfo"]).toBe(target);
    expect(p["key"]).toBe("pk");
  });
  test("createRoot throws - the host owns the root", () => {
    expect(() => createRoot()).toThrow(/host-only/);
  });
});
