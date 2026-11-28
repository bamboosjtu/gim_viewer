import type { TowerPreview } from "@gim/powerline-core";
export function drawTowerPreview(
  container: HTMLElement,
  preview: TowerPreview,
) {
  const [minX, minZ, maxX, maxZ] = preview.bounds,
    width = Math.max(1, maxX - minX),
    height = Math.max(1, maxZ - minZ),
    margin = Math.max(width, height) * 0.04;
  const initial = [
    minX - margin,
    -maxZ - margin,
    width + 2 * margin,
    height + 2 * margin,
  ];
  let box = [...initial];

  container.innerHTML = `<svg viewBox="${box.join(" ")}" preserveAspectRatio="xMidYMid meet" aria-label="杆塔二维骨架" role="img"><path d="${preview.segments.map(([a, b, c, d]) => `M${a} ${-b}L${c} ${-d}`).join("")}" fill="none" stroke="#346ea2" stroke-width=".7" vector-effect="non-scaling-stroke"/></svg>`;
  const svg = container.querySelector("svg")!;
  const update = () => svg.setAttribute("viewBox", box.join(" "));
  let drag: [number, number] | undefined;
  svg.addEventListener("pointerdown", (e) => {
    svg.setPointerCapture(e.pointerId);
    drag = [e.clientX, e.clientY];
  });
  svg.addEventListener("pointermove", (e) => {
    if (!drag) return;
    const scale = Math.max(box[2] / svg.clientWidth, box[3] / svg.clientHeight);
    box[0] -= (e.clientX - drag[0]) * scale;
    box[1] -= (e.clientY - drag[1]) * scale;
    drag = [e.clientX, e.clientY];
    update();
  });
  svg.addEventListener("pointerup", () => {
    drag = undefined;
  });
  svg.addEventListener("pointercancel", () => {
    drag = undefined;
  });
  svg.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const factor = e.deltaY > 0 ? 1.15 : 0.87;
      box[0] += (box[2] - box[2] * factor) / 2;
      box[1] += (box[3] - box[3] * factor) / 2;
      box[2] *= factor;
      box[3] *= factor;
      update();
    },
    { passive: false },
  );
  const zoom = (factor: number) => {
    if (box[2] * factor < initial[2] / 20 || box[2] * factor > initial[2] * 20)
      return;
    box[0] += (box[2] - box[2] * factor) / 2;
    box[1] += (box[3] - box[3] * factor) / 2;
    box[2] *= factor;
    box[3] *= factor;
    update();
  };
  const controls = document.createElement("div");
  controls.className = "preview-zoom-controls";
  controls.innerHTML =
    '<button class="text-button" aria-label="放大塔形">＋</button><button class="text-button" aria-label="缩小塔形">−</button>';
  container.after(controls);
  const [zoomIn, zoomOut] =
    controls.querySelectorAll<HTMLButtonElement>("button");
  zoomIn.onclick = () => zoom(0.8);
  zoomOut.onclick = () => zoom(1.25);
  container
    .closest(".tower-preview")!
    .querySelector<HTMLButtonElement>("#preview-reset")!.onclick = () => {
    box = [...initial];
    update();
  };
}
