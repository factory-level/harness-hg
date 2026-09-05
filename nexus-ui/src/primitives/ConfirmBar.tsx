// ConfirmBar: THE destructive-confirmation grammar - a warning Banner
// with a keep/confirm pair, never window.confirm (a native dialog blocks
// the page and looks like nothing else here). The workspace conflict
// banner is the same shape; sheet deletion is the first caller by name.
// Non-modal on purpose: the canvas stays visible so the operator can see
// what the confirmation is about.
import { React } from "../sdk";
import { Banner, Button, ButtonGroup } from "@astryxdesign/core";

export interface ConfirmBarProps {
  title: string;
  description: string;
  confirmLabel: string;
  cancelLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}

export function ConfirmBar({ title, description, confirmLabel, cancelLabel = "Keep", onConfirm, onCancel }: ConfirmBarProps) {
  return (
    <Banner
      status="warning"
      title={title}
      description={description}
      endContent={
        <ButtonGroup label={title} size="sm">
          <Button label={cancelLabel} onClick={onCancel} />
          <Button variant="destructive" label={confirmLabel} onClick={onConfirm} />
        </ButtonGroup>
      }
    />
  );
}
