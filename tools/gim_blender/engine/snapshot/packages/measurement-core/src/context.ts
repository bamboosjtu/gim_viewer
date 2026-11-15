import type {OperationTraceId,SpanId,TaskId,TraceContext} from './types.js';
const identity=(value:string)=>{if(!value||value.length>512||/[\0\r\n]/.test(value))throw Error('invalid-measurement-id');return value;};
export const operationTraceId=(value:string)=>identity(value) as OperationTraceId;
export const spanId=(value:string)=>identity(value) as SpanId;
export const taskId=(value:string)=>identity(value) as TaskId;
export function captureContext(context:TraceContext):Readonly<TraceContext>{return Object.freeze({...context});}
