import fs from 'node:fs';
import process from 'node:process';

function loadDotEnv(path = '.env') {
  if (!fs.existsSync(path)) return;

  const lines = fs.readFileSync(path, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const [, key, rawValue] = match;
    if (process.env[key] !== undefined) continue;

    let value = rawValue.trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    process.env[key] = value;
  }
}

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}

function integer(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (Number.isNaN(parsed)) throw new Error(`${name} must be an integer`);
  return parsed;
}

function boolean(name, fallback) {
  const value = process.env[name];
  if (value === undefined || value === '') return fallback;
  return ['1', 'true', 'yes', 'y'].includes(value.toLowerCase());
}

function list(name, fallback) {
  const value = process.env[name];
  if (!value) return fallback;
  return value
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

loadDotEnv();

export function buildConfig() {
  return {
  databaseUrl: required('DATABASE_URL'),
  targetTiploc: process.env.TARGET_TIPLOC || 'ARKSEYL',
  targetStanox: process.env.TARGET_STANOX || '',
  openRail: {
    username: required('OPENRAIL_USERNAME'),
    password: required('OPENRAIL_PASSWORD'),
    stompHost: process.env.OPENRAIL_STOMP_HOST || 'publicdatafeeds.networkrail.co.uk',
    stompPort: integer('OPENRAIL_STOMP_PORT', 61618),
    stompTopics: list('OPENRAIL_STOMP_TOPICS', ['TRAIN_MVT_ALL_TOC', 'VSTP_ALL']),
    stompClientId: process.env.OPENRAIL_STOMP_CLIENT_ID || 'arksey-level-crossing',
    durableSubscription: boolean('OPENRAIL_STOMP_DURABLE', true)
  },
  schedule: {
    dailyTime: process.env.SCHEDULE_DAILY_TIME || '06:15',
    timezone: process.env.SCHEDULE_TIMEZONE || 'Europe/London',
    lookaheadDays: integer('SCHEDULE_LOOKAHEAD_DAYS', 3),
    type: process.env.SCHEDULE_TYPE || 'CIF_ALL_FULL_DAILY',
    day: process.env.SCHEDULE_DAY || 'toc-full',
    importOnStart: boolean('SCHEDULE_IMPORT_ON_START', false)
  }
  };
}

export const config = process.argv.includes('--help') ? null : buildConfig();
