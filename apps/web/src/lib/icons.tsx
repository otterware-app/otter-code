// Adapted from Synara (MIT); see THIRD_PARTY_NOTICES.md.
import { type CSSProperties, type FC, type SVGProps } from "react";
import { CentralIcon, type CentralIconVariant } from "./central-icons";
import {
  IconAlertCircle,
  IconAlertOctagon,
  IconAlertTriangle,
  IconArrowBackUp,
  IconArrowForwardUp,
  IconArrowDown,
  IconArrowLeft,
  IconArrowRight,
  IconArrowUp,
  IconArrowUpRight,
  IconBolt,
  IconBrain,
  IconBulb,
  IconBug,
  IconCamera,
  IconCheck,
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconChevronUp,
  IconCircleCheck,
  IconColumns2,
  IconDots,
  IconDownload,
  IconEye,
  IconFile,
  IconFlask2,
  IconHistory,
  IconInfoCircle,
  IconLayoutDistributeHorizontal,
  IconListCheck,
  IconListDetails,
  IconMinus,
  IconDeviceDesktop,
  IconMessageCircle,
  IconMoon,
  IconPaperclip,
  IconPlus,
  IconRefresh,
  IconRotate2,
  IconLayoutRows as IconRows3,
  IconStar,
  IconSun,
  IconTextWrap,
  IconTrash,
  IconX,
  type TablerIcon,
} from "@tabler/icons-react";

// Keep the existing icon API stable while the app moves from Lucide to Tabler.
export type LucideIcon = FC<SVGProps<SVGSVGElement>>;

function adaptIcon(Component: TablerIcon): LucideIcon {
  return function AdaptedIcon(props) {
    return <Component {...props} stroke={props.stroke ?? 1.5} />;
  };
}

// CSS masks avoid overlapping SVG strokes darkening shared vertices.
function centralIconWrapper(name: string, variant?: CentralIconVariant): LucideIcon {
  return function CentralIconWrapper({ className, style, ...rest }) {
    const ariaLabelRaw = (rest as { ["aria-label"]?: unknown })["aria-label"];
    const label = typeof ariaLabelRaw === "string" ? ariaLabelRaw : undefined;
    return (
      <CentralIcon
        name={name}
        variant={variant}
        className={typeof className === "string" ? className : undefined}
        style={style as CSSProperties | undefined}
        label={label}
      />
    );
  };
}

export const ContextCompactionIcon: LucideIcon = centralIconWrapper("arrows-hide");

export const WorkflowIcon: LucideIcon = centralIconWrapper("agents");

export const NewThreadIcon: LucideIcon = centralIconWrapper("compose-pencil");
export const FullAccessIcon: LucideIcon = centralIconWrapper("shield-access");

export const UsageGaugeIcon: LucideIcon = centralIconWrapper("gauge");

/** The "+" affordance behind every add/create action (Add project, activity header). */
export const AddPlusIcon: LucideIcon = centralIconWrapper("plus-medium");
/** 2x3 dot grip for drag-to-reorder handles (provider rows, sidebar nav customize). */
export const DragHandleIcon: LucideIcon = centralIconWrapper("dot-grid-2x3");

export const ArrowLeftIcon = adaptIcon(IconArrowLeft);
export const ArrowRightIcon = adaptIcon(IconArrowRight);
export const ArrowDownIcon = adaptIcon(IconArrowDown);
export const ArrowUpIcon = adaptIcon(IconArrowUp);
export const ArrowUpRightIcon = adaptIcon(IconArrowUpRight);

const AGENT_ROBOT_ICON_NAME = "robot-3";
export const BotIcon: LucideIcon = centralIconWrapper(AGENT_ROBOT_ICON_NAME);
export const BookOpenIcon: LucideIcon = centralIconWrapper("newspaper-2");
export const BugIcon = adaptIcon(IconBug);
export const CameraIcon = adaptIcon(IconCamera);
export const CheckIcon = adaptIcon(IconCheck);
export const ChevronDownIcon = adaptIcon(IconChevronDown);
export const ChevronLeftIcon = adaptIcon(IconChevronLeft);
export const ChevronRightIcon = adaptIcon(IconChevronRight);
export const ChevronUpIcon = adaptIcon(IconChevronUp);

export const CircleAlertIcon = adaptIcon(IconAlertCircle);
export const OctagonAlertIcon = adaptIcon(IconAlertOctagon);
export const CircleCheckIcon = adaptIcon(IconCircleCheck);

export const ArrowUpCircleIcon: LucideIcon = centralIconWrapper("arrow-up-circle");

export const Columns2Icon = adaptIcon(IconColumns2);

/** The one "Keybindings" glyph: the Help menu row, the feature tour, and (by basename) the
 *  Settings nav entry, so the three always match. */
const KEYBINDINGS_ICON_NAME = "shortcut";
export const KeyboardIcon: LucideIcon = centralIconWrapper(KEYBINDINGS_ICON_NAME);
const COPY_ICON_NAME = "square-behind-square-6";
export const CopyIcon = centralIconWrapper(COPY_ICON_NAME);
export const LightbulbIcon = adaptIcon(IconBulb);
export const LinkIcon = centralIconWrapper("chain-link-3");

export const DiffIcon = centralIconWrapper("difference-modified");
export const DownloadIcon = adaptIcon(IconDownload);

export const EllipsisIcon = adaptIcon(IconDots);
export const EyeIcon = adaptIcon(IconEye);
export const CodeIcon: LucideIcon = centralIconWrapper("code");

export const PaperclipIcon = adaptIcon(IconPaperclip);

export const BrainIcon = adaptIcon(IconBrain);
export const FileIcon = adaptIcon(IconFile);

export const FlaskConicalIcon = adaptIcon(IconFlask2);
export const GitCommitIcon: LucideIcon = centralIconWrapper("commits");
export const GitMergeIcon: LucideIcon = centralIconWrapper("merged");

export const IssueOpenedIcon: LucideIcon = centralIconWrapper("record");

// GitHub labels (the code review label filter).
export const TagIcon: LucideIcon = centralIconWrapper("tag");
// Two-person glyph for "reviewers"/"people" rows (pull request meta grid).
export const UsersIcon: LucideIcon = centralIconWrapper("user-group");
// One globe for the whole app (browser rows, web search, favicon fallback,
// local servers): the Central glyph, so it matches the other work-row icons.
export const GlobeIcon: LucideIcon = centralIconWrapper("globe");

// Handset glyph for the iOS Simulator dock pane.
export const DeviceMobileIcon: LucideIcon = centralIconWrapper("phone");

// Single hammer/build glyph (tool-call rows, codex provider, "build" scripts).
// Sourced from the Central set so it matches the other work-row icons (pencil,
// terminal, skill cube) it sits beside, instead of the Tabler wrench it used to be.
export const HammerIcon: LucideIcon = centralIconWrapper("hammer");
export const HistoryIcon = adaptIcon(IconHistory);

export const CalendarIcon: LucideIcon = centralIconWrapper("calendar-1");
export const InfoIcon = adaptIcon(IconInfoCircle);

export const ListChecksIcon = adaptIcon(IconListCheck);
export const ListTodoIcon = adaptIcon(IconListDetails);

export const MessageCircleIcon = adaptIcon(IconMessageCircle);
export const MinusIcon = adaptIcon(IconMinus);

export const PanelRightCloseIcon = centralIconWrapper("sidebar-simple-right-wide");

const PENCIL_ICON_NAME = "pencil";
export const PencilIcon: LucideIcon = centralIconWrapper(PENCIL_ICON_NAME);
const PIN_ICON_NAME = "pin";
export const PinIcon: LucideIcon = centralIconWrapper(PIN_ICON_NAME);

export const PlayIcon: LucideIcon = centralIconWrapper("play", "fill");

/** Outline trash can from the Central set (Trash2 is the legacy Tabler glyph). */
export const TrashCanIcon: LucideIcon = centralIconWrapper("trash-can");

export const Plus = adaptIcon(IconPlus);
export const PlusIcon = adaptIcon(IconPlus);
export const RefreshCwIcon = adaptIcon(IconRefresh);
export const RotateCcwIcon = adaptIcon(IconRotate2);
export const Rows3Icon = adaptIcon(IconLayoutDistributeHorizontal);
export const SearchIcon: LucideIcon = centralIconWrapper("magnifying-glass");
// Single source for the settings gear. Every settings affordance renders this
// one Central glyph so gears stay identical across the chrome.
export const SettingsIcon: LucideIcon = centralIconWrapper("settings-gear-4");
export const StarIcon = adaptIcon(IconStar);

export const SunIcon = adaptIcon(IconSun);
export const MoonIcon = adaptIcon(IconMoon);

export const MonitorIcon = adaptIcon(IconDeviceDesktop);

export const SquareSplitHorizontal: LucideIcon = (props) => (
  <IconColumns2 className={props.className} style={props.style} />
);
export const SquareSplitVertical: LucideIcon = (props) => (
  <IconRows3 className={props.className} style={props.style} />
);

export const TextWrapIcon = adaptIcon(IconTextWrap);
export const Trash2 = adaptIcon(IconTrash);
export const TriangleAlertIcon = adaptIcon(IconAlertTriangle);
export const Undo2Icon = adaptIcon(IconArrowBackUp);

export const Redo2Icon = adaptIcon(IconArrowForwardUp);
export const XIcon = adaptIcon(IconX);
export const ZapIcon = adaptIcon(IconBolt);

export {
  ClockHour7Icon as ClockIcon,
  Folder02Icon as FolderOpenIcon,
  FolderAddIcon,
  FolderClosedIcon as FolderIcon,
  FolderLibraryIcon as FoldersIcon,
  GitPullRequestClosedIcon,
  GitPullRequestDraftIcon,
  WorkflowCircle05Icon as GitBranchIcon,
  WorkflowCircle05Icon as GitForkIcon,
  GitCompareArrowsIcon as CodeReviewIcon,
  Home07Icon as HomeIcon,
  InboxIcon,
  MoreHorizontalIcon,
  LinkSquare02Icon as ExternalLinkIcon,
  SquareTerminalIcon as TerminalIcon,
} from "./hugeicons";
