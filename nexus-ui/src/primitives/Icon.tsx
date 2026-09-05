// Icon: the ONE glyph primitive. Every functional icon in the app is a
// lucide glyph drawn at a fixed box, one stroke weight, in currentColor -
// so the theme, tool-rail, chevron and arrow marks share an
// optical weight instead of whatever a system font has for U+2B1A.
// lucide-react already rides the tree through Astryx's neutral theme;
// promoting it to a direct dependency pins that. Names are a closed
// vocabulary: a screen asks for a MEANING (chevron-right, external),
// never a lucide export, so the drawing can change in one place.
import { React } from "../sdk";
import {
  ArrowLeft,
  ArrowRight,
  ArrowUpRight,
  AtSign,
  Bell,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  Circle,
  Diamond,
  GitBranch,
  LayoutGrid,
  Maximize,
  MessageSquare,
  Minus,
  Moon,
  Pause,
  Pencil,
  Pill,
  Play,
  Plus,
  Redo2,
  Settings,
  Shapes,
  Spline,
  Square,
  SquareDashed,
  StickyNote,
  Sun,
  Trash2,
  Type,
  Undo2,
  X,
} from "lucide-react";

const ICONS = {
  "arrow-left": ArrowLeft,
  "arrow-right": ArrowRight,
  external: ArrowUpRight,
  "chevron-down": ChevronDown,
  "chevron-left": ChevronLeft,
  "chevron-right": ChevronRight,
  check: Check,
  close: X,
  sun: Sun,
  moon: Moon,
  settings: Settings,
  undo: Undo2,
  redo: Redo2,
  add: Plus,
  "zoom-in": Plus,
  "zoom-out": Minus,
  fit: Maximize,
  insert: LayoutGrid,
  select: SquareDashed,
  note: StickyNote,
  shape: Shapes,
  // The armed shape tool's variants (one meaning per drawable region).
  "shape-rect": Square,
  "shape-ellipse": Circle,
  "shape-diamond": Diamond,
  "shape-pill": Pill,
  text: Type,
  connect: Spline,
  edit: Pencil,
  trash: Trash2,
  play: Play,
  pause: Pause,
  // The card badge domains (CardBadges.tsx).
  repositories: GitBranch,
  communication: MessageSquare,
  iam: AtSign,
  alerting: Bell,
} as const;

export type IconName = keyof typeof ICONS;

export function Icon({
  name,
  size = 16,
  label,
  className,
}: {
  name: IconName;
  /** Box size in px; the stroke stays 1.75 at every size. */
  size?: number;
  /** A label makes the glyph a named image; without one it is decoration
   * beside text and hidden from assistive tech. */
  label?: string;
  className?: string;
}) {
  const Glyph = ICONS[name];
  return (
    <Glyph
      className={className ? `nx-icon ${className}` : "nx-icon"}
      size={size}
      strokeWidth={1.75}
      absoluteStrokeWidth
      aria-hidden={label ? undefined : true}
      aria-label={label}
      role={label ? "img" : undefined}
      focusable="false"
    />
  );
}
