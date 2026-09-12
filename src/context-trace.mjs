import { summarizeToolEvents } from "./tool-audit.mjs";

export function recordContextTrace(response, trace, metrics, admitted = true) {
  if (!trace) return;
  response.momoContextTrace = trace;
  if (trace.metricsRecorded) return;
  trace.metricsRecorded = true;
  if (admitted) metrics.contextRequestsAdmitted++;
  else metrics.contextRequestsRejected++;
  if (trace.softLimitHit) metrics.outboundBodySoftLimitHits++;
  if (trace.hardLimitRejected) metrics.outboundBodyHardLimitRejects++;
  metrics.imageBytesRemoved += trace.imageBytesRemoved || 0;
  metrics.imageBytesForwarded += trace.imageBytesForwarded || 0;
  metrics.imageDedupHits += trace.imageDedupHits || 0;
  metrics.historicalImagesRemoved += trace.historicalImagesRemoved || 0;
  metrics.maxSerializedBodyBytes = Math.max(metrics.maxSerializedBodyBytes, trace.maxOutboundBytes || trace.outboundBytes || 0);
}

export function contextLogFields(response, request) {
  const trace = response.momoContextTrace;
  return {
    toolAudit: response.momoToolAudit ? { ...response.momoToolAudit, events: summarizeToolEvents(response.momoToolEvents) } : undefined,
    requestBytes: trace?.requestBytes || request.momoRequestBodyBytes,
    outboundBytes: trace?.outboundBytes,
    imageCount: trace?.imageCount,
    imageBytes: trace?.imageBytes,
    policyAction: trace?.policyActions?.join(",") || (trace?.hardLimitRejected ? "hard_limit_rejected" : undefined),
  };
}
