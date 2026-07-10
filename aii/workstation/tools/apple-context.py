#!/usr/bin/env python3
"""apple-context — token-efficient conversation/context reader for Apple apps.

One tool so agents can pull context from local Apple app stores without
re-deriving SQLite paths and Apple's binary blob formats every time.
Output is compact by design: terse one-line-per-record, reactions stripped,
snippets not full bodies, server-side --search/--since/--limit filtering.

Covers (all read from local stores, no network, read-only):
  contacts   AddressBook name -> handles (phone/email)
  messages   iMessage/SMS thread by contact name OR handle
  notes      Apple Notes index (titles+snippets); --full dumps one note body
  reminders  Reminders across all local stores
  mail       Mail metadata (subject/from/date) via Envelope Index

Examples:
  apple-context.py contacts zara
  apple-context.py messages zara --limit 40
  apple-context.py messages zara --search flight
  apple-context.py notes --search wishlist
  apple-context.py reminders --pending
  apple-context.py mail --search invoice --limit 20
"""
import argparse
import glob
import gzip
import os
import re
import sqlite3

HOME = os.path.expanduser("~")
CHAT_DB = f"{HOME}/Library/Messages/chat.db"
AB_GLOBS = [
    f"{HOME}/Library/Application Support/AddressBook/AddressBook-v22.abcddb",
    f"{HOME}/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb",
]
NOTES_DB = f"{HOME}/Library/Group Containers/group.com.apple.notes/NoteStore.sqlite"
REMINDERS_GLOB = (
    f"{HOME}/Library/Group Containers/group.com.apple.reminders"
    "/Container_v1/Stores/Data-*.sqlite"
)
MAIL_INDEX = f"{HOME}/Library/Mail/V10/MailData/Envelope Index"
APPLE_EPOCH = 978307200  # 2001-01-01 in unix seconds

# Tapback / reaction prefixes to drop for token efficiency.
_REACTIONS = ("Loved ", "Liked ", "Disliked ", "Laughed at ", "Emphasized ",
              "Questioned ", "Reacted ")


def _connect_ro(path):
    """Read-only connection. Prefer immutable (no lock), but fall back to a
    WAL-aware ro open when a live -wal makes the immutable view look malformed."""
    try:
        return sqlite3.connect(f"file:{path}?mode=ro", uri=True)
    except sqlite3.OperationalError:
        # Locked live db -> immutable view ignores the -wal lock.
        return sqlite3.connect(f"file:{path}?mode=ro&immutable=1", uri=True)


def _ab_dbs():
    for pat in AB_GLOBS:
        for p in glob.glob(pat):
            yield p


def decode_attributed_body(blob):
    """Extract plain text from a typedstream attributedBody blob (newer macOS)."""
    if not blob:
        return None
    try:
        s = blob.split(b"NSString")[1][5:]
        if s[0] == 0x81:
            ln = int.from_bytes(s[1:3], "little")
            s = s[3:3 + ln]
        else:
            ln = s[0]
            s = s[1:1 + ln]
        return s.decode("utf-8", errors="replace")
    except Exception:
        return None


def _body(text, attributed):
    return text or decode_attributed_body(attributed) or "[media]"


# ---------------------------------------------------------------- contacts
def resolve_contact(name):
    """Return list of (label, handle) for a contact name (phones + emails)."""
    out, seen = [], set()
    for db_path in _ab_dbs():
        try:
            db = _connect_ro(db_path)
        except sqlite3.Error:
            continue
        rows = db.execute(
            """SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER, e.ZADDRESS
               FROM ZABCDRECORD r
               LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
               LEFT JOIN ZABCDEMAILADDRESS e ON e.ZOWNER = r.Z_PK
               WHERE r.ZFIRSTNAME LIKE ? OR r.ZLASTNAME LIKE ?""",
            (f"%{name}%", f"%{name}%"),
        ).fetchall()
        for first, last, number, email in rows:
            label = f"{first or ''} {last or ''}".strip()
            for h in (number, email):
                if h and (label, h) not in seen:
                    seen.add((label, h))
                    out.append((label, h))
    return out


def cmd_contacts(a):
    hits = resolve_contact(a.name)
    if not hits:
        print(f"(no contact matching '{a.name}')")
        return
    for label, handle in hits:
        print(f"{label} | {handle}")


# ---------------------------------------------------------------- messages
def _norm(h):
    return re.sub(r"[^\d@a-zA-Z.]", "", h).lstrip("1").lower()


def iter_thread(handle, since=None):
    db = _connect_ro(CHAT_DB)
    q = f"""SELECT datetime(m.date/1000000000 + {APPLE_EPOCH}, 'unixepoch', 'localtime'),
                   m.is_from_me, m.text, m.attributedBody
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE REPLACE(REPLACE(REPLACE(REPLACE(c.chat_identifier,' ',''),
                  '-',''),'(',''),')','') LIKE ?"""
    params = [f"%{_norm(handle)}%" if handle.replace('+', '').isdigit() else f"%{handle}%"]
    if since:
        q += f" AND (m.date/1000000000 + {APPLE_EPOCH}) > CAST(strftime('%s', ?) AS INTEGER)"
        params.append(since)
    q += " ORDER BY m.date ASC"
    for dt, me, text, ab in db.execute(q, params):
        yield dt, "ME  " if me else "THEM", _body(text, ab)


def cmd_messages(a):
    target = a.who
    # If it isn't obviously a handle, resolve the name to handles first.
    if not (a.who.startswith("+") or "@" in a.who or a.who.replace("+", "").isdigit()):
        hits = resolve_contact(a.who)
        handles = [h for _, h in hits if h and h.startswith("+")]
        if not handles:
            handles = [h for _, h in hits if h]
        if not handles:
            print(f"(no contact/handle for '{a.who}')")
            return
        target = handles[0]
    rows = []
    for dt, who, body in iter_thread(target, a.since):
        if any(body.startswith(p) for p in _REACTIONS):
            continue
        if a.search and a.search.lower() not in body.lower():
            continue
        rows.append((dt[5:16], who, body))  # drop year+seconds for tokens
    if a.limit:
        rows = rows[-a.limit:]
    print(f"# {target}  ({len(rows)} msgs)")
    for dt, who, body in rows:
        print(f"{dt} {who}| {body}")


# ---------------------------------------------------------------- notes
def _extract_note_text(zdata):
    """Best-effort readable text from a gzip'd protobuf note body."""
    try:
        raw = gzip.decompress(zdata)
    except Exception:
        return ""
    # Pull the longest run of printable UTF-8 out of the protobuf payload.
    chunks = re.findall(rb"[\x09\x0a\x20-\x7e\xc2-\xf4][\x80-\xbf\x09\x0a\x20-\x7e]{3,}", raw)
    text = " ".join(c.decode("utf-8", "ignore") for c in chunks)
    text = re.sub(r"\s+", " ", text).strip()
    return text


def cmd_notes(a):
    db = _connect_ro(NOTES_DB)
    rows = db.execute(
        """SELECT o.ZTITLE1, d.ZDATA,
                  datetime(o.ZMODIFICATIONDATE1 + ?, 'unixepoch', 'localtime')
           FROM ZICCLOUDSYNCINGOBJECT o
           JOIN ZICNOTEDATA d ON d.ZNOTE = o.Z_PK
           WHERE o.ZTITLE1 IS NOT NULL
           ORDER BY o.ZMODIFICATIONDATE1 DESC""",
        (APPLE_EPOCH,),
    ).fetchall()
    n = 0
    for title, zdata, mod in rows:
        body = _extract_note_text(zdata) if (a.search or a.full) else ""
        hay = f"{title} {body}".lower()
        if a.search and a.search.lower() not in hay:
            continue
        n += 1
        if a.full:
            print(f"=== {title}  ({mod}) ===\n{body}\n")
        else:
            snip = ""
            if body:
                snip = " — " + body[:120]
            print(f"{(mod or '')[:10]} | {title}{snip}")
        if a.limit and n >= a.limit:
            break
    if not n:
        print("(no notes matched)")


# ---------------------------------------------------------------- reminders
def cmd_reminders(a):
    printed = 0
    for db_path in sorted(glob.glob(REMINDERS_GLOB)):
        try:
            db = _connect_ro(db_path)
            lists = dict(db.execute(
                "SELECT Z_PK, ZNAME FROM ZREMCDBASELIST").fetchall())
            rows = db.execute(
                """SELECT ZTITLE, ZNOTES, ZCOMPLETED, ZFLAGGED, ZLIST,
                          datetime(ZDUEDATE + ?, 'unixepoch', 'localtime')
                   FROM ZREMCDREMINDER WHERE ZTITLE IS NOT NULL""",
                (APPLE_EPOCH,),
            ).fetchall()
        except sqlite3.Error:
            continue
        for title, notes, done, flag, lst, due in rows:
            if a.pending and done:
                continue
            if a.search and a.search.lower() not in f"{title} {notes or ''}".lower():
                continue
            box = "x" if done else " "
            listname = lists.get(lst, "?")
            duestr = f" @{due[:16]}" if due else ""
            flagstr = " ⚑" if flag else ""
            note = f" — {notes}" if notes else ""
            print(f"[{box}] {listname}: {title}{duestr}{flagstr}{note}")
            printed += 1
    if not printed:
        print("(no reminders matched)")


# ---------------------------------------------------------------- mail
def cmd_mail(a):
    db = _connect_ro(MAIL_INDEX)
    q = """SELECT datetime(m.date_sent, 'unixepoch', 'localtime'),
                  a.address, a.comment, s.subject, m.read
           FROM messages m
           LEFT JOIN subjects s ON m.subject = s.ROWID
           LEFT JOIN addresses a ON m.sender = a.ROWID
           WHERE 1=1"""
    params = []
    if a.search:
        q += " AND (s.subject LIKE ? OR a.address LIKE ? OR a.comment LIKE ?)"
        params += [f"%{a.search}%"] * 3
    if a.unread:
        q += " AND m.read = 0"
    q += " ORDER BY m.date_sent DESC LIMIT ?"
    params.append(a.limit or 30)
    n = 0
    for dt, addr, name, subj, read in db.execute(q, params):
        n += 1
        who = name or addr or "?"
        dot = " " if read else "•"
        print(f"{dot}{(dt or '')[:16]} | {who[:28]:28} | {subj or '(no subject)'}")
    if not n:
        print("(no mail matched)")


# ---------------------------------------------------------------- cli
def main():
    p = argparse.ArgumentParser(prog="apple-context", description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("contacts"); c.add_argument("name")

    m = sub.add_parser("messages")
    m.add_argument("who", help="contact name, phone (+1...), or email")
    m.add_argument("--limit", type=int, default=40)
    m.add_argument("--since")
    m.add_argument("--search")

    n = sub.add_parser("notes")
    n.add_argument("--search"); n.add_argument("--limit", type=int)
    n.add_argument("--full", action="store_true", help="dump full note body")

    r = sub.add_parser("reminders")
    r.add_argument("--search")
    r.add_argument("--pending", action="store_true", help="only incomplete")

    ml = sub.add_parser("mail")
    ml.add_argument("--search"); ml.add_argument("--limit", type=int, default=30)
    ml.add_argument("--unread", action="store_true")

    a = p.parse_args()
    {"contacts": cmd_contacts, "messages": cmd_messages, "notes": cmd_notes,
     "reminders": cmd_reminders, "mail": cmd_mail}[a.cmd](a)


if __name__ == "__main__":
    main()
