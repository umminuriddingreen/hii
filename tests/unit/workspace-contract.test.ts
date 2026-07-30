import { describe, expect, it } from 'vitest';
import { seedFor, seedFromString, seedFromUrl } from '../../lib/workspace/ingest';
import { emptyWorkspace, normalizeSpatialObject } from '../../lib/workspace/types';
import { fitWorkspaceViewport, panWorkspaceViewport, zoomWorkspaceViewportAt } from '../../lib/workspace/viewport';
import { searchWorkspaceNodes } from '../../lib/workspace/search';

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
  it('fits distant workspace content into the visible canvas',()=>{
    const viewport=fitWorkspaceViewport([{x:0,y:0,w:200,h:100},{x:7800,y:3900,w:200,h:100}],{width:1200,height:700});
    expect(viewport).not.toBeNull();
    expect(viewport!.zoom).toBeCloseTo(0.132);
    expect(viewport!.x).toBeCloseTo(72);
    expect(viewport!.y).toBeCloseTo(86);
  });
  it('searches existing nodes by human-readable payload and metadata',()=>{
    const base={x:0,y:0,w:200,h:100,z:1,createdAt:'2026-01-01',updatedAt:'2026-01-01',payload:{}};
    const nodes=[
      {...base,id:'image',type:'image' as const,payload:{name:'South Berkeley field survey.jpg'}},
      {...base,id:'proof',type:'note' as const,object:{kind:'proof' as const},payload:{title:'Release evidence'}}
    ];
    expect(searchWorkspaceNodes(nodes,'berkeley')).toMatchObject([{node:{id:'image'},title:'South Berkeley field survey.jpg'}]);
    expect(searchWorkspaceNodes(nodes,'proof evidence')).toMatchObject([{node:{id:'proof'}}]);
    expect(searchWorkspaceNodes(nodes,'missing')).toEqual([]);
  });
});
