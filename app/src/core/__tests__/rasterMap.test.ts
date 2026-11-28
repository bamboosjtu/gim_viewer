import {it,expect,vi} from 'vitest';
import {RasterTiles} from '../../map/raster';
it('wraps tile columns at the antimeridian, reuses visible tiles and disconnects them on disposal',()=>{
 const images:{src:string;onload:unknown;onerror:unknown}[]=[];
 class MockImage {src='';onload=null;onerror=null;constructor(){images.push(this);}}
 vi.stubGlobal('Image',MockImage);try{
 const raster=new RasterTiles(['tiles/{z}/{x}/{y}'],vi.fn(),vi.fn(),vi.fn());
 const camera={center:[180,0] as [number,number],zoom:1,bearing:0,pitch:0};
 const ctx={drawImage:vi.fn()} as unknown as CanvasRenderingContext2D;raster.draw(ctx,camera,256,256);
 const previous=images.length;expect(previous).toBeGreaterThan(0);expect(images.every(i=>/^tiles\/2\/[0-3]\/[0-3]$/.test(i.src))).toBe(true);
 raster.draw(ctx,camera,256,256);expect(images).toHaveLength(previous);raster.dispose();expect(images.every(i=>!i.src&&i.onload===null)).toBe(true);
 }finally{vi.unstubAllGlobals();}
});
