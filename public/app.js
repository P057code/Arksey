const statusBand = document.querySelector('#statusBand');
const crossingStatus = document.querySelector('#crossingStatus');
const statusMeta = document.querySelector('#statusMeta');
const lastUpdated = document.querySelector('#lastUpdated');
const timeline = document.querySelector('#timeline');

const panels = [
  {
    label: document.querySelector('#directionOneLabel'),
    details: document.querySelector('#directionOneDetails')
  },
  {
    label: document.querySelector('#directionTwoLabel'),
    details: document.querySelector('#directionTwoDetails')
  }
];

const demoEnabled = new URLSearchParams(window.location.search).has('demo');

loadStatus();
setInterval(loadStatus, 5000);

async function loadStatus() {
  try {
    const payload = demoEnabled ? demoPayload() : await fetchStatus();
    render(payload);
  } catch (error) {
    crossingStatus.textContent = 'Feed unavailable';
    statusMeta.innerHTML = '<span class="error">Check the web server and database connection.</span>';
    statusBand.className = 'status-band';
    lastUpdated.textContent = 'Update failed';
    renderEmptyPanels();
    timeline.innerHTML = '';
  }
}

async function fetchStatus() {
  const response = await fetch('/api/status', { cache: 'no-store' });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.json();
}

function render(payload) {
  const crossing = payload.crossing;
  if (!crossing) {
    crossingStatus.textContent = 'No crossing data';
    statusMeta.textContent = 'The database has no Arksey crossing state yet.';
    statusBand.className = 'status-band';
    renderEmptyPanels();
    renderTimeline([]);
    return;
  }

  statusBand.className = `status-band ${crossing.isClosed ? 'closed' : 'open'}`;
  crossingStatus.textContent = crossing.status;
  statusMeta.textContent = statusSummary(crossing);
  lastUpdated.textContent = `Updated ${formatClock(payload.fetchedAt)}`;

  renderPanels(payload.nextByDirection || []);
  renderTimeline(payload.nextOverall || []);
}

function renderPanels(trains) {
  const displayTrains = [...trains];
  while (displayTrains.length < 2) displayTrains.push(null);

  displayTrains.slice(0, 2).forEach((train, index) => {
    if (!train) {
      panels[index].label.textContent = index === 0 ? 'No direction data' : 'Waiting for second direction';
      panels[index].details.innerHTML = emptyDetails();
      return;
    }

    panels[index].label.textContent = train.directionLabel || train.direction || 'Unknown direction';
    panels[index].details.innerHTML = trainDetails(train);
  });
}

function renderEmptyPanels() {
  panels.forEach((panel, index) => {
    panel.label.textContent = index === 0 ? 'No train data' : 'No train data';
    panel.details.innerHTML = emptyDetails();
  });
}

function renderTimeline(trains) {
  if (!trains.length) {
    timeline.innerHTML = '<p class="muted">No upcoming ARKSEYL train passages are currently loaded.</p>';
    return;
  }

  timeline.innerHTML = trains
    .map((train) => `
      <div class="timeline-item">
        <span class="badge">${escapeHtml(train.direction || 'UNK')}</span>
        <div>
          <strong>${escapeHtml(serviceTitle(train))}</strong>
          <div class="muted">${escapeHtml(train.directionLabel || 'Unknown direction')}</div>
        </div>
        <strong>${formatClock(train.effectivePassAt)}</strong>
      </div>
    `)
    .join('');
}

function trainDetails(train) {
  return `
    <dt>Train</dt>
    <dd>${escapeHtml(serviceTitle(train))}</dd>
    <dt>Timetable</dt>
    <dd>${formatClock(train.scheduledPassAt)}</dd>
    <dt>${train.timeSource === 'timetable' ? 'Live time' : 'Live time'}</dt>
    <dd class="primary-time">${liveTimeText(train)}</dd>
    <dt>Line / path</dt>
    <dd>${escapeHtml([train.line, train.path].filter(Boolean).join(' / ') || 'Not supplied')}</dd>
  `;
}

function emptyDetails() {
  return `
    <dt>Train</dt>
    <dd>Waiting</dd>
    <dt>Timetable</dt>
    <dd>-</dd>
    <dt>Live time</dt>
    <dd class="primary-time">-</dd>
    <dt>Line / path</dt>
    <dd>-</dd>
  `;
}

function liveTimeText(train) {
  if (train.actualPassAt) return `${formatClock(train.actualPassAt)} actual`;
  if (train.estimatedPassAt) return `${formatClock(train.estimatedPassAt)} live`;
  return 'Not available';
}

function serviceTitle(train) {
  const identifier = train.headcode || train.trainUid || train.trustTrainId || 'Unknown train';
  const origin = train.originName || train.originTiploc;
  const destination = train.destinationName || train.destinationTiploc;

  if (origin && destination) {
    return `${identifier} - ${origin} - ${destination}`;
  }

  return identifier;
}

function statusSummary(crossing) {
  if (crossing.isClosed) {
    const opens = crossing.opensAt ? ` Expected open ${formatClock(crossing.opensAt)}.` : '';
    const count = crossing.trainsInCurrentWindow ? `${crossing.trainsInCurrentWindow} train window.` : '';
    return `${count}${opens}`.trim() || 'Closed by current train window.';
  }

  if (crossing.nextClosesAt) {
    return `Next closure expected ${formatClock(crossing.nextClosesAt)}.`;
  }

  return 'No upcoming closure is currently loaded.';
}

function formatClock(value) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/London',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).format(new Date(value));
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function demoPayload() {
  const now = Date.now();
  const minutes = (count) => new Date(now + count * 60_000).toISOString();

  return {
    crossing: {
      name: 'Arksey Level Crossing',
      tiploc: 'ARKSEYL',
      isClosed: now % 2 === 0,
      status: 'Crossing Closed',
      opensAt: minutes(2),
      trainsInCurrentWindow: 1,
      nextClosesAt: minutes(16)
    },
    nextByDirection: [
      {
        direction: 'UP',
        directionLabel: 'Up direction',
        headcode: '1D42',
        originName: 'London Kings Cross',
        destinationName: 'Edinburgh',
        scheduledPassAt: minutes(2),
        estimatedPassAt: minutes(3),
        effectivePassAt: minutes(3),
        timeSource: 'live',
        line: 'UF',
        path: null
      },
      {
        direction: 'DOWN',
        directionLabel: 'Down direction',
        headcode: '4E19',
        originName: 'Doncaster Down Decoy',
        destinationName: 'Peterborough',
        scheduledPassAt: minutes(11),
        estimatedPassAt: null,
        effectivePassAt: minutes(11),
        timeSource: 'timetable',
        line: 'DF',
        path: null
      }
    ],
    nextOverall: [
      {
        direction: 'UP',
        directionLabel: 'Up direction',
        headcode: '1D42',
        originName: 'London Kings Cross',
        destinationName: 'Edinburgh',
        effectivePassAt: minutes(3)
      },
      {
        direction: 'DOWN',
        directionLabel: 'Down direction',
        headcode: '4E19',
        originName: 'Doncaster Down Decoy',
        destinationName: 'Peterborough',
        effectivePassAt: minutes(11)
      },
      {
        direction: 'UP',
        directionLabel: 'Up direction',
        headcode: '1A25',
        originName: 'Leeds',
        destinationName: 'London Kings Cross',
        effectivePassAt: minutes(18)
      }
    ],
    fetchedAt: new Date().toISOString()
  };
}
