/** DOM event bridge; property formatting is a pure service. */
export * from '../services/propertyPresentation.js';
import type { PropertyReferenceDetail } from '../services/propertyPresentation.js';

type PropertyReferenceHandler = (detail: PropertyReferenceDetail) => boolean | void;
const propertyReferenceHandlers = new Set<PropertyReferenceHandler>();
let propertyReferenceEventsReady = false;

/** 安装一次属性引用事件桥；正文中的路径永远不会作为可见文本输出。 */
export function ensurePropertyReferenceEvents(): void {
  if (propertyReferenceEventsReady || typeof window === 'undefined') return;
  propertyReferenceEventsReady = true;
  window.addEventListener('gim:file-reference-click', (event) => {
    const detail = (event as CustomEvent<PropertyReferenceDetail>).detail;
    if (!detail?.kind || !detail.path) return;
    for (const handler of Array.from(propertyReferenceHandlers)) {
      try {
        if (handler(detail) === true) break;
      } catch (error) {
        console.warn('[属性引用] 跳转处理失败:', error);
      }
    }
  });
}

/** 注册工程级文件引用路由，返回可选的注销函数。 */
export function registerPropertyReferenceHandler(handler: PropertyReferenceHandler): () => void {
  ensurePropertyReferenceEvents();
  propertyReferenceHandlers.add(handler);
  return () => propertyReferenceHandlers.delete(handler);
}
