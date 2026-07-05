ObjC.import('stdlib');
const Notes = Application('Notes');
Notes.includeStandardAdditions = true;

const total = Notes.notes.length;
const out = [];
const chunkSize = 25;

for (let start = 0; start < total; start += chunkSize) {
  const end = Math.min(start + chunkSize, total);
  const chunk = Notes.notes.slice(start, end);
  let ids, names, bodies, mods;
  try {
    ids = chunk.id();
    names = chunk.name();
    bodies = chunk.body();
    mods = chunk.modificationDate();
  } catch (e) {
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

const path = '/private/tmp/claude-501/-Users-ummi/a5704029-4d72-4fe2-be77-7ccb45d6ed6a/scratchpad/notes_export.json';
const jsonStr = JSON.stringify(out);
const data = $.NSString.alloc.initWithUTF8String(jsonStr);
data.writeToFileAtomicallyEncodingError(path, true, $.NSUTF8StringEncoding, null);
out.length;
