import { describe, expect, it } from 'vitest';
import { seedFor, seedFromString, seedFromUrl } from '../../lib/workspace/ingest';
import { emptyWorkspace, normalizeSpatialObject } from '../../lib/workspace/types';

describe('workspace contract', () => {
  it('starts from a durable empty workspace shape',()=>expect(emptyWorkspace()).toMatchObject({version:1,viewport:{x:0,y:0,zoom:1},nextZ:1,nodes:[]}));
  it('normalizes governed spatial metadata',()=>expect(normalizeSpatialObject({kind:'receipt',owner:'\u001b[31moperator\u001b[0m',status:'completed',proofRefs:[' build log ',null]})).toMatchObject({kind:'receipt',owner:'operator',status:'completed',proofRefs:['build log']}));
  it('routes pasted input deterministically',()=>{expect(seedFromString('https://hii.local/proof').type).toBe('link');expect(seedFromUrl('https://hii.local/reference.svg').type).toBe('image');expect(seedFromString('<section>proof</section>').type).toBe('html')});
  it('labels modeled sound data',()=>expect(seedFor('sound-field')).toMatchObject({object:{kind:'scene',status:'ready'},payload:{dataMode:'modeled'}}));
});
