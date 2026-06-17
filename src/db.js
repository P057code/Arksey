import mysql from 'mysql2/promise';

export class Database {
  constructor(databaseUrl) {
    const options = connectionOptions(databaseUrl);
    this.pool = mysql.createPool({
      ...options,
      waitForConnections: true,
      connectionLimit: 10,
      timezone: 'Z',
      supportBigNumbers: true,
      decimalNumbers: true
    });
  }

  async close() {
    await this.pool.end();
  }

  async query(text, params = []) {
    const [rows, fields] = await this.pool.execute(text, params);
    return { rows, fields, rowCount: rows.affectedRows ?? rows.length ?? 0, insertId: rows.insertId };
  }

  async getTargetStanox(tiploc) {
    const result = await this.query(
      'SELECT stanox FROM tiploc_location WHERE tiploc_code = ?',
      [tiploc]
    );
    return result.rows[0]?.stanox || null;
  }

  async upsertTiplocLocation(location) {
    await this.query(
      `INSERT INTO tiploc_location (tiploc_code, display_name, stanox, crs)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         display_name = CASE
           WHEN VALUES(display_name) IS NULL THEN display_name
           WHEN VALUES(display_name) = VALUES(tiploc_code) THEN display_name
           ELSE VALUES(display_name)
         END,
         stanox = coalesce(VALUES(stanox), stanox),
         crs = coalesce(VALUES(crs), crs)`,
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
       VALUES (?, ?, ?)`,
      [source, importType, JSON.stringify(metadata)]
    );
    return result.insertId;
  }

  async finishImportRun(id, status, stats, error = null) {
    await this.query(
      `UPDATE rail_import_run
       SET finished_at = utc_timestamp(3),
           status = ?,
           records_seen = ?,
           records_matched = ?,
           records_imported = ?,
           error = ?
       WHERE id = ?`,
      [
        status,
        stats.recordsSeen || 0,
        stats.recordsMatched || 0,
        stats.recordsImported || 0,
        error,
        id
      ]
    );
  }

  async insertFeedMessage(source, messageType, payload, externalMessageId = null) {
    const result = await this.query(
      `INSERT INTO rail_feed_message
         (source, message_type, external_message_id, payload)
       VALUES (?, ?, ?, ?)`,
      [source, messageType, externalMessageId, JSON.stringify(payload)]
    );
    return result.insertId;
  }

  async upsertService(service) {
    const scheduleId = service.scheduleId;

    await this.query(
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         train_uid = coalesce(VALUES(train_uid), train_uid),
         headcode = coalesce(VALUES(headcode), headcode),
         trust_train_id = coalesce(VALUES(trust_train_id), trust_train_id),
         train_service_code = coalesce(VALUES(train_service_code), train_service_code),
         operator_code = coalesce(VALUES(operator_code), operator_code),
         origin_tiploc = coalesce(VALUES(origin_tiploc), origin_tiploc),
         destination_tiploc = coalesce(VALUES(destination_tiploc), destination_tiploc)`,
      [
        service.trainUid || null,
        scheduleId,
        service.serviceDate,
        service.headcode || null,
        service.trustTrainId || null,
        service.trainServiceCode || null,
        service.operatorCode || null,
        service.originTiploc || null,
        service.destinationTiploc || null
      ]
    );

    const result = await this.query(
      `SELECT id
       FROM train_service
       WHERE schedule_id = ?
         AND service_date = ?
       LIMIT 1`,
      [scheduleId, service.serviceDate]
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
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         estimated_pass_at = coalesce(VALUES(estimated_pass_at), estimated_pass_at),
         actual_pass_at = coalesce(VALUES(actual_pass_at), actual_pass_at),
         direction_ind = coalesce(VALUES(direction_ind), direction_ind),
         line = coalesce(VALUES(line), line),
         path = coalesce(VALUES(path), path),
         source_message_id = coalesce(VALUES(source_message_id), source_message_id),
         import_run_id = coalesce(VALUES(import_run_id), import_run_id),
         status = VALUES(status),
         confidence = VALUES(confidence)`,
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
       JOIN rail_feed_message m ON p.source_message_id = m.id
       SET p.status = 'deleted'
       WHERE m.source = 'network_rail_schedule'
         AND p.tiploc_code = ?
         AND (p.import_run_id <> ? OR p.import_run_id IS NULL)
         AND p.scheduled_pass_at >= ?
         AND p.scheduled_pass_at < date_add(?, INTERVAL 1 DAY)
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
       WHERE p.tiploc_code = ?
         AND s.service_date BETWEEN date_sub(?, INTERVAL 1 DAY) AND date_add(?, INTERVAL 1 DAY)
         AND (? IS NULL OR s.headcode = ?)
         AND p.scheduled_pass_at BETWEEN date_sub(?, INTERVAL 120 MINUTE)
                                  AND date_add(?, INTERVAL 120 MINUTE)
       ORDER BY abs(timestampdiff(SECOND, p.scheduled_pass_at, ?)) ASC
       LIMIT 1`,
      [
        targetTiploc,
        serviceDate,
        serviceDate,
        headcode || null,
        headcode || null,
        plannedAt || actualAt,
        plannedAt || actualAt,
        plannedAt || actualAt
      ]
    );

    if (candidate.rows[0]) {
      await this.query(
        `UPDATE train_passage
         SET actual_pass_at = ?,
             direction_ind = coalesce(?, direction_ind),
             source_message_id = ?,
             confidence = 'actual'
         WHERE id = ?`,
        [actualAt, directionInd || null, sourceMessageId, candidate.rows[0].id]
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
       WHERE crossing_slug = ?
       LIMIT 1`,
      [crossingSlug]
    );

    const directions = await this.query(
      `WITH ranked AS (
         SELECT
           v_crossing_next_train.*,
           row_number() OVER (
             PARTITION BY direction_ind
             ORDER BY effective_pass_at ASC, train_passage_id ASC
           ) AS direction_rank
         FROM v_crossing_next_train
         WHERE crossing_slug = ?
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
       WHERE crossing_slug = ?
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

function connectionOptions(databaseUrl) {
  const url = new URL(databaseUrl);
  const sslMode = url.searchParams.get('sslmode');
  url.searchParams.delete('sslmode');

  const options = { uri: url.toString() };
  if (sslMode === 'require') {
    options.ssl = { rejectUnauthorized: true };
  }

  return options;
}
