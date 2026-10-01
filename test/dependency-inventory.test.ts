import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
const require=createRequire(import.meta.url);
const {inventory}=require('../scripts/dependency-inventory.mjs');
const make=(packages:any)=>({name:'package-lock.json',bytes:JSON.stringify({lockfileVersion:3,packages:{'':{version:'1'},...packages}})});
test('offline inventory retains scoped identity integrity and license without registry credentials',()=>{const data=inventory([make({'node_modules/@scope/pkg':{version:'1.2.3',integrity:'sha512-abc',license:'MIT',resolved:'https://user:secret@example.test/pkg',dev:true}})]);assert.equal(data.packages[0].name,'@scope/pkg');assert.equal(data.packages[0].declaredLicense,'MIT');assert.equal(data.sources[0].sha256.length,64);assert.equal(JSON.stringify(data).includes('secret'),false);});
test('offline inventory is deterministic and keeps optional dependencies visible',()=>{const lock=make({'node_modules/z':{version:'2',integrity:'sha512-z',optional:true},'node_modules/a':{version:'1',integrity:'sha512-a'}});const a=inventory([lock]);assert.deepEqual(a,inventory([lock]));assert.deepEqual(a.packages.map((x:any)=>x.name),['a','z']);assert.equal(a.packages[1].optional,true);assert.equal(a.packages[0].declaredLicense,null);});
test('offline inventory rejects unsupported links or absent integrity',()=>{assert.throws(()=>inventory([{name:'bad',bytes:'{}'}]));assert.throws(()=>inventory([make({'node_modules/a':{version:'1'}})]));});
