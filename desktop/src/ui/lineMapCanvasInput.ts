interface LineMapCanvasInput {
  getPan(): { x: number; y: number };
  panTo(x: number, y: number): void;
  zoomAt(x: number, y: number, factor: number): void;
  hover(x: number, y: number): void;
  click(x: number, y: number): void;
  leave(): void;
  fit(): void;
  hasHover(): boolean;
}

/** Owns mouse gestures and their DOM listeners for one Canvas. */
export function bindLineMapCanvasInput(
  canvas: HTMLCanvasElement,
  input: LineMapCanvasInput,
): () => void {
  let drag: { x: number; y: number; panX: number; panY: number } | null = null;
  let moved = false;
  const point = (event: MouseEvent) => {
    const rect = canvas.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  function wheel(event: WheelEvent): void {
    event.preventDefault();
    const { x, y } = point(event);
    input.zoomAt(x, y, event.deltaY < 0 ? 1.15 : 1 / 1.15);
  }
  function down(event: MouseEvent): void {
    if (event.button !== 0) return;
    const pan = input.getPan();
    drag = { x: event.clientX, y: event.clientY, panX: pan.x, panY: pan.y };
    moved = false;
    canvas.style.cursor = 'grabbing';
  }
  function move(event: MouseEvent): void {
    if (drag) {
      const dx = event.clientX - drag.x,
        dy = event.clientY - drag.y;
      if (Math.abs(dx) > 2 || Math.abs(dy) > 2) moved = true;
      input.panTo(drag.panX + dx, drag.panY + dy);
      return;
    }
    const { x, y } = point(event);
    input.hover(x, y);
  }
  function up(event: MouseEvent): void {
    if (drag) {
      drag = null;
      canvas.style.cursor = input.hasHover() ? 'pointer' : 'grab';
    }
    if (!moved && event.button === 0) {
      const { x, y } = point(event);
      input.click(x, y);
    }
  }
  function leave(): void {
    if (drag) {
      drag = null;
      canvas.style.cursor = 'grab';
    }
    input.leave();
  }
  const doubleClick = () => input.fit();
  canvas.addEventListener('wheel', wheel, { passive: false });
  canvas.addEventListener('mousedown', down);
  window.addEventListener('mousemove', move);
  window.addEventListener('mouseup', up);
  canvas.addEventListener('mouseleave', leave);
  canvas.addEventListener('dblclick', doubleClick);
  return () => {
    canvas.removeEventListener('wheel', wheel);
    canvas.removeEventListener('mousedown', down);
    window.removeEventListener('mousemove', move);
    window.removeEventListener('mouseup', up);
    canvas.removeEventListener('mouseleave', leave);
    canvas.removeEventListener('dblclick', doubleClick);
  };
}
