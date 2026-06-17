import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';
import { config } from './config.js';
import { Database } from './db.js';

if (process.argv.includes('--help')) {
  printHelp();
  process.exit(0);
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.resolve(__dirname, '..', 'public');
const db = new Database(config.databaseUrl);

const mimeTypes = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml; charset=utf-8',
  '.json': 'application/json; charset=utf-8'
};

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);

    if (url.pathname === '/api/status') {
      await handleStatus(response);
      return;
    }

    await serveStatic(url.pathname, response);
  } catch (error) {
    console.error(error);
    sendJson(response, 500, {
      error: 'internal_error',
      message: 'The Arksey crossing page could not complete the request.'
    });
  }
});

server.listen(config.web.port, () => {
  console.log(`Arksey crossing page running at http://localhost:${config.web.port}`);
});

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

async function handleStatus(response) {
  const data = await db.getCrossingDashboard('arksey');

  sendJson(response, 200, {
    crossing: data.crossing ? mapCrossing(data.crossing) : null,
    nextByDirection: data.nextByDirection.map(mapTrain),
    nextOverall: data.nextOverall.map(mapTrain),
    fetchedAt: new Date().toISOString()
  });
}

async function serveStatic(urlPath, response) {
  const requestedPath = urlPath === '/' ? '/index.html' : urlPath;
  const safePath = path
    .normalize(requestedPath)
    .replace(/^(\.\.[/\\])+/, '')
    .replace(/^[/\\]/, '');
  const filePath = path.join(publicDir, safePath);
  const relativePath = path.relative(publicDir, filePath);

  if (relativePath.startsWith('..') || path.isAbsolute(relativePath)) {
    response.writeHead(403);
    response.end('Forbidden');
    return;
  }

  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    response.writeHead(404);
    response.end('Not found');
    return;
  }

  const ext = path.extname(filePath);
  response.writeHead(200, {
    'Content-Type': mimeTypes[ext] || 'application/octet-stream',
    'Cache-Control': 'no-store'
  });
  fs.createReadStream(filePath).pipe(response);
}

function mapCrossing(row) {
  return {
    id: row.crossing_id,
    slug: row.crossing_slug,
    name: row.crossing_name,
    tiploc: row.tiploc_code,
    isClosed: row.is_closed,
    status: row.public_status,
    closedFrom: row.closed_from,
    opensAt: row.opens_at,
    trainsInCurrentWindow: row.trains_in_current_window,
    nextClosesAt: row.next_closes_at,
    nextOpensAt: row.next_opens_at,
    nextTrainCount: row.next_train_count,
    overrideReason: row.override_reason,
    calculatedAt: row.calculated_at
  };
}

function mapTrain(row) {
  return {
    id: row.train_passage_id,
    direction: row.direction_ind,
    directionLabel: row.direction_label,
    headcode: row.headcode,
    trainUid: row.train_uid,
    trustTrainId: row.trust_train_id,
    operatorCode: row.operator_code,
    originTiploc: row.origin_tiploc,
    originName: row.origin_name,
    destinationTiploc: row.destination_tiploc,
    destinationName: row.destination_name,
    scheduledPassAt: row.scheduled_pass_at,
    estimatedPassAt: row.estimated_pass_at,
    actualPassAt: row.actual_pass_at,
    effectivePassAt: row.effective_pass_at,
    timeSource: row.time_source,
    line: row.line,
    path: row.path
  };
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(payload));
}

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down web server`);
  server.close();
  await db.close();
  process.exit(0);
}

function printHelp() {
  console.log(`Arksey crossing web page

Usage:
  node src/webServer.js         Serve the web page and /api/status
  node src/webServer.js --help  Show this help

Configure DATABASE_URL and PORT in .env; see .env.example.`);
}
