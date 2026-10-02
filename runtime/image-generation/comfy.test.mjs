import {test} from 'node:test';
import assert from 'node:assert/strict';
import {graph,machine,output} from './comfy.mjs';
test('reports the ComfyUI execution machine from its configured route',()=>{
 assert.equal(machine('http://127.0.0.1:4191',{endpointConfigured:false,platform:'darwin'}),'PC');
 assert.equal(machine('http://127.0.0.1:4191',{endpointConfigured:true,platform:'darwin'}),'Mac');
 assert.equal(machine('http://127.0.0.1:8188',{endpointConfigured:true,platform:'darwin'}),'Mac');
 assert.equal(machine('http://127.0.0.1:8188',{endpointConfigured:true,pcEndpoint:'http://127.0.0.1:4189',override:'Mac',platform:'darwin'}),'Mac');
 assert.equal(machine('https://example.invalid:8188',{endpointConfigured:true,platform:'darwin'}),'Remote · machine unknown');
});
test('rejects uninstalled models and excessive image dimensions',()=>{
 assert.throws(()=>graph({prompt:'test',model:'missing'},['z_image_turbo_bf16.safetensors']));
 assert.throws(()=>graph({prompt:'test',width:4096},['z_image_turbo_bf16.safetensors']));
});
test('rejects artifact path traversal',async()=>assert.rejects(output('../../config.json')));
test('checkpoint graph has no disconnected invalid VAE loader',()=>{
 const g=graph({prompt:'test',model:'sdxl.safetensors'},['sdxl.safetensors']);
 assert.equal(g['8'],undefined);assert.deepEqual(g['9'].inputs.vae,['2',2]);
});
