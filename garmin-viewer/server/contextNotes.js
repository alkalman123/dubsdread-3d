// Durable facts the athlete has told the Coach chat about themselves --
// upcoming trips/objectives ("climbing trip to the Red River Gorge the
// week of Nov 10"), or standing situational facts ("has a hangboard at
// home, works from home 2-3 days/week"). These aren't inferred from
// Garmin data; they only exist because the athlete said them in chat (see
// server/chat.js's remember_context tool), and they're fed back into every
// future chat exchange as context so the coach doesn't need re-told the
// same thing every conversation.
//
// Same ephemeral-disk situation as server/healthImport.js -- this file
// lives on Render's wiped-on-deploy disk, so the frontend caches it
// client-side and restores it the same way it restores the health import.

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '.data');
const NOTES_FILE = path.join(DATA_DIR, 'contextNotes.json');

function ensureDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function loadNotes() {
  try {
    const notes = JSON.parse(fs.readFileSync(NOTES_FILE, 'utf8'));
    return Array.isArray(notes) ? notes : [];
  } catch {
    return [];
  }
}

function saveNotes(notes) {
  ensureDir();
  fs.writeFileSync(NOTES_FILE, JSON.stringify(notes));
}

function addNote({ note, category }) {
  const notes = loadNotes();
  const entry = {
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    note: String(note || '').trim(),
    category: ['objective', 'equipment', 'schedule', 'other'].includes(category) ? category : 'other',
    createdAt: new Date().toISOString(),
  };
  if (!entry.note) return null;
  notes.push(entry);
  saveNotes(notes);
  return entry;
}

function removeNote(id) {
  const notes = loadNotes().filter((n) => n.id !== id);
  saveNotes(notes);
  return notes;
}

module.exports = { loadNotes, saveNotes, addNote, removeNote };
