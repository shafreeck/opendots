import { createProductSnapshot, verifyProductSnapshot, restoreProductSnapshot, ProductBackupError } from '../src/product-backup.ts';

const usage = `Experimental product database recovery (Linux, Node 24):
  node scripts/product-backup.mjs snapshot --source /absolute/product.sqlite --destination /absolute/new-snapshot-directory
  node scripts/product-backup.mjs verify --snapshot /absolute/snapshot-directory
  node scripts/product-backup.mjs restore --snapshot /absolute/snapshot-directory --destination /absolute/new-restore-directory --app-stopped

Final independent security review is incomplete; see the documented limits.
Only the explicitly selected product database is included. Snapshots contain private
history, auth-session hashes and persisted receipts. They exclude Morphz storage,
external resources, operator configs and the separate computer-control database.
Restore requires the operator to stop the app first, invalidates saved login
sessions in the new copy, and never reconnects or rewinds external effects.
See docs/BACKUP_RECOVERY.md before selecting a restored database for startup.`;

try {
  const [operation, ...args] = process.argv.slice(2);
  if (operation === '--help' && args.length === 0) { console.log(usage); }
  else {
    const allowed = operation === 'snapshot' ? ['source','destination'] : operation === 'verify' ? ['snapshot'] : operation === 'restore' ? ['snapshot','destination','app-stopped'] : [];
    const values = new Map();
    for (let i = 0; i < args.length; i++) {
      const argument = args[i];
      if (!argument.startsWith('--') || !allowed.includes(argument.slice(2)) || values.has(argument.slice(2))) throw new ProductBackupError('backup_cli_arguments_invalid');
      const name = argument.slice(2);
      if (name === 'app-stopped') values.set(name, true);
      else { const value = args[++i]; if (!value || value.startsWith('--')) throw new ProductBackupError('backup_cli_arguments_invalid'); values.set(name, value); }
    }
    if (!allowed.length || allowed.some(name => !values.has(name))) throw new ProductBackupError('backup_cli_arguments_invalid');
    if (operation === 'snapshot') {
      const result = await createProductSnapshot({ source: values.get('source'), destination: values.get('destination') });
      console.log(JSON.stringify({ status: 'snapshot_created', directory: result.directory, databasePath: result.databasePath, manifestPath: result.manifestPath }));
    } else if (operation === 'verify') {
      verifyProductSnapshot(values.get('snapshot')); console.log(JSON.stringify({ status: 'snapshot_verified' }));
    } else {
      const result = await restoreProductSnapshot({ snapshot: values.get('snapshot'), destination: values.get('destination'), appStopped: values.get('app-stopped') === true });
      console.log(JSON.stringify({ status: 'restored_to_new_path', ...result, reconnectPerformed: false }));
    }
  }
} catch (error) {
  console.error(error instanceof ProductBackupError ? error.code : 'backup_operation_failed');
  process.exitCode = 1;
}
