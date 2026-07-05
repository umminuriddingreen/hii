ObjC.import('stdlib');
const Notes = Application('Notes');
const acct = Notes.accounts.byName('iCloud');
const folder = acct.folders.byName('Notes');

const total = folder.notes.length;
const out = [];
const chunkSize = 10;

for (let start = 0; start < total; start += chunkSize) {
  const end = Math.min(start + chunkSize, total);
  const chunk = folder.notes.slice(start, end);
  let ids, names, bodies, mods;
  try {
    ids = chunk.id();
    names = chunk.name();
    bodies = chunk.body();
    mods = chunk.modificationDate();
  } catch (e) {
    // fall back to per-note within failed chunk
    for (let j = start; j < end; j++) {
      try {
        const n = folder.notes[j];
        const plain = n.body().replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
        out.push({ id: n.id(), name: n.name(), snippet: plain.substring(0, 400), modified: null });
      } catch (e2) {}
    }
    continue;
  }
  for (let i = 0; i < ids.length; i++) {
    let plain = '';
    try {
      plain = bodies[i].replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim();
    } catch (e) {}
    out.push({
      id: ids[i],
      name: names[i],
      snippet: plain.substring(0, 400),
      modified: mods[i] ? mods[i].toISOString() : null
    });
  }
}

const path = '/private/tmp/claude-501/-Users-ummi/a5704029-4d72-4fe2-be77-7ccb45d6ed6a/scratchpad/notes_remaining.json';
const data = $.NSString.alloc.initWithUTF8String(JSON.stringify(out));
data.writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
out.length;
