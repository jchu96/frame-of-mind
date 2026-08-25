import * as Sentry from "@sentry/bun";
import {
  scrubTraceAttributes,
  type AnalysisSpan,
  type AnalysisTracer,
  type TraceAttributes,
} from "./telemetry-trace.js";

// SDK-backed implementation of the tracing port. Imported only by the CLI
// entry path (instrument/telemetry); services, adapters, and hosted bundles
// depend on the pure port in telemetry-trace.ts instead. Attributes are
// scrubbed at set time (belt) and again by beforeSendTransaction (suspenders).

function wrap(span: Sentry.Span): AnalysisSpan {
  return {
    setAttributes(attributes: TraceAttributes) {
      span.setAttributes(scrubTraceAttributes(attributes));
    },
  };
}

export function createSentryAnalysisTracer(): AnalysisTracer {
  return {
    span({ op, name, attributes }, callback) {
      return Sentry.startSpan(
        {
          op,
          name,
          attributes: scrubTraceAttributes(attributes),
        },
        (span) => callback(wrap(span)),
      );
    },
  };
}
