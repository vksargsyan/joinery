import { forwardRef, type HTMLAttributes } from 'react';
import { createPortal } from 'react-dom';

/**
 * An invisible point on screen for a menu to open at (the pointer, a header's corner): the
 * trigger of a right-click menu. It lives in the document body: a dock panel is its own
 * containing block, so a fixed element inside it would be placed from the panel's corner, not
 * the window's, and the menu would open away from the pointer.
 */
export const PointerAnchor = forwardRef<
  HTMLSpanElement,
  { readonly x: number; readonly y: number } & HTMLAttributes<HTMLSpanElement>
>(function PointerAnchor({ x, y, style, ...rest }, ref) {
  return createPortal(
    <span
      ref={ref}
      aria-hidden="true"
      {...rest}
      style={{
        position: 'fixed',
        left: x,
        top: y,
        width: 1,
        height: 1,
        pointerEvents: 'none',
        ...style,
      }}
    />,
    document.body,
  );
});
