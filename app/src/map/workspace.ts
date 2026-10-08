import type { BusinessObject, Coordinate, PowerlineProject } from '@gim/powerline-core';
import type { Settings } from '../native/bridge';
import type { Map as GLMap, StyleSpecification } from 'maplibre-gl';
import { RasterTiles } from './raster';
export interface Camera { center: [number, number]; zoom: number }
const merc = (c: Coordinate): [number, number] => [(c[0] + 180) / 360, (1 - Math.log(Math.tan(Math.PI / 4 + Math.max(-85, Math.min(85, c[1])) * Math.PI / 360)) / Math.PI) / 2];
const inverse = (x: number, y: number): [number, number] => [x * 360 - 180, Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180 / Math.PI];
export class MapWorkspace {
  private canvas: HTMLCanvasElement;
  private glElement: HTMLDivElement;
  private selectionLabel: HTMLDivElement;
  private map?: GLMap;
  private raster?: RasterTiles;
  // Chromium before 80 lacks module Workers and can block its native RenderThread on GL composition.
  private legacyRaster = Number(navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] ?? 100) < 80;
  private project?: PowerlineProject;
  private selected?: string;
  private gps?: { coordinate: Coordinate; accuracy: number };
  private camera: Camera = { center: [105, 35], zoom: 3 };
  private settings?: Settings;
  private base: Settings['baseLayer'] = 'canvas';
  private generation = 0;
  private errors = 0;
  private fallbackTimer?: ReturnType<typeof setTimeout>;
  private hit: { id: string; point?: [number, number]; segment?: [number, number, number, number] }[] = [];
  private touches = new Map<number, { x: number; y: number }>();
  private drag?: { x: number; y: number; moved: boolean };
  private resizeObserver: ResizeObserver;
  constructor(private host: HTMLElement, private onSelect: (id: string) => void, private status: (text: string, base: string) => void, private onCamera: (c: Camera) => void) {
    this.glElement = document.createElement('div'); this.glElement.className = 'gl-map'; host.append(this.glElement);
    this.canvas = document.createElement('canvas'); this.canvas.className = 'engineering-canvas'; this.canvas.setAttribute('aria-label', '工程地图，可拖动和缩放'); this.canvas.tabIndex = 0; host.append(this.canvas);
    this.selectionLabel = document.createElement('div'); this.selectionLabel.className = 'object-map-label'; this.selectionLabel.hidden = true; host.append(this.selectionLabel);
    this.resizeObserver = new ResizeObserver(() => { this.map?.resize(); this.draw(); }); this.resizeObserver.observe(host);
    this.canvas.addEventListener('pointerdown', e => { this.canvas.setPointerCapture(e.pointerId); this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.drag = { x: e.clientX, y: e.clientY, moved: false }; });
    this.canvas.addEventListener('pointermove', e => {
      const old = this.touches.get(e.pointerId); if (!old) return;
      if (this.touches.size === 2) {
        const other = [...this.touches.entries()].find(([id]) => id !== e.pointerId)![1];
        const before = Math.hypot(old.x - other.x, old.y - other.y), after = Math.hypot(e.clientX - other.x, e.clientY - other.y);
        if (before > 1 && after > 1) this.camera.zoom = Math.max(0, Math.min(21, this.camera.zoom + Math.log2(after / before)));
      } else {
        const center = merc(this.camera.center), scale = this.scale(); this.camera.center = inverse(center[0] - (e.clientX - old.x) / scale, center[1] - (e.clientY - old.y) / scale);
      }
      if (this.drag && Math.hypot(e.clientX - this.drag.x, e.clientY - this.drag.y) > 5) this.drag.moved = true;
      this.touches.set(e.pointerId, { x: e.clientX, y: e.clientY }); this.draw(); this.onCamera(this.camera);
    });
    this.canvas.addEventListener('pointerup', e => { if (!this.drag?.moved && this.touches.size === 1) { const r = this.canvas.getBoundingClientRect(); this.pick(e.clientX - r.left, e.clientY - r.top); } this.touches.delete(e.pointerId); this.drag = undefined; });
    this.canvas.addEventListener('pointercancel', e => { this.touches.delete(e.pointerId); this.drag = undefined; });
    this.canvas.addEventListener('wheel', e => { e.preventDefault(); this.zoom(e.deltaY < 0 ? 0.5 : -0.5); }, { passive: false });
    this.canvas.addEventListener('keydown', e => { if (e.key === '+' || e.key === '=') this.zoom(1); if (e.key === '-') this.zoom(-1); if (e.key === 'Home') this.fit(); });
    this.draw();
  }
  setProject(project: PowerlineProject, camera?: Camera) { this.project = project; if (camera) { this.camera = camera; this.syncCamera(); } else this.fit(); this.updateOverlay(); this.draw(); }
  getCamera(): Camera { return this.map ? { center: this.map.getCenter().toArray(), zoom: this.map.getZoom() } : { center: [...this.camera.center], zoom: this.camera.zoom }; }
  private syncCamera() { this.map?.jumpTo(this.camera); this.onCamera(this.camera); }
  private scale() { return 512 * 2 ** this.camera.zoom; }
  private xy(c: Coordinate): [number, number] { const p = merc(c), center = merc(this.camera.center); return [(p[0] - center[0]) * this.scale() + this.host.clientWidth / 2, (p[1] - center[1]) * this.scale() + this.host.clientHeight / 2]; }
  fit(object?: BusinessObject) {
    const coords = object ? object.geometry?.length ? object.geometry : object.coordinate ? [object.coordinate] : [] : this.project?.objects.flatMap(o => o.kind === 'tower' && o.coordinate ? [o.coordinate] : o.geometry ?? []) ?? [];
    if (!coords.length) return;
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const coordinate of coords) { const [x,y] = merc(coordinate); minX = Math.min(minX,x); maxX = Math.max(maxX,x); minY = Math.min(minY,y); maxY = Math.max(maxY,y); }
    const w = Math.max(100, this.host.clientWidth - 110), h = Math.max(100, this.host.clientHeight - 130);
    this.camera = { center: inverse((minX + maxX) / 2, (minY + maxY) / 2), zoom: Math.max(1, Math.min(object?.kind === 'tower' || object?.kind === 'cross' ? 17 : 18, Math.log2(Math.min(w / Math.max(1e-7, maxX - minX), h / Math.max(1e-7, maxY - minY)) / 512))) };
    this.syncCamera(); this.draw();
  }
  zoom(delta: number) { this.camera = this.getCamera(); this.camera.zoom = Math.max(0, Math.min(21, this.camera.zoom + delta)); this.syncCamera(); this.draw(); }
  select(id: string, focus = false) { this.selected = id; this.updateOverlay(); if (focus) { const obj = this.project?.objects.find(o => o.id === id); if (obj && ['tower', 'span', 'cross'].includes(obj.kind)) this.fit(obj); } this.draw(); }
  setGps(coordinate: Coordinate, accuracy: number) { this.gps = { coordinate, accuracy }; this.updateOverlay(); this.draw(); }
  locateGps() { if (!this.gps) return; this.camera = { center: this.gps.coordinate.slice(0, 2) as [number, number], zoom: 16 }; this.syncCamera(); this.draw(); }
  async setBase(settings: Settings) {
    this.settings = settings; this.camera = this.getCamera(); const token = ++this.generation;
    clearTimeout(this.fallbackTimer); this.map?.remove(); this.map = undefined; this.raster?.dispose(); this.raster = undefined; this.canvas.hidden = false; this.glElement.hidden = true; this.draw();
    this.base = settings.baseLayer;
    if (this.base === 'canvas') { this.canvasAttribution(); this.status('无底图工程图 · 可离线查看', 'canvas'); return; }
    if (!settings.tiandituKey && this.base !== 'osm') { this.base = 'osm'; this.status('天地图密钥未配置，使用 OSM', 'osm'); }
    await this.createMap(token);
  }
  private style(): StyleSpecification {
    if (this.base === 'osm') return { version: 8, sources: { tiles: { type: 'raster', tiles: ['https://tile.openstreetmap.org/{z}/{x}/{y}.png'], tileSize: 256, attribution: '© OpenStreetMap contributors' } }, layers: [{ id: 'base', type: 'raster', source: 'tiles' }] };
    const pair = this.base === 'vector' ? ['vec', 'cva'] : this.base === 'terrain' ? ['ter', 'cta'] : ['img', 'cia'];
    const sources: StyleSpecification['sources'] = {}; const layers: StyleSpecification['layers'] = [];
    pair.forEach((layer, i) => { sources[`tiles${i}`] = { type: 'raster', tiles: [`https://t0.tianditu.gov.cn/${layer}_w/wmts?SERVICE=WMTS&REQUEST=GetTile&VERSION=1.0.0&LAYER=${layer}&STYLE=default&TILEMATRIXSET=w&FORMAT=tiles&TILECOL={x}&TILEROW={y}&TILEMATRIX={z}&tk=${encodeURIComponent(this.settings!.tiandituKey)}`], tileSize: 256, attribution: '© 天地图' }; layers.push({ id: `base${i}`, source: `tiles${i}`, type: 'raster' }); });
    return { version: 8, sources, layers };
  }
  private async createMap(token: number) {
    try {
      if (this.legacyRaster) { this.createRaster(token); return; }
      const { default: maplibre } = await import('maplibre-gl'); if (token !== this.generation) return;
      this.glElement.hidden = false;
      const map = new maplibre.Map({ container: this.glElement, style: this.style(), ...this.camera, attributionControl: { compact: true }, renderWorldCopies: false, maxZoom: 21 }); this.map = map; this.errors = 0;
      const baseLabel = { imagery: '天地图影像', vector: '天地图矢量', terrain: '天地图地形', osm: 'OSM', canvas: '工程图' }[this.base]; this.status(`连接 ${baseLabel}…`, this.base);
      map.on('load', () => { if (token !== this.generation) return; this.updateOverlay(); });
      map.on('sourcedata', e => { if (token !== this.generation || !e.sourceId?.startsWith('tiles') || e.dataType !== 'source' || !e.isSourceLoaded) return; clearTimeout(this.fallbackTimer); this.canvas.hidden = true; this.status(baseLabel, this.base); });
      map.on('moveend', () => { if (token !== this.generation) return; this.camera = this.getCamera(); this.onCamera(this.camera); });
      map.on('render', () => this.updateLabel());
      map.on('click', e => { if (!map.getLayer('towers')) return; const found = map.queryRenderedFeatures([[e.point.x - 14, e.point.y - 14], [e.point.x + 14, e.point.y + 14]], { layers: ['towers', 'crosses', 'spans'] }).sort((a,b) => (a.properties?.kind === 'tower' ? 0 : a.properties?.kind === 'cross' ? 1 : 2) - (b.properties?.kind === 'tower' ? 0 : b.properties?.kind === 'cross' ? 1 : 2)); const id = found.find(f => f.properties?.id)?.properties?.id; if (id) this.onSelect(String(id)); });
      map.on('error', () => { if (token === this.generation && ++this.errors >= 4) this.fallback(token); });
      this.fallbackTimer = setTimeout(() => this.fallback(token), 10000);
    } catch { if (token === this.generation) { this.legacyRaster = true; this.map?.remove(); this.map = undefined; this.glElement.hidden = true; this.canvas.hidden = false; this.createRaster(token); } }
  }
  private createRaster(token: number) {
    const style = this.style();
    const urls = Object.values(style.sources).map(source => 'tiles' in source ? source.tiles?.[0] : undefined).filter((url): url is string => Boolean(url));
    const label = { imagery: '天地图影像', vector: '天地图矢量', terrain: '天地图地形', osm: 'OSM', canvas: '工程图' }[this.base];
    this.errors = 0; this.status(`连接 ${label}…`, this.base);
    this.raster = new RasterTiles(urls, () => this.draw(), () => {
      if (token !== this.generation) return;
      clearTimeout(this.fallbackTimer); this.status(label, this.base);
      const attribution = document.getElementById('fallback-attribution');
      if (attribution) { attribution.textContent = this.base === 'osm' ? '© OpenStreetMap contributors' : '© 天地图'; attribution.hidden = false; }
    }, () => { if (token === this.generation && ++this.errors >= 4) this.fallback(token); });
    this.fallbackTimer = setTimeout(() => this.fallback(token), 10000); this.draw();
  }
  private fallback(token: number) {
    if (token !== this.generation) return;
    this.camera = this.getCamera(); clearTimeout(this.fallbackTimer); this.map?.remove(); this.map = undefined; this.raster?.dispose(); this.raster = undefined; this.canvas.hidden = false; this.glElement.hidden = true;
    if (this.base !== 'osm' && this.base !== 'canvas') { this.base = 'osm'; const next = ++this.generation; this.status('天地图连接失败，切换 OSM', 'osm'); void this.createMap(next); }
    else { this.generation++; this.base = 'canvas'; this.canvasAttribution(); this.status('底图不可用 · 无底图工程图', 'canvas'); this.draw(); }
  }
  private canvasAttribution() { const attribution = document.getElementById('fallback-attribution'); if (attribution) attribution.textContent = '工程坐标 · 无底图'; }
  private updateOverlay() {
    const map = this.map; if (!map?.isStyleLoaded()) return;
    const features = (this.project?.objects ?? []).filter(o => ['tower', 'span', 'cross'].includes(o.kind) && o.coordinate).map(o => ({ type: 'Feature' as const, properties: { id: o.id, kind: o.kind as string, selected: o.id === this.selected ? 1 : 0 }, geometry: o.kind === 'span' && o.geometry ? { type: 'LineString' as const, coordinates: o.geometry } : { type: 'Point' as const, coordinates: o.coordinate! } }));
    if (this.gps) features.push({ type: 'Feature', properties: { id: 'gps', kind: 'gps', selected: 0 }, geometry: { type: 'Point', coordinates: this.gps.coordinate } });
    const data = { type: 'FeatureCollection' as const, features };
    const source = map.getSource('engineering') as import('maplibre-gl').GeoJSONSource | undefined;
    if (source) { source.setData(data); return; }
    map.addSource('engineering', { type: 'geojson', data });
    map.addLayer({ id: 'spans', type: 'line', source: 'engineering', filter: ['==', ['get', 'kind'], 'span'], paint: { 'line-color': ['case', ['==', ['get', 'selected'], 1], '#ffb12c', '#2b8eff'], 'line-width': ['case', ['==', ['get', 'selected'], 1], 5, 2.5] } });
    map.addLayer({ id: 'towers', type: 'circle', source: 'engineering', filter: ['==', ['get', 'kind'], 'tower'], paint: { 'circle-radius': ['case', ['==', ['get', 'selected'], 1], 10, 5], 'circle-color': ['case', ['==', ['get', 'selected'], 1], '#1988ff', '#ffffff'], 'circle-stroke-color': '#1761bd', 'circle-stroke-width': 2 } });
    map.addLayer({ id: 'crosses', type: 'circle', source: 'engineering', filter: ['==', ['get', 'kind'], 'cross'], paint: { 'circle-radius': ['case', ['==', ['get', 'selected'], 1], 9, 4], 'circle-color': '#ffae35', 'circle-stroke-width': 1.5, 'circle-stroke-color': '#7d541b' } });
    map.addLayer({ id: 'selected-object', type: 'circle', source: 'engineering', filter: ['all', ['==', ['geometry-type'], 'Point'], ['==', ['get', 'selected'], 1]], paint: { 'circle-radius': 10, 'circle-color': '#1988ff', 'circle-stroke-color': '#ffffff', 'circle-stroke-width': 2.5 } });
    map.addLayer({ id: 'gps', type: 'circle', source: 'engineering', filter: ['==', ['get', 'kind'], 'gps'], paint: { 'circle-radius': 8, 'circle-color': '#1169e1', 'circle-stroke-width': 3, 'circle-stroke-color': '#ffffff' } });
  }
  private draw() {
    this.updateLabel();
    const w = this.host.clientWidth, h = this.host.clientHeight, dpr = window.devicePixelRatio || 1;
    if (!w || !h) return; this.canvas.width = w * dpr; this.canvas.height = h * dpr;
    const c = this.canvas.getContext('2d')!; c.scale(dpr, dpr); c.fillStyle = '#e9f0ec'; c.fillRect(0, 0, w, h);
    c.strokeStyle = '#dce5df'; c.lineWidth = 1;
    const center = merc(this.camera.center); const gx = (center[0] * this.scale()) % 80, gy = (center[1] * this.scale()) % 80;
    for (let x = -gx; x < w; x += 80) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, h); c.stroke(); } for (let y = -gy; y < h; y += 80) { c.beginPath(); c.moveTo(0, y); c.lineTo(w, y); c.stroke(); }
    this.raster?.draw(c, this.camera, w, h);
    this.hit = [];
    const ordered = [...(this.project?.objects ?? [])].sort((a, b) => (a.kind === 'span' ? 0 : 1) - (b.kind === 'span' ? 0 : 1));
    for (const obj of ordered) {
      const selected = obj.id === this.selected;
      if (obj.kind === 'span' && obj.geometry?.length) {
        const [a, b] = obj.geometry.map(p => this.xy(p)); c.beginPath(); c.moveTo(...a); c.lineTo(...b); c.strokeStyle = selected ? '#f6a31f' : '#247de0'; c.lineWidth = selected ? 5 : 2.5; c.stroke(); this.hit.push({ id: obj.id, segment: [...a, ...b] });
      } else if ((obj.kind === 'tower' || obj.kind === 'cross') && obj.coordinate) {
        const [x, y] = this.xy(obj.coordinate); if (x < -50 || y < -50 || x > w + 50 || y > h + 50) continue;
        c.beginPath(); c.arc(x, y, selected ? 11 : obj.kind === 'cross' ? 4 : 5, 0, Math.PI * 2); c.fillStyle = selected ? '#177ce5' : obj.kind === 'cross' ? '#ecad4a' : '#fff'; c.fill(); c.strokeStyle = selected ? '#fff' : '#1761bd'; c.lineWidth = selected ? 3 : 1.8; c.stroke();
        this.hit.push({ id: obj.id, point: [x, y] });
        if (selected || (this.camera.zoom > 13 && obj.kind === 'tower')) { c.font = selected ? '600 13px sans-serif' : '11px sans-serif'; const label = obj.name.length > 18 ? obj.name.slice(0, 18) + '…' : obj.name; const tw = c.measureText(label).width; c.fillStyle = selected ? '#1761bd' : 'rgba(255,255,255,.94)'; c.fillRect(x + 10, y - 26, tw + 12, 23); c.fillStyle = selected ? '#fff' : '#214259'; c.fillText(label, x + 16, y - 10); }
      }
    }
    if (this.gps) { const [x, y] = this.xy(this.gps.coordinate); c.beginPath(); c.arc(x, y, Math.min(w, this.gps.accuracy / (40075016.7 * Math.cos(this.gps.coordinate[1] * Math.PI / 180) / this.scale())), 0, 2 * Math.PI); c.fillStyle = 'rgba(40,129,237,.13)'; c.fill(); c.beginPath(); c.arc(x, y, 7, 0, 2 * Math.PI); c.fillStyle = '#1679e5'; c.fill(); c.strokeStyle = '#fff'; c.lineWidth = 3; c.stroke(); }
    if (!this.project) { c.fillStyle = '#748d81'; c.font = '14px sans-serif'; c.textAlign = 'center'; c.fillText('导入线路工程，查看塔位与档', w / 2, h / 2); }
  }
  private updateLabel() {
    const obj = this.project?.objects.find(o => o.id === this.selected);
    if (!this.canvas.hidden || !obj?.coordinate || !['tower','cross'].includes(obj.kind) || !this.map) { this.selectionLabel.hidden = true; return; }
    const point = this.map.project(obj.coordinate.slice(0,2) as [number,number]);
    this.selectionLabel.hidden = point.x < 0 || point.y < 0 || point.x > this.host.clientWidth || point.y > this.host.clientHeight;
    this.selectionLabel.textContent = obj.name; this.selectionLabel.style.left = `${point.x+13}px`; this.selectionLabel.style.top = `${point.y-31}px`;
  }
  private pick(x: number, y: number) {
    const points = this.hit.filter(h => h.point).map(h => ({ id: h.id, d: Math.hypot(x - h.point![0], y - h.point![1]) })).sort((a, b) => a.d - b.d); if (points[0]?.d <= 22) { this.onSelect(points[0].id); return; }
    const segments = this.hit.filter(h => h.segment).map(h => { const [ax, ay, bx, by] = h.segment!; const t = Math.max(0, Math.min(1, ((x - ax) * (bx - ax) + (y - ay) * (by - ay)) / ((bx - ax) ** 2 + (by - ay) ** 2 || 1))); return { id: h.id, d: Math.hypot(x - ax - t * (bx - ax), y - ay - t * (by - ay)) }; }).sort((a, b) => a.d - b.d); if (segments[0]?.d <= 14) this.onSelect(segments[0].id);
  }
  destroy() { this.generation++; clearTimeout(this.fallbackTimer); this.resizeObserver.disconnect(); this.map?.remove(); this.raster?.dispose(); }
}
