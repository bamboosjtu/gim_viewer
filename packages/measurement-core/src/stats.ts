/** Bounded logarithmic histogram. Quantiles carry their interval; totals are exact. */
export class DurationStats {
  count = 0;
  totalMs = 0;
  maxMs = 0;
  minMs = Infinity;
  private bins = new Map<number, number>();
  add(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw Error('invalid-duration');
    const bucket = ms === 0 ? -1 : Math.min(4095, Math.floor(Math.log1p(ms / 0.01) / Math.log(1.01)));
    this.bins.set(bucket, (this.bins.get(bucket) ?? 0) + 1);
    this.count++; this.totalMs += ms; this.maxMs = Math.max(this.maxMs, ms); this.minMs = Math.min(this.minMs, ms);
  }
  quantile(p: number) {
    if (!this.count) return null;
    const rank = Math.max(1, Math.ceil(this.count * p)); let count = 0;
    for (const [bucket, frequency] of [...this.bins].sort(([a], [b]) => a - b)) {
      count += frequency;
      if (count >= rank) return bucket === -1 ? { lowerMs: 0, upperMs: 0 }
        : { lowerMs: Math.max(this.minMs, (Math.pow(1.01, bucket) - 1) * 0.01),
          upperMs: Math.min(this.maxMs, (Math.pow(1.01, bucket + 1) - 1) * 0.01) };
    }
    return { lowerMs: this.maxMs, upperMs: this.maxMs };
  }
  snapshot() {
    return { count: this.count, totalMs: this.totalMs, minMs: this.count ? this.minMs : null,
      maxMs: this.count ? this.maxMs : null, p50: this.quantile(0.5), p95: this.quantile(0.95),
      p99: this.quantile(0.99), quantileMethod: 'bounded-log-histogram-1pct' };
  }
  histogram(){return {bins:[...this.bins.entries()],count:this.count,totalMs:this.totalMs,minMs:this.count?this.minMs:0,maxMs:this.maxMs};}
  merge(histogram:ReturnType<DurationStats['histogram']>):void {
    if(!Number.isSafeInteger(histogram.count)||histogram.count<1||!Number.isFinite(histogram.totalMs)||histogram.totalMs<0
      ||!Number.isFinite(histogram.minMs)||histogram.minMs<0||!Number.isFinite(histogram.maxMs)||histogram.maxMs<histogram.minMs
      ||histogram.bins.length>4097||histogram.bins.some(([bin,count])=>!Number.isInteger(bin)||bin< -1||bin>4095||!Number.isSafeInteger(count)||count<1)
      ||histogram.bins.reduce((sum,[,count])=>sum+count,0)!==histogram.count)throw Error('invalid-duration-histogram');
    for(const [bin,count]of histogram.bins)this.bins.set(bin,(this.bins.get(bin)??0)+count);
    this.count+=histogram.count;this.totalMs+=histogram.totalMs;this.minMs=Math.min(this.minMs,histogram.minMs);this.maxMs=Math.max(this.maxMs,histogram.maxMs);
  }
}

export function calibrateClock(hostSentMs: number, remoteReceivedMs: number, remoteSentMs: number, hostReceivedMs: number) {
  const values = [hostSentMs, remoteReceivedMs, remoteSentMs, hostReceivedMs];
  if (!values.every(Number.isFinite) || hostReceivedMs < hostSentMs || remoteSentMs < remoteReceivedMs) throw Error('invalid-clock-exchange');
  const networkMs = Math.max(0, hostReceivedMs - hostSentMs - (remoteSentMs - remoteReceivedMs));
  return { offsetMs: ((hostSentMs - remoteReceivedMs) + (hostReceivedMs - remoteSentMs)) / 2, uncertaintyMs: networkMs / 2 };
}
