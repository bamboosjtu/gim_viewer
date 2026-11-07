/** Frame budget and stage order for the Canvas map. No DOM or map instance. */
export type LineMapStage = 'towers' | 'wires' | 'crosses' | 'labels';
export const LINE_MAP_FRAME_BUDGET_MS = 8;
export function lineMapStageBatchSize(stage: LineMapStage): number {
  return stage === 'towers' ? 256 : stage === 'wires' ? 64 : stage === 'crosses' ? 128 : 256;
}
export function runLineMapStageSlice(
  offset: number, sourceLength: number, batchSize: number,
  draw: (index: number) => void, now: () => number = () => performance.now(),
): number {
  const hardEnd = Math.min(sourceLength, offset + batchSize);
  const deadline = now() + LINE_MAP_FRAME_BUDGET_MS;
  let next = offset;
  while (next < hardEnd) {
    draw(next);
    next++;
    if (next - offset >= 8 && now() >= deadline) break;
  }
  return next;
}
