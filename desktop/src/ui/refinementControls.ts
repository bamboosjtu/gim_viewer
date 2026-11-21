interface RefinementActions {
  isCurrent(): boolean;
  refine(): (() => Promise<unknown>) | undefined;
  release(): (() => void) | undefined;
  onRefined(): void;
  onReleased(): void;
}

export function bindRefinementControls(
  drawer: HTMLElement,
  kind: 'dev' | 'ifc',
  actions: RefinementActions,
): void {
  const refine = drawer.querySelector<HTMLButtonElement>(`[data-${kind}-refine]`);
  const release = drawer.querySelector<HTMLButtonElement>(`[data-${kind}-release-fine]`);
  const result = drawer.querySelector<HTMLElement>(`[data-${kind}-refine-result]`);
  let action = 0;
  if (refine)
    refine.onclick = async () => {
      if (!actions.isCurrent()) return;
      const run = actions.refine();
      if (!run) return;
      const ownAction = ++action;
      refine.disabled = true;
      if (release) {
        release.disabled = false;
        release.textContent = '取消精化';
      }
      if (result) result.textContent = '正在生成…';
      try {
        await run();
        if (!actions.isCurrent() || ownAction !== action) return;
        if (result) result.textContent = '精细模型已显示';
        actions.onRefined();
      } catch (error) {
        if (actions.isCurrent() && ownAction === action && result)
          result.textContent = `生成失败：${String(error)}`;
      } finally {
        if (ownAction === action) {
          refine.disabled = false;
          if (release) {
            release.disabled = false;
            release.textContent = '返回浏览表示';
          }
        }
      }
    };
  if (release)
    release.onclick = () => {
      if (!actions.isCurrent()) return;
      const run = actions.release();
      if (!run) return;
      action++;
      if (refine) refine.disabled = false;
      release.textContent = '返回浏览表示';
      run();
      if (!actions.isCurrent()) return;
      if (result) result.textContent = '已返回浏览表示';
      actions.onReleased();
    };
}
