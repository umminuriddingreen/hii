import { createFixtureResolver } from './resolver.ts';

const previewRecords = Object.freeze([
  Object.freeze({
    schemaVersion: 1,
    id: '14th-street',
    name: '14th Street',
    policy: Object.freeze({ read: 'public', write: 'local' }),
    objects: Object.freeze([
      Object.freeze({
        id: 'welcome',
        type: 'text',
        x: 96,
        y: 88,
        width: 360,
        height: 180,
        rotation: 0,
        content: Object.freeze({ text: 'A public preview. Changes still belong to the local HII host.' }),
        updatedAt: '2026-08-20T00:00:00.000Z'
      }),
      Object.freeze({
        id: 'place-sticker',
        type: 'sticker',
        x: 510,
        y: 210,
        width: 180,
        height: 180,
        rotation: -6,
        content: Object.freeze({ text: '14TH' }),
        updatedAt: '2026-08-20T00:00:00.000Z'
      })
    ]),
    updatedAt: '2026-08-20T00:00:00.000Z'
  })
]);

/** Non-secret, immutable preview data. Never authoritative and never writable. */
export const previewResolver = createFixtureResolver(previewRecords);
