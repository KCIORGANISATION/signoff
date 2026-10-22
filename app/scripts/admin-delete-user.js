// Deletes a beta tester's account and everything in it, like "Delete my account" does.
// Usage: npm run admin:delete-user -- <email>
// Shows what will be deleted, then asks to type the email again before doing anything.
import { ask, emailArgument, fail, requireDatabase } from './admin.js';

requireDatabase();
const email = emailArgument('npm run admin:delete-user -- <email>');

const { accountSummary, deleteAccount, findUserByEmail } = await import('../src/account.js');
const { config } = await import('../src/config.js');
const { close } = await import('../src/db.js');

try {
  const user = await findUserByEmail(email);
  if (!user) fail(`No account with the email ${email}.`);
  const summary = await accountSummary(user.id);
  console.log(`\nAccount ${email}, created ${user.created_at.toISOString().slice(0, 10)}.`);
  console.log(`It has ${summary.projects} project(s), ${summary.milestones} milestone(s) (${summary.approved} approved) and ${summary.files} file(s).`);
  console.log('Deleting it removes all of this for good. Client links stop working. Backups keep a copy until they expire.\n');

  const answer = await ask('Type the email again to confirm, or anything else to cancel: ');
  if (answer.toLowerCase() !== email) fail('Cancelled. Nothing was deleted.');

  // Without the production file storage settings here, files are not deleted now:
  // they are listed in storage_orphans for "npm run admin:clean-storage".
  const filesLater = config.files.storage !== 'r2';
  const result = await deleteAccount(user.id, { filesLater });
  if (!result) fail('The account was already gone.');
  console.log('Deleted.');
  if (result.files > 0 && (filesLater || !result.filesRemoved)) {
    console.log(`${result.files} file(s) are listed in storage_orphans: run npm run admin:clean-storage where FILES_R2_* are set.`);
  } else if (result.files > 0) {
    console.log(`${result.files} file(s) removed from storage.`);
  }
} finally {
  await close();
}
