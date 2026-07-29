import { describe, expect, it } from 'vitest';
import { seedFor, seedFromString, seedFromUrl } from '../../lib/workspace/ingest';
import { emptyWorkspace, normalizeSpatialObject } from '../../lib/workspace/types';
import { panWorkspaceViewport, zoomWorkspaceViewportAt } from '../../lib/workspace/viewport';

describe('workspace contract', () => {
  it('starts from a durable empty workspace shape',()=>expect(emptyWorkspace()).toMatchObject({version:1,viewport:{x:0,y:0,zoom:1},nextZ:1,nodes:[]}));
  it('normalizes governed spatial metadata',()=>expect(normalizeSpatialObject({kind:'receipt',owner:'\u001b[31moperator\u001b[0m',status:'completed',proofRefs:[' build log ',null]})).toMatchObject({kind:'receipt',owner:'operator',status:'completed',proofRefs:['build log']}));
  it('routes pasted input deterministically',()=>{expect(seedFromString('https://hii.local/proof').type).toBe('link');expect(seedFromUrl('https://hii.local/reference.svg').type).toBe('image');expect(seedFromString('<section>proof</section>').type).toBe('html')});
  it('labels modeled sound data',()=>expect(seedFor('sound-field')).toMatchObject({object:{kind:'scene',status:'ready'},payload:{dataMode:'modeled'}}));
  it('pans the workspace with natural trackpad deltas',()=>expect(panWorkspaceViewport({x:80,y:-20,zoom:1},24,-12)).toEqual({x:56,y:-8,zoom:1}));
  it('keeps the trackpad pinch anchor fixed in screen space',()=>{
    const before={x:40,y:20,zoom:1};
    const point={x:300,y:240};
    const after=zoomWorkspaceViewportAt(before,point,-80);
    expect((point.x-after.x)/after.zoom).toBeCloseTo((point.x-before.x)/before.zoom);
    expect((point.y-after.y)/after.zoom).toBeCloseTo((point.y-before.y)/before.zoom);
    expect(after.zoom).toBeGreaterThan(before.zoom);
  });
});
