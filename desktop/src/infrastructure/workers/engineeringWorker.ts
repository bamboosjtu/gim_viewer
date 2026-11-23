import { createWorkerProbe } from '../../measurement/workerProbe.js';
import { createEngineeringWorkerHandler } from '../../services/engineering/engineeringWorkerHandler.js';
import type {
  EngineeringSourceInput,
  EngineeringWorkerReply,
  EngineeringWorkerRequest,
  EngineeringWorkerResponse,
} from './engineeringWorkerProtocol.js';
import { engineeringWorkerResultTransfers } from './engineeringWorkerTransport.js';
import { WorkerRequests } from './workerRequests.js';

function replyTransfers(reply: EngineeringWorkerReply): ArrayBuffer[] {
  switch (reply.type) {
    case 'model':
      return engineeringWorkerResultTransfers(reply.result);
    case 'evidence-checkpoint':
      return reply.checkpoint ? [reply.checkpoint.bytes.buffer as ArrayBuffer] : [];
    case 'geometry-cache':
      return reply.bytes ? [reply.bytes.buffer as ArrayBuffer] : [];
    case 'cache':
      return reply.result.bytes ? [reply.result.bytes.buffer as ArrayBuffer] : [];
    default:
      return [];
  }
}

const send = self.postMessage.bind(self) as (
  response: EngineeringWorkerResponse,
  transfer?: Transferable[],
) => void;
const sourceRequests = new WorkerRequests<EngineeringSourceInput>();
let sourceId = 0;
let activeRequest = 0;
const handle = createEngineeringWorkerHandler((paths) => {
  const readId = ++sourceId;
  return sourceRequests.request(readId, () =>
    send({ type: 'read-sources', paths, readId, requestId: activeRequest }),
  );
});
const probe = createWorkerProbe();
let chain = Promise.resolve();

self.onmessage = (event: MessageEvent<EngineeringWorkerRequest>) => {
  if (probe.control(event)) return;
  const request = event.data;
  if (request.type === 'source-files') {
    // An in-flight build may be waiting for this reply.
    sourceRequests.settle(
      request.readId,
      request.input,
      request.error ? Error(request.error) : undefined,
    );
    return;
  }
  chain = chain.then(() =>
    probe.run(event, async (trace) => {
      const { requestId } = request;
      activeRequest = requestId;
      try {
        const reply = await handle(request, trace, (stage, completed) =>
          send({ type: 'progress', stage, completed, requestId }),
        );
        const transfers = replyTransfers(reply);
        trace.produced({ transferBuffers: transfers.length });
        send(trace.result({ ...reply, requestId }), transfers);
        trace.sentResult();
      } catch (error) {
        trace.fail(error);
        send({ type: 'error', requestId, message: String(error) });
      }
    }),
  );
};
