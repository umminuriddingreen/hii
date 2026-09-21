// SPDX-License-Identifier: LicenseRef-BSL-1.1
const calendar = `BEGIN:VCALENDAR\r
VERSION:2.0\r
PRODID:-//HII//UMMI ARCH495 Studio//EN\r
CALSCALE:GREGORIAN\r
METHOD:PUBLISH\r
X-WR-CALNAME:UMMI · Museum of the American Landscape\r
X-WR-CALDESC:Source-confirmed ARCH495 studio milestones and project deadlines.\r
X-WR-TIMEZONE:America/New_York\r
BEGIN:VEVENT\r
UID:arch495-site-visit-20260911@hii.ummi\r
DTSTAMP:20260920T220000Z\r
DTSTART;VALUE=DATE:20260911\r
DTEND;VALUE=DATE:20260912\r
SUMMARY:ARCH495 · Natirar site visit\r
DESCRIPTION:Gather site annotations, notebook sketches, material and detail photographs, wide-angle collage views, and unresolved site questions.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:arch495-pinup-20260915@hii.ummi\r
DTSTAMP:20260920T220000Z\r
DTSTART;TZID=America/New_York:20260915T130000\r
DTEND;TZID=America/New_York:20260915T180000\r
SUMMARY:ARCH495 · Site research pin-up\r
LOCATION:NJIT studio\r
DESCRIPTION:Site Research Drawing, field-condition source, concept source, and site-visit documentation. Pin up before class.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:arch495-working-session-20260918@hii.ummi\r
DTSTAMP:20260920T220000Z\r
DTSTART;TZID=America/New_York:20260918T130000\r
DTEND;TZID=America/New_York:20260918T180000\r
SUMMARY:ARCH495 · Concept-model working session\r
LOCATION:NJIT studio\r
DESCRIPTION:Model-building methods, desk crits, one concept model complete, program diagram at 50 percent, and site drawing at 95 percent.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:arch495-concept-deadline-20260922@hii.ummi\r
DTSTAMP:20260920T220000Z\r
DTSTART;TZID=America/New_York:20260922T120000\r
DTEND;TZID=America/New_York:20260922T121500\r
SUMMARY:DEADLINE · ARCH495 concept submission\r
DESCRIPTION:Upload one intentionally designed PDF containing the complete seven-part concept submission to the shared studio Google Drive.\r
STATUS:CONFIRMED\r
BEGIN:VALARM\r
TRIGGER:-P1D\r
ACTION:DISPLAY\r
DESCRIPTION:ARCH495 concept PDF is due tomorrow at noon.\r
END:VALARM\r
BEGIN:VALARM\r
TRIGGER:-PT3H\r
ACTION:DISPLAY\r
DESCRIPTION:ARCH495 concept PDF is due in three hours.\r
END:VALARM\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:arch495-desk-crits-20260922@hii.ummi\r
DTSTAMP:20260920T220000Z\r
DTSTART;TZID=America/New_York:20260922T130000\r
DTEND;TZID=America/New_York:20260922T180000\r
SUMMARY:ARCH495 · Concept submission desk crits\r
LOCATION:NJIT studio\r
DESCRIPTION:Desk crits following the noon digital submission.\r
STATUS:CONFIRMED\r
END:VEVENT\r
BEGIN:VEVENT\r
UID:arch495-internal-pinup-20260925@hii.ummi\r
DTSTAMP:20260920T220000Z\r
DTSTART;TZID=America/New_York:20260925T130000\r
DTEND;TZID=America/New_York:20260925T180000\r
SUMMARY:ARCH495 · Internal studio pin-up\r
LOCATION:NJIT studio storefront area\r
DESCRIPTION:Internal studio pin-up following the concept submission.\r
STATUS:CONFIRMED\r
END:VEVENT\r
END:VCALENDAR\r
`;

export function GET() {
  return new Response(calendar, {
    headers: {
      'Content-Type': 'text/calendar; charset=utf-8',
      'Content-Disposition': 'inline; filename="ummi-arch495-studio.ics"',
      'Cache-Control': 'public, max-age=300'
    }
  });
}
