import { createGunzip } from 'node:zlib';
import readline from 'node:readline';
import { Readable } from 'node:stream';
import {
  expandRunDates,
  findTargetLocationTime,
  getScheduleLocations,
  scheduleDateTime,
  serviceDateFromInstant
} from './openRailParsers.js';

export class ScheduleImporter {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  async importDailySchedule() {
    const runId = await this.db.startImportRun('network_rail_schedule', 'daily_json', {
      type: this.config.schedule.type,
      day: this.config.schedule.day,
      targetTiploc: this.config.targetTiploc,
      lookaheadDays: this.config.schedule.lookaheadDays
    });

    const stats = { recordsSeen: 0, recordsMatched: 0, recordsImported: 0 };

    try {
      const response = await fetch(this.scheduleUrl(), {
        headers: {
          Authorization: `Basic ${Buffer.from(
            `${this.config.openRail.username}:${this.config.openRail.password}`
          ).toString('base64')}`
        },
        redirect: 'follow'
      });

      if (!response.ok) {
        throw new Error(`Schedule download failed: ${response.status} ${response.statusText}`);
      }

      const lineReader = readline.createInterface({
        input: Readable.fromWeb(response.body).pipe(createGunzip()),
        crlfDelay: Infinity
      });

      for await (const line of lineReader) {
        if (!line.trim()) continue;
        stats.recordsSeen += 1;

        const record = JSON.parse(line);
        if (record.TiplocV1) {
          const imported = await this.importTiplocRecord(record.TiplocV1);
          if (imported) {
            stats.recordsMatched += 1;
            stats.recordsImported += 1;
          }
          continue;
        }

        const schedule = record.JsonScheduleV1;
        if (!schedule) continue;

        const imported = await this.importScheduleRecord(schedule, record, runId);
        if (imported.matched) stats.recordsMatched += 1;
        stats.recordsImported += imported.count;
      }

      if (this.config.schedule.type.includes('_FULL_')) {
        const staleCount = await this.cleanupStalePassages(runId);
        if (staleCount) console.log(`Marked ${staleCount} stale schedule passages deleted`);
      }

      await this.db.finishImportRun(runId, 'succeeded', stats);
      return stats;
    } catch (error) {
      await this.db.finishImportRun(runId, 'failed', stats, error.stack || error.message);
      throw error;
    }
  }

  async importTiplocRecord(tiplocRecord) {
    const tiplocCode = tiplocRecord.tiploc_code || tiplocRecord.tiploc;
    if (tiplocCode !== this.config.targetTiploc) return false;

    await this.db.upsertTiplocLocation({
      tiplocCode,
      displayName: tiplocRecord.description || tiplocRecord.name || tiplocCode,
      stanox: tiplocRecord.stanox || null,
      crs: tiplocRecord.crs_code || null
    });
    return true;
  }

  async importScheduleRecord(schedule, rawRecord, runId) {
    const locations = getScheduleLocations(schedule);
    const target = findTargetLocationTime(locations, this.config.targetTiploc);
    if (!target) return { matched: false, count: 0 };

    const runDates = expandRunDates(
      schedule,
      this.config.schedule.lookaheadDays
    );
    if (runDates.length === 0) return { matched: true, count: 0 };

    const sourceMessageId = await this.db.insertFeedMessage(
      'network_rail_schedule',
      'JsonScheduleV1',
      rawRecord,
      schedule.CIF_train_uid || null
    );

    let count = 0;
    for (const serviceDate of runDates) {
      const segment = Array.isArray(schedule.schedule_segment)
        ? schedule.schedule_segment[0]
        : schedule.schedule_segment;
      const scheduleId = [
        'schedule',
        schedule.CIF_train_uid,
        schedule.schedule_start_date,
        schedule.schedule_end_date,
        schedule.CIF_stp_indicator,
        serviceDate
      ].join(':');

      const isCancelled =
        schedule.transaction_type?.toLowerCase() === 'delete' ||
        schedule.CIF_stp_indicator === 'C';

      const serviceId = await this.db.upsertService({
        trainUid: schedule.CIF_train_uid,
        scheduleId,
        serviceDate,
        headcode: segment?.signalling_id || segment?.CIF_headcode || null,
        trainServiceCode: segment?.CIF_train_service_code || null,
        operatorCode: schedule.atoc_code || null
      });

      await this.db.upsertPassage({
        serviceId,
        tiplocCode: this.config.targetTiploc,
        scheduledPassAt: scheduleDateTime(
          serviceDate,
          target.minutesAfterMidnight,
          target.dayOffset
        ),
        sourceMessageId,
        importRunId: runId,
        status: isCancelled ? 'cancelled' : 'active',
        confidence: 'scheduled'
      });
      count += 1;
    }

    return { matched: true, count };
  }

  async cleanupStalePassages(runId) {
    const from = serviceDateFromInstant(new Date());
    const throughDate = new Date();
    throughDate.setUTCDate(throughDate.getUTCDate() + this.config.schedule.lookaheadDays - 1);
    const through = serviceDateFromInstant(throughDate);

    return this.db.markStaleSchedulePassagesDeleted({
      targetTiploc: this.config.targetTiploc,
      importRunId: runId,
      fromDate: from,
      throughDate: through
    });
  }

  scheduleUrl() {
    const url = new URL('https://publicdatafeeds.networkrail.co.uk/ntrod/CifFileAuthenticate');
    url.searchParams.set('type', this.config.schedule.type);
    url.searchParams.set('day', this.config.schedule.day);
    return url.toString();
  }
}
