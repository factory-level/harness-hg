// Hover surface: status/badge popovers. Keeps the two contracts the old
// implementation proved (single-open registry + 260ms close grace, #401)
// but renders through Astryx Popover - top layer, anchor-positioned,
// collision-handled - instead of in-tree absolute positioning.
import { React } from "../sdk";
import { Popover } from "@astryxdesign/core";

const GRACE_MS = 260;

// One hover surface open at a time, app-wide. Context (not module scope -
// the anti-pattern list bans module-scope state): provided by AppShell.
export const HoverRegistry = React.createContext<{ claim: (close: () => void) => void }>({
  claim: () => {},
});

export function createHoverRegistry(): { claim: (close: () => void) => void } {
  let current: (() => void) | null = null;
  return {
    claim(close) {
      if (current && current !== close) current();
      current = close;
    },
  };
}

export interface HoverPopoverProps {
  content: unknown;
  label: string;
  children: (props: {
    /** Astryx's anchor ref - MUST land on the trigger element, or the
     * popover has nothing to position against and opens at the viewport
     * origin. */
    ref: (el: HTMLElement | null) => void;
    onMouseEnter: () => void;
    onMouseLeave: () => void;
    onFocus: () => void;
    onBlur: () => void;
  }) => unknown;
}

export function HoverPopover({ content, label, children }: HoverPopoverProps) {
  const [open, setOpen] = React.useState(false);
  const timer = React.useRef<ReturnType<typeof setTimeout> | null>(null);
  const registry = React.useContext(HoverRegistry);

  const show = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    registry.claim(() => setOpen(false));
    setOpen(true);
  }, [registry]);

  const hide = React.useCallback(() => {
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setOpen(false), GRACE_MS);
  }, []);

  React.useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  return (
    <Popover
      isOpen={open}
      onOpenChange={setOpen}
      placement="end"
      label={label}
      content={content as React.ReactNode}
      // A hover surface is PASSIVE: it must not grab focus (that blurs
      // the trigger and fights the grace timer) or grow a close button.
      hasAutoFocus={false}
      hasCloseButton={false}
      isModal={false}
    >
      {(trigger: { ref: (el: HTMLElement | null) => void }) =>
        children({ ref: trigger.ref, onMouseEnter: show, onMouseLeave: hide, onFocus: show, onBlur: hide }) as React.ReactElement}
    </Popover>
  );
}
