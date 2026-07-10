#!/usr/bin/env python3
"""aii-messages — iMessage access layer for AII.

Reads the local Messages database (chat.db) and Contacts (AddressBook)
directly. Handles the attributedBody format that hides message text on
newer macOS versions.

Usage:
  aii-messages.py contacts <name>                  # find handles for a contact name
  aii-messages.py thread <handle> [--since DATE] [--limit N]
  aii-messages.py export <handle> <outfile>        # full thread to pipe-delimited file
  aii-messages.py recent [--since DATE]            # all threads, recent first
  aii-messages.py stats <handle>                   # volume by month, per-sender counts

<handle> is a phone number (+1...) or iMessage email.
"""
import argparse
import glob
import os
import sqlite3
import sys

CHAT_DB = os.path.expanduser("~/Library/Messages/chat.db")
AB_GLOB = os.path.expanduser(
    "~/Library/Application Support/AddressBook/Sources/*/AddressBook-v22.abcddb"
)
APPLE_EPOCH = 978307200


def decode_attributed_body(blob):
    """Extract plain text from a typedstream attributedBody blob."""
    if not blob:
        return None
    try:
        s = blob.split(b"NSString")[1][5:]
        if s[0] == 0x81:
            ln = int.from_bytes(s[1:3], "little")
            s = s[3 : 3 + ln]
        else:
            ln = s[0]
            s = s[1 : 1 + ln]
        return s.decode("utf-8", errors="replace")
    except Exception:
        return None


def body_of(text, attributed):
    return text or decode_attributed_body(attributed) or "[media]"


def find_contacts(name):
    seen = set()
    for db_path in glob.glob(AB_GLOB):
        db = sqlite3.connect(db_path)
        rows = db.execute(
            """SELECT r.ZFIRSTNAME, r.ZLASTNAME, p.ZFULLNUMBER
               FROM ZABCDRECORD r
               LEFT JOIN ZABCDPHONENUMBER p ON p.ZOWNER = r.Z_PK
               WHERE r.ZFIRSTNAME LIKE ? OR r.ZLASTNAME LIKE ?""",
            (f"%{name}%", f"%{name}%"),
        ).fetchall()
        for first, last, number in rows:
            key = (first, last, number)
            if key not in seen:
                seen.add(key)
                print(f"{first or ''} {last or ''}".strip(), "|", number or "no-number")


def iter_thread(handle, since=None):
    # Join through chat, not handle: sent messages can carry handle_id = 0,
    # which a handle join silently drops.
    db = sqlite3.connect(CHAT_DB)
    q = f"""SELECT datetime(m.date/1000000000 + {APPLE_EPOCH}, 'unixepoch', 'localtime'),
                   m.is_from_me, m.text, m.attributedBody
            FROM message m
            JOIN chat_message_join cmj ON cmj.message_id = m.ROWID
            JOIN chat c ON c.ROWID = cmj.chat_id
            WHERE c.chat_identifier = ?"""
    params = [handle]
    if since:
        q += f" AND (m.date/1000000000 + {APPLE_EPOCH}) > CAST(strftime('%s', ?) AS INTEGER)"
        params.append(since)
    q += " ORDER BY m.date ASC"
    for dt, me, text, ab in db.execute(q, params):
        yield dt, "ME" if me else "THEM", body_of(text, ab)


def cmd_thread(args):
    rows = list(iter_thread(args.handle, args.since))
    if args.limit:
        rows = rows[-args.limit :]
    for dt, who, body in rows:
        print(f"{dt}|{who}|{body}")


def cmd_export(args):
    n = 0
    with open(args.outfile, "w") as f:
        for dt, who, body in iter_thread(args.handle):
            f.write(f"{dt}|{who}|{body}\n")
            n += 1
    print(f"exported {n} messages -> {args.outfile}")


def cmd_recent(args):
    db = sqlite3.connect(CHAT_DB)
    q = f"""SELECT datetime(m.date/1000000000 + {APPLE_EPOCH}, 'unixepoch', 'localtime'),
                   m.is_from_me, COALESCE(h.id, '?'), m.text, m.attributedBody
            FROM message m LEFT JOIN handle h ON m.handle_id = h.ROWID"""
    params = []
    if args.since:
        q += f" WHERE (m.date/1000000000 + {APPLE_EPOCH}) > CAST(strftime('%s', ?) AS INTEGER)"
        params.append(args.since)
    q += " ORDER BY m.date ASC"
    for dt, me, hid, text, ab in db.execute(q, params):
        who = f"ME->{hid}" if me else hid
        print(f"{dt}|{who}|{body_of(text, ab)[:300]}")


def cmd_stats(args):
    me = them = 0
    months = {}
    first = last = None
    for dt, who, _ in iter_thread(args.handle):
        if who == "ME":
            me += 1
        else:
            them += 1
        months[dt[:7]] = months.get(dt[:7], 0) + 1
        last = dt
        first = first or dt
    print(f"total: {me + them}  me: {me}  them: {them}")
    print(f"range: {first} -> {last}")
    for mo in sorted(months):
        print(f"  {mo}: {months[mo]}")


def main():
    p = argparse.ArgumentParser(prog="aii-messages")
    sub = p.add_subparsers(dest="cmd", required=True)

    c = sub.add_parser("contacts")
    c.add_argument("name")

    t = sub.add_parser("thread")
    t.add_argument("handle")
    t.add_argument("--since")
    t.add_argument("--limit", type=int)

    e = sub.add_parser("export")
    e.add_argument("handle")
    e.add_argument("outfile")

    r = sub.add_parser("recent")
    r.add_argument("--since")

    s = sub.add_parser("stats")
    s.add_argument("handle")

    args = p.parse_args()
    {
        "contacts": lambda: find_contacts(args.name),
        "thread": lambda: cmd_thread(args),
        "export": lambda: cmd_export(args),
        "recent": lambda: cmd_recent(args),
        "stats": lambda: cmd_stats(args),
    }[args.cmd]()


if __name__ == "__main__":
    main()
