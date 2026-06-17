import process from 'node:process';
import { config } from './config.js';
import { Database } from './db.js';
import { ScheduleImporter } from './scheduleImporter.js';
import { StompIngestor } from './stompIngestor.js';

const args = new Set(process.argv.slice(2));
if (args.has('--help')) {
  printHelp();
  process.exit(0);
}

const db = new Database(config.databaseUrl);
const importer = new ScheduleImporter(db, config);
const stomp = new StompIngestor(db, config);

async function main() {
  if (args.has('--schedule-once')) {
    const stats = await importer.importDailySchedule();
    console.log('Schedule import completed:', stats);
    await db.close();
    return;
  }

  if (!args.has('--stomp-only') && config.schedule.importOnStart) {
    const stats = await importer.importDailySchedule();
    console.log('Startup schedule import completed:', stats);
  }

  if (!args.has('--stomp-only')) {
    scheduleDailyImport();
  }

  await stomp.start();
}

function scheduleDailyImport() {
  const scheduleNextRun = () => {
    const delay = millisecondsUntilNextLocalTime(
      config.schedule.dailyTime,
      config.schedule.timezone
    );

    console.log(
      `Next daily schedule import at ${config.schedule.dailyTime} ${config.schedule.timezone}`
    );

    setTimeout(async () => {
      try {
        const stats = await importer.importDailySchedule();
        console.log('Daily schedule import completed:', stats);
      } catch (error) {
        console.error('Daily schedule import failed:', error);
      } finally {
        scheduleNextRun();
      }
    }, delay);
  };

  scheduleNextRun();
}

function millisecondsUntilNextLocalTime(hhmm, timezone) {
  const [hour, minute] = hhmm.split(':').map(Number);
  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    throw new Error(`Invalid SCHEDULE_DAILY_TIME: ${hhmm}`);
  }

  const now = new Date();
  const localParts = new Intl.DateTimeFormat('en-GB', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(now);

  const value = (type) => Number(localParts.find((part) => part.type === type).value);
  const localNowUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    value('hour'),
    value('minute'),
    value('second')
  );
  let targetLocalUtc = Date.UTC(
    value('year'),
    value('month') - 1,
    value('day'),
    hour,
    minute,
    0
  );

  if (targetLocalUtc <= localNowUtc) {
    targetLocalUtc += 24 * 60 * 60 * 1000;
  }

  return targetLocalUtc - localNowUtc;
}

process.on('SIGINT', async () => shutdown('SIGINT'));
process.on('SIGTERM', async () => shutdown('SIGTERM'));

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down`);
  stomp.stop();
  await db.close();
  process.exit(0);
}

function printHelp() {
  console.log(`Arksey OpenRailData ingestor

Usage:
  node src/index.js                 Run STOMP feeds and daily schedule import timer
  node src/index.js --schedule-once Import today's Network Rail SCHEDULE JSON once
  node src/index.js --stomp-only    Run only live STOMP subscriptions
  node src/index.js --help          Show this help

Configure with .env; see .env.example.`);
}

main().catch(async (error) => {
  console.error(error);
  await db.close();
  process.exit(1);
});
