// THE layer-model file (#667): the one place stacking is decided. The
// style-gates test fails any z-index/zIndex literal outside this file and
// the generated theme.
//
// Two stacking domains exist, deliberately:
//
// 1. FLOATING surfaces (drawers, dialogs, popovers, menus, tooltips,
//    toasts) ride the browser's native TOP LAYER via Astryx's Layer
//    system (Popover API + <dialog>). The top layer paints above every
//    z-index by definition and orders by promotion, so these surfaces
//    carry NO z-index at all - requesting one is the anti-pattern this
//    file exists to kill. Dismissal/focus come from the primitives.
//
// 2. IN-PAGE tiers - the canvas world and the docked chrome - use the
//    named scale below, emitted by gen-theme from design/tokens.json as
//    --nx-z-* custom properties. A component requests a NAME, never a
//    number.
//
// The legacy hover/menu/modal tiers stay in the token scale so ported
// styles keep resolving during the migration; new code must not request
// them - use the floating primitives instead.

export const PAGE_LAYERS = [
  "world",
  "world-content",
  "object",
  "object-active",
  "fixture",
  "badge",
  "panel",
  "chrome",
] as const;

export type PageLayer = (typeof PAGE_LAYERS)[number];

/** The only sanctioned way to put a stacking value in a style: by name. */
export function layerVar(layer: PageLayer): string {
  return `var(--nx-z-${layer})`;
}
