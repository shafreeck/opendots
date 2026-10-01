import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** Offline lockfile inventory, not a binary SBOM or a vulnerability assessment. */
export function inventory(locks) {
  const packages=[]; const sources=[];
  for (const {name,bytes} of locks) {
    const lock=JSON.parse(bytes);
    if(lock.lockfileVersion!==3 || !lock.packages || typeof lock.packages!=='object') throw new Error('Expected npm lockfile version 3');
    sources.push({path:name,sha256:createHash('sha256').update(bytes).digest('hex')});
    for(const [path,item] of Object.entries(lock.packages)) {
      if(path==='') continue;
      if(!path.includes('node_modules/') || !item || typeof item.version!=='string') throw new Error('Unsupported lockfile entry');
      const packageName=item.name??path.slice(path.lastIndexOf('node_modules/')+13);
      if(typeof packageName!=='string'||!packageName||typeof item.integrity!=='string') throw new Error('Package identity or integrity missing');
      // Registry locations are intentionally omitted: an inventory must not echo
      // credentials from a custom registry URL or serialize unrelated lock data.
      packages.push({lockfile:name,path,name:packageName,version:item.version,integrity:item.integrity,declaredLicense:typeof item.license==='string'?item.license:null,development:item.dev===true,optional:item.optional===true});
    }
  }
  packages.sort((a,b)=>a.lockfile.localeCompare(b.lockfile)||a.path.localeCompare(b.path));
  return {schema:'opendots.npm-lock-inventory.v1',scope:'Resolved npm lockfile packages, including optional platforms; not proof of installed or shipped binaries',exclusions:['Operating system/container packages','Electron embedded Chromium and bundled third-party binaries','Native build/link dependencies, including React Native platform binaries','Runtime binary internal dependencies','Vulnerability and legal clearance'],sources,packages};
}
if(process.argv[1]===fileURLToPath(import.meta.url)) {
  const root=new URL('../',import.meta.url);
  const result=inventory(['package-lock.json','apps/desktop/package-lock.json','apps/mobile/package-lock.json'].map(name=>({name,bytes:readFileSync(new URL(name,root),'utf8')})));
  process.stdout.write(JSON.stringify(result,null,2)+'\n');
}
