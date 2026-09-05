// Automatic-runtime shim over the host React: library code compiled with
// the automatic JSX runtime resolves react/jsx-runtime here.
import { SDK } from "../sdk";
const R = (SDK?.React ?? {}) as typeof import("react");
export const Fragment = R.Fragment;
export function jsx(type: unknown, props: Record<string, unknown> | null, key?: unknown) {
  return R.createElement(type as never, key === undefined ? props : { ...props, key: key as never });
}
export const jsxs = jsx;
export const jsxDEV = (type: unknown, props: Record<string, unknown> | null, key?: unknown) => jsx(type, props, key);
