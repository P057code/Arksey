import stompit from 'stompit';
import {
  extractHeadcodeFromTrustTrainId,
  findTargetLocationTime,
  getRouteEndpoints,
  getVstpLocations,
  normaliseDirectionInd,
  normaliseRecords,
  parseEpochMillis,
  parseJsonMessage,
  scheduleDateTime,
  serviceDateFromInstant
} from './openRailParsers.js';

export class StompIngestor {
  constructor(db, config) {
    this.db = db;
    this.config = config;
    this.client = null;
    this.connecting = false;
    this.stopped = false;
    this.reconnectAttempt = 0;
    this.warnedMissingStanox = false;
  }

  async start() {
    this.stopped = false;
    await this.connect();
  }

  stop() {
    this.stopped = true;
    if (this.client) this.client.disconnect();
  }

  async connect() {
    if (this.connecting || this.stopped) return;
    this.connecting = true;

    const connectHeaders = {
      host: '/',
      login: this.config.openRail.username,
      passcode: this.config.openRail.password,
      'client-id': this.config.openRail.stompClientId,
      'heart-beat': '10000,10000'
    };

    stompit.connect(
      {
        host: this.config.openRail.stompHost,
        port: this.config.openRail.stompPort,
        connectHeaders
      },
      (error, client) => {
        this.connecting = false;
        if (error) {
          console.error('STOMP connection failed:', error.message);
          this.scheduleReconnect();
          return;
        }

        this.client = client;
        this.reconnectAttempt = 0;
        console.log('Connected to Network Rail STOMP feeds');

        client.on('error', (clientError) => {
          console.error('STOMP client error:', clientError.message);
          this.scheduleReconnect();
        });

        for (const topic of this.config.openRail.stompTopics) {
          this.subscribe(topic);
        }
      }
    );
  }

  subscribe(topic) {
    const destination = `/topic/${topic}`;
    const headers = {
      destination,
      ack: 'client-individual'
    };

    if (this.config.openRail.durableSubscription) {
      headers['activemq.subscriptionName'] = `${this.config.openRail.stompClientId}-${topic}`;
    }

    this.client.subscribe(headers, (error, message) => {
      if (error) {
        console.error(`STOMP subscribe failed for ${destination}:`, error.message);
        return;
      }

      message.readString('utf8', async (readError, body) => {
        if (readError) {
          console.error(`STOMP read failed for ${destination}:`, readError.message);
          return;
        }

        try {
          await this.processTopicMessage(topic, body);
          this.client.ack(message);
        } catch (processError) {
          console.error(`Failed processing ${destination}:`, processError);
          this.client.nack(message);
        }
      });
    });
  }

  async processTopicMessage(topic, body) {
    const payload = parseJsonMessage(body);
    const records = normaliseRecords(payload);

    for (const record of records) {
      if (topic === 'TRAIN_MVT_ALL_TOC') {
        await this.processTrainMovement(record);
      } else if (topic === 'VSTP_ALL') {
        await this.processVstp(record);
      } else {
        await this.db.insertFeedMessage('network_rail_train_movements', topic, record);
      }
    }
  }

  async processTrainMovement(record) {
    const messageType = record.header?.msg_type || 'unknown';
    const sourceMessageId = await this.db.insertFeedMessage(
      'network_rail_train_movements',
      messageType,
      record,
      record.body?.train_id || null
    );

    if (messageType !== '0003') return;

    const targetStanox = this.config.targetStanox || await this.db.getTargetStanox(this.config.targetTiploc);
    if (!targetStanox) {
      if (!this.warnedMissingStanox) {
        console.warn('TARGET_STANOX is not set and ARKSEYL has no stanox in tiploc_location; movement messages will be stored raw only.');
        this.warnedMissingStanox = true;
      }
      return;
    }

    const body = record.body || {};
    const locStanox = body.loc_stanox || body.reporting_stanox;
    if (locStanox !== targetStanox) return;

    const actualAt = parseEpochMillis(body.actual_timestamp);
    const plannedAt = parseEpochMillis(body.planned_timestamp || body.gbtt_timestamp);
    if (!actualAt && !plannedAt) return;

    const serviceDate = serviceDateFromInstant(plannedAt || actualAt);
    const trainId = body.train_id || body.current_train_id || 'unknown';
    const headcode = extractHeadcodeFromTrustTrainId(trainId);

    await this.db.applyActualMovement({
      targetTiploc: this.config.targetTiploc,
      trainId,
      headcode,
      serviceDate,
      plannedAt: plannedAt || actualAt,
      actualAt: actualAt || plannedAt,
      directionInd: normaliseDirectionInd(body.direction_ind),
      sourceMessageId
    });
  }

  async processVstp(record) {
    const wrapper = record.VSTPCIFMsgV1 || record;
    const schedule = wrapper.schedule;
    const sourceMessageId = await this.db.insertFeedMessage(
      'network_rail_vstp',
      'VSTPCIFMsgV1',
      record,
      wrapper.originMsgId || schedule?.schedule_id || null
    );

    if (!schedule) return;

    const locations = getVstpLocations(schedule);
    const target = findTargetLocationTime(locations, this.config.targetTiploc, { vstp: true });
    if (!target) return;
    const endpoints = getRouteEndpoints(locations, { vstp: true });
    await this.ensureEndpointLocations(endpoints);

    const serviceDate = schedule.schedule_start_date;
    if (!serviceDate) return;

    const segment = Array.isArray(schedule.schedule_segment)
      ? schedule.schedule_segment[0]
      : schedule.schedule_segment;
    const scheduleId = [
      'vstp',
      schedule.CIF_train_uid,
      schedule.schedule_start_date,
      schedule.CIF_stp_indicator,
      wrapper.originMsgId || schedule.schedule_id || ''
    ].join(':');

    const isCancelled =
      schedule.transaction_type?.toLowerCase() === 'delete' ||
      schedule.CIF_stp_indicator === 'C';

    const serviceId = await this.db.upsertService({
      trainUid: schedule.CIF_train_uid?.trim(),
      scheduleId,
      serviceDate,
      headcode: segment?.signalling_id || segment?.CIF_headcode || null,
      trainServiceCode: segment?.CIF_train_service_code || null,
      operatorCode: segment?.atoc_code || schedule.atoc_code || null,
      originTiploc: endpoints.originTiploc,
      destinationTiploc: endpoints.destinationTiploc
    });

    await this.db.upsertPassage({
      serviceId,
      tiplocCode: this.config.targetTiploc,
      scheduledPassAt: scheduleDateTime(
        serviceDate,
        target.minutesAfterMidnight,
        target.dayOffset
      ),
      directionInd: target.directionInd,
      line: target.line,
      path: target.path,
      sourceMessageId,
      status: isCancelled ? 'cancelled' : 'active',
      confidence: 'scheduled'
    });
  }

  async ensureEndpointLocations(endpoints) {
    for (const tiplocCode of [endpoints.originTiploc, endpoints.destinationTiploc]) {
      if (!tiplocCode) continue;
      await this.db.upsertTiplocLocation({
        tiplocCode,
        displayName: tiplocCode
      });
    }
  }

  scheduleReconnect() {
    if (this.stopped) return;
    if (this.client) {
      try {
        this.client.disconnect();
      } catch {
        // The client may already be closed.
      }
      this.client = null;
    }

    const delay = Math.min(60, 2 ** this.reconnectAttempt) * 1000;
    this.reconnectAttempt += 1;
    console.log(`Reconnecting to STOMP in ${delay / 1000}s`);
    setTimeout(() => this.connect(), delay);
  }
}
