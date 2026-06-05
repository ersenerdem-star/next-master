import { forwardRef, useCallback, useImperativeHandle, useRef, useState, type HTMLAttributes, type PointerEvent as ReactPointerEvent } from "react";

type DraggableSurfaceProps = HTMLAttributes<HTMLDivElement> & {
  boundsPadding?: number;
  dragHandleSelector?: string;
  enabled?: boolean;
};

type DragState = {
  pointerId: number;
  startX: number;
  startY: number;
  startOffsetX: number;
  startOffsetY: number;
  startRect: DOMRect;
};

function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(value, min), max);
}

export const DraggableSurface = forwardRef<HTMLDivElement, DraggableSurfaceProps>(function DraggableSurface(
  {
    boundsPadding = 16,
    dragHandleSelector = ".draggable-surface__handle",
    enabled = true,
    className = "",
    style,
    onPointerDown,
    ...rest
  },
  forwardedRef,
) {
  const localRef = useRef<HTMLDivElement | null>(null);
  const dragStateRef = useRef<DragState | null>(null);
  const [offset, setOffset] = useState({ x: 0, y: 0 });
  const [dragging, setDragging] = useState(false);

  useImperativeHandle(forwardedRef, () => localRef.current as HTMLDivElement, []);

  const stopDragging = useCallback(() => {
    dragStateRef.current = null;
    setDragging(false);
    window.removeEventListener("pointermove", handlePointerMove);
    window.removeEventListener("pointerup", handlePointerUp);
    window.removeEventListener("pointercancel", handlePointerUp);
  }, []);

  const handlePointerUp = useCallback(() => {
    stopDragging();
  }, [stopDragging]);

  const handlePointerMove = useCallback(
    (event: PointerEvent) => {
      const dragState = dragStateRef.current;
      if (!dragState) return;

      const rawDeltaX = event.clientX - dragState.startX;
      const rawDeltaY = event.clientY - dragState.startY;

      const minDeltaX = boundsPadding - dragState.startRect.left;
      const maxDeltaX = window.innerWidth - boundsPadding - dragState.startRect.right;
      const minDeltaY = boundsPadding - dragState.startRect.top;
      const maxDeltaY = window.innerHeight - boundsPadding - dragState.startRect.bottom;

      const nextDeltaX = clamp(rawDeltaX, minDeltaX, maxDeltaX);
      const nextDeltaY = clamp(rawDeltaY, minDeltaY, maxDeltaY);

      setOffset({
        x: dragState.startOffsetX + nextDeltaX,
        y: dragState.startOffsetY + nextDeltaY,
      });
    },
    [boundsPadding],
  );

  const handleLocalPointerDown = useCallback(
    (event: ReactPointerEvent<HTMLDivElement>) => {
      onPointerDown?.(event);
      if (event.defaultPrevented || !enabled) return;

      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest("button, input, select, textarea, a, [role='button']")) return;

      const root = localRef.current;
      if (!root) return;
      if (!target.closest(dragHandleSelector)) return;

      dragStateRef.current = {
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startOffsetX: offset.x,
        startOffsetY: offset.y,
        startRect: root.getBoundingClientRect(),
      };

      setDragging(true);
      window.addEventListener("pointermove", handlePointerMove);
      window.addEventListener("pointerup", handlePointerUp);
      window.addEventListener("pointercancel", handlePointerUp);
      event.preventDefault();
    },
    [dragHandleSelector, enabled, handlePointerMove, handlePointerUp, offset.x, offset.y, onPointerDown],
  );

  return (
    <div
      {...rest}
      ref={localRef}
      className={`${className}${dragging ? " is-dragging" : ""}`}
      onPointerDown={handleLocalPointerDown}
      style={{
        ...style,
        transform: `${style?.transform ? `${style.transform} ` : ""}translate(${offset.x}px, ${offset.y}px)`,
      }}
    />
  );
});
