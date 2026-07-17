// Valence kit — the shared design-system layer.
// Import from "@/components/kit"; never hardcode colors or px sizes in views.

export { TONE, TONE_INK, toneMix, cssToken, type Tone } from "./tokens";
export {
  cx, Dot, Pill, StatusPill, StatusChip, TypeTag, NoteChip, Action, IconButton,
  Stat, KV, Empty, Skeleton,
  ErrorState, Clamp, PageHeader, SectionLabel, Card, TabBar, RowList, RowItem,
} from "./core";
export {
  type StateHue, rowHueClass, Readout, Chip, Pips, Hint, EyebrowHeader,
} from "./anatomy";
export { AssayRow } from "./AssayRow";
export { Modal, ConfirmModal, Drawer, Overlay, OverlayTabs } from "./modal";
export { Menu, type MenuItem } from "./menu";
export { toast, Toaster, type Toast } from "./toast";
