/**
 * Thin SVG icon set — single-file so it doesn't drag in a UI library.
 * Each glyph uses `currentColor` so the parent's `color` cascades.
 *
 * The names mirror Tabler-icons / Lucide conventions to keep them
 * recognisable when grepping later.
 */

import type { SVGProps } from 'react';

type IconName =
  | 'search'
  | 'bell'
  | 'pencil'
  | 'send'
  | 'stop'
  | 'plus'
  | 'attach'
  | 'context'
  | 'copy'
  | 'thumbs-up'
  | 'thumbs-down'
  | 'speaker'
  | 'more'
  | 'chevron-right'
  | 'spark'
  | 'edit'
  | 'rotate'
  | 'mic'
  | 'check'
  | 'x'
  | 'sliders'
  | 'plug'
  | 'lock'
  | 'wrench'
  | 'chat'
  | 'workflow'
  | 'settings'
  | 'agent'
  | 'workspace';

interface IconProps extends SVGProps<SVGSVGElement> {
  readonly name: IconName;
  readonly size?: number;
}

export function Icon({ name, size = 18, ...rest }: IconProps): JSX.Element {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {paths[name]}
    </svg>
  );
}

const paths: Record<IconName, JSX.Element> = {
  search: (
    <>
      <circle cx="11" cy="11" r="7" />
      <path d="m20 20-3.5-3.5" />
    </>
  ),
  bell: (
    <>
      <path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9" />
      <path d="M10.3 21a1.94 1.94 0 0 0 3.4 0" />
    </>
  ),
  pencil: (
    <>
      <path d="M17 3 21 7 7 21H3v-4z" />
      <path d="m14 6 4 4" />
    </>
  ),
  send: <path d="m4 12 16-8-6 18-3-7z" />,
  stop: <rect x="5" y="5" width="14" height="14" rx="2" />,
  plus: (
    <>
      <path d="M12 5v14" />
      <path d="M5 12h14" />
    </>
  ),
  attach: <path d="m21 12-8.5 8.5a5 5 0 0 1-7-7L14 5a3.5 3.5 0 0 1 5 5l-9 9a2 2 0 0 1-3-3l8-8" />,
  context: (
    <>
      <path d="M14 3h6v6" />
      <path d="M21 3 12 12" />
      <path d="M20 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h5" />
    </>
  ),
  copy: (
    <>
      <rect x="9" y="9" width="13" height="13" rx="2" />
      <path d="M5 15V5a2 2 0 0 1 2-2h10" />
    </>
  ),
  'thumbs-up': (
    <>
      <path d="M7 22V11" />
      <path d="M7 11h-3a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h3" />
      <path d="M7 11h10a3 3 0 0 1 3 3l-1 5a3 3 0 0 1-3 2.5H7" />
      <path d="M13 11V6a3 3 0 0 0-3-3L7 11" />
    </>
  ),
  'thumbs-down': (
    <>
      <path d="M17 2v11" />
      <path d="M17 13h3a2 2 0 0 0 2-2V5a2 2 0 0 0-2-2h-3" />
      <path d="M17 13H7a3 3 0 0 1-3-3l1-5a3 3 0 0 1 3-2.5h9" />
      <path d="M11 13v5a3 3 0 0 0 3 3l3-8" />
    </>
  ),
  speaker: (
    <>
      <path d="M11 4.7a.7.7 0 0 0-1.2-.5L6.4 7.6A1.4 1.4 0 0 1 5.4 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.4a1.4 1.4 0 0 1 1 .4l3.4 3.4a.7.7 0 0 0 1.2-.5z" />
      <path d="M16 9a5 5 0 0 1 0 6" />
      <path d="M19.4 5.6a9 9 0 0 1 0 12.7" />
    </>
  ),
  more: (
    <>
      <circle cx="5" cy="12" r="1.4" fill="currentColor" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" />
      <circle cx="19" cy="12" r="1.4" fill="currentColor" />
    </>
  ),
  'chevron-right': <path d="m9 6 6 6-6 6" />,
  spark: (
    <>
      <path d="M12 3v3" />
      <path d="M12 18v3" />
      <path d="M5 12H2" />
      <path d="M22 12h-3" />
      <path d="M19 5l-2 2" />
      <path d="M7 17l-2 2" />
      <path d="M19 19l-2-2" />
      <path d="M7 7L5 5" />
    </>
  ),
  edit: (
    <>
      <path d="M12 20h9" />
      <path d="M16.5 3.5a2.121 2.121 0 1 1 3 3L7 19l-4 1 1-4z" />
    </>
  ),
  rotate: (
    <>
      <path d="M3 12a9 9 0 1 0 3-6.7" />
      <path d="M3 4v5h5" />
    </>
  ),
  mic: (
    <>
      <rect x="9" y="2" width="6" height="12" rx="3" />
      <path d="M5 11a7 7 0 0 0 14 0" />
      <path d="M12 18v3" />
    </>
  ),
  check: <path d="m5 12 5 5L20 7" />,
  x: (
    <>
      <path d="M6 6l12 12" />
      <path d="M6 18 18 6" />
    </>
  ),
  sliders: (
    <>
      <path d="M4 21v-7" />
      <path d="M4 10V3" />
      <path d="M12 21v-9" />
      <path d="M12 8V3" />
      <path d="M20 21v-5" />
      <path d="M20 12V3" />
      <path d="M2 14h4" />
      <path d="M10 8h4" />
      <path d="M18 16h4" />
    </>
  ),
  plug: (
    <>
      <path d="M9 2v6" />
      <path d="M15 2v6" />
      <path d="M7 8h10v3a5 5 0 0 1-10 0z" />
      <path d="M12 16v6" />
    </>
  ),
  lock: (
    <>
      <rect x="4" y="11" width="16" height="10" rx="2" />
      <path d="M8 11V7a4 4 0 0 1 8 0v4" />
    </>
  ),
  wrench: (
    <path d="M14.7 6.3a1 1 0 0 0 0 1.4l1.6 1.6a1 1 0 0 0 1.4 0l3.77-3.77a6 6 0 0 1-7.94 7.94l-6.91 6.91a2.12 2.12 0 0 1-3-3l6.91-6.91a6 6 0 0 1 7.94-7.94l-3.76 3.76z" />
  ),
  chat: (
    <>
      <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.5 8.5 0 0 1-7-3.9L3 21l1.6-3.6A8.5 8.5 0 0 1 21 11.5z" />
    </>
  ),
  workflow: (
    <>
      <rect x="3" y="3" width="6" height="6" rx="1" />
      <rect x="15" y="15" width="6" height="6" rx="1" />
      <path d="M9 6h6a3 3 0 0 1 3 3v6" />
    </>
  ),
  settings: (
    <>
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </>
  ),
  agent: (
    <>
      <rect x="4" y="7" width="16" height="12" rx="3" />
      <path d="M12 3v4" />
      <circle cx="9" cy="13" r="1" fill="currentColor" />
      <circle cx="15" cy="13" r="1" fill="currentColor" />
      <path d="M9 17h6" />
    </>
  ),
  workspace: (
    <>
      <rect x="3" y="3" width="7" height="9" rx="1.5" />
      <rect x="14" y="3" width="7" height="5" rx="1.5" />
      <rect x="14" y="12" width="7" height="9" rx="1.5" />
      <rect x="3" y="16" width="7" height="5" rx="1.5" />
    </>
  ),
};
