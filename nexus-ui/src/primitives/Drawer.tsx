// The ONE right-drawer primitive (#667): every detail surface - agent
// detail, alert evidence, backup routine, capability panel - is this
// component with different content. Composes Astryx Dialog: native
// <dialog> in the top layer, so focus trapping, Escape, backdrop and
// restore-on-close come from the platform, not from bespoke geometry.
import { React } from "../sdk";
import { Dialog, DialogHeader } from "@astryxdesign/core";
import "./primitives.css";

export interface DrawerProps {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  children?: unknown;
}

export function Drawer({ open, onClose, title, subtitle, children }: DrawerProps) {
  return (
    <Dialog
      isOpen={open}
      onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose();
      }}
      className="nx-drawer"
      purpose="info"
    >
      <DialogHeader title={title} subtitle={subtitle} onOpenChange={(isOpen: boolean) => {
        if (!isOpen) onClose();
      }} />
      {children as React.ReactNode}
    </Dialog>
  );
}
