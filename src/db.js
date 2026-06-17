import pg from 'pg';

const { Pool } = pg;

export class Database {
  constructor(databaseUrl) {
    this.pool = new Pool({ connectionString: databaseUrl });
  }

  async close() {
    await this.pool.end();
  }

  async query(text, params = []) {
    return this.pool.query(text, params);
  }

  async getTargetStanox(tiploc) {
    const result = await this.query(
      'SELECT stanox FROM tiploc_location WHERE tiploc_code = $1',
      [tiploc]
    );
    return result.rows[0]?.stanox || null;
  }

  async upsertTiplocLocation(location) {
    await this.query(
      `INSERT INTO tiploc_location (tiploc_code, display_name, stanox, crs)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (tiploc_code)
       DO UPDATE SET
         display_name = CASE
           WHEN EXCLUDED.display_name IS NULL THEN tiploc_location.display_name
           WHEN EXCLUDED.display_name = EXCLUDED.tiploc_code THEN tiploc_location.display_name
           ELSE EXCLUDED.display_name
         END,
         stanox = coalesce(EXCLUDED.stanox, tiploc_location.stanox),
         crs = coalesce(EXCLUDED.crs, tiploc_location.crs)`,
      [
        location.tiplocCode,
        location.displayName || location.tiplocCode,
        location.stanox || null,
        location.crs || null
      ]
    );
  }

  async startImportRun(source, importType, metadata = {}) {
    const result = await this.query(
      `INSERT INTO rail_import_run (source, import_type, metadata)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [source, importType, metadata]
    );
    return result.rows[0].id;
  }

  async finishImportRun(id, status, stats, error = null) {
    await this.query(
      `UPDATE rail_import_run
       SET finished_at = now(),
           status = $2,
           records_seen = $3,
           records_matched = $4,
           records_imported = $5,
           error = $6
       WHERE id = $1`,
      [
        id,
        status,
        stats.recordsSeen || 0,
        stats.recordsMatched || 0,
        stats.recordsImported || 0,
        error
      ]
    );
  }

  async insertFeedMessage(source, messageType, payload, externalMessageId = null) {
    const result = await this.query(
      `INSERT INTO rail_feed_message
         (source, message_type, external_message_id, payload)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [source, messageType, externalMessageId, payload]
    );
    return result.rows[0].id;
  }

  async upsertService(service) {
    const result = await this.query(
      `INSERT INTO train_service (
         train_uid,
         schedule_id,
         service_date,
         headcode,
         trust_train_id,
         train_service_code,
         operator_code,
         origin_tiploc,
         destination_tiploc
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       ON CONFLICT (schedule_id, service_date)
       WHERE schedule_id IS NOT NULL
       DO UPDATE SET
         train_uid = coalesce(EXCLUDED.train_uid, train_service.train_uid),
         headcode = coalesce(EXCLUDED.headcode, train_service.headcode),
         trust_train_id = coalesce(EXCLUDED.trust_train_id, train_service.trust_train_id),
         train_service_code = coalesce(EXCLUDED.train_service_code, train_service.train_service_code),
         operator_code = coalesce(EXCLUDED.operator_code, train_service.operator_code),
         origin_tiploc = coalesce(EXCLUDED.origin_tiploc, train_service.origin_tiploc),
         destination_tiploc = coalesce(EXCLUDED.destination_tiploc, train_service.destination_tiploc)
       RETURNING id`,
      [
        service.trainUid || null,
        service.scheduleId,
        service.serviceDate,
        service.headcode || null,
        service.trustTrainId || null,
        service.trainServiceCode || null,
        service.operatorCode || null,
        service.originTiploc || null,
        service.destinationTiploc || null
      ]
    );
    return result.rows[0].id;
  }

  async upsertPassage(passage) {
    await this.query(
      `INSERT INTO train_passage (
         service_id,
         tiploc_code,
         scheduled_pass_at,
         estimated_pass_at,
         actual_pass_at,
         direction_ind,
         line,
         path,
         source_message_id,
         import_run_id,
         status,
         confidence
       )
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
       ON CONFLICT (service_id, tiploc_code, scheduled_pass_at)
       WHERE service_id IS NOT NULL
       DO UPDATE SET
         estimated_pass_at = coalesce(EXCLUDED.estimated_pass_at, train_passage.estimated_pass_at),
         actual_pass_at = coalesce(EXCLUDED.actual_pass_at, train_passage.actual_pass_at),
         direction_ind = coalesce(EXCLUDED.direction_ind, train_passage.direction_ind),
         line = coalesce(EXCLUDED.line, train_passage.line),
         path = coalesce(EXCLUDED.path, train_passage.path),
         source_message_id = coalesce(EXCLUDED.source_message_id, train_passage.source_message_id),
         import_run_id = coalesce(EXCLUDED.import_run_id, train_passage.import_run_id),
         status = EXCLUDED.status,
         confidence = EXCLUDED.confidence`,
      [
        passage.serviceId,
        passage.tiplocCode,
        passage.scheduledPassAt,
        passage.estimatedPassAt || null,
        passage.actualPassAt || null,
        passage.directionInd || null,
        passage.line || null,
        passage.path || null,
        passage.sourceMessageId || null,
        passage.importRunId || null,
        passage.status || 'active',
        passage.confidence || 'scheduled'
      ]
    );
  }

  async markStaleSchedulePassagesDeleted({ targetTiploc, importRunId, fromDate, throughDate }) {
    const result = await this.query(
      `UPDATE train_passage p
       SET status = 'deleted'
       FROM rail_feed_message m
       WHERE p.source_message_id = m.id
         AND m.source = 'network_rail_schedule'
         AND p.tiploc_code = $1
         AND p.import_run_id IS DISTINCT FROM $2
         AND p.scheduled_pass_at >= $3::date
         AND p.scheduled_pass_at < ($4::date + interval '1 day')
         AND p.status = 'active'`,
      [targetTiploc, importRunId, fromDate, throughDate]
    );
    return result.rowCount;
  }

  async applyActualMovement({ targetTiploc, trainId, headcode, serviceDate, plannedAt, actualAt, directionInd, sourceMessageId }) {
    const candidate = await this.query(
      `SELECT p.id
       FROM train_passage p
       JOIN train_service s ON s.id = p.service_id
       WHERE p.tiploc_code = $1
         AND s.service_date BETWEEN ($2::date - interval '1 day') AND ($2::date + interval '1 day')
         AND ($3::text IS NULL OR s.headcode = $3)
         AND p.scheduled_pass_at BETWEEN ($4::timestamptz - interval '120 minutes')
                                  AND ($4::timestamptz + interval '120 minutes')
       ORDER BY abs(extract(epoch FROM (p.scheduled_pass_at - $4::timestamptz))) ASC
       LIMIT 1`,
      [targetTiploc, serviceDate, headcode, plannedAt || actualAt]
    );

    if (candidate.rows[0]) {
      await this.query(
        `UPDATE train_passage
         SET actual_pass_at = $2,
             direction_ind = coalesce($3, direction_ind),
             source_message_id = $4,
             confidence = 'actual'
         WHERE id = $1`,
        [candidate.rows[0].id, actualAt, directionInd || null, sourceMessageId]
      );
      return 'updated';
    }

    const serviceId = await this.upsertService({
      scheduleId: `trust:${trainId}:${serviceDate}`,
      serviceDate,
      headcode,
      trustTrainId: trainId
    });

    await this.upsertPassage({
      serviceId,
      tiplocCode: targetTiploc,
      scheduledPassAt: plannedAt || actualAt,
      actualPassAt: actualAt,
      directionInd,
      sourceMessageId,
      confidence: 'actual'
    });
    return 'inserted';
  }

  async getCrossingDashboard(crossingSlug = 'arksey') {
    const state = await this.query(
      `SELECT *
       FROM v_crossing_state
       WHERE crossing_slug = $1
       LIMIT 1`,
      [crossingSlug]
    );

    const directions = await this.query(
      `WITH ranked AS (
         SELECT
           *,
           row_number() OVER (
             PARTITION BY direction_ind
             ORDER BY effective_pass_at ASC, train_passage_id ASC
           ) AS direction_rank
         FROM v_crossing_next_train
         WHERE crossing_slug = $1
       )
       SELECT *
       FROM ranked
       WHERE direction_rank = 1
       ORDER BY
         CASE direction_ind
           WHEN 'UP' THEN 1
           WHEN 'DOWN' THEN 2
           ELSE 3
         END,
         effective_pass_at ASC
       LIMIT 4`,
      [crossingSlug]
    );

    const nextOverall = await this.query(
      `SELECT *
       FROM v_crossing_next_train
       WHERE crossing_slug = $1
       ORDER BY effective_pass_at ASC, train_passage_id ASC
       LIMIT 6`,
      [crossingSlug]
    );

    return {
      crossing: state.rows[0] || null,
      nextByDirection: directions.rows,
      nextOverall: nextOverall.rows
    };
  }
}
