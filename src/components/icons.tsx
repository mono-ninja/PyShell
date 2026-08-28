/**
 * Inline SVG icons.
 *
 * Emoji glyphs like U+1F5CE (🗎) render inconsistently across platforms and font
 * fallbacks — on macOS the file/folder ones came out as unrelated shapes — so
 * anything structural uses a real vector here. Script icons stay emoji because
 * those come from the manifest and are the author's choice.
 *
 * 16×16 grid, 1.5px stroke, `currentColor`, so an icon takes the colour and size
 * of whatever it sits in.
 */

interface IconProps {
  /** Pixel size; defaults to 16. */
  size?: number;
  class?: string;
}

function Svg({ size = 16, class: className = "", children }: IconProps & { children: preact.ComponentChildren }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      stroke-width="1.5"
      stroke-linecap="round"
      stroke-linejoin="round"
      class={`shrink-0 ${className}`}
      aria-hidden="true"
      focusable="false"
    >
      {children}
    </svg>
  );
}

export function FileIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M9.5 1.75H4.25a1 1 0 0 0-1 1v10.5a1 1 0 0 0 1 1h7.5a1 1 0 0 0 1-1V5.25z" />
      <path d="M9.25 1.9V5.5h3.5" />
    </Svg>
  );
}

export function FolderIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M1.75 4.25a1 1 0 0 1 1-1h3l1.5 1.75h5a1 1 0 0 1 1 1v6.75a1 1 0 0 1-1 1h-9.5a1 1 0 0 1-1-1z" />
    </Svg>
  );
}

export function SaveIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.75 2.75h8l2.5 2.5v8a.5.5 0 0 1-.5.5h-10a.5.5 0 0 1-.5-.5v-10a.5.5 0 0 1 .5-.5z" />
      <path d="M5 2.75v3.5h5v-3.5M5 13.25V9.5h6v3.75" />
    </Svg>
  );
}

export function LockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="3.25" y="7" width="9.5" height="7" rx="1" />
      <path d="M5.5 7V4.75a2.5 2.5 0 0 1 5 0V7" />
    </Svg>
  );
}

export function PlayIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5 3.5 12 8l-7 4.5z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function StopIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="4" y="4" width="8" height="8" rx="1.25" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function CloseIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M4 4l8 8M12 4l-8 8" />
    </Svg>
  );
}

export function BookIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2.25 3a1 1 0 0 1 1-1H7a1.5 1.5 0 0 1 1.5 1.5v10A1.25 1.25 0 0 0 7.25 12H2.25z" />
      <path d="M13.75 3a1 1 0 0 0-1-1H9.5A1.5 1.5 0 0 0 8 3.5v10A1.25 1.25 0 0 1 9.25 12h4.5z" />
    </Svg>
  );
}

export function SearchIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="7" cy="7" r="4.25" />
      <path d="M10.2 10.2 13.5 13.5" />
    </Svg>
  );
}

export function ChevronIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M6 3.5 10.5 8 6 12.5" />
    </Svg>
  );
}

export function AlertIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M8 2.5 14.5 13.5h-13z" />
      <path d="M8 6.5v3M8 11.5v.01" />
    </Svg>
  );
}

export function CheckIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 8.5 6.25 11.75 13 5" />
    </Svg>
  );
}

export function SunIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2.75" />
      <path d="M8 1.5v1.25M8 13.25v1.25M1.5 8h1.25M13.25 8h1.25M3.4 3.4l.9.9M11.7 11.7l.9.9M12.6 3.4l-.9.9M4.3 11.7l-.9.9" />
    </Svg>
  );
}

export function MoonIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M13 9.6A5.5 5.5 0 0 1 6.4 3a5.75 5.75 0 1 0 6.6 6.6z" />
    </Svg>
  );
}

export function AutoThemeIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.75" />
      <path d="M8 2.25v11.5a5.75 5.75 0 0 0 0-11.5z" fill="currentColor" stroke="none" />
    </Svg>
  );
}

export function TerminalIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <rect x="1.75" y="2.75" width="12.5" height="10.5" rx="1.25" />
      <path d="M4.5 6.5 6.25 8 4.5 9.5M8.25 10.25h3.25" />
    </Svg>
  );
}

export function EditorIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M5.75 5.5 3.25 8l2.5 2.5M10.25 5.5 12.75 8l-2.5 2.5" />
      <path d="M9 3.25 7 12.75" />
    </Svg>
  );
}

export function GearIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.25v1.6M8 13.15v1.6M14.75 8h-1.6M2.85 8H1.25M12.6 3.4l-1.13 1.13M4.53 11.47 3.4 12.6M12.6 12.6l-1.13-1.13M4.53 4.53 3.4 3.4" />
    </Svg>
  );
}

export function TrashIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M3 4.25h10M6.5 4.25V3a1 1 0 0 1 1-1h1a1 1 0 0 1 1 1v1.25M5.25 4.25l.5 8.5a1 1 0 0 0 1 .92h2.5a1 1 0 0 0 1-.92l.5-8.5" />
    </Svg>
  );
}

export function WrapIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4.5h12M2 8h8M2 11.5h12" />
      <path d="M10 6.5 12.5 8 10 9.5" />
    </Svg>
  );
}

/** Descending bars + a down arrow: sorting, in the same visual family as WrapIcon. */
export function SortIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M2 4h7M2 8h5M2 12h3" />
      <path d="M12 3.5v9M10 10.5 12 12.5 14 10.5" />
    </Svg>
  );
}

export function ClockIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </Svg>
  );
}

/** Circular arrow — rebuild / refresh. */
export function RefreshIcon(props: IconProps) {
  return (
    <Svg {...props}>
      <path d="M12.5 6.5A4.5 4.5 0 1 0 13.5 10" />
      <path d="M13 3v3.5h-3.5" />
    </Svg>
  );
}

/**
 * Pin marker for Favorites. `filled` is the pinned state — outline alone reads
 * as "not pinned yet" on a hover-revealed button, which is what the sidebar
 * needs to distinguish the two.
 */
export function StarIcon({ filled, ...props }: IconProps & { filled?: boolean }) {
  return (
    <Svg {...props}>
      <path
        d="M8.00 2.10L9.53 6.30L13.99 6.45L10.47 9.20L11.70 13.50L8.00 11.00L4.30 13.50L5.53 9.20L2.01 6.45L6.47 6.30Z"
        fill={filled ? "currentColor" : "none"}
      />
    </Svg>
  );
}
