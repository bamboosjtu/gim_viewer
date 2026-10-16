import {expect,it} from 'vitest';
import {WorkQueue} from '../workQueue.js';
it('selection preempts aging work; promotion, cancellation and stable ties retain one queued item per key',()=>{
  const queue=new WorkQueue<string>();queue.set('base','base',4,0);queue.set('detail','detail',2,60000);queue.set('selected','selected',0,60000);
  expect(queue.take()![0]).toBe('selected');expect(queue.take()![0]).toBe('base');
  queue.set('later','later',4,60000);queue.set('later','later',0,60000);expect(queue.size).toBe(2);expect(queue.take()![0]).toBe('later');
  queue.set('cancel','cancel',1,0);queue.delete('cancel');expect(queue.take()![0]).toBe('detail');expect(queue.take()).toBeUndefined();
  queue.set('first','1',1,0);queue.set('second','2',1,0);expect(queue.take()![0]).toBe('first');
});
