/**
 * ChronoSQL Database Manager using sql.js (WebAssembly SQLite)
 * Persisted client-side via IndexedDB
 */

const DB_NAME = 'ChronoSQL_IndexedDB';
const STORE_NAME = 'sqlite_bytes';
const DB_KEY = 'chrono_sqlite_db';

let db = null;
let SQL = null;

/**
 * Initialize IndexedDB helper
 */
function openIndexedDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, 1);
    request.onupgradeneeded = (e) => {
      const dbStore = e.target.result;
      if (!dbStore.objectStoreNames.contains(STORE_NAME)) {
        dbStore.createObjectStore(STORE_NAME);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

/**
 * Load SQLite Byte Array from IndexedDB
 */
async function loadDBBytesFromStorage() {
  try {
    const idb = await openIndexedDB();
    return new Promise((resolve) => {
      const tx = idb.transaction(STORE_NAME, 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.get(DB_KEY);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    });
  } catch (err) {
    console.warn('IndexedDB load warning:', err);
    return null;
  }
}

/**
 * Save SQLite Byte Array to IndexedDB
 */
async function saveDBToStorage() {
  if (!db) return;
  try {
    const binaryArray = db.export();
    const idb = await openIndexedDB();
    const tx = idb.transaction(STORE_NAME, 'readwrite');
    const store = tx.objectStore(STORE_NAME);
    store.put(binaryArray, DB_KEY);
  } catch (err) {
    console.error('Failed to persist SQLite to IndexedDB:', err);
  }
}

/**
 * Main Database Initialization
 */
async function initDB() {
  try {
    // Locate WebAssembly binary file
    const config = {
      locateFile: file => `https://cdnjs.cloudflare.com/ajax/libs/sql.js/1.8.0/${file}`
    };

    SQL = await initSqlJs(config);
    const savedBytes = await loadDBBytesFromStorage();

    if (savedBytes) {
      db = new SQL.Database(savedBytes);
      console.log('SQLite loaded existing database from IndexedDB.');
    } else {
      db = new SQL.Database();
      console.log('SQLite initialized fresh in-memory database.');
    }

    // Enable Foreign Keys & Create Tables
    db.run("PRAGMA foreign_keys = ON;");

    db.run(`
      CREATE TABLE IF NOT EXISTS items (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        is_running INTEGER DEFAULT 0,
        current_start_time TEXT,
        sort_order INTEGER DEFAULT 0
      );
    `);

    // Safely add sort_order column to items table if it doesn't exist yet
    try {
      db.run("ALTER TABLE items ADD COLUMN sort_order INTEGER DEFAULT 0;");
    } catch (e) {
      // Column already exists
    }

    db.run(`
      CREATE TABLE IF NOT EXISTS time_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        item_id INTEGER NOT NULL,
        start_time TEXT NOT NULL,
        stop_time TEXT NOT NULL,
        duration_seconds INTEGER NOT NULL,
        log_date TEXT NOT NULL,
        FOREIGN KEY(item_id) REFERENCES items(id) ON DELETE CASCADE
      );
    `);

    db.run(`
      CREATE TABLE IF NOT EXISTS todos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task TEXT NOT NULL,
        is_completed INTEGER DEFAULT 0,
        sort_order INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
    `);

    await saveDBToStorage();
    return true;
  } catch (err) {
    console.error('Failed to initialize SQLite:', err);
    throw err;
  }
}

/* ==========================================
   CRUD Query API Methods
   ========================================== */

/** Add a new item to SQLite */
async function dbAddItem(name) {
  const maxRes = db.exec("SELECT COALESCE(MAX(sort_order), 0) FROM items;");
  const maxOrder = (maxRes.length && maxRes[0].values.length) ? maxRes[0].values[0][0] : 0;

  const stmt = db.prepare("INSERT INTO items (name, is_running, sort_order) VALUES (?, 0, ?);");
  stmt.run([name.trim(), maxOrder + 1]);
  stmt.free();
  
  // Get last inserted ID
  const res = db.exec("SELECT last_insert_rowid() as id;");
  const lastId = res[0].values[0][0];
  
  await saveDBToStorage();
  return lastId;
}

/** Delete item and its time logs */
async function dbDeleteItem(itemId) {
  db.run("DELETE FROM time_logs WHERE item_id = ?;", [itemId]);
  db.run("DELETE FROM items WHERE id = ?;", [itemId]);
  await saveDBToStorage();
}

/** Start timer for an item */
async function dbStartTimer(itemId) {
  const startTimeISO = new Date().toISOString();
  db.run("UPDATE items SET is_running = 1, current_start_time = ? WHERE id = ?;", [startTimeISO, itemId]);
  await saveDBToStorage();
  return startTimeISO;
}

/** Stop timer and insert log into SQLite */
async function dbStopTimer(itemId) {
  // Get current_start_time
  const res = db.exec("SELECT current_start_time FROM items WHERE id = ?;", [itemId]);
  if (!res.length || !res[0].values.length || !res[0].values[0][0]) {
    throw new Error('Timer was not running');
  }

  const startTimeISO = res[0].values[0][0];
  const stopTimeISO = new Date().toISOString();
  
  const startDate = new Date(startTimeISO);
  const stopDate = new Date(stopTimeISO);
  const durationSeconds = Math.max(1, Math.round((stopDate - startDate) / 1000));
  
  // Local date formatted as YYYY-MM-DD for reporting
  const year = startDate.getFullYear();
  const month = String(startDate.getMonth() + 1).padStart(2, '0');
  const day = String(startDate.getDate()).padStart(2, '0');
  const logDateStr = `${year}-${month}-${day}`;

  // Insert log record into SQLite
  db.run(`
    INSERT INTO time_logs (item_id, start_time, stop_time, duration_seconds, log_date)
    VALUES (?, ?, ?, ?, ?);
  `, [itemId, startTimeISO, stopTimeISO, durationSeconds, logDateStr]);

  // Reset item state
  db.run("UPDATE items SET is_running = 0, current_start_time = NULL WHERE id = ?;", [itemId]);

  await saveDBToStorage();
  return { durationSeconds, logDateStr };
}

/** Fetch all items with total accumulated duration */
function dbGetAllItems() {
  const query = `
    SELECT 
      i.id,
      i.name,
      i.created_at,
      i.is_running,
      i.current_start_time,
      COALESCE(i.sort_order, 0) AS sort_order,
      COALESCE(SUM(l.duration_seconds), 0) AS total_logged_seconds
    FROM items i
    LEFT JOIN time_logs l ON i.id = l.item_id
    GROUP BY i.id
    ORDER BY sort_order ASC, i.id ASC;
  `;
  
  const res = db.exec(query);
  if (!res.length) return [];

  const columns = res[0].columns;
  return res[0].values.map(row => {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  });
}

/** Reorder Tracker Item */
async function dbMoveItem(itemId, direction) {
  const items = dbGetAllItems();
  const index = items.findIndex(i => i.id === itemId);
  if (index === -1) return;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= items.length) return;

  // Normalize sort_order
  items.forEach((item, i) => {
    item.sort_order = i + 1;
  });

  const temp = items[index].sort_order;
  items[index].sort_order = items[targetIndex].sort_order;
  items[targetIndex].sort_order = temp;

  items.forEach(item => {
    db.run("UPDATE items SET sort_order = ? WHERE id = ?;", [item.sort_order, item.id]);
  });

  await saveDBToStorage();
}

/* ==========================================
   Todo CRUD Query Methods
   ========================================== */

/** Add a new todo task */
async function dbAddTodo(task) {
  const maxRes = db.exec("SELECT COALESCE(MAX(sort_order), 0) FROM todos;");
  const maxOrder = (maxRes.length && maxRes[0].values.length) ? maxRes[0].values[0][0] : 0;

  const stmt = db.prepare("INSERT INTO todos (task, is_completed, sort_order) VALUES (?, 0, ?);");
  stmt.run([task.trim(), maxOrder + 1]);
  stmt.free();

  const res = db.exec("SELECT last_insert_rowid() as id;");
  const lastId = res[0].values[0][0];

  await saveDBToStorage();
  return lastId;
}

/** Fetch all todos sorted by sort_order ASC */
function dbGetAllTodos() {
  const query = `SELECT id, task, is_completed, sort_order, created_at FROM todos ORDER BY sort_order ASC, id ASC;`;
  const res = db.exec(query);
  if (!res.length) return [];

  const columns = res[0].columns;
  return res[0].values.map(row => {
    const obj = {};
    columns.forEach((col, idx) => {
      obj[col] = row[idx];
    });
    return obj;
  });
}

/** Toggle completion state of a todo */
async function dbToggleTodo(todoId) {
  db.run("UPDATE todos SET is_completed = CASE WHEN is_completed = 1 THEN 0 ELSE 1 END WHERE id = ?;", [todoId]);
  await saveDBToStorage();
}

/** Delete a todo item */
async function dbDeleteTodo(todoId) {
  db.run("DELETE FROM todos WHERE id = ?;", [todoId]);
  await saveDBToStorage();
}

/** Reorder Todo item */
async function dbMoveTodo(todoId, direction) {
  const todos = dbGetAllTodos();
  const index = todos.findIndex(t => t.id === todoId);
  if (index === -1) return;
  const targetIndex = direction === 'up' ? index - 1 : index + 1;
  if (targetIndex < 0 || targetIndex >= todos.length) return;

  todos.forEach((t, i) => {
    t.sort_order = i + 1;
  });

  const temp = todos[index].sort_order;
  todos[index].sort_order = todos[targetIndex].sort_order;
  todos[targetIndex].sort_order = temp;

  todos.forEach(t => {
    db.run("UPDATE todos SET sort_order = ? WHERE id = ?;", [t.sort_order, t.id]);
  });

  await saveDBToStorage();
}

/** Fetch log history for a single item */
function dbGetItemHistory(itemId) {
  const query = `
    SELECT id, start_time, stop_time, duration_seconds, log_date
    FROM time_logs
    WHERE item_id = ?
    ORDER BY id DESC;
  `;
  const stmt = db.prepare(query);
  stmt.bind([itemId]);
  
  const results = [];
  while (stmt.step()) {
    const row = stmt.getAsObject();
    results.push(row);
  }
  stmt.free();
  return results;
}

/** Fetch filtered reports data for Screen 2 & CSV Export */
function dbGetReportData(startDate, endDate) {
  let query = `
    SELECT 
      i.name AS item_name,
      l.log_date,
      l.start_time,
      l.stop_time,
      l.duration_seconds
    FROM time_logs l
    JOIN items i ON l.item_id = i.id
  `;

  const params = [];
  const conditions = [];

  if (startDate) {
    conditions.push("l.log_date >= ?");
    params.push(startDate);
  }
  if (endDate) {
    conditions.push("l.log_date <= ?");
    params.push(endDate);
  }

  if (conditions.length > 0) {
    query += " WHERE " + conditions.join(" AND ");
  }

  query += " ORDER BY l.log_date DESC, l.id DESC;";

  const stmt = db.prepare(query);
  stmt.bind(params);

  const rows = [];
  let totalDurationSeconds = 0;

  while (stmt.step()) {
    const row = stmt.getAsObject();
    rows.push(row);
    totalDurationSeconds += row.duration_seconds;
  }
  stmt.free();

  return {
    rows,
    totalDurationSeconds,
    sessionCount: rows.length
  };
}

/** Export SQLite Database as a downloadable binary file */
function dbExportDatabaseFile() {
  if (!db) return;
  const binaryArray = db.export();
  const blob = new Blob([binaryArray], { type: 'application/x-sqlite3' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `ChronoSQL_Database_${new Date().toISOString().slice(0,10)}.sqlite`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
}
