import { describe, expect, it } from 'vitest';

import { normalizeParametersSchema } from '../../integrations/pi/hii-mcp';

describe('Pi HII MCP schema bridge', () => {
  it('passes declared MCP object schemas through as Pi parameters', () => {
    const schema = {
      type: 'object',
      properties: {
        objectId: { type: 'string' },
      },
      required: ['objectId'],
    };

    expect(normalizeParametersSchema(schema)).toEqual({
      ...schema,
      additionalProperties: true,
    });
  });

  it('falls back to an empty object schema when MCP omits or corrupts inputSchema', () => {
    expect(normalizeParametersSchema(undefined)).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    });
    expect(normalizeParametersSchema({ type: 'array' })).toEqual({
      type: 'object',
      properties: {},
      required: [],
      additionalProperties: true,
    });
  });
});
