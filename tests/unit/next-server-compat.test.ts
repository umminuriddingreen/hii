import { describe,expect,it } from 'vitest';
import { NextResponse } from '../../src/lib/next-server-compat';
describe('legacy endpoint response bridge',()=>{it('keeps JSON and redirect semantics',async()=>{const json=NextResponse.json({ok:true},{status:201});expect(json.status).toBe(201);expect(await json.json()).toEqual({ok:true});expect(NextResponse.redirect('http://localhost/done',{status:303}).status).toBe(303)})});
