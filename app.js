/**
 * ChronoSQL Application Controller
 * Handles UI events, live timers, screen routing, and CSV exporting.
 */

// Application State
let activeTab = 'screen-tracker';
let liveTimerInterval = null;
let currentItems = [];

// DOM Element References
const elements = {
  screenTracker: document.getElementById('screen-tracker'),
  screenReports: document.getElementById('screen-reports'),
  navItems: document.querySelectorAll('.nav-item'),
  addItemForm: document.getElementById('add-item-form'),
  itemNameInput: document.getElementById('item-name-input'),
  itemsList: document.getElementById('items-list'),
  emptyTrackerState: document.getElementById('empty-tracker-state'),
  totalItemsCount: document.getElementById('total-items-count'),
  activeTimersCount: document.getElementById('active-timers-count'),
  todayTotalTime: document.getElementById('today-total-time'),
  
  // Reports DOM
  filterStartDate: document.getElementById('filter-start-date'),
  filterEndDate: document.getElementById('filter-end-date'),
  presetBtns: document.querySelectorAll('.preset-pills .pill-btn'),
  reportTotalDuration: document.getElementById('report-total-duration'),
  reportTotalSessions: document.getElementById('report-total-sessions'),
  reportCountBadge: document.getElementById('report-count-badge'),
  reportList: document.getElementById('report-list'),
  btnDownloadCSV: document.getElementById('btn-download-csv'),
  btnExportDB: document.getElementById('btn-export-db'),

  // Modal DOM
  historyModal: document.getElementById('history-modal'),
  modalActivityName: document.getElementById('modal-activity-name'),
  modalHistoryList: document.getElementById('modal-history-list'),
  btnCloseModal: document.getElementById('btn-close-modal'),

  // Toast Container
  toastContainer: document.getElementById('toast-container')
};

/** Initialize Application */
document.addEventListener('DOMContentLoaded', async () => {
  try {
    showToast('Initializing SQLite database...', 'info');
    await initDB();
    
    // Refresh Lucide icons
    if (window.lucide) lucide.createIcons();

    // Set up Date Filter default presets (Today)
    setPresetDateRange('today');

    // Bind Event Listeners
    setupNavigation();
    setupFormListeners();
    setupReportListeners();
    setupModalListeners();

    // Initial Render
    await refreshTrackerList();
    await renderReports();

    // Start Live Timer Interval (updates UI every 1 second)
    startLiveTimerLoop();
    
    // Register Service Worker for PWA support
    registerServiceWorker();

    showToast('SQLite Database ready!', 'success');
  } catch (err) {
    showToast('Error initializing SQLite: ' + err.message, 'error');
    console.error(err);
  }
});

/** Register PWA Service Worker */
function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js')
        .then((reg) => {
          console.log('[PWA] ServiceWorker registered with scope:', reg.scope);
        })
        .catch((err) => {
          console.warn('[PWA] ServiceWorker registration failed:', err);
        });
    });
  }
}

/* ==========================================
   Navigation & Screen Switching
   ========================================== */
function setupNavigation() {
  elements.navItems.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetScreenId = btn.dataset.target;
      
      elements.navItems.forEach(nav => nav.classList.remove('active'));
      btn.classList.add('active');

      document.querySelectorAll('.screen').forEach(screen => {
        screen.classList.remove('active');
      });

      const targetScreen = document.getElementById(targetScreenId);
      if (targetScreen) {
        targetScreen.classList.add('active');
        activeTab = targetScreenId;
      }

      if (targetScreenId === 'screen-reports') {
        renderReports();
      } else if (targetScreenId === 'screen-tracker') {
        refreshTrackerList();
      }
    });
  });

  if (elements.btnExportDB) {
    elements.btnExportDB.addEventListener('click', () => {
      dbExportDatabaseFile();
      showToast('Exported SQLite database file (.sqlite)', 'success');
    });
  }
}

/* ==========================================
   Screen 1: Tracker & Items Logic
   ========================================== */
function setupFormListeners() {
  elements.addItemForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const name = elements.itemNameInput.value.trim();
    if (!name) return;

    try {
      await dbAddItem(name);
      elements.itemNameInput.value = '';
      showToast(`Added activity "${name}"`, 'success');
      await refreshTrackerList();
    } catch (err) {
      showToast('Failed to add item: ' + err.message, 'error');
    }
  });
}

async function refreshTrackerList() {
  currentItems = dbGetAllItems();
  
  elements.totalItemsCount.textContent = `${currentItems.length} ${currentItems.length === 1 ? 'activity' : 'activities'}`;

  if (currentItems.length === 0) {
    elements.itemsList.innerHTML = `
      <div class="empty-state">
        <i data-lucide="clock-4" class="empty-icon"></i>
        <p class="empty-title">No activities added yet</p>
        <p class="empty-desc">Type a name above and tap Add to start tracking time in SQLite.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    updateQuickStats();
    return;
  }

  elements.itemsList.innerHTML = '';
  
  currentItems.forEach(item => {
    const card = document.createElement('div');
    card.className = `item-card ${item.is_running ? 'running' : ''}`;
    card.id = `item-card-${item.id}`;

    // Total displayed seconds = past logged + current session running seconds
    let currentSessionSecs = 0;
    if (item.is_running && item.current_start_time) {
      const startMs = new Date(item.current_start_time).getTime();
      currentSessionSecs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    }
    const totalSecs = (item.total_logged_seconds || 0) + currentSessionSecs;

    card.innerHTML = `
      <div class="item-name-group">
        <span class="status-indicator"></span>
        <span class="item-name">${escapeHTML(item.name)}</span>
      </div>
      <div class="item-actions-group">
        <span class="timer-display" id="timer-display-${item.id}">${formatSecondsHHMMSS(totalSecs)}</span>
        <button class="btn ${item.is_running ? 'btn-rose' : 'btn-emerald'} btn-toggle-timer" data-id="${item.id}" data-running="${item.is_running}">
          <i data-lucide="${item.is_running ? 'square' : 'play'}"></i>          
        </button>
        <button class="icon-btn btn-history" data-id="${item.id}" data-name="${escapeHTML(item.name)}" title="View Log History">
          <i data-lucide="history"></i>
        </button>
        <button class="icon-btn btn-delete" data-id="${item.id}" data-name="${escapeHTML(item.name)}" title="Delete Activity">
          <i data-lucide="trash-2"></i>
        </button>
      </div>
    `;

    elements.itemsList.appendChild(card);
  });

  if (window.lucide) lucide.createIcons();

  // Attach event handlers for toggle, history, and delete buttons
  elements.itemsList.querySelectorAll('.btn-toggle-timer').forEach(btn => {
    btn.addEventListener('click', async () => {
      const itemId = parseInt(btn.dataset.id);
      const isRunning = parseInt(btn.dataset.running) === 1;

      try {
        if (isRunning) {
          const { durationSeconds } = await dbStopTimer(itemId);
          showToast(`Timer stopped. Logged ${formatDurationReadable(durationSeconds)}.`, 'info');
        } else {
          await dbStartTimer(itemId);
          showToast('Timer started!', 'success');
        }
        await refreshTrackerList();
      } catch (err) {
        showToast('Error toggling timer: ' + err.message, 'error');
      }
    });
  });

  elements.itemsList.querySelectorAll('.btn-history').forEach(btn => {
    btn.addEventListener('click', () => {
      openHistoryModal(parseInt(btn.dataset.id), btn.dataset.name);
    });
  });

  elements.itemsList.querySelectorAll('.btn-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const itemId = parseInt(btn.dataset.id);
      const name = btn.dataset.name;
      if (confirm(`Are you sure you want to delete "${name}" and all its recorded logs?`)) {
        await dbDeleteItem(itemId);
        showToast(`Deleted "${name}"`, 'info');
        await refreshTrackerList();
      }
    });
  });

  updateQuickStats();
}

/** Ticking Loop for running timers */
function startLiveTimerLoop() {
  if (liveTimerInterval) clearInterval(liveTimerInterval);
  liveTimerInterval = setInterval(() => {
    let activeCount = 0;
    let todaySecondsAcc = 0;

    currentItems.forEach(item => {
      let currentSessionSecs = 0;
      if (item.is_running && item.current_start_time) {
        activeCount++;
        const startMs = new Date(item.current_start_time).getTime();
        currentSessionSecs = Math.max(0, Math.floor((Date.now() - startMs) / 1000));
      }
      
      const totalSecs = (item.total_logged_seconds || 0) + currentSessionSecs;
      
      const timerDisplay = document.getElementById(`timer-display-${item.id}`);
      if (timerDisplay) {
        timerDisplay.textContent = formatSecondsHHMMSS(totalSecs);
      }
    });

    elements.activeTimersCount.textContent = activeCount;
  }, 1000);
}

function updateQuickStats() {
  const activeCount = currentItems.filter(i => i.is_running === 1).length;
  elements.activeTimersCount.textContent = activeCount;

  // Calculate today's total from reports
  const todayStr = getTodayISOString();
  const reportData = dbGetReportData(todayStr, todayStr);
  
  // Add running sessions for today
  let activeTodaySecs = 0;
  currentItems.forEach(i => {
    if (i.is_running && i.current_start_time) {
      const startMs = new Date(i.current_start_time).getTime();
      activeTodaySecs += Math.max(0, Math.floor((Date.now() - startMs) / 1000));
    }
  });

  elements.todayTotalTime.textContent = formatSecondsHHMMSS(reportData.totalDurationSeconds + activeTodaySecs);
}

/* ==========================================
   Screen 2: Reports & CSV Export Logic
   ========================================== */
function setupReportListeners() {
  elements.filterStartDate.addEventListener('change', () => {
    clearPresetSelection();
    renderReports();
  });
  
  elements.filterEndDate.addEventListener('change', () => {
    clearPresetSelection();
    renderReports();
  });

  elements.presetBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      elements.presetBtns.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      setPresetDateRange(btn.dataset.preset);
      renderReports();
    });
  });

  elements.btnDownloadCSV.addEventListener('click', () => {
    downloadCSVReport();
  });
}

function clearPresetSelection() {
  elements.presetBtns.forEach(b => b.classList.remove('active'));
}

function setPresetDateRange(preset) {
  const now = new Date();
  let startDate = '';
  let endDate = '';

  if (preset === 'today') {
    startDate = getFormattedDate(now);
    endDate = startDate;
  } else if (preset === 'yesterday') {
    const yest = new Date(now);
    yest.setDate(yest.getDate() - 1);
    startDate = getFormattedDate(yest);
    endDate = startDate;
  } else if (preset === 'week') {
    const firstDay = new Date(now);
    const day = firstDay.getDay() || 7; // Get day of week (Monday = 1)
    if (day !== 1) firstDay.setHours(-24 * (day - 1));
    startDate = getFormattedDate(firstDay);
    endDate = getFormattedDate(now);
  } else if (preset === 'all') {
    startDate = '';
    endDate = '';
  }

  elements.filterStartDate.value = startDate;
  elements.filterEndDate.value = endDate;
}

async function renderReports() {
  const startDate = elements.filterStartDate.value;
  const endDate = elements.filterEndDate.value;

  const { rows, totalDurationSeconds, sessionCount } = dbGetReportData(startDate, endDate);

  elements.reportTotalDuration.textContent = formatDurationReadable(totalDurationSeconds);
  elements.reportTotalSessions.textContent = sessionCount;
  elements.reportCountBadge.textContent = `${sessionCount} ${sessionCount === 1 ? 'entry' : 'entries'}`;

  if (rows.length === 0) {
    elements.reportList.innerHTML = `
      <div class="empty-state">
        <i data-lucide="calendar-x" class="empty-icon"></i>
        <p class="empty-title">No time logs found</p>
        <p class="empty-desc">No duration records exist in SQLite for the selected date filter.</p>
      </div>
    `;
    if (window.lucide) lucide.createIcons();
    return;
  }

  elements.reportList.innerHTML = '';
  rows.forEach(log => {
    const row = document.createElement('div');
    row.className = 'report-item-row';
    
    const startTimeStr = formatTimeString(log.start_time);
    const stopTimeStr = formatTimeString(log.stop_time);

    row.innerHTML = `
      <div class="report-item-header">
        <span class="report-item-title">${escapeHTML(log.item_name)}</span>
        <span class="report-item-duration">${formatDurationReadable(log.duration_seconds)}</span>
      </div>
      <div class="report-item-meta">
        <span><i data-lucide="calendar" style="width:12px;height:12px;display:inline-block;vertical-align:-1px;"></i> ${log.log_date}</span>
        <span>${startTimeStr} - ${stopTimeStr}</span>
      </div>
    `;
    elements.reportList.appendChild(row);
  });

  if (window.lucide) lucide.createIcons();
}

/** CSV Export Generator */
function downloadCSVReport() {
  const startDate = elements.filterStartDate.value;
  const endDate = elements.filterEndDate.value;

  const { rows } = dbGetReportData(startDate, endDate);

  if (rows.length === 0) {
    showToast('No logs available to export for this date filter.', 'error');
    return;
  }

  // Build CSV string with UTF-8 BOM for Excel compatibility
  const headers = ['Name', 'Date', 'Start Time', 'Stop Time', 'Duration (Formatted)', 'Duration (Seconds)'];
  
  let csvContent = '\uFEFF' + headers.map(escapeCSVField).join(',') + '\n';

  rows.forEach(log => {
    const rowData = [
      log.item_name,
      log.log_date,
      formatTimeString(log.start_time),
      formatTimeString(log.stop_time),
      formatDurationReadable(log.duration_seconds),
      log.duration_seconds
    ];
    csvContent += rowData.map(escapeCSVField).join(',') + '\n';
  });

  const blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  
  const dateSuffix = startDate && endDate ? `${startDate}_to_${endDate}` : (startDate || endDate || 'All_Time');
  const filename = `ChronoSQL_Report_${dateSuffix}.csv`;

  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);

  showToast(`Downloaded ${filename}`, 'success');
}

/* ==========================================
   History Modal Logic
   ========================================== */
function setupModalListeners() {
  elements.btnCloseModal.addEventListener('click', () => {
    elements.historyModal.classList.remove('active');
  });

  elements.historyModal.addEventListener('click', (e) => {
    if (e.target === elements.historyModal) {
      elements.historyModal.classList.remove('active');
    }
  });
}

function openHistoryModal(itemId, itemName) {
  elements.modalActivityName.textContent = itemName;
  const historyLogs = dbGetItemHistory(itemId);

  if (historyLogs.length === 0) {
    elements.modalHistoryList.innerHTML = `
      <div class="empty-state" style="padding:20px;">
        <p class="empty-title" style="font-size:14px;">No completed sessions yet</p>
        <p class="empty-desc">Start and stop the timer to log sessions in SQLite.</p>
      </div>
    `;
  } else {
    elements.modalHistoryList.innerHTML = '';
    historyLogs.forEach(log => {
      const item = document.createElement('div');
      item.className = 'report-item-row';
      item.innerHTML = `
        <div class="report-item-header">
          <span class="report-item-title">${log.log_date}</span>
          <span class="report-item-duration">${formatDurationReadable(log.duration_seconds)}</span>
        </div>
        <div class="report-item-meta">
          <span>Logged in SQLite</span>
          <span>${formatTimeString(log.start_time)} - ${formatTimeString(log.stop_time)}</span>
        </div>
      `;
      elements.modalHistoryList.appendChild(item);
    });
  }

  elements.historyModal.classList.add('active');
}

/* ==========================================
   Utility Helpers
   ========================================== */
function formatSecondsHHMMSS(totalSeconds) {
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const hh = String(hours).padStart(2, '0');
  const mm = String(minutes).padStart(2, '0');
  const ss = String(seconds).padStart(2, '0');

  return `${hh}:${mm}:${ss}`;
}

function formatDurationReadable(seconds) {
  if (!seconds || seconds <= 0) return '0s';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;

  const parts = [];
  if (h > 0) parts.push(`${h}h`);
  if (m > 0) parts.push(`${m}m`);
  if (s > 0 || parts.length === 0) parts.push(`${s}s`);

  return parts.join(' ');
}

function formatTimeString(isoString) {
  if (!isoString) return '';
  const d = new Date(isoString);
  return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function getFormattedDate(dateObj) {
  const y = dateObj.getFullYear();
  const m = String(dateObj.getMonth() + 1).padStart(2, '0');
  const d = String(dateObj.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function getTodayISOString() {
  return getFormattedDate(new Date());
}

function escapeHTML(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeCSVField(field) {
  if (field === null || field === undefined) return '""';
  const str = String(field);
  if (str.includes(',') || str.includes('"') || str.includes('\n')) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;

  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(-10px)';
    toast.style.transition = 'all 0.3s ease';
    setTimeout(() => toast.remove(), 300);
  }, 3200);
}
