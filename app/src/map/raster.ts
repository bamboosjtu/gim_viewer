import type { Camera } from './workspace';

/** Bounded 2D tiles for WebViews without a reliable MapLibre renderer. No project or GPS data leaves this class. */
export class RasterTiles {
  private tiles = new Map<string, { image: HTMLImageElement; ready: boolean }>();
  private disposed = false;
  private queued = false;
  constructor(private urls: string[], private redraw: () => void, private loaded: () => void, private failed: () => void) {}
  draw(context: CanvasRenderingContext2D, camera: Camera, width: number, height: number) {
    // The engineering camera uses a 512px world; these WMTS/OSM tiles have 256px pixels.
    const z = Math.max(0, Math.min(18, Math.floor(camera.zoom) + 1)), count = 2 ** z;
    const lat = Math.max(-85, Math.min(85, camera.center[1]));
    const cx = (camera.center[0] + 180) / 360 * count;
    const cy = (1 - Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360)) / Math.PI) / 2 * count;
    const size = 512 * 2 ** (camera.zoom - z);
    const left = Math.floor(cx - width / (2 * size)), right = Math.floor(cx + width / (2 * size));
    const top = Math.max(0, Math.floor(cy - height / (2 * size))), bottom = Math.min(count - 1, Math.floor(cy + height / (2 * size)));
    const visible = new Set<string>();
    this.urls.forEach((url, layer) => {
      for (let x = left; x <= right; x++) for (let y = top; y <= bottom; y++) {
        const column = ((x % count) + count) % count, key = `${layer}/${z}/${column}/${y}`; visible.add(key);
        let tile = this.tiles.get(key);
        if (!tile) {
          const image = new Image(); tile = { image, ready: false }; this.tiles.set(key, tile);
          image.crossOrigin = 'anonymous';
          image.onload = () => {
            if (this.disposed) return;
            tile!.ready = true; if (layer === 0) this.loaded();
            if (!this.queued) { this.queued = true; requestAnimationFrame(() => { this.queued = false; if (!this.disposed) this.redraw(); }); }
          };
          image.onerror = () => { if (!this.disposed) this.failed(); };
          image.src = url.replace('{z}', String(z)).replace('{x}', String(column)).replace('{y}', String(y));
        }
        if (tile.ready) context.drawImage(tile.image, (x - cx) * size + width / 2, (y - cy) * size + height / 2, size + .5, size + .5);
      }
    });
    // Keep recent tiles for panning, but never retain an unbounded geographic browsing history.
    for (const [key, tile] of this.tiles) {
      if (this.tiles.size <= 192) break;
      if (!visible.has(key)) { tile.image.onload = null; tile.image.onerror = null; tile.image.src = ''; this.tiles.delete(key); }
    }
  }
  dispose() { this.disposed = true; for (const tile of this.tiles.values()) { tile.image.onload = null; tile.image.onerror = null; tile.image.src = ''; } this.tiles.clear(); }
}
