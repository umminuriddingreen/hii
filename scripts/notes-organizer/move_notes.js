// Usage: osascript -l JavaScript move_notes.js <mapping.json> <start> <count>
// mapping.json: [{id, name, category}]  — moves notes into folders named by category.
ObjC.import('stdlib');

function run(argv) {
  const mappingPath = argv[0];
  const start = parseInt(argv[1] || '0', 10);
  const count = parseInt(argv[2] || '100', 10);

  const data = $.NSString.stringWithContentsOfFileEncodingError(mappingPath, $.NSUTF8StringEncoding, null);
  const rows = JSON.parse(data.js).slice(start, start + count);

  const Notes = Application('Notes');
  const account = Notes.accounts.byName('iCloud');

  // ensure folders exist
  const existing = {};
  account.folders().forEach(f => { existing[f.name()] = true; });
  const cats = [...new Set(rows.map(r => r.category))];
  cats.forEach(c => {
    if (!existing[c]) {
      account.folders.push(Notes.Folder({ name: c }));
      existing[c] = true;
    }
  });

  let moved = 0, failed = 0;
  rows.forEach(r => {
    try {
      const note = Notes.notes.byId(r.id);
      Notes.move(note, { to: account.folders.byName(r.category) });
      moved++;
    } catch (e) {
      failed++;
    }
  });
  return JSON.stringify({ start: start, processed: rows.length, moved: moved, failed: failed });
}
