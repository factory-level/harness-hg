// The primitive catalog barrel (#667) - see design/PRIMITIVES.md for the
// name/purpose/usage table. Astryx-composed primitives are re-exported
// here so screens import from ONE place and the catalog stays the honest
// inventory of what exists.
export { Drawer } from "./Drawer";
export type { DrawerProps } from "./Drawer";
export { HoverPopover, HoverRegistry, createHoverRegistry } from "./HoverPopover";
export { ConfirmBar } from "./ConfirmBar";
export type { ConfirmBarProps } from "./ConfirmBar";
export { HealthDot, StatusPill, StatusWord, OwnershipSphere } from "./health";
export { AgentAvatar, Face, RingsMark, abbrOf } from "./mark";
export { Icon } from "./Icon";
export type { IconName } from "./Icon";
export type { HealthLevel, SaveState } from "./health";
export { layerVar, PAGE_LAYERS } from "../layers";
export type { PageLayer } from "../layers";
// Astryx passthroughs - themed by the tokens.json astryxBridge, consumed
// as-is. Screens NEVER import @astryxdesign/core directly.
export {
  Button,
  ButtonGroup,
  IconButton,
  Card,
  Badge,
  Item,
  TabList,
  Tab,
  Popover,
  Tooltip,
  DropdownMenu,
  ContextMenu,
  Banner,
  EmptyState,
  TextInput,
  Switch,
  ToggleButton,
  ToggleButtonGroup,
  Toolbar,
  LayerProvider,
  useToast,
} from "@astryxdesign/core";
