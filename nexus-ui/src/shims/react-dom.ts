// react-dom shim for the plugin bundle. createPortal is a plain portal-
// object constructor (no reconciler involved) - reimplemented verbatim so
// the host React renders it. createRoot must never run inside the plugin
// (the host owns the root); it throws with a legible message.
const REACT_PORTAL_TYPE = Symbol.for("react.portal");
export function createPortal(children: unknown, containerInfo: unknown, implementation: unknown = null, key: unknown = null) {
  return {
    $$typeof: REACT_PORTAL_TYPE,
    key: key == null ? null : String(key),
    children,
    containerInfo,
    implementation,
  };
}
export function createRoot(): never {
  throw new Error("nexus-ui plugin bundle: createRoot is host-only; the plugin renders inside the host tree");
}
export function flushSync<T>(fn: () => T): T {
  return fn();
}
export default { createPortal, createRoot, flushSync };
