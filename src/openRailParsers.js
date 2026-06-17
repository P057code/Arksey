const DATE_FORMAT = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/London',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit'
});

export function parseEpochMillis(value) {
  if (value === null || value === undefined || value === '') return null;
  const millis = Number.parseInt(String(value), 10);
  return Number.isFinite(millis) ? new Date(millis) : null;
}

export function serviceDateFromInstant(date) {
  const parts = DATE_FORMAT.formatToParts(date);
  const value = (type) => parts.find((part) => part.type === type).value;
  return `${value('year')}-${value('month')}-${value('day')}`;
}

export function extractHeadcodeFromTrustTrainId(trainId) {
  if (!trainId || trainId.length < 6) return null;
  return trainId.slice(2, 6).trim() || null;
}

export function normaliseRecords(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && typeof payload === 'object') return [payload];
  return [];
}

export function parseJsonMessage(body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body);
  return JSON.parse(text);
}

export function getScheduleLocations(schedule) {
  const segment = schedule.schedule_segment;
  if (Array.isArray(segment)) {
    return segment.flatMap((item) => item.schedule_location || []);
  }
  return segment?.schedule_location || [];
}

export function getVstpLocations(schedule) {
  const segment = schedule.schedule_segment;
  if (Array.isArray(segment)) {
    return segment.flatMap((item) => item.schedule_location || []);
  }
  return segment?.schedule_location || [];
}

export function getVstpTiploc(location) {
  return (
    location?.location?.tiploc?.tiploc_id ||
    location?.tiploc_code ||
    location?.tiploc_id ||
    null
  );
}

export function getVstpTime(location) {
  return firstPresent(
    location.scheduled_pass_time,
    location.pass,
    location.scheduled_arrival_time,
    location.arrival,
    location.scheduled_departure_time,
    location.departure
  );
}

export function getScheduleTime(location) {
  return firstPresent(location.pass, location.arrival, location.departure);
}

export function runsOnDate(schedule, date) {
  const start = schedule.schedule_start_date;
  const end = schedule.schedule_end_date;
  if (start && date < start) return false;
  if (end && date > end) return false;

  const days = schedule.schedule_days_runs;
  if (!days || days.length !== 7) return true;

  const weekday = new Date(`${date}T12:00:00Z`).getUTCDay();
  const mondayBasedIndex = weekday === 0 ? 6 : weekday - 1;
  return days[mondayBasedIndex] === '1';
}

export function expandRunDates(schedule, lookaheadDays, baseDate = new Date()) {
  const dates = [];
  for (let offset = 0; offset < lookaheadDays; offset += 1) {
    const date = new Date(baseDate);
    date.setUTCDate(date.getUTCDate() + offset);
    const dateString = serviceDateFromInstant(date);
    if (runsOnDate(schedule, dateString)) dates.push(dateString);
  }
  return dates;
}

export function parseLocalRailTime(value) {
  if (value === null || value === undefined) return null;
  const cleaned = String(value).trim();
  if (!cleaned) return null;

  const match = cleaned.match(/^(\d{1,2})(\d{2})(?:(\d{2})|(H))?$/i);
  if (!match) return null;

  const hours = Number.parseInt(match[1], 10);
  const minutes = Number.parseInt(match[2], 10);
  const seconds = match[3] ? Number.parseInt(match[3], 10) : match[4] ? 30 : 0;
  if (hours > 23 || minutes > 59) return null;

  return hours * 60 + minutes + seconds / 60;
}

export function scheduleDateTime(serviceDate, minutesAfterMidnight, dayOffset = 0) {
  const [year, month, day] = serviceDate.split('-').map(Number);
  const totalSeconds = Math.round(minutesAfterMidnight * 60);
  const wholeMinutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  const base = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  base.setUTCDate(base.getUTCDate() + dayOffset);

  const localDate = serviceDateFromInstant(base);
  const hh = String(Math.floor(wholeMinutes / 60)).padStart(2, '0');
  const mm = String(wholeMinutes % 60).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');
  return `${localDate} ${hh}:${mm}:${ss} Europe/London`;
}

export function findTargetLocationTime(locations, targetTiploc, options = {}) {
  let previousMinutes = null;
  let dayOffset = 0;

  for (const location of locations) {
    const tiploc = options.vstp ? getVstpTiploc(location) : location.tiploc_code;
    const rawTime = options.vstp ? getVstpTime(location) : getScheduleTime(location);
    const minutes = parseLocalRailTime(rawTime);

    if (minutes !== null && previousMinutes !== null && minutes < previousMinutes - 720) {
      dayOffset += 1;
    }
    if (minutes !== null) previousMinutes = minutes;

    if (tiploc === targetTiploc && minutes !== null) {
      return { rawTime, minutesAfterMidnight: minutes, dayOffset };
    }
  }

  return null;
}

function firstPresent(...values) {
  return values.find((value) => value !== null && value !== undefined && String(value).trim() !== '');
}
