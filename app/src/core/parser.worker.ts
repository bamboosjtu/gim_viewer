import { buildPowerlineProject, buildTowerPreview, type ProjectIdentity } from '@gim/powerline-core';
interface Message { job: number; kind: 'project' | 'preview'; files?: { path: string; text: string }[]; identity?: ProjectIdentity; text?: string; path?: string }
self.onmessage = (event: MessageEvent<Message>) => {
  const m = event.data;
  try {
    const result = m.kind === 'project' ? buildPowerlineProject(m.files!, m.identity!, (stage, done, total) => self.postMessage({ job: m.job, progress: { stage, done, total } })) : buildTowerPreview(m.text!, m.path!);
    self.postMessage({ job: m.job, result });
  } catch (error) { self.postMessage({ job: m.job, error: error instanceof Error ? error.message : String(error) }); }
};
