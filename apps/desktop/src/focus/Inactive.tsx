/**
 * Stage 1: inactive — the 44×44 logo-only square. Clicking it expands
 * the widget to the active stage.
 */

import { LogoMark } from './focus-primitives';
import { style } from './focus-styles';

export function Inactive({ onActivate }: { readonly onActivate: () => void }): JSX.Element {
  // The whole window background is the drag region; the icon
  // button sits on top with a higher z-index so the click reaches
  // React, never the drag layer.
  return (
    <div style={style.inactiveRoot}>
      <button
        type="button"
        onClick={onActivate}
        aria-label="moxxy · click to expand"
        style={style.inactiveButton}
      >
        <LogoMark />
      </button>
    </div>
  );
}
