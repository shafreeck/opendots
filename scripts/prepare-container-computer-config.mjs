/** Operator-requested container startup only. Copies NONSECRET configuration into
 * a fresh private tmp directory; never edits the selected config or credential.
 * Browser lifecycle belongs to the supervised dbus-run-session/Chromium command.
 */
import { mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { readComputerConfig } from '../src/computer-config.ts';
import { browserLifetime } from '../src/linux-computer.ts';
const config=readComputerConfig(process.argv[2]??'');
const browserPid=Number(process.env.OPENDOTS_SUPERVISED_BROWSER_PID);
browserLifetime(browserPid)();
if(config.display!==':99'||config.xauthority!=='/tmp/opendots.Xauthority'||config.previewPort!==5901||config.controlPort!==5902||config.previewReadOnlyEnforced!==true)throw Error('Computer config does not match the provided supervised desktop layout');
const directory=mkdtempSync(join(tmpdir(),'opendots-active-computer-'));
const path=join(directory,'computer.json');
writeFileSync(path,JSON.stringify({...config,browserPid,browserInstanceId:randomUUID()}),{mode:0o600,flag:'wx'});
process.stdout.write(path+'\n');
