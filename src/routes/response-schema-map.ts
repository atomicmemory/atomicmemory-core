/**
 * @file Route→schema maps consumed by `validate-response` middleware.
 *
 * Keyed by Express's router-relative `${method} ${route.path}` format
 * (method lowercase, path matches what Express stores in `req.route.path`).
 * When a new route is added, add a corresponding entry here; the
 * validator is a no-op for routes not in the map (so new routes
 * ship without a hard dependency on a schema existing yet).
 */

import * as R from '../schemas/responses.js';
import type { ResponseSchemaMap } from '../middleware/validate-response.js';

export const MEMORY_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'post /ingest': R.IngestResponseSchema,
  'post /ingest/quick': R.IngestResponseSchema,
  'post /search': R.SearchResponseSchema,
  'post /search/fast': R.SearchResponseSchema,
  'post /expand': R.ExpandResponseSchema,
  'get /list': R.ListResponseSchema,
  'get /stats': R.StatsResponseSchema,
  'get /health': R.HealthResponseSchema,
  'put /config': R.ConfigUpdateResponseSchema,
  'post /consolidate': R.ConsolidateResponseSchema,
  'post /decay': R.DecayResponseSchema,
  'get /cap': R.CapResponseSchema,
  'get /lessons': R.LessonsListResponseSchema,
  'get /lessons/stats': R.LessonStatsResponseSchema,
  'post /lessons/report': R.LessonReportResponseSchema,
  'delete /lessons/:id': R.SuccessResponseSchema,
  'post /reconcile': R.ReconciliationResponseSchema,
  'get /reconcile/status': R.ReconcileStatusResponseSchema,
  'post /reset-source': R.ResetSourceResponseSchema,
  'get /:id': R.GetMemoryResponseSchema,
  'delete /:id': R.SuccessResponseSchema,
  'get /audit/summary': R.MutationSummaryResponseSchema,
  'get /audit/recent': R.AuditRecentResponseSchema,
  'get /:id/audit': R.AuditTrailResponseSchema,
};

export const AGENT_RESPONSE_SCHEMAS: ResponseSchemaMap = {
  'put /trust': R.TrustResponseSchema,
  'get /trust': R.TrustResponseSchema,
  'get /conflicts': R.ConflictsListResponseSchema,
  'put /conflicts/:id/resolve': R.ResolveConflictResponseSchema,
  'post /conflicts/auto-resolve': R.AutoResolveConflictsResponseSchema,
};
